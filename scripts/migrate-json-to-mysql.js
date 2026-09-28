"use strict";

// Migra los datos historicos de data/*.json a MySQL/MariaDB y verifica que no
// se pierda nada. NO es destructiva y se puede ejecutar las veces que sea:
//
//   node scripts/migrate-json-to-mysql.js                 migra lo que falte y verifica
//   node scripts/migrate-json-to-mysql.js --verify-only   solo compara JSON vs MySQL
//   opciones: --data-dir <ruta>
//
// Reglas:
//   * Nunca borra ni actualiza filas existentes (no hay DELETE / DROP / UPDATE).
//   * Datos propios de la app (contramedidas + fotos, bonos, calendarios): se
//     insertan solo si su clave natural no se migro antes (tabla
//     migracion_registros). Asi no se duplica, no se pisa lo editado en la app
//     y no se revive lo que se borro desde la app despues de migrar.
//   * Datos de origen externo (tiempo muerto de koide, gastos y entregas de los
//     Excel): se cargan UNA vez como copia inicial si la fuente nunca se ha
//     sincronizado; despues los actualiza su proceso normal (koide / Python).
//   * Documentos: el disco es la fuente; se sincroniza el indice.
//
// Codigo de salida: 0 = sin perdida de datos, 1 = error o perdida inexplicada.
// Los archivos JSON NO se modifican ni se borran.

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

const CARGA_INICIAL = "__carga_inicial__";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const DATA_DIR = resolvePath(arg("--data-dir") || env("DATA_DIR", "data"));
const VERIFY_ONLY = process.argv.includes("--verify-only");
if (process.argv.includes("--force")) {
  console.error("[migracion] --force ya no existe: la migracion nunca borra datos.");
  process.exit(1);
}

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

