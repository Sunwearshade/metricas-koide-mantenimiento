"use strict";

// Acceso a datos de la aplicacion en MySQL.
//
// Cada funcion devuelve/recibe los mismos objetos que antes se leian/escribian
// en los archivos JSON de data/, para que la API responda exactamente igual.

const { query, tx } = require("./db");

/* ---------- Conversion de valores ---------- */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NO = { ok: false };

// Fecha/hora ISO ("...Z") -> Date, si se puede reconstruir exactamente.
function isoToDate(v) {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const d = new Date(v);
  return !isNaN(d) && d.toISOString() === v ? d : null;
}

// Cualquier fecha parseable -> Date (solo para columnas tipadas de consulta).
function anyToDate(v) {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear();
  return y >= 1000 && y <= 9999 ? d : null;
}

function validDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

function toInt(v) {
  return Number.isInteger(v) && Math.abs(v) <= 2147483647 ? v : null;
}

function toTiny(v) {
  return Number.isInteger(v) && v >= -128 && v <= 127 ? v : null;
}

function toNum(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function toStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return [...s].length > max ? [...s].slice(0, max).join("") : s;
}

function toText(v) {
  if (v === null || v === undefined) return null;
  let s = String(v);
  while (Buffer.byteLength(s, "utf8") > 65535) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

/* ---------- Codecs para tablas "documento" (contramedidas, bonos, calendarios) ----------
 *
 * Cada campo conocido va a su columna tipada si su valor cabe exactamente;
 * si no (tipo distinto, texto demasiado largo, fecha con otro formato...), el
 * valor se guarda en la columna "extra" para no perderlo. Campos desconocidos
 * tambien van a "extra". Por defecto columna NULL = la clave no existia.
 */

const codec = {
  str: (max) => ({
    enc: (v) => (typeof v === "string" && [...v].length <= max ? { ok: true, v } : NO),
    dec: (v) => v,
  }),
  text: {
    enc: (v) => (typeof v === "string" && Buffer.byteLength(v, "utf8") <= 65535 ? { ok: true, v } : NO),
    dec: (v) => v,
  },
  // Fecha 'YYYY-MM-DD'; la cadena vacia se guarda como NULL.
  date: {
    enc: (v) => (v === "" ? { ok: true, v: null } : validDate(v) ? { ok: true, v } : NO),
    dec: (v) => (v === null ? "" : v),
    nullValue: "",
  },
  // Entero; null se guarda como NULL.
  intOrNull: {
    enc: (v) => (v === null ? { ok: true, v: null } : toInt(v) !== null ? { ok: true, v } : NO),
    dec: (v) => v,
    nullValue: null,
  },
  iso: {
    enc: (v) => {
      const d = isoToDate(v);
      return d ? { ok: true, v: d } : NO;
    },
    dec: (v) => v.toISOString(),
  },
  jsonObject: {
    enc: (v) => (v && typeof v === "object" && !Array.isArray(v) ? { ok: true, v: JSON.stringify(v) } : NO),
    dec: (v) => JSON.parse(v),
  },
  jsonArray: {
    enc: (v) => (Array.isArray(v) ? { ok: true, v: JSON.stringify(v) } : NO),
    dec: (v) => JSON.parse(v),
  },
};

const ABSENT_KEY = "__ausentes";

// spec: [[claveJS, columna, codec], ...] en el orden canonico de las claves.
function encodeDoc(obj, spec, skipKeys = []) {
  const cols = {};
  const extra = {};
  const absent = [];
  const known = new Set(spec.map((s) => s[0]).concat(skipKeys));
  for (const [key, col, c] of spec) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      cols[col] = null;
      if (c.nullValue !== undefined) absent.push(key);
      continue;
    }
    const r = c.enc(obj[key]);
    if (r.ok) {
      cols[col] = r.v;
    } else {
      cols[col] = null;
      extra[key] = obj[key];
    }
  }
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) extra[key] = obj[key];
  }
  if (absent.length) extra[ABSENT_KEY] = absent;
  cols.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return cols;
}

