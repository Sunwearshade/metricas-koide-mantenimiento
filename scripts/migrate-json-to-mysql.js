"use strict";

// Migra los archivos JSON de data/ a MySQL y verifica que no se pierda nada.
//
//   node scripts/migrate-json-to-mysql.js                 migra (solo si las tablas estan vacias)
//   node scripts/migrate-json-to-mysql.js --verify-only   solo compara JSON vs MySQL
//   node scripts/migrate-json-to-mysql.js --force         BORRA el contenido actual de las tablas y vuelve a migrar
//   opciones: --data-dir <ruta>
//
// Codigo de salida: 0 = OK, 1 = error o diferencias, 3 = las tablas ya tenian
// datos y no se hizo nada (la base ya fue migrada antes).
//
// Los archivos JSON NO se modifican ni se borran.
// La verificacion lee MySQL con las mismas funciones que usa la API y compara
// el resultado con el JSON original (conteos + contenido exacto, incluido el
// orden de claves), y revisa que existan en disco los archivos referenciados.

const fs = require("fs");
const path = require("path");
const { loadEnvFile, env, resolvePath } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const store = require("../lib/store");

const DOC_CATEGORIAS = [
  "Dibujos",
  "Lay out de planta",
  "Plan de mantenimiento mayor",
  "Indicadores 2026",
  "Check list",
  "Instrucciones de trabajo",
];

