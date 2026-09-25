"use strict";

// Importa los datos legacy validados (data/*.json) a MariaDB 10.4 aplicando las
// decisiones aprobadas y registra la trazabilidad en las tablas legacy_*.
//
//   node scripts/importar-legacy-mariadb.js --verificar   SOLO LECTURA: valida archivos, manifiesto y base; no escribe nada
//   node scripts/importar-legacy-mariadb.js --ensayo      importa y verifica dentro de una transaccion y SIEMPRE hace ROLLBACK
//   node scripts/importar-legacy-mariadb.js --ejecutar    importa y verifica; COMMIT solo si todas las verificaciones pasan
//   opciones: --data-dir <ruta>  (por defecto DATA_DIR de .env o data/)
//
// Decisiones aplicadas (docs/migracion-legacy/manifiesto-legacy.json):
//   * bonos 2026-W37: NO se inserta en bonos_semanas; se conserva en legacy_registros como "excluido".
//   * R13 heredado de plantilla: se migra tal cual en celdas y se marca en legacy_marcas.
//   * 6 calendarios no registrados: solo en legacy_archivos (historico_pendiente_validacion); calendarios queda vacia.
//   * Anomalias (KOIDE, gastos, entregas, contramedidas, bonos): se migran sin corregir y se listan en legacy_anomalias.
//   * Reglas de negocio (MTBF 22 h, bono >= 90): viven en el codigo/config; este script no las toca.
//
// Garantias:
//   * Los archivos de data/ solo se leen.
//   * Solo INSERT, y solo sobre tablas vacias (se verifica antes). No hay UPDATE ni DELETE.
//     (setSync / saveBonosPlantilla / saveBonoSemana de lib/store.js usan INSERT ... ON DUPLICATE
//     KEY UPDATE; con las tablas vacias equivalen a un INSERT.)
//   * Todo en una sola transaccion. Cualquier error o verificacion fallida -> ROLLBACK.
//   * Sesion con sql_mode estricto (sin truncamientos silenciosos) y UTC. No cambia la configuracion de MariaDB/XAMPP.
//   * La verificacion lee con las mismas funciones que usa la API (lib/store.js), dentro de la transaccion.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEnvFile, env, resolvePath, ROOT } = require("../lib/env");

loadEnvFile();

// lib/store.js toma "query" de lib/db.js al cargarse. Se envuelve ANTES de
// cargar store.js para que sus lecturas usen la conexion de la transaccion y
// vean los datos aun no confirmados. No se modifica ningun archivo del proyecto.
const db = require("../lib/db");
const poolQuery = db.query;
let txConn = null;
db.query = async (sql, params) => {
  if (txConn) {
    const [rows] = await txConn.query(sql, params);
    return rows;
  }
  return poolQuery(sql, params);
};
const store = require("../lib/store");

/* ---------- Configuracion ---------- */

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const MODOS = ["--verificar", "--ensayo", "--ejecutar"].filter((m) => process.argv.includes(m));
const DATA_DIR = resolvePath(arg("--data-dir") || env("DATA_DIR", "data"));
const MANIFEST_FILE = path.join(ROOT, "docs", "migracion-legacy", "manifiesto-legacy.json");
const MIG_DIR = path.join(ROOT, "db", "migrations", "mariadb");
const LOG_DIR = resolvePath(env("LOG_DIR", "logs"));
const STRICT_SQL_MODE =
  "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const MIGRACIONES_REQUERIDAS = ["0000", "0001", "0002"];
const SEMANA_EXCLUIDA = "2026-W37";
const BONOS_XLSX_RUTA = "template-bonos.xlsx";
const DOC_CATEGORIAS = [
  "Dibujos",
  "Lay out de planta",
  "Plan de mantenimiento mayor",
  "Indicadores 2026",
  "Check list",
  "Instrucciones de trabajo",
];
const TABLAS_DESTINO = [
  "fuentes_sync", "maquinas", "tiempo_muerto", "gastos", "entregas", "contramedidas",
  "contramedida_fotos", "bonos_plantilla", "bonos_semanas", "calendarios", "documentos",
  "legacy_lotes", "legacy_archivos", "legacy_registros", "legacy_marcas", "legacy_anomalias",
  "diccionario_datos",
];

const checks = [];
function check(nombre, ok, detalle = "") {
  checks.push({ nombre, ok: Boolean(ok), detalle: String(detalle || "") });
  console.log(`${ok ? "OK   " : "FALLA"} | ${nombre}${detalle ? "  " + detalle : ""}`);
  return ok;
}
function fail(msg) {
  throw Object.assign(new Error(msg), { controlled: true });
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function firstDiff(a, b, p = "") {
  if (same(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (!Array.isArray(a) && !same(ka, kb)) return `${p || "/"}: claves ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
    if (ka.length !== kb.length) return `${p || "/"}: longitud ${ka.length} vs ${kb.length}`;
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${p}/${k}`);
      if (d) return d;
    }
  }
  return `${p || "/"}: ${JSON.stringify(a).slice(0, 120)} vs ${JSON.stringify(b).slice(0, 120)}`;
}