function decodeDoc(row, spec, extraKeysHandled = []) {
  const extra = row.extra ? JSON.parse(row.extra) : {};
  const absent = new Set(extra[ABSENT_KEY] || []);
  const out = {};
  for (const [key, col, c] of spec) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      out[key] = extra[key];
    } else if (row[col] !== null && row[col] !== undefined) {
      out[key] = c.dec(row[col]);
    } else if (c.nullValue !== undefined && !absent.has(key)) {
      out[key] = c.nullValue;
    }
  }
  const knownKeys = new Set(spec.map((s) => s[0]).concat(extraKeysHandled, [ABSENT_KEY]));
  for (const key of Object.keys(extra)) {
    if (!knownKeys.has(key)) out[key] = extra[key];
  }
  return { obj: out, extra };
}

function insertSql(table, cols) {
  const keys = Object.keys(cols);
  return {
    sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    params: keys.map((k) => cols[k]),
  };
}

async function bulkInsert(conn, table, rows, chunk = 300) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await conn.query(`INSERT INTO ${table} (${keys.join(", ")}) VALUES ?`, [
      part.map((r) => keys.map((k) => r[k])),
    ]);
  }
}

async function setSync(conn, fuente, { area = null, actualizado, registros, detalle = null }) {
  await conn.query(
    `INSERT INTO fuentes_sync (fuente, area, actualizado, registros, detalle) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE area = VALUES(area), actualizado = VALUES(actualizado),
       registros = VALUES(registros), detalle = VALUES(detalle)`,
    [fuente, area, actualizado, registros, detalle]
  );
}

async function getSync(fuente) {
  const rows = await query("SELECT * FROM fuentes_sync WHERE fuente = ?", [fuente]);
  return rows[0] || null;
}

/* ---------- Tiempo muerto (koide) ---------- */

function recordRow(r, orden) {
  return {
    id: r.id,
    orden,
    record_date: validDate(r.record_date) ? r.record_date : null,
    shift: toStr(r.shift, 20),
    group_name: toStr(r.group_name, 20),
    machine_id: toInt(r.machine_id),
    machine_code: toStr(r.machine_code, 50),
    operator_employee_number: toStr(r.operator_employee_number, 50),
    operator_name: toStr(r.operator_name, 255),
    downtime_start: anyToDate(r.downtime_start),
    downtime_end: anyToDate(r.downtime_end),
    downtime_minutes: toInt(r.downtime_minutes),
    responsible_area: toStr(r.responsible_area, 100),
    downtime_category: toStr(r.downtime_category, 100),
    problem_description: toText(r.problem_description),
    responsible_person: toStr(r.responsible_person, 255),
    action_taken: toText(r.action_taken),
    status: toStr(r.status, 50),
    response_time_minutes: toInt(r.response_time_minutes),
    repair_time_minutes: toInt(r.repair_time_minutes),
    external_minutes: toInt(r.external_minutes),
    created_at: anyToDate(r.created_at),
    updated_at: anyToDate(r.updated_at),
    payload: JSON.stringify(r),
  };
}

function machineRow(m, orden) {
  return {
    id: m.id,
    orden,
    code: toStr(m.code, 50),
    name: toStr(m.name, 255),
    process: toStr(m.process, 100),
    active: toInt(m.active),
    target_pcs_per_hour: toInt(m.target_pcs_per_hour),
    effective_hours_per_day: toNum(m.effective_hours_per_day),
    created_at: anyToDate(m.created_at),
    updated_at: anyToDate(m.updated_at),
    payload: JSON.stringify(m),
  };
}

// Reemplaza el espejo completo (equivale a sobrescribir tiempo-muerto.json).
async function saveTiempoMuerto(payload) {
  const records = payload.records || [];
  const machines = payload.machines || [];
  const actualizado = isoToDate(payload.updatedAt) || anyToDate(payload.updatedAt) || new Date();
  const extraRecords = records.filter((r) => toInt(r && r.id) === null);
  const extraMachines = machines.filter((m) => toInt(m && m.id) === null);
  if (extraRecords.length || extraMachines.length) {
    throw new Error("Registros de koide sin id numerico; no se pueden guardar");
  }
  await tx(async (conn) => {
    await conn.query("DELETE FROM tiempo_muerto");
    await conn.query("DELETE FROM maquinas");
    await bulkInsert(conn, "tiempo_muerto", records.map(recordRow));
    await bulkInsert(conn, "maquinas", machines.map(machineRow));
    await setSync(conn, "tiempo_muerto", {
      area: payload.area || null,
      actualizado,
      registros: records.length,
      detalle: `${machines.length} maquinas`,
    });
  });
}