// Tablas de datos (orden valido para borrar respetando llaves foraneas).
const TABLES = [
  "contramedida_fotos",
  "contramedidas",
  "bonos_semanas",
  "bonos_plantilla",
  "calendarios",
  "documentos",
  "tiempo_muerto",
  "maquinas",
  "gastos",
  "entregas",
  "fuentes_sync",
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const DATA_DIR = resolvePath(arg("--data-dir") || env("DATA_DIR", "data"));
const FORCE = process.argv.includes("--force");
const VERIFY_ONLY = process.argv.includes("--verify-only");

function readJson(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return { exists: false, file };
  return { exists: true, file, data: JSON.parse(fs.readFileSync(file, "utf8")), mtime: fs.statSync(file).mtime };
}

function loadSources() {
  return {
    tm: readJson("tiempo-muerto.json"),
    gastos: readJson("gastos.json"),
    entregas: readJson("entregas.json"),
    cm: readJson("contramedidas.json"),
    bonos: readJson("bonos.json"),
    cal: readJson("calendarios.json"),
  };
}

// Normaliza igual que el servidor al leer los JSON antes de la migracion.
function expectedFrom(src) {
  const exp = {};
  if (src.tm.exists) {
    exp.tm = { updatedAt: src.tm.data.updatedAt, area: src.tm.data.area, records: src.tm.data.records, machines: src.tm.data.machines || [] };
  }
  exp.gastos = src.gastos.exists ? src.gastos.data : null;
  exp.entregas = src.entregas.exists ? src.entregas.data : null;
  exp.cm = src.cm.exists && Array.isArray(src.cm.data) ? src.cm.data : [];
  if (src.bonos.exists) {
    const b = src.bonos.data;
    exp.bonos = { ...b, template: b.template || null, weeks: b.weeks || {} };
  } else {
    exp.bonos = { template: null, weeks: {} };
  }
  exp.cal = src.cal.exists && Array.isArray(src.cal.data) ? src.cal.data : [];
  return exp;
}

async function countRows(conn) {
  const out = {};
  for (const t of TABLES) {
    const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number(r.n);
  }
  return out;
}

function docFiles(cat) {
  const dir = path.join(DATA_DIR, "documentos", cat);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function migrate(src, exp) {
  await db.tx(async (conn) => {
    const counts = await countRows(conn);
    const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
    if (nonEmpty.length && !FORCE) {
      throw Object.assign(new Error(
        "Las tablas ya tienen datos (" +
          nonEmpty.map(([t, n]) => `${t}=${n}`).join(", ") +
          "). No se modifico nada. Use --verify-only para comparar, o --force para BORRAR y volver a migrar."
      ), { exitCode: 3 });
    }
    if (FORCE) {
      for (const t of TABLES) await conn.query(`DELETE FROM ${t}`);
      console.log("[migracion] --force: tablas vaciadas");
    }

    if (exp.tm) {
      await store.bulkInsert(conn, "tiempo_muerto", exp.tm.records.map(store.recordRow));
      await store.bulkInsert(conn, "maquinas", exp.tm.machines.map(store.machineRow));
      await store.setSync(conn, "tiempo_muerto", {
        area: exp.tm.area || null,
        actualizado: store.isoToDate(exp.tm.updatedAt) || src.tm.mtime,
        registros: exp.tm.records.length,
        detalle: `${exp.tm.machines.length} maquinas`,
      });
    }
    if (exp.gastos !== null) {
      await store.bulkInsert(conn, "gastos", exp.gastos.map(store.gastoRow));
      await store.setSync(conn, "gastos", { actualizado: src.gastos.mtime, registros: exp.gastos.length, detalle: "migrado de gastos.json" });
    }
    if (exp.entregas !== null) {
      await store.bulkInsert(conn, "entregas", exp.entregas.map(store.entregaRow));
      await store.setSync(conn, "entregas", { actualizado: src.entregas.mtime, registros: exp.entregas.length, detalle: "migrado de entregas.json" });
    }
    for (const cm of exp.cm) await store.writeCm(conn, cm);

    const { weeks, ...bonosMeta } = exp.bonos;
    const bonosTieneDatos = Object.keys(bonosMeta).some((k) => k !== "template") || bonosMeta.template !== null;
    if (bonosTieneDatos) {
      const ruta = fs.existsSync(path.join(DATA_DIR, "template-bonos.xlsx")) ? "template-bonos.xlsx" : null;
      await store.saveBonosPlantilla(bonosMeta, ruta, conn);
    }
    for (const [key, w] of Object.entries(weeks)) {
      if (!w || w.key !== key) throw new Error(`bonos.json: la semana "${key}" no coincide con su campo key`);
      await store.saveBonoSemana(w, conn);
    }
    for (const entry of exp.cal) await store.insertCalendario(entry, conn);
  });

  for (const cat of DOC_CATEGORIAS) await store.syncDocumentos(cat, docFiles(cat));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function firstDiff(a, b, p = "") {
  if (same(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (!same(ka, kb) && !Array.isArray(a)) return `${p || "/"}: claves ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${p}/${k}`);
      if (d) return d;
    }
    if (ka.length !== kb.length) return `${p || "/"}: longitud ${ka.length} vs ${kb.length}`;
  }
  return `${p || "/"}: ${JSON.stringify(a).slice(0, 120)} vs ${JSON.stringify(b).slice(0, 120)}`;
}

async function verify(src, exp) {
  const checks = [];
  const add = (nombre, antes, despues, ok, detalle = "") => checks.push({ nombre, antes, despues, ok, detalle });
  const conn = await db.getPool().getConnection();
  let counts;
  try {
    counts = await countRows(conn);
  } finally {
    conn.release();
  }

  // --- Tiempo muerto ---
  const tm = await store.loadTiempoMuerto();
  if (exp.tm) {
    add("tiempo_muerto (registros)", exp.tm.records.length, counts.tiempo_muerto, exp.tm.records.length === counts.tiempo_muerto);
    add("maquinas", exp.tm.machines.length, counts.maquinas, exp.tm.machines.length === counts.maquinas);
    const d = firstDiff(exp.tm, tm && { updatedAt: tm.updatedAt, area: tm.area, records: tm.records, machines: tm.machines });
    add("tiempo_muerto (contenido exacto)", "tiempo-muerto.json", "API /api/data", !d, d || "");
  } else {
    add("tiempo_muerto", "sin archivo", tm ? "con datos" : "sin datos", !tm);
  }

  // --- Gastos / entregas ---
  for (const [key, fn, table] of [
    ["gastos", store.loadGastos, "gastos"],
    ["entregas", store.loadEntregas, "entregas"],
  ]) {
    const got = await fn();
    const want = exp[key];
    add(`${table} (registros)`, want === null ? "sin archivo" : want.length, counts[table], want === null ? got === null : want.length === counts[table]);
    const d = firstDiff(want, got);
    add(`${table} (contenido exacto)`, `${key}.json`, `API /api/${key}`, !d, d || "");
  }

  // --- Contramedidas ---
  const cms = await store.listContramedidas();
  add("contramedidas (registros)", exp.cm.length, counts.contramedidas, exp.cm.length === counts.contramedidas);
  const nFotos = exp.cm.reduce((n, c) => n + (Array.isArray(c.fotos) ? c.fotos.length : 0), 0);
  add("contramedida_fotos (registros)", nFotos, counts.contramedida_fotos, nFotos === counts.contramedida_fotos);
  let d = firstDiff(exp.cm, cms);
  add("contramedidas (contenido exacto)", "contramedidas.json", "API /api/contramedidas", !d, d || "");
  const faltanFotos = [];
  for (const c of exp.cm) {
    for (const f of Array.isArray(c.fotos) ? c.fotos : []) {
      if (!fs.existsSync(path.join(DATA_DIR, "contramedidas-fotos", c.id, f))) faltanFotos.push(`${c.id}/${f}`);
    }
  }
  add("fotos en disco", nFotos, nFotos - faltanFotos.length, faltanFotos.length === 0, faltanFotos.join(", "));

  // --- Bonos ---
  const bonos = await store.loadBonos();
  const nWeeks = Object.keys(exp.bonos.weeks).length;
  add("bonos_semanas (registros)", nWeeks, counts.bonos_semanas, nWeeks === counts.bonos_semanas);
  d = firstDiff(exp.bonos, bonos);
  add("bonos (contenido exacto)", "bonos.json", "API /api/bonos", !d, d || "");
  if (exp.bonos.template) {
    const ok = fs.existsSync(path.join(DATA_DIR, "template-bonos.xlsx"));
    add("plantilla bonos en disco", "template-bonos.xlsx", ok ? "existe" : "NO existe", ok);
  }

  // --- Calendarios ---
  const cals = await store.listCalendarios();
  add("calendarios (registros)", exp.cal.length, counts.calendarios, exp.cal.length === counts.calendarios);
  d = firstDiff(exp.cal, cals);
  add("calendarios (contenido exacto)", "calendarios.json", "API /api/calendarios", !d, d || "");
  const faltanCal = exp.cal.filter((c) => !fs.existsSync(path.join(DATA_DIR, "calendarios", c.id + ".xlsx"))).map((c) => c.id);
  add("archivos de calendario en disco", exp.cal.length, exp.cal.length - faltanCal.length, faltanCal.length === 0, faltanCal.join(", "));

  // --- Documentos ---
  const nDocs = DOC_CATEGORIAS.reduce((n, c) => n + docFiles(c).length, 0);
  add("documentos (archivos en disco vs filas)", nDocs, counts.documentos, nDocs === counts.documentos);

  return { checks, counts };
}

function printReport(checks) {
  const w = Math.max(...checks.map((c) => c.nombre.length));
  console.log("");
  console.log("Verificacion".padEnd(w) + "  | Antes (JSON)           | Despues (MySQL)        | Resultado");
  console.log("-".repeat(w + 70));
  for (const c of checks) {
    console.log(
      `${c.nombre.padEnd(w)}  | ${String(c.antes).padEnd(22)} | ${String(c.despues).padEnd(22)} | ${c.ok ? "OK" : "ERROR"}${c.detalle ? "  " + c.detalle : ""}`
    );
  }
  console.log("");
}

async function main() {
  console.log(`[migracion] Carpeta de datos: ${DATA_DIR}`);
  const src = loadSources();
  for (const [k, v] of Object.entries(src)) {
    console.log(`[migracion]   ${path.basename(v.file).padEnd(20)} ${v.exists ? "encontrado" : "no existe (se omite)"}`);
  }
  const exp = expectedFrom(src);

  if (!VERIFY_ONLY) {
    await migrate(src, exp);
    console.log("[migracion] Datos insertados.");
  }

  const { checks, counts } = await verify(src, exp);
  printReport(checks);
  const ok = checks.every((c) => c.ok);

  const resumen = { fecha: new Date().toISOString(), dataDir: DATA_DIR, modo: VERIFY_ONLY ? "verify-only" : FORCE ? "force" : "normal", ok, checks, counts };
  const logDir = resolvePath(env("LOG_DIR", "logs"));
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `migracion-${resumen.fecha.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(logFile, JSON.stringify(resumen, null, 2));
  await db.query("INSERT INTO migraciones (ejecutada, origen, resultado, resumen) VALUES (?, ?, ?, ?)", [
    new Date(),
    DATA_DIR,
    ok ? "OK" : "ERROR",
    JSON.stringify(resumen),
  ]);
  console.log(`[migracion] Reporte: ${logFile}`);
  console.log(ok ? "[migracion] RESULTADO: OK - todos los conteos y contenidos coinciden." : "[migracion] RESULTADO: ERROR - revise las filas marcadas.");
  await db.closePool();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[migracion] ERROR:", err.message);
  await db.closePool().catch(() => {});
  process.exit(err.exitCode || 1);
});