/* ---------- 1. Fuentes y premisas (solo lectura, sin base de datos) ---------- */

function leerFuentes() {
  if (!fs.existsSync(MANIFEST_FILE)) fail(`No existe el manifiesto ${MANIFEST_FILE}`);
  const manifiestoRaw = fs.readFileSync(MANIFEST_FILE);
  const manifiesto = JSON.parse(manifiestoRaw.toString("utf8"));

  const leer = (f) => {
    const file = path.join(DATA_DIR, f);
    if (!fs.existsSync(file)) fail(`Falta ${file}`);
    const buf = fs.readFileSync(file);
    return { file, buf, sha: sha256(buf), data: JSON.parse(buf.toString("utf8")), mtime: fs.statSync(file).mtime };
  };
  const src = {
    tm: leer("tiempo-muerto.json"),
    gastos: leer("gastos.json"),
    entregas: leer("entregas.json"),
    cm: leer("contramedidas.json"),
    bonos: leer("bonos.json"),
    cal: leer("calendarios.json"),
  };
  return { manifiesto, manifiestoSha: sha256(manifiestoRaw), src };
}

function validarPremisas({ manifiesto, src }) {
  console.log("\n--- Premisas (archivos y manifiesto) ---");
  // Integridad: cada archivo de data/ coincide con el checksum validado (legacy o copia del proyecto nuevo).
  let archivosOk = 0;
  for (const a of manifiesto.archivos) {
    const file = path.join(DATA_DIR, a.ruta.replace(/^data\//, ""));
    if (!fs.existsSync(file)) {
      check(`archivo presente: ${a.ruta}`, false, "no existe en " + DATA_DIR);
      continue;
    }
    const s = sha256(fs.readFileSync(file));
    if (s === a.sha256_legacy || s === a.sha256_nuevo) archivosOk++;
    else check(`checksum de ${a.ruta}`, false, "el archivo cambio desde la validacion");
  }
  check("archivos de data/ identicos a la validacion (SHA-256)", archivosOk === manifiesto.archivos.length, `${archivosOk}/${manifiesto.archivos.length}`);

  const c = manifiesto.conteos_origen;
  const tm = src.tm.data;
  const b = src.bonos.data;
  const weeks = Object.keys(b.weeks || {});
  const fotos = src.cm.data.reduce((n, x) => n + (Array.isArray(x.fotos) ? x.fotos.length : 0), 0);
  check("conteo paros", tm.records.length === c.tiempo_muerto_registros, tm.records.length);
  check("conteo maquinas", tm.machines.length === c.maquinas, tm.machines.length);
  check("conteo gastos", src.gastos.data.length === c.gastos, src.gastos.data.length);
  check("conteo entregas", src.entregas.data.length === c.entregas, src.entregas.data.length);
  check("conteo contramedidas", src.cm.data.length === c.contramedidas, src.cm.data.length);
  check("conteo fotos de contramedidas", fotos === c.contramedida_fotos, fotos);
  check("plantilla de bonos presente", Boolean(b.template) && c.bonos_plantillas === 1);
  check("semanas de bonos en archivo", weeks.length === c.bonos_semanas_en_archivo, weeks.join(", "));
  check("calendarios.json vacio", Array.isArray(src.cal.data) && src.cal.data.length === c.calendarios_registrados);

  // W37: existe y sigue vacia (premisa de la decision de excluirla).
  const w37 = b.weeks[SEMANA_EXCLUIDA];
  const exclusion = manifiesto.decisiones_aprobadas.exclusiones.find((e) => e.ruta.includes(SEMANA_EXCLUIDA));
  check(`${SEMANA_EXCLUIDA} existe y su key coincide`, w37 && w37.key === SEMANA_EXCLUIDA);
  check(`${SEMANA_EXCLUIDA} registrada como exclusion en el manifiesto`, Boolean(exclusion));
  if (w37) {
    // Celdas de resultados segun config.json -> bonos.secciones (filas x columnas resultado/nivel/monto/calificacion/razon).
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    const celdasResultado = [];
    for (const sec of (cfg.bonos && cfg.bonos.secciones) || []) {
      for (const fila of sec.filas || []) {
        for (const k of ["resultado", "nivel", "monto", "calificacion", "razon"]) {
          if (sec.cols && sec.cols[k]) celdasResultado.push(sec.cols[k] + fila);
        }
      }
    }
    const capturadas = celdasResultado.filter((addr) => addr !== "R13" && String((w37.cells || {})[addr] ?? "") !== "");
    check(
      `${SEMANA_EXCLUIDA} sin resultados capturados (${celdasResultado.length} celdas de resultado vacias, salvo R13)`,
      celdasResultado.length > 0 && capturadas.length === 0,
      capturadas.join(",")
    );
  }

  // R13 heredado de plantilla.
  const marca = manifiesto.decisiones_aprobadas.marcas.find((m) => m.celda === "R13");
  check("marca R13 en el manifiesto", Boolean(marca));
  if (marca) {
    const conValor = weeks.filter((k) => k !== SEMANA_EXCLUIDA && b.weeks[k].cells && b.weeks[k].cells.R13 === marca.valor);
    check("R13 identico en las semanas marcadas", same([...conValor].sort(), [...marca.semanas].sort()), conValor.join(", "));
    check("R13 igual al texto de la plantilla", b.template.cells.R13 && b.template.cells.R13.w === marca.valor);
  }

  // Calendarios historicos: presentes y sin registrar.
  const cal = manifiesto.decisiones_aprobadas.calendarios_no_registrados.archivos;
  let calOk = 0;
  for (const f of cal) {
    const file = path.join(DATA_DIR, f.ruta.replace(/^data\//, ""));
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === f.sha256) calOk++;
  }
  check("calendarios historicos presentes e identicos", calOk === cal.length && cal.length === c.calendarios_archivos_no_registrados, `${calOk}/${cal.length}`);

  // Fotos referenciadas y documentos.
  const faltan = [];
  for (const x of src.cm.data) for (const f of x.fotos || []) if (!fs.existsSync(path.join(DATA_DIR, "contramedidas-fotos", x.id, f))) faltan.push(`${x.id}/${f}`);
  check("fotos referenciadas existen en disco", faltan.length === 0, faltan.join(", "));
  const docs = DOC_CATEGORIAS.reduce((n, cat) => {
    const dir = path.join(DATA_DIR, "documentos", cat);
    return n + (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  }, 0);
  check("documentos en disco (se esperan 0)", docs === c.documentos_archivos, docs);
  check("plantilla de bonos (xlsx) en disco", fs.existsSync(path.join(DATA_DIR, BONOS_XLSX_RUTA)));
}

/* ---------- 2. Base de datos (solo lectura) ---------- */

function checksumMigracion(file) {
  const sql = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return sha256(Buffer.from(sql, "utf8"));
}

async function prepararSesion(conn) {
  await conn.query(`SET SESSION sql_mode = '${STRICT_SQL_MODE}'`);
  await conn.query("SET SESSION time_zone = '+00:00'");
}

async function validarBase(conn, manifiestoSha) {
  console.log("\n--- Base de datos (solo lectura) ---");
  const [[v]] = await conn.query("SELECT @@version AS version, @@version_comment AS comentario, @@max_allowed_packet AS map, DATABASE() AS bd");
  check("servidor MariaDB", /mariadb/i.test(`${v.version} ${v.comentario}`), `${v.version} / base ${v.bd}`);
  check("max_allowed_packet >= 1 MB", Number(v.map) >= 1048576, v.map);

  const [tablas] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  const nombres = new Set(tablas.map((r) => r.t));
  const faltan = TABLAS_DESTINO.concat("schema_migrations").filter((t) => !nombres.has(t));
  if (!check("tablas del esquema presentes", faltan.length === 0, faltan.join(", "))) return false;

  const [aplicadas] = await conn.query("SELECT version, checksum_sha256 FROM schema_migrations");
  const porVersion = new Map(aplicadas.map((r) => [r.version, r.checksum_sha256]));
  for (const ver of MIGRACIONES_REQUERIDAS) {
    const file = fs.readdirSync(MIG_DIR).find((f) => f.startsWith(ver + "_"));
    const ok = file && porVersion.get(ver) === checksumMigracion(path.join(MIG_DIR, file));
    check(`migracion ${ver} aplicada y sin cambios`, ok, file || "archivo no encontrado");
  }
  for (const t of ["gastos", "entregas"]) {
    const [[col]] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'huella_identidad'",
      [t]
    );
    check(`${t}.huella_identidad existe`, col.n === 1);
  }

  const noVacias = [];
  for (const t of TABLAS_DESTINO) {
    const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    if (Number(r.n) > 0) noVacias.push(`${t}=${r.n}`);
  }
  check("tablas destino vacias (evita duplicados)", noVacias.length === 0, noVacias.join(", "));
  const [[lote]] = await conn.query("SELECT COUNT(*) AS n FROM legacy_lotes WHERE manifiesto_sha256 = ? AND resultado = 'ok'", [manifiestoSha]);
  check("este manifiesto no se importo antes", Number(lote.n) === 0);
  return checks.every((c) => c.ok);
}

/* ---------- 3. Construccion de filas ---------- */

async function insertMany(conn, table, rows, maxBytes = 400 * 1024) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  let lote = [];
  let bytes = 0;
  const flush = async () => {
    if (!lote.length) return;
    await conn.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ?`, [lote.map((r) => cols.map((c) => r[c]))]);
    lote = [];
    bytes = 0;
  };
  for (const r of rows) {
    const size = cols.reduce((s, c) => s + (r[c] == null ? 4 : Buffer.byteLength(String(r[c]))) + 8, 0);
    if (lote.length && bytes + size > maxBytes) await flush();
    lote.push(r);
    bytes += size;
  }
  await flush();
}

function tipoArchivo(ruta) {
  if (/\.json$/i.test(ruta)) return "json";
  if (/\.xlsx?$/i.test(ruta)) return "excel";
  if (/\.(png|jpe?g)$/i.test(ruta)) return "imagen";
  if (/\.log$/i.test(ruta)) return "log";
  return "otro";
}

function gruposExactos(arr) {
  const m = new Map();
  arr.forEach((r, i) => {
    const k = JSON.stringify(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  });
  return [...m.values()].filter((v) => v.length > 1);
}

function diccionario() {
  const d = [];
  const add = (tabla, origen, campos, descripcion = null) => campos.forEach((c) => d.push({ tabla, campo: c, origen, descripcion }));
  add("tiempo_muerto", "original_koide", ["id", "record_date", "shift", "group_name", "machine_id", "machine_code", "operator_employee_number", "operator_name", "downtime_start", "downtime_end", "responsible_area", "downtime_category", "problem_description", "responsible_person", "action_taken", "status", "external_minutes", "created_at", "updated_at"], "Dato de KOIDE (columna tipada copiada de payload)");
  add("tiempo_muerto", "calculado_koide", ["downtime_minutes"], "Fin menos inicio del paro, calculado por KOIDE");
  add("tiempo_muerto", "calculado_koide", ["response_time_minutes"], "Inicio de reparacion menos inicio del paro, calculado por KOIDE");
  add("tiempo_muerto", "calculado_koide", ["repair_time_minutes"], "Fin menos inicio de reparacion menos external_minutes, calculado por KOIDE");
  add("tiempo_muerto", "original_koide", ["payload"], "JSON exacto del registro de KOIDE (37 campos)");
  add("tiempo_muerto", "original_koide", ["payload.repair_started_by_employee_number", "payload.closed_by_employee_number"], "Numero de empleado; contiene texto libre en origen (TM-1), no se corrige");
  add("tiempo_muerto", "metadato_migracion", ["orden"], "Posicion en el arreglo original");
  add("maquinas", "original_koide", ["id", "code", "name", "process", "active", "target_pcs_per_hour", "created_at", "updated_at", "payload"]);
  add("maquinas", "original_koide", ["effective_hours_per_day"], "21.6 en KOIDE; el MTBF legacy usa 22 h/dia y no este valor");
  add("maquinas", "metadato_migracion", ["orden"]);
  add("gastos", "original_excel", ["sheet", "cotizacion", "proveedor", "producto", "observaciones", "cantidad", "unidad", "precio_unitario", "importe", "iva", "total_partida", "po", "fecha_elaboracion", "fecha_entrega", "moneda", "proyecto", "termino_pago", "comentario", "payload"]);
  add("gastos", "calculado_script", ["tiene_po", "entregado", "payload.entregado_meses"], "Calculado por scripts/extract_v4.py");
  add("gastos", "calculado_script", ["mes_entrega"], "Indice del mes de la hoja del Excel (0-11), no el mes de entrega");
  add("gastos", "metadato_migracion", ["orden"], "Posicion en gastos.json: identidad legacy");
  add("gastos", "metadato_migracion", ["huella_identidad"], "SHA-256 de campos originales no mutables; generado por MariaDB");
  add("entregas", "original_excel", ["proveedor", "material", "cantidad", "depto", "serie", "po", "fecha_envio", "fecha_estimada", "dias", "estatus", "observaciones", "payload"]);
  add("entregas", "calculado_script", ["mes"], "Mes de fecha_envio, calculado por scripts/extract_entregas.py");
  add("entregas", "metadato_migracion", ["orden"], "Posicion en entregas.json: identidad legacy");
  add("entregas", "metadato_migracion", ["huella_identidad"], "SHA-256 de campos originales no mutables; generado por MariaDB");
  add("contramedidas", "calculado_app", ["id", "creada", "referencia"], "Generado por el servidor");
  add("contramedidas", "captura_usuario", ["tipo", "maquina", "categoria", "descripcion", "responsable", "fecha_limite", "estado", "trabajo_realizado"]);
  add("contramedidas", "calculado_app", ["maquina_nombre"], "Copia del catalogo de maquinas al crear");
  add("contramedidas", "calculado_app", ["falla_comun"], "Falla mas frecuente al momento de crear; valor congelado");
  add("contramedidas", "metadato_migracion", ["orden", "extra"]);
  add("contramedida_fotos", "calculado_app", ["nombre", "ruta"], "Nombre asignado por el servidor (pierde etiqueta antes/despues)");
  add("contramedida_fotos", "metadato_migracion", ["creada", "orden"], "Fecha de migracion; el legacy no guardaba la fecha de la foto");
  add("bonos_plantilla", "original_excel", ["hoja", "plantilla"], "Parseado de template-bonos.xlsx; incluye datos de la semana 32");
  add("bonos_plantilla", "calculado_app", ["actualizado"]);
  add("bonos_semanas", "calculado_app", ["clave", "semana", "periodo_ini", "periodo_fin", "fecha", "guardado", "celdas.D9", "celdas.N9", "celdas.P9", "celdas.D7"]);
  add("bonos_semanas", "calculado_app", ["celdas.N", "celdas.H", "celdas.J", "celdas.P"], "Resultado %, nivel, monto y calificacion calculados del indice; editables antes de guardar");
  add("bonos_semanas", "captura_usuario", ["celdas.R"], "Razon de NG");
  add("bonos_semanas", "heredado_de_plantilla", ["celdas.R13"], "Texto de la plantilla copiado a cada semana (ver legacy_marcas)");
  add("calendarios", "original_excel", ["hojas"]);
  add("calendarios", "captura_usuario", ["estado"], "Realizado/Reprogramado/Pendiente por celda");
  return d;
}

/* ---------- 4. Importacion ---------- */

async function importar(conn, { manifiesto, manifiestoSha, src }) {
  const tm = src.tm.data;
  const b = src.bonos.data;
  const decisiones = manifiesto.decisiones_aprobadas;
  const exclusion = decisiones.exclusiones.find((e) => e.ruta.includes(SEMANA_EXCLUIDA));
  const marcaR13 = decisiones.marcas.find((m) => m.celda === "R13");
  const semanas = Object.keys(b.weeks).filter((k) => k !== SEMANA_EXCLUIDA);
  const now = new Date();

  // Lote. Se inserta directamente como "ok": si algo falla, el ROLLBACK lo elimina junto con todo lo demas.
  const plan = {
    decisiones: { excluida: SEMANA_EXCLUIDA, marca: "R13 heredado_de_plantilla", calendarios: "historico_pendiente_validacion" },
    esperado: {
      tiempo_muerto: tm.records.length, maquinas: tm.machines.length, gastos: src.gastos.data.length,
      entregas: src.entregas.data.length, contramedidas: src.cm.data.length, bonos_semanas: semanas.length,
    },
  };
  const [ins] = await conn.query(
    "INSERT INTO legacy_lotes (ejecutado, origen, manifiesto_sha256, resultado, resumen) VALUES (?, ?, ?, 'ok', ?)",
    [now, DATA_DIR, manifiestoSha, JSON.stringify(plan)]
  );
  const loteId = ins.insertId;

  // --- Tablas operativas (mismo mapeo que la aplicacion) ---
  await store.bulkInsert(conn, "tiempo_muerto", tm.records.map(store.recordRow));
  await store.bulkInsert(conn, "maquinas", tm.machines.map(store.machineRow));
  await store.setSync(conn, "tiempo_muerto", {
    area: tm.area || null,
    actualizado: store.isoToDate(tm.updatedAt) || src.tm.mtime,
    registros: tm.records.length,
    detalle: `${tm.machines.length} maquinas`,
  });
  await store.bulkInsert(conn, "gastos", src.gastos.data.map(store.gastoRow));
  await store.setSync(conn, "gastos", { actualizado: src.gastos.mtime, registros: src.gastos.data.length, detalle: `migrado de gastos.json (lote ${loteId})` });
  await store.bulkInsert(conn, "entregas", src.entregas.data.map(store.entregaRow));
  await store.setSync(conn, "entregas", { actualizado: src.entregas.mtime, registros: src.entregas.data.length, detalle: `migrado de entregas.json (lote ${loteId})` });
  for (const cm of src.cm.data) await store.writeCm(conn, cm);
  const { weeks, ...bonosMeta } = b;
  await store.saveBonosPlantilla({ ...bonosMeta, template: b.template || null }, BONOS_XLSX_RUTA, conn);
  for (const key of semanas) {
    if (weeks[key].key !== key) fail(`bonos.json: la semana "${key}" no coincide con su campo key`);
    await store.saveBonoSemana(weeks[key], conn);
  }
  // calendarios: no se inserta nada (calendarios.json vacio; los 6 archivos quedan como historicos).

  // --- Huellas de gastos / entregas (generadas por MariaDB) ---
  const huellas = {};
  for (const t of ["gastos", "entregas"]) {
    const [rows] = await conn.query(
      `SELECT orden, huella_identidad, ROW_NUMBER() OVER (PARTITION BY huella_identidad ORDER BY orden) AS ocurrencia FROM ${t}`
    );
    huellas[t] = new Map(rows.map((r) => [Number(r.orden), { h: r.huella_identidad, o: Number(r.ocurrencia) }]));
  }

  // --- legacy_registros: foto historica exacta ---
  const reg = [];
  const push = (fuente, clave, orden, obj, extra = {}) => {
    const payload = JSON.stringify(obj);
    reg.push({
      lote_id: loteId, fuente, clave_legacy: String(clave), orden, payload,
      payload_sha256: sha256(Buffer.from(payload, "utf8")),
      huella_identidad: extra.h || null, ocurrencia: extra.o || null,
      estado_migracion: extra.estado || "migrado", motivo: extra.motivo || null,
    });
  };
  const tmMeta = Object.fromEntries(Object.entries(tm).filter(([k]) => k !== "records" && k !== "machines"));
  push("tiempo_muerto_meta", "meta", 0, tmMeta);
  tm.records.forEach((r, i) => push("tiempo_muerto", r.id, i, r));
  tm.machines.forEach((m, i) => push("maquinas", m.id, i, m));
  src.gastos.data.forEach((g, i) => push("gastos", i, i, g, huellas.gastos.get(i)));
  src.entregas.data.forEach((e, i) => push("entregas", i, i, e, huellas.entregas.get(i)));
  src.cm.data.forEach((c, i) => push("contramedidas", c.id, i, c));
  push("bonos_plantilla", "plantilla", 0, bonosMeta);
  Object.keys(weeks).forEach((k, i) =>
    push("bonos_semanas", k, i, weeks[k], k === SEMANA_EXCLUIDA ? { estado: "excluido", motivo: exclusion.motivo } : {})
  );
  await insertMany(conn, "legacy_registros", reg);

  // --- legacy_archivos ---
  const archivos = manifiesto.archivos.map((a) => {
    const esCal = a.ruta.startsWith("data/calendarios/");
    let nota = null;
    if (esCal) nota = "No registrado en calendarios.json. No activo. Pendiente de validacion.";
    else if (a.estado === "mismo_contenido_difiere_fin_de_linea") nota = `En el proyecto nuevo difiere solo en fin de linea (CRLF). SHA-256 nuevo: ${a.sha256_nuevo}`;
    return {
      lote_id: loteId, ruta: a.ruta, bytes: a.bytes, sha256: a.sha256_legacy, tipo: tipoArchivo(a.ruta),
      estado: esCal ? "historico_pendiente_validacion" : /\.json$/i.test(a.ruta) ? "migrado" : "conservado_en_disco",
      nota,
    };
  });
  await insertMany(conn, "legacy_archivos", archivos);

  // --- legacy_marcas: R13 ---
  const marcas = marcaR13.semanas.map((k) => ({
    lote_id: loteId, tabla: "bonos_semanas", registro: k, campo: "celdas.R13", marca: "heredado_de_plantilla",
    valor: weeks[k].cells.R13,
    nota: k === "2026-W32" ? marcaR13.observacion : "Texto de la plantilla (semana 32) guardado en la semana; se conserva tal cual",
  }));
  await insertMany(conn, "legacy_marcas", marcas);

  // --- legacy_anomalias ---
  const an = [];
  const A = (codigo, fuente, registro, campo, valor, descripcion) =>
    an.push({ lote_id: loteId, codigo, fuente, registro: String(registro), campo, valor: valor == null ? null : String(valor), descripcion });
  const T = manifiesto.anomalias_conservadas.tiempo_muerto;
  const recPorId = new Map(tm.records.map((r) => [r.id, r]));
  for (const x of T.empleado_texto_libre.detalle) A("TM-1", "tiempo_muerto", x.id, x.campo, x.valor, "Numero de empleado con texto libre en origen KOIDE; no se corrige");
  for (const id of T.paros_mayores_24h.ids) A("TM-2", "tiempo_muerto", id, "downtime_minutes", recPorId.get(id).downtime_minutes, "Paro mayor a 24 h; se conserva");
  for (const grupo of T.duplicados_logicos_maquina_inicio) for (const id of grupo) {
    const r = recPorId.get(id);
    A("TM-4", "tiempo_muerto", id, "machine_id|downtime_start", `${r.machine_id}|${r.downtime_start}`, `Posible duplicado logico (ids ${grupo.join(", ")}); se conserva`);
  }
  for (const id of T.registros_con_caracter_reemplazo_U_FFFD.ids) A("TM-5", "tiempo_muerto", id, null, null, "Texto con caracter U+FFFD (codificacion defectuosa en origen); se conserva");
  for (const id of T.registros_no_finalizados) A("TM-6", "tiempo_muerto", id, "status", recPorId.get(id).status, "Paro no finalizado en la foto validada");
  for (const [fuente, codigo, arr] of [["gastos", "GA-DUP", src.gastos.data], ["entregas", "EN-DUP", src.entregas.data]]) {
    for (const g of gruposExactos(arr)) for (const i of g) A(codigo, fuente, i, null, `grupo: ${g.join("/")}`, "Registro duplicado exacto; se conserva");
  }
  for (const [fuente, codigo, arr] of [["gastos", "GA-HUELLA-AMBIGUA", src.gastos.data], ["entregas", "EN-HUELLA-AMBIGUA", src.entregas.data]]) {
    const porHuella = new Map();
    arr.forEach((r, i) => {
      const h = huellas[fuente].get(i).h;
      if (!porHuella.has(h)) porHuella.set(h, []);
      porHuella.get(h).push(i);
    });
    for (const [h, idx] of porHuella) {
      if (idx.length > 1 && new Set(idx.map((i) => JSON.stringify(arr[i]))).size > 1) {
        for (const i of idx) A(codigo, fuente, i, "huella_identidad", h, `Misma huella con contenido distinto (posiciones ${idx.join("/")}); ocurrencia depende del orden; revisar manualmente`);
      }
    }
  }
  const C = manifiesto.anomalias_conservadas.contramedidas;
  for (const x of C.responsable_fuera_de_config) A("CM-2", "contramedidas", x.id, "responsable", x.responsable, "Responsable no esta en config.json maintenanceTechnicians");
  for (const f of C.foto_sin_etiqueta_antes_despues) A("CM-1", "contramedidas", f.split("/")[0], "fotos", f, "Foto sin etiqueta antes/despues (el servidor la renombra)");
  for (const id of C.sin_fecha_de_completado) A("CM-4", "contramedidas", id, "estado", "Completado", "Completada sin fecha de completado");
  for (const id of C.fecha_limite_anterior_a_creada) A("CM-5", "contramedidas", id, "fechaLimite", src.cm.data.find((c) => c.id === id).fechaLimite, "Fecha limite anterior a la fecha de creacion");
  const B = manifiesto.anomalias_conservadas.bonos;
  A("BO-1", "bonos_semanas", SEMANA_EXCLUIDA, null, null, "Semana vacia autoguardada por buscarBono(); excluida de bonos_semanas");
  A("BO-3", "bonos_semanas", "*", "celdas.N9/P9/D7", B.formatos_fecha_mixtos, "Formatos de fecha mixtos entre semanas");
  A("BO-4", "bonos_plantilla", "plantilla", "D36/D38/N38/P38", null, B.encabezado_eficiencia_fijo);
  A("BO-5", "bonos_plantilla", "plantilla", "filas 42-43", null, "Filas de Eficiencia vacias en todas las semanas");
  A("BO-6", "bonos_plantilla", "plantilla", "L13:L19", "A", B.celda_oculta);
  await insertMany(conn, "legacy_anomalias", an);

  const dic = diccionario();
  await insertMany(conn, "diccionario_datos", dic);

  return { loteId, semanas, reg, archivos, marcas, an, dic };
}

/* ---------- 5. Verificacion dentro de la transaccion ---------- */

async function verificar(conn, { src }, r) {
  console.log("\n--- Verificacion (lectura con lib/store.js dentro de la transaccion) ---");
  const tm = src.tm.data;
  const b = src.bonos.data;

  const esperado = {
    tiempo_muerto: tm.records.length, maquinas: tm.machines.length, gastos: src.gastos.data.length,
    entregas: src.entregas.data.length, contramedidas: src.cm.data.length,
    contramedida_fotos: src.cm.data.reduce((n, c) => n + (c.fotos || []).length, 0),
    bonos_plantilla: 1, bonos_semanas: r.semanas.length, calendarios: 0, documentos: 0, fuentes_sync: 3,
    legacy_lotes: 1, legacy_registros: r.reg.length, legacy_archivos: r.archivos.length,
    legacy_marcas: r.marcas.length, legacy_anomalias: r.an.length, diccionario_datos: r.dic.length,
  };
  for (const [t, n] of Object.entries(esperado)) {
    const [[x]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    check(`filas ${t}`, Number(x.n) === n, `${x.n} (esperado ${n})`);
  }

  // Contenido exacto, leido como lo sirve la API.
  const tmDb = await store.loadTiempoMuerto();
  let d = firstDiff({ updatedAt: tm.updatedAt, area: tm.area, records: tm.records, machines: tm.machines }, tmDb);
  check("tiempo_muerto + maquinas: contenido exacto", !d, d || "");
  d = firstDiff(src.gastos.data, await store.loadGastos());
  check("gastos: contenido exacto", !d, d || "");
  d = firstDiff(src.entregas.data, await store.loadEntregas());
  check("entregas: contenido exacto", !d, d || "");
  d = firstDiff(src.cm.data, await store.listContramedidas());
  check("contramedidas (con fotos): contenido exacto", !d, d || "");
  const { weeks, ...meta } = b;
  const bonosEsperado = { template: b.template || null, weeks: Object.fromEntries(r.semanas.map((k) => [k, weeks[k]])) };
  for (const [k, v] of Object.entries(meta)) if (k !== "template") bonosEsperado[k] = v;
  d = firstDiff(bonosEsperado, await store.loadBonos());
  check(`bonos: contenido exacto sin ${SEMANA_EXCLUIDA}`, !d, d || "");
  check("calendarios operativos vacios", same(await store.listCalendarios(), []));

  // W37
  const [[w]] = await conn.query("SELECT COUNT(*) AS n FROM bonos_semanas WHERE clave = ?", [SEMANA_EXCLUIDA]);
  check(`${SEMANA_EXCLUIDA} NO esta en bonos_semanas`, Number(w.n) === 0);
  const [[wl]] = await conn.query(
    "SELECT estado_migracion, motivo, payload_sha256 FROM legacy_registros WHERE fuente = 'bonos_semanas' AND clave_legacy = ?",
    [SEMANA_EXCLUIDA]
  );
  check(
    `${SEMANA_EXCLUIDA} conservada en legacy_registros como excluido con contenido exacto`,
    wl && wl.estado_migracion === "excluido" && wl.motivo && wl.payload_sha256 === sha256(Buffer.from(JSON.stringify(weeks[SEMANA_EXCLUIDA]), "utf8"))
  );

  // R13: dato operativo = marca
  const [[m]] = await conn.query(
    `SELECT COUNT(*) AS n FROM legacy_marcas lm JOIN bonos_semanas bs ON bs.clave = lm.registro
     WHERE lm.marca = 'heredado_de_plantilla' AND lm.campo = 'celdas.R13'
       AND CONVERT(JSON_UNQUOTE(JSON_EXTRACT(bs.celdas, '$.R13')) USING utf8mb4) COLLATE utf8mb4_bin
           = CONVERT(lm.valor USING utf8mb4) COLLATE utf8mb4_bin`
  );
  check("R13 operativo identico a la marca en todas las semanas marcadas", Number(m.n) === r.marcas.length, `${m.n}/${r.marcas.length}`);

  // legacy_registros
  const [[sh]] = await conn.query("SELECT COUNT(*) AS n FROM legacy_registros WHERE CONVERT(SHA2(payload, 256) USING ascii) COLLATE ascii_bin <> payload_sha256");
  check("legacy_registros: SHA-256 de cada payload correcto", Number(sh.n) === 0, `${sh.n} discrepancias`);
  for (const t of ["gastos", "entregas"]) {
    const [[h]] = await conn.query(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT huella_identidad, ocurrencia) AS pares, SUM(huella_identidad IS NULL) AS sin FROM legacy_registros WHERE fuente = ?",
      [t]
    );
    check(`${t}: (huella, ocurrencia) unica para todos los registros`, Number(h.pares) === Number(h.n) && Number(h.sin) === 0 && Number(h.n) === src[t].data.length, `${h.pares}/${h.n}`);
  }
  const [[ids]] = await conn.query(
    "SELECT COUNT(*) AS n FROM legacy_registros lr JOIN tiempo_muerto t ON t.id = CAST(lr.clave_legacy AS UNSIGNED) WHERE lr.fuente = 'tiempo_muerto'"
  );
  check("IDs originales de KOIDE conservados (legacy_registros <-> tiempo_muerto)", Number(ids.n) === tm.records.length, ids.n);

  // Calendarios historicos
  const [[cal]] = await conn.query(
    "SELECT COUNT(*) AS n FROM legacy_archivos WHERE estado = 'historico_pendiente_validacion' AND ruta LIKE 'data/calendarios/%'"
  );
  check("6 calendarios como historico_pendiente_validacion y fuera de calendarios", Number(cal.n) === 6);

  // Anomalias ambiguas
  const [amb] = await conn.query("SELECT codigo, COUNT(*) AS n FROM legacy_anomalias WHERE codigo LIKE '%HUELLA-AMBIGUA' GROUP BY codigo ORDER BY codigo");
  check("GA-HUELLA-AMBIGUA y EN-HUELLA-AMBIGUA registradas", amb.length === 2, amb.map((x) => `${x.codigo}=${x.n}`).join(", "));

  // fuentes_sync
  const sync = await store.getSync("tiempo_muerto");
  check("fuentes_sync tiempo_muerto = updatedAt de la foto", sync && sync.actualizado.toISOString() === tm.updatedAt);

  return checks.every((c) => c.ok);
}

/* ---------- main ---------- */

function escribirLog(resumen) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `importacion-legacy-${resumen.fecha.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(resumen, null, 2));
  return file;
}

async function main() {
  if (MODOS.length !== 1) {
    console.log("Uso: node scripts/importar-legacy-mariadb.js --verificar | --ensayo | --ejecutar [--data-dir <ruta>]");
    process.exitCode = 2;
    return;
  }
  const modo = MODOS[0].slice(2);
  console.log(`[importar] Modo: ${modo}  |  datos: ${DATA_DIR}`);
  const fuentes = leerFuentes();
  validarPremisas(fuentes);
  if (!checks.every((c) => c.ok)) fail("Las premisas no se cumplen; no se conecta a la base.");

  const conn = await db.getPool().getConnection();
  let resultado = "sin_cambios";
  try {
    await prepararSesion(conn);
    if (!(await validarBase(conn, fuentes.manifiestoSha))) fail("La base no esta lista; no se importo nada.");
    if (modo === "verificar") {
      console.log("\n[importar] --verificar: todas las validaciones previas pasaron. No se escribio nada.");
      return;
    }

    await conn.beginTransaction();
    txConn = conn;
    try {
      const r = await importar(conn, fuentes);
      const ok = await verificar(conn, fuentes, r);
      if (!ok) fail("Verificacion fallida.");
      if (modo === "ensayo") {
        await conn.rollback();
        resultado = "ensayo_ok_rollback";
        console.log("\n[importar] --ensayo: todo correcto. Se hizo ROLLBACK; la base queda vacia.");
      } else {
        await conn.commit();
        resultado = "commit";
        console.log(`\n[importar] COMMIT realizado. Lote ${r.loteId}.`);
      }
    } catch (err) {
      try {
        await conn.rollback();
      } catch {}
      resultado = "rollback_por_error";
      throw err;
    } finally {
      txConn = null;
    }
  } finally {
    conn.release();
    const resumen = { fecha: new Date().toISOString(), modo, dataDir: DATA_DIR, resultado, ok: checks.every((c) => c.ok), checks };
    console.log(`[importar] Reporte: ${escribirLog(resumen)}`);
    await db.closePool();
  }
}

main().catch((err) => {
  console.error("[importar] ERROR:", err.message);
  if (!err.controlled) console.error(err.stack);
  process.exit(1);
});