async function loadTiempoMuerto() {
  const sync = await getSync("tiempo_muerto");
  if (!sync) return null;
  const records = await query("SELECT payload FROM tiempo_muerto ORDER BY orden");
  const machines = await query("SELECT payload FROM maquinas ORDER BY orden");
  return {
    updatedAt: sync.actualizado.toISOString(),
    area: sync.area,
    records: records.map((r) => JSON.parse(r.payload)),
    machines: machines.map((m) => JSON.parse(m.payload)),
  };
}

/* ---------- Gastos / Entregas (escritos por los scripts Python) ---------- */

// Mismo mapeo que scripts/metricos_db.py (gasto_row / entrega_row); se usa
// en la migracion inicial desde gastos.json / entregas.json.
function toBoolInt(v) {
  return typeof v === "boolean" ? (v ? 1 : 0) : toInt(v);
}

function gastoRow(g, orden) {
  return {
    orden,
    sheet: toStr(g.sheet, 100),
    cotizacion: toStr(g.cotizacion, 50),
    proveedor: toText(g.proveedor),
    producto: toText(g.producto),
    observaciones: toText(g.observaciones),
    cantidad: toNum(g.cantidad),
    unidad: toStr(g.unidad, 50),
    precio_unitario: toNum(g.precio_unitario),
    importe: toNum(g.importe),
    iva: toNum(g.iva),
    total_partida: toNum(g.total_partida),
    po: toStr(g.po, 50),
    tiene_po: toBoolInt(g.tiene_po),
    entregado: toBoolInt(g.entregado),
    fecha_elaboracion: validDate(g.fecha_elaboracion) ? g.fecha_elaboracion : null,
    fecha_entrega: validDate(g.fecha_entrega) ? g.fecha_entrega : null,
    mes_entrega: toTiny(g.mes_entrega),
    moneda: toStr(g.moneda, 20),
    proyecto: toStr(g.proyecto, 255),
    termino_pago: toStr(g.termino_pago, 100),
    comentario: toText(g.comentario),
    payload: JSON.stringify(g),
  };
}

function entregaRow(e, orden) {
  return {
    orden,
    proveedor: toText(e.proveedor),
    material: toText(e.material),
    cantidad: toNum(e.cantidad),
    depto: toStr(e.depto, 100),
    serie: toStr(e.serie, 50),
    po: toStr(e.po, 50),
    fecha_envio: validDate(e.fecha_envio) ? e.fecha_envio : null,
    fecha_estimada: validDate(e.fecha_estimada) ? e.fecha_estimada : null,
    dias: toInt(e.dias),
    estatus: toStr(e.estatus, 50),
    observaciones: toText(e.observaciones),
    mes: toTiny(e.mes),
    payload: JSON.stringify(e),
  };
}

// Devuelve null si nunca se ha cargado la fuente (antes: el archivo no existia).
async function loadPayloads(table, fuente) {
  const sync = await getSync(fuente);
  if (!sync) return null;
  const rows = await query(`SELECT payload FROM ${table} ORDER BY orden`);
  return rows.map((r) => JSON.parse(r.payload));
}

const loadGastos = () => loadPayloads("gastos", "gastos");
const loadEntregas = () => loadPayloads("entregas", "entregas");

/* ---------- Contramedidas ---------- */