// Normaliza igual que el servidor original al leer los JSON.
function expectedFrom(src) {
  const exp = {};
  exp.tm = src.tm.exists
    ? { updatedAt: src.tm.data.updatedAt, area: src.tm.data.area, records: src.tm.data.records || [], machines: src.tm.data.machines || [] }
    : null;
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

function docFiles(cat) {
  const dir = path.join(DATA_DIR, "documentos", cat);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function registrados(conn, dataset) {
  const [rows] = await conn.query("SELECT clave FROM migracion_registros WHERE dataset = ?", [dataset]);
  return new Set(rows.map((r) => r.clave));
}

async function registrar(conn, dataset, clave, origen) {
  await conn.query(
    "INSERT INTO migracion_registros (dataset, clave, origen, migrado_en) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE clave = clave",
    [dataset, String(clave), origen, new Date()]
  );
}

async function existe(conn, table, col, value) {
  const [rows] = await conn.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`, [value]);
  return rows.length > 0;
}

/* ---------- Migracion (solo inserta lo que falta) ---------- */

async function migrate(src, exp) {
  const hechos = [];
  await db.tx(async (conn) => {
    // --- Origen externo: copia inicial una sola vez ---
    const externos = [
      ["tiempo_muerto", "tm", "tiempo-muerto.json"],
      ["gastos", "gastos", "gastos.json"],
      ["entregas", "entregas", "entregas.json"],
    ];
    for (const [fuente, key, archivo] of externos) {
      if (!exp[key]) continue;
      const ya = (await registrados(conn, fuente)).has(CARGA_INICIAL) || (await store.getSync(fuente)) !== null;
      if (ya) {
        await registrar(conn, fuente, CARGA_INICIAL, archivo);
        continue;
      }
      if (fuente === "tiempo_muerto") {
        await store.bulkInsert(conn, "tiempo_muerto", exp.tm.records.map(store.recordRow));
        await store.bulkInsert(conn, "maquinas", exp.tm.machines.map(store.machineRow));
        await store.setSync(conn, "tiempo_muerto", {
          area: exp.tm.area || null,
          actualizado: store.isoToDate(exp.tm.updatedAt) || src.tm.mtime,
          registros: exp.tm.records.length,
          detalle: `${exp.tm.machines.length} maquinas`,
        });
      } else {
        const rowFn = fuente === "gastos" ? store.gastoRow : store.entregaRow;
        await store.bulkInsert(conn, fuente, exp[key].map(rowFn));
        await store.setSync(conn, fuente, { actualizado: src[key].mtime, registros: exp[key].length, detalle: `migrado de ${archivo}` });
      }
      await registrar(conn, fuente, CARGA_INICIAL, archivo);
      hechos.push(`${fuente}: carga inicial`);
    }

    // --- Contramedidas (+ fotos) ---
    let reg = await registrados(conn, "contramedidas");
    for (const cm of exp.cm) {
      if (reg.has(cm.id)) continue;
      if (!(await existe(conn, "contramedidas", "id", cm.id))) {
        await store.writeCm(conn, cm);
        hechos.push(`contramedida ${cm.id}`);
      }
      await registrar(conn, "contramedidas", cm.id, "contramedidas.json");
    }

    // --- Bonos: plantilla + semanas ---
    const { weeks, ...bonosMeta } = exp.bonos;
    const bonosTieneDatos = Object.keys(bonosMeta).some((k) => k !== "template") || bonosMeta.template !== null;
    reg = await registrados(conn, "bonos_plantilla");
    if (bonosTieneDatos && !reg.has("1")) {
      if (!(await existe(conn, "bonos_plantilla", "id", 1))) {
        const ruta = fs.existsSync(path.join(DATA_DIR, "template-bonos.xlsx")) ? "template-bonos.xlsx" : null;
        await store.saveBonosPlantilla(bonosMeta, ruta, conn);
        hechos.push("bonos: plantilla");
      }
      await registrar(conn, "bonos_plantilla", "1", "bonos.json");
    }
    reg = await registrados(conn, "bonos_semanas");
    for (const [key, w] of Object.entries(weeks)) {
      if (!w || w.key !== key) throw new Error(`bonos.json: la semana "${key}" no coincide con su campo key`);
      if (reg.has(key)) continue;
      if (!(await existe(conn, "bonos_semanas", "clave", key))) {
        await store.saveBonoSemana(w, conn);
        hechos.push(`bono ${key}`);
      }
      await registrar(conn, "bonos_semanas", key, "bonos.json");
    }

    // --- Calendarios ---
    reg = await registrados(conn, "calendarios");
    for (const entry of exp.cal) {
      if (reg.has(entry.id)) continue;
      if (!(await existe(conn, "calendarios", "id", entry.id))) {
        await store.insertCalendario(entry, conn);
        hechos.push(`calendario ${entry.id}`);
      }
      await registrar(conn, "calendarios", entry.id, "calendarios.json");
    }
  });

  // Documentos: el disco es la fuente (sincronizacion idempotente del indice).
  for (const cat of DOC_CATEGORIAS) await store.syncDocumentos(cat, docFiles(cat));
  return hechos;
}

/* ---------- Verificacion ---------- */

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

async function countRows(table) {
  return Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
}

async function verify(src, exp) {
  const checks = [];
  // estado: OK | INFO (diferencia explicada) | ERROR (perdida o dato distinto sin explicacion)
  const add = (dataset, fuente, destino, original, migrado, estado, detalle = "") =>
    checks.push({ dataset, fuente, destino, original, migrado, diferencia: typeof original === "number" && typeof migrado === "number" ? migrado - original : "", estado, detalle });

  const regDe = async (ds) => {
    const rows = await db.query("SELECT clave FROM migracion_registros WHERE dataset = ?", [ds]);
    return new Set(rows.map((r) => r.clave));
  };

  // --- Origen externo ---
  const tm = await store.loadTiempoMuerto();
  if (exp.tm) {
    const nTm = await countRows("tiempo_muerto");
    const nMaq = await countRows("maquinas");
    const d = tm && firstDiff(exp.tm, { updatedAt: tm.updatedAt, area: tm.area, records: tm.records, machines: tm.machines });
    if (tm && !d) {
      add("Tiempo muerto (paros koide)", "tiempo-muerto.json", "tiempo_muerto", exp.tm.records.length, nTm, "OK", "contenido exacto");
      add("Maquinas (catalogo koide)", "tiempo-muerto.json", "maquinas", exp.tm.machines.length, nMaq, "OK", "contenido exacto");
    } else if (tm && tm.updatedAt > exp.tm.updatedAt) {
      add("Tiempo muerto (paros koide)", "tiempo-muerto.json", "tiempo_muerto", exp.tm.records.length, nTm, "INFO", `ORIGEN EXTERNO: resincronizado desde koide el ${tm.updatedAt}`);
      add("Maquinas (catalogo koide)", "tiempo-muerto.json", "maquinas", exp.tm.machines.length, nMaq, "INFO", "ORIGEN EXTERNO: resincronizado desde koide");
    } else {
      add("Tiempo muerto (paros koide)", "tiempo-muerto.json", "tiempo_muerto", exp.tm.records.length, nTm, "ERROR", d || "sin datos");
    }
  }
  for (const [key, fn, table, archivo] of [
    ["gastos", store.loadGastos, "gastos", "gastos.json"],
    ["entregas", store.loadEntregas, "entregas", "entregas.json"],
  ]) {
    if (exp[key] === null) continue;
    const got = await fn();
    const n = await countRows(table);
    const d = firstDiff(exp[key], got);
    const sync = await store.getSync(table);
    if (!d) add(key === "gastos" ? "Gastos (Excel requisiciones)" : "Entregas (Excel tiempos de entrega)", archivo, table, exp[key].length, n, "OK", "contenido exacto");
    else if (sync && !String(sync.detalle || "").startsWith("migrado de"))
      add(key === "gastos" ? "Gastos (Excel requisiciones)" : "Entregas (Excel tiempos de entrega)", archivo, table, exp[key].length, n, "INFO", `ORIGEN EXTERNO: re-extraido del Excel el ${sync.actualizado.toISOString()}`);
    else add(key, archivo, table, exp[key].length, n, "ERROR", d);
  }

  // --- Contramedidas ---
  {
    const reg = await regDe("contramedidas");
    let ok = 0, editadas = 0, borradas = 0, perdidas = [], nFotos = 0, fotosOk = 0;
    const faltanFotos = [];
    for (const c of exp.cm) {
      const actual = await store.getContramedida(c.id);
      const fotos = Array.isArray(c.fotos) ? c.fotos : [];
      nFotos += fotos.length;
      for (const f of fotos) {
        if (!fs.existsSync(path.join(DATA_DIR, "contramedidas-fotos", c.id, f))) faltanFotos.push(`${c.id}/${f}`);
      }
      if (!actual) {
        if (reg.has(c.id)) borradas++;
        else perdidas.push(c.id);
        continue;
      }
      if (same(actual, c)) {
        ok++;
        fotosOk += fotos.length;
      } else {
        editadas++;
        fotosOk += fotos.filter((f) => (actual.fotos || []).includes(f)).length;
      }
    }
    const det = [];
    if (editadas) det.push(`${editadas} modificadas despues en la app`);
    if (borradas) det.push(`${borradas} borradas despues en la app`);
    if (perdidas.length) det.push(`PERDIDAS: ${perdidas.join(", ")}`);
    add("Contramedidas", "contramedidas.json", "contramedidas", exp.cm.length, ok + editadas, perdidas.length ? "ERROR" : det.length ? "INFO" : "OK", det.join("; "));
    add("Fotos de contramedidas", "contramedidas-fotos/", "contramedida_fotos", nFotos, fotosOk, perdidas.length ? "ERROR" : fotosOk === nFotos ? "OK" : "INFO", fotosOk === nFotos ? "" : "cambios hechos en la app");
    add("Fotos en disco", "contramedidas-fotos/", "disco", nFotos, nFotos - faltanFotos.length, faltanFotos.length ? "ERROR" : "OK", faltanFotos.join(", "));
  }

  // --- Bonos ---
  {
    const bonos = await store.loadBonos();
    const { weeks: expWeeks, ...expMeta } = exp.bonos;
    const { weeks: gotWeeks, ...gotMeta } = bonos;
    if (expMeta.template !== null || Object.keys(expMeta).length > 1) {
      const d = firstDiff(expMeta, gotMeta);
      add("Bonos: plantilla", "bonos.json + template-bonos.xlsx", "bonos_plantilla", 1, gotMeta.template ? 1 : 0, d ? ((await regDe("bonos_plantilla")).has("1") ? "INFO" : "ERROR") : "OK", d ? `reemplazada despues en la app (${d})` : "contenido exacto");
      const okXlsx = fs.existsSync(path.join(DATA_DIR, "template-bonos.xlsx"));
      add("Bonos: archivo de plantilla", "template-bonos.xlsx", "disco", 1, okXlsx ? 1 : 0, okXlsx ? "OK" : "ERROR");
    }
    const reg = await regDe("bonos_semanas");
    let ok = 0, editadas = 0, borradas = 0;
    const perdidas = [];
    for (const [k, w] of Object.entries(expWeeks)) {
      const g = gotWeeks[k];
      if (!g) (reg.has(k) ? borradas++ : perdidas.push(k));
      else if (same(g, w)) ok++;
      else editadas++;
    }
    const det = [];
    if (editadas) det.push(`${editadas} re-guardadas despues en la app`);
    if (borradas) det.push(`${borradas} borradas despues en la app`);
    if (perdidas.length) det.push(`PERDIDAS: ${perdidas.join(", ")}`);
    add("Bonos: semanas", "bonos.json", "bonos_semanas", Object.keys(expWeeks).length, ok + editadas, perdidas.length ? "ERROR" : det.length ? "INFO" : "OK", det.join("; "));
  }

  // --- Calendarios ---
  {
    const reg = await regDe("calendarios");
    let ok = 0, editados = 0;
    const perdidos = [];
    let borrados = 0;
    for (const c of exp.cal) {
      const g = await store.getCalendario(c.id);
      if (!g) (reg.has(c.id) ? borrados++ : perdidos.push(c.id));
      else if (same(g, c)) ok++;
      else editados++;
    }
    add("Calendarios (registrados en la app)", "calendarios.json", "calendarios", exp.cal.length, ok + editados, perdidos.length ? "ERROR" : "OK", perdidos.length ? `PERDIDOS: ${perdidos.join(", ")}` : "");
    const faltan = exp.cal.filter((c) => !fs.existsSync(path.join(DATA_DIR, "calendarios", c.id + ".xlsx"))).map((c) => c.id);
    add("Calendarios: archivos .xlsx", "calendarios/<id>.xlsx", "disco", exp.cal.length, exp.cal.length - faltan.length, faltan.length ? "ERROR" : "OK", faltan.join(", "));
    // Excel presentes en la carpeta que la app nunca registro (no se tocan).
    const registrados = new Set(exp.cal.map((c) => c.id + ".xlsx"));
    const sueltos = fs.existsSync(path.join(DATA_DIR, "calendarios"))
      ? fs.readdirSync(path.join(DATA_DIR, "calendarios")).filter((f) => /\.xlsx?$/i.test(f) && !registrados.has(f))
      : [];
    if (sueltos.length) {
      add("Calendarios: Excel sin registrar", "data/calendarios/", "(se conservan en disco)", sueltos.length, 0, "VERIFICAR", "REQUIERE VERIFICACION: nunca se cargaron en la app; subirlos desde Calendarios si deben usarse");
    }
  }

  // --- Documentos ---
  const nDocs = DOC_CATEGORIAS.reduce((n, c) => n + docFiles(c).length, 0);
  const nDocRows = await countRows("documentos");
  add("Documentos", "data/documentos/", "documentos", nDocs, nDocRows, nDocs === nDocRows ? "OK" : "ERROR");

  const counts = {};
  for (const t of (await db.query("SHOW TABLES")).map((r) => Object.values(r)[0])) counts[t] = await countRows(t);
  return { checks, counts };
}

function printReport(checks) {
  const cols = ["dataset", "fuente", "destino", "original", "migrado", "diferencia", "estado"];
  const heads = ["Dataset", "Fuente", "Destino", "Original", "MySQL", "Dif.", "Estado"];
  const w = cols.map((c, i) => Math.max(heads[i].length, ...checks.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join(" | ");
  console.log("");
  console.log(line(heads));
  console.log(w.map((n) => "-".repeat(n)).join("-+-"));
  for (const c of checks) console.log(line(cols.map((k) => c[k])) + (c.detalle ? "  " + c.detalle : ""));
  console.log("");
}

async function main() {
  console.log(`[migracion] Carpeta de datos: ${DATA_DIR}`);
  const src = loadSources();
  for (const v of Object.values(src)) {
    console.log(`[migracion]   ${path.basename(v.file).padEnd(20)} ${v.exists ? "encontrado" : "no existe (se omite)"}`);
  }
  const exp = expectedFrom(src);

  // Asegura que existan las tablas (incluida la bitacora de migracion).
  const conn = await db.getPool().getConnection();
  try {
    await db.applyMigrations(conn, { log: console.log });
  } finally {
    conn.release();
  }

  let hechos = [];
  if (!VERIFY_ONLY) {
    hechos = await migrate(src, exp);
    console.log(hechos.length ? `[migracion] Insertados: ${hechos.length} conjuntos/registros nuevos.` : "[migracion] Nada nuevo que migrar (ya estaba migrado).");
  }

  const { checks, counts } = await verify(src, exp);
  printReport(checks);
  const ok = checks.every((c) => c.estado !== "ERROR");

  const resumen = { fecha: new Date().toISOString(), dataDir: DATA_DIR, modo: VERIFY_ONLY ? "verify-only" : "normal", ok, insertados: hechos, checks, counts };
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
  console.log(ok ? "[migracion] RESULTADO: OK - no hay perdida de datos." : "[migracion] RESULTADO: ERROR - revise las filas marcadas ERROR.");
  await db.closePool();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[migracion] ERROR:", err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