const CM_SPEC = [
  ["id", "id", codec.str(40)],
  ["tipo", "tipo", codec.str(255)],
  ["maquina", "maquina", codec.str(255)],
  ["maquinaNombre", "maquina_nombre", codec.str(255)],
  ["fallaComun", "falla_comun", codec.text],
  ["referencia", "referencia", codec.str(255)],
  ["categoria", "categoria", codec.str(255)],
  ["descripcion", "descripcion", codec.text],
  ["responsable", "responsable", codec.str(255)],
  ["fechaLimite", "fecha_limite", codec.date],
  ["estado", "estado", codec.str(100)],
  ["creada", "creada", codec.iso],
  ["trabajoRealizado", "trabajo_realizado", codec.text],
  // (mig 006) enlace con la contramedida registrada en KOIDE MES a partir de
  // una recomendacion por acumulacion de fallas (equipo + categoria).
  ["mesId", "mes_id", { enc: (v) => (Number.isInteger(v) && v > 0 ? { ok: true, v } : NO), dec: (v) => v }],
  ["recomendacionClave", "recomendacion_clave", codec.str(120)],
];

function cmFotoRuta(id, nombre) {
  return `contramedidas-fotos/${id}/${nombre}`;
}

function isFotoList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && [...x].length <= 255);
}

async function writeCm(conn, cm, { update = false, fotoFechas = new Map() } = {}) {
  const cols = encodeDoc(cm, CM_SPEC, isFotoList(cm.fotos) ? ["fotos"] : []);
  if (update) {
    const { id, ...rest } = cols;
    const keys = Object.keys(rest);
    await conn.query(`UPDATE contramedidas SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...keys.map((k) => rest[k]),
      id,
    ]);
    await conn.query("DELETE FROM contramedida_fotos WHERE contramedida_id = ?", [cm.id]);
  } else {
    const { sql, params } = insertSql("contramedidas", cols);
    await conn.query(sql, params);
  }
  if (isFotoList(cm.fotos)) {
    const now = new Date();
    await bulkInsert(
      conn,
      "contramedida_fotos",
      cm.fotos.map((nombre, i) => ({
        contramedida_id: cm.id,
        orden: i,
        nombre,
        ruta: cmFotoRuta(cm.id, nombre),
        creada: fotoFechas.get(nombre) || now,
      }))
    );
  }
}

async function cmFromRows(rows) {
  if (!rows.length) return [];
  const fotos = await query(
    `SELECT contramedida_id, nombre FROM contramedida_fotos
     WHERE contramedida_id IN (?) ORDER BY contramedida_id, orden`,
    [rows.map((r) => r.id)]
  );
  const byCm = new Map();
  for (const f of fotos) {
    if (!byCm.has(f.contramedida_id)) byCm.set(f.contramedida_id, []);
    byCm.get(f.contramedida_id).push(f.nombre);
  }
  return rows.map((row) => {
    const { obj, extra } = decodeDoc(row, CM_SPEC, ["fotos"]);
    // "fotos" va despues de los campos canonicos (asi lo agregaba la app).
    if (byCm.has(row.id)) obj.fotos = byCm.get(row.id);
    else if (Object.prototype.hasOwnProperty.call(extra, "fotos")) obj.fotos = extra.fotos;
    for (const key of Object.keys(extra)) {
      if (key !== "fotos" && key !== ABSENT_KEY && !CM_SPEC.some((s) => s[0] === key)) {
        delete obj[key];
        obj[key] = extra[key];
      }
    }
    return obj;
  });
}

async function listContramedidas() {
  return cmFromRows(await query("SELECT * FROM contramedidas ORDER BY orden"));
}

async function getContramedida(id) {
  const [cm] = await cmFromRows(await query("SELECT * FROM contramedidas WHERE id = ?", [id]));
  return cm || null;
}

async function insertContramedida(cm) {
  await tx((conn) => writeCm(conn, cm));
  return cm;
}

async function updateContramedida(cm) {
  await tx(async (conn) => {
    const prev = await conn.query("SELECT nombre, creada FROM contramedida_fotos WHERE contramedida_id = ?", [cm.id]);
    const fotoFechas = new Map(prev[0].map((f) => [f.nombre, f.creada]));
    await writeCm(conn, cm, { update: true, fotoFechas });
  });
  return cm;
}

async function deleteContramedida(id) {
  await query("DELETE FROM contramedidas WHERE id = ?", [id]);
}

/* ---------- Propuestas de contramedida (mig 007) ----------
 * Una fila por CICLO de recomendacion (UNIQUE ciclo). La crea la programacion
 * automatica (AUTOMATICA, PENDIENTE_APROBACION) o la programacion manual
 * desde una recomendacion (MANUAL, CONFIRMADA). */

function numOrNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

function propuestaFromRow(r) {
  return {
    id: Number(r.id),
    ciclo: r.ciclo,
    recomendacionClave: r.recomendacion_clave,
    equipo: { codigo: r.equipo_codigo, nombre: r.equipo_nombre, proceso: r.proceso },
    categoria: { codigo: r.categoria_codigo, nombre: r.categoria_nombre },
    horasAcumuladas: numOrNull(r.horas_acumuladas),
    paros: numOrNull(r.paros),
    umbralHoras: numOrNull(r.umbral_horas),
    contramedidaPreviaId: r.contramedida_previa_id || null,
    detectadaEn: r.detectada_en ? r.detectada_en.toISOString() : null,
    origen: r.origen,
    estado: r.estado,
    fechaPropuesta: r.fecha_propuesta || null,
    fechaConfirmada: r.fecha_confirmada || null,
    reprogramaciones: Number(r.reprogramaciones || 0),
    motivo: r.motivo || null,
    resueltaPor: r.resuelta_por || null,
    resueltaEn: r.resuelta_en ? r.resuelta_en.toISOString() : null,
    contramedidaId: r.contramedida_id || null,
    mesId: numOrNull(r.mes_id),
    creadaPor: r.creada_por,
    creada: r.created_at ? r.created_at.toISOString() : null,
    actualizada: r.updated_at ? r.updated_at.toISOString() : null,
  };
}

async function listPropuestas({ estados, ciclos } = {}) {
  const where = [];
  const params = [];
  if (estados && estados.length) { where.push("estado IN (?)"); params.push(estados); }
  if (ciclos) {
    if (!ciclos.length) return [];
    where.push("ciclo IN (?)");
    params.push(ciclos);
  }
  const rows = await query(`SELECT * FROM contramedidas_propuestas ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`, params);
  return rows.map(propuestaFromRow);
}

async function getPropuesta(id, conn) {
  const sql = "SELECT * FROM contramedidas_propuestas WHERE id = ?";
  const rows = conn ? (await conn.query(sql, [id]))[0] : await query(sql, [id]);
  return rows[0] ? propuestaFromRow(rows[0]) : null;
}

async function getPropuestaPorCiclo(ciclo, conn) {
  const sql = "SELECT * FROM contramedidas_propuestas WHERE ciclo = ?";
  const rows = conn ? (await conn.query(sql, [ciclo]))[0] : await query(sql, [ciclo]);
  return rows[0] ? propuestaFromRow(rows[0]) : null;
}

// INSERT IGNORE: si el ciclo ya tiene propuesta no se duplica. Devuelve el id
// nuevo o null si ya existia.
async function insertPropuesta(p, conn) {
  const ahora = new Date();
  const cols = {
    ciclo: p.ciclo, recomendacion_clave: p.recomendacionClave, equipo_codigo: p.equipo.codigo, equipo_nombre: p.equipo.nombre || null,
    proceso: p.equipo.proceso || null, categoria_codigo: p.categoria.codigo || null, categoria_nombre: p.categoria.nombre || null,
    horas_acumuladas: p.horasAcumuladas, paros: p.paros, umbral_horas: p.umbralHoras, contramedida_previa_id: p.contramedidaPreviaId == null ? null : String(p.contramedidaPreviaId),
    detectada_en: ahora, origen: p.origen, estado: p.estado, fecha_propuesta: p.fechaPropuesta || null, fecha_confirmada: p.fechaConfirmada || null,
    resuelta_por: p.resueltaPor || null, resuelta_en: p.resueltaPor ? ahora : null, contramedida_id: p.contramedidaId || null, mes_id: p.mesId || null,
    creada_por: p.creadaPor, created_at: ahora, updated_at: ahora,
  };
  const keys = Object.keys(cols);
  const sql = `INSERT IGNORE INTO contramedidas_propuestas (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  const params = keys.map((k) => cols[k]);
  const r = conn ? (await conn.query(sql, params))[0] : await query(sql, params);
  return r.affectedRows ? Number(r.insertId) : null;
}

// Cambio de estado condicionado: solo aplica si el estado actual es uno de
// `desde` (transicion atomica; evita dobles aprobaciones). true si aplico.
const PROPUESTA_COLS = {
  estado: "estado", origen: "origen", fechaPropuesta: "fecha_propuesta", fechaConfirmada: "fecha_confirmada", motivo: "motivo",
  resueltaPor: "resuelta_por", resueltaEn: "resuelta_en", contramedidaId: "contramedida_id", mesId: "mes_id",
  horasAcumuladas: "horas_acumuladas", paros: "paros", reprogramaciones: "reprogramaciones",
};
async function updatePropuesta(id, desde, campos, conn) {
  const keys = Object.keys(campos).filter((k) => PROPUESTA_COLS[k]);
  const sets = keys.map((k) => `${PROPUESTA_COLS[k]} = ?`);
  const params = keys.map((k) => campos[k]);
  sets.push("updated_at = ?");
  params.push(new Date());
  let sql = `UPDATE contramedidas_propuestas SET ${sets.join(", ")} WHERE id = ?`;
  params.push(id);
  if (desde && desde.length) {
    sql += " AND estado IN (?)";
    params.push(desde);
  }
  const r = conn ? (await conn.query(sql, params))[0] : await query(sql, params);
  return r.affectedRows > 0;
}

/* ---------- Bonos ---------- */

const WEEK_SPEC = [
  ["key", "clave", codec.str(100)],
  ["semana", "semana", codec.intOrNull],
  ["periodoIni", "periodo_ini", codec.str(50)],
  ["periodoFin", "periodo_fin", codec.str(50)],
  ["fecha", "fecha", codec.str(50)],
  ["cells", "celdas", codec.jsonObject],
  ["guardado", "guardado", codec.iso],
];

const PLANTILLA_SPEC = [
  ["template", "plantilla", { enc: (v) => ({ ok: true, v: v === null ? null : JSON.stringify(v) }), dec: JSON.parse, nullValue: null }],
  ["updatedAt", "actualizado", codec.iso],
];

// Devuelve el mismo objeto que antes contenia bonos.json.
async function loadBonos() {
  const [row] = await query("SELECT * FROM bonos_plantilla WHERE id = 1");
  const bonos = row ? decodeDoc(row, PLANTILLA_SPEC).obj : { template: null };
  if (bonos.template === undefined) bonos.template = null;
  const weeks = {};
  for (const w of await query("SELECT * FROM bonos_semanas ORDER BY orden")) {
    weeks[w.clave] = decodeDoc(w, WEEK_SPEC).obj;
  }
  // Orden de claves igual al de bonos.json: template, weeks, updatedAt, ...
  const out = { template: bonos.template, weeks };
  for (const [k, v] of Object.entries(bonos)) if (k !== "template") out[k] = v;
  return out;
}

async function saveBonosPlantilla(bonosMeta, archivoRuta, conn) {
  const cols = encodeDoc(bonosMeta, PLANTILLA_SPEC, ["weeks"]);
  const t = bonosMeta.template;
  const params = [
    t && typeof t.sheet === "string" ? toStr(t.sheet, 255) : null,
    archivoRuta,
    cols.plantilla,
    cols.actualizado,
    cols.extra,
  ];
  const sql = `INSERT INTO bonos_plantilla (id, hoja, archivo_ruta, plantilla, actualizado, extra)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE hoja = VALUES(hoja), archivo_ruta = VALUES(archivo_ruta),
       plantilla = VALUES(plantilla), actualizado = VALUES(actualizado), extra = VALUES(extra)`;
  if (conn) await conn.query(sql, params);
  else await query(sql, params);
}

async function saveBonoSemana(week, conn) {
  const cols = encodeDoc(week, WEEK_SPEC);
  const { clave, ...rest } = cols;
  const keys = Object.keys(rest);
  const sql = `INSERT INTO bonos_semanas (clave, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})
     ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(", ")}`;
  const params = [clave, ...keys.map((k) => rest[k])];
  if (conn) await conn.query(sql, params);
  else await query(sql, params);
}

async function deleteBonoSemana(key) {
  await query("DELETE FROM bonos_semanas WHERE clave = ?", [key]);
}

/* ---------- Calendarios ---------- */

const CAL_SPEC = [
  ["id", "id", codec.str(40)],
  ["name", "nombre", codec.str(255)],
  ["uploadedAt", "subido", codec.iso],
  ["sheets", "hojas", codec.jsonArray],
  ["status", "estado", codec.jsonObject],
];

function calRuta(id) {
  return `calendarios/${id}.xlsx`;
}

async function listCalendarios() {
  const rows = await query("SELECT * FROM calendarios ORDER BY orden");
  return rows.map((r) => decodeDoc(r, CAL_SPEC).obj);
}

async function insertCalendario(entry, conn) {
  const cols = encodeDoc(entry, CAL_SPEC);
  cols.archivo_ruta = calRuta(entry.id);
  const { sql, params } = insertSql("calendarios", cols);
  if (conn) await conn.query(sql, params);
  else await query(sql, params);
}

async function getCalendario(id) {
  const [row] = await query("SELECT * FROM calendarios WHERE id = ?", [id]);
  return row ? decodeDoc(row, CAL_SPEC).obj : null;
}

async function updateCalendario(entry) {
  const cols = encodeDoc(entry, CAL_SPEC);
  const { id, ...rest } = cols;
  const keys = Object.keys(rest);
  await query(`UPDATE calendarios SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => rest[k]),
    id,
  ]);
}

async function deleteCalendario(id) {
  await query("DELETE FROM calendarios WHERE id = ?", [id]);
}

/* ---------- Documentos ---------- */

// Sincroniza la tabla con lo que hay en disco para una categoria.
// files: [{ name, size, mtime(ISO) }] tal como los lista el disco.
async function syncDocumentos(categoria, files) {
  await tx(async (conn) => {
    const [rows] = await conn.query("SELECT id, nombre, tamano, modificado FROM documentos WHERE categoria = ?", [
      categoria,
    ]);
    const byName = new Map(rows.map((r) => [r.nombre, r]));
    const now = new Date();
    for (const f of files) {
      const mtime = new Date(f.mtime);
      const prev = byName.get(f.name);
      byName.delete(f.name);
      if (!prev) {
        await conn.query(
          "INSERT INTO documentos (categoria, nombre, ruta, tamano, modificado, registrado) VALUES (?, ?, ?, ?, ?, ?)",
          [categoria, f.name, `documentos/${categoria}/${f.name}`, f.size, mtime, now]
        );
      } else if (Number(prev.tamano) !== f.size || prev.modificado.getTime() !== mtime.getTime()) {
        await conn.query("UPDATE documentos SET tamano = ?, modificado = ? WHERE id = ?", [f.size, mtime, prev.id]);
      }
    }
    for (const gone of byName.values()) {
      await conn.query("DELETE FROM documentos WHERE id = ?", [gone.id]);
    }
  });
}

module.exports = {
  isoToDate,
  anyToDate,
  recordRow,
  machineRow,
  gastoRow,
  entregaRow,
  getSync,
  setSync,
  bulkInsert,
  saveTiempoMuerto,
  loadTiempoMuerto,
  loadGastos,
  loadEntregas,
  listContramedidas,
  getContramedida,
  insertContramedida,
  updateContramedida,
  deleteContramedida,
  writeCm,
  listPropuestas,
  getPropuesta,
  getPropuestaPorCiclo,
  insertPropuesta,
  updatePropuesta,
  loadBonos,
  saveBonosPlantilla,
  saveBonoSemana,
  deleteBonoSemana,
  listCalendarios,
  getCalendario,
  insertCalendario,
  updateCalendario,
  deleteCalendario,
  syncDocumentos,
};
