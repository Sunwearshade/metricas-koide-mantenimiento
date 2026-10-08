"use strict";

// PROGRAMA DE MANTENIMIENTO PREVENTIVO MENSUAL (mig 009). Traido del sistema
// "metricos" (08/10/2026); convive con el calendario de Excel (lib/store.js).
//
//   * Cada mes agenda un preventivo por maquina en dias de lunes a sabado.
//     Orden: primero las maquinas con mas minutos de tiempo muerto en el mes
//     ANTERIOR, luego las que no tuvieron paros. Si el mes anterior no tiene
//     paros, el mes queda sin programar.
//   * La programacion automatica solo llena meses vacios cuyo mes anterior ya
//     empezo (nunca toca un mes con tareas). Regenerar o limpiar a mano se
//     rechaza si el mes ya tiene estados o reportes, para no perderlos.
//   * Cada tarea guarda estado (Realizado / Reprogramado / Pendiente) y un
//     reporte: responsable, puntos revisados, observaciones y evidencias.

const fs = require("fs");
const path = require("path");
const { query, tx } = require("./db");
const auditoria = require("./auditoria");

const ESTADOS = ["Realizado", "Reprogramado", "Pendiente"];
const COLORES_DEFAULT = { Realizado: "#16a34a", Reprogramado: "#f59e0b", Pendiente: "#94a3b8" };
const MES_NOMBRES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EVIDENCIA_RE = /^ev_[a-z0-9]+_[a-z0-9]+\.(jpg|png|pdf)$/;
const MAX_EVIDENCIAS = 6;
const MAX_EVIDENCIA_BYTES = 5 * 1024 * 1024;
const MAX_PUNTOS = 60;

class PreventivoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------- Fechas ---------- */

function mesDe(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function mesAnterior(mes) {
  const [y, m] = mes.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return mesDe(d);
}

function nombreMes(mes) {
  const [y, m] = mes.split("-").map(Number);
  return `${MES_NOMBRES[m - 1]} ${y}`;
}

function diasHabiles(mes) {
  const [y, m] = mes.split("-").map(Number);
  const out = [];
  const d = new Date(y, m - 1, 1);
  while (d.getMonth() === m - 1) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 6) out.push(`${mes}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/* ---------- Programacion (pura, sin base de datos) ---------- */

// records/machines: mismo formato que /api/data (cache del servidor).
// Devuelve [{ fecha, orden, maquina, maquinaNombre }] o [] si el mes anterior
// no tiene paros.
function programarMes(mes, records, machines) {
  const prev = mesAnterior(mes);
  const rows = (records || []).filter((r) => String(r.record_date || "").slice(0, 7) === prev);
  if (!rows.length) return [];
  const minutos = new Map();
  for (const r of rows) {
    const c = String(r.machine_code || "").trim();
    if (!c) continue;
    if (r.downtime_minutes != null && !isNaN(r.downtime_minutes)) {
      minutos.set(c, (minutos.get(c) || 0) + Number(r.downtime_minutes));
    }
  }
  const nombres = new Map((machines || []).map((m) => [String(m.code || "").trim(), m.name || ""]));
  const con = [...minutos.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const sin = (machines || []).map((m) => String(m.code || "").trim()).filter((c) => c && !minutos.has(c));
  const habiles = diasHabiles(mes);
  const porDia = new Map();
  return [...con, ...sin].map((c, i) => {
    const fecha = habiles[i % habiles.length];
    const orden = porDia.get(fecha) || 0;
    porDia.set(fecha, orden + 1);
    return { fecha, orden, maquina: c, maquinaNombre: nombres.get(c) || "" };
  });
}

/* ---------- Lectura ---------- */

function colores(config) {
  return { ...COLORES_DEFAULT, ...((config && config.calendarios && config.calendarios.colores) || {}) };
}

function parseJson(v, def) {
  if (v === null || v === undefined) return def;
  try {
    return JSON.parse(v);
  } catch {
    return def;
  }
}

function tareaDeFila(r, col) {
  const t = {
    id: r.id,
    maquina: r.maquina_codigo,
    maquinaNombre: r.maquina_nombre || "",
    estado: r.estado || "",
    color: r.estado ? col[r.estado] || "" : "",
  };
  const tieneReporte =
    r.reporte_en !== null ||
    r.reporte_responsable !== null ||
    r.reporte_puntos !== null ||
    r.reporte_observaciones !== null ||
    r.reporte_evidencias !== null;
  if (tieneReporte) {
    t.reporte = {
      responsable: r.reporte_responsable || "",
      puntos: parseJson(r.reporte_puntos, []),
      observaciones: r.reporte_observaciones || "",
      evidencias: parseJson(r.reporte_evidencias, []).map((e) => ({ name: e.name, url: evidenciaUrl(e.name) })),
      por: r.reporte_por || "",
      en: r.reporte_en ? r.reporte_en.toISOString() : null,
    };
  }
  return t;
}

// Formato de la API: [{ id, mes, name, dias: { 'YYYY-MM-DD': [tarea, ...] } }]
async function listar(config) {
  const col = colores(config);
  const meses = await query("SELECT mes FROM preventivo_meses ORDER BY mes");
  const tareas = await query("SELECT * FROM preventivo_tareas ORDER BY mes, fecha, orden");
  const out = new Map(meses.map((m) => [m.mes, { id: m.mes, mes: m.mes, name: nombreMes(m.mes), dias: {} }]));
  for (const r of tareas) {
    const cal = out.get(r.mes);
    if (!cal) continue;
    (cal.dias[r.fecha] = cal.dias[r.fecha] || []).push(tareaDeFila(r, col));
  }
  return [...out.values()];
}

async function obtenerTarea(id) {
  const [r] = await query("SELECT * FROM preventivo_tareas WHERE id = ?", [id]);
  return r || null;
}

/* ---------- Meses ---------- */

function validarMes(mes) {
  const s = String(mes || "");
  if (!MES_RE.test(s)) throw new PreventivoError("Formato de mes invalido (YYYY-MM)");
  return s;
}

async function crearMes(mes, { user = null, conn = null } = {}) {
  mes = validarMes(mes);
  const now = new Date();
  const q = conn ? (s, p) => conn.query(s, p).then(([r]) => r) : query;
  const r = await q("INSERT IGNORE INTO preventivo_meses (mes, created_at, updated_at) VALUES (?, ?, ?)", [mes, now, now]);
  if (r.affectedRows && user) await auditoria.registrar({ user, accion: "crear_mes", entidad: "preventivo", entidadId: mes });
  return r.affectedRows > 0;
}

// Crea los meses desde el actual hasta diciembre (igual que el sistema original).
async function asegurarRestoAno(hoy = new Date()) {
  const y = hoy.getFullYear();
  for (let m = hoy.getMonth() + 1; m <= 12; m++) await crearMes(`${y}-${String(m).padStart(2, "0")}`);
}

async function eliminarMes(mes, { user, dataDir }) {
  mes = validarMes(mes);
  const evid = await evidenciasDeMes(mes);
  const r = await query("DELETE FROM preventivo_meses WHERE mes = ?", [mes]);
  if (!r.affectedRows) throw new PreventivoError("No encontrado", 404);
  borrarEvidencias(dataDir, evid);
  await auditoria.registrar({ user, accion: "eliminar_mes", entidad: "preventivo", entidadId: mes });
}

async function mesTieneAvance(mes, conn) {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS n FROM preventivo_tareas
     WHERE mes = ? AND (estado <> '' OR reporte_en IS NOT NULL)`,
    [mes]
  );
  return Number(r.n) > 0;
}

async function insertarTareas(conn, mes, tareas) {
  for (const t of tareas) {
    await conn.query(
      "INSERT INTO preventivo_tareas (mes, fecha, orden, maquina_codigo, maquina_nombre) VALUES (?, ?, ?, ?, ?)",
      [mes, t.fecha, t.orden, String(t.maquina).slice(0, 50), String(t.maquinaNombre || "").slice(0, 255) || null]
    );
  }
}

// Regenera (o limpia, con tareas = []) la agenda de un mes. Rechaza si el mes
// ya tiene estados o reportes.
async function reemplazarAgenda(mes, tareas, { user }) {
  mes = validarMes(mes);
  await tx(async (conn) => {
    const [[existe]] = await conn.query("SELECT mes FROM preventivo_meses WHERE mes = ? FOR UPDATE", [mes]);
    if (!existe) throw new PreventivoError("No encontrado", 404);
    if (await mesTieneAvance(mes, conn)) {
      throw new PreventivoError(
        `${nombreMes(mes)} ya tiene tareas marcadas o con reporte; no se puede regenerar ni limpiar.`,
        409
      );
    }
    await conn.query("DELETE FROM preventivo_tareas WHERE mes = ?", [mes]);
    await insertarTareas(conn, mes, tareas);
    await conn.query("UPDATE preventivo_meses SET updated_at = ? WHERE mes = ?", [new Date(), mes]);
    await auditoria.registrar(
      { user, accion: tareas.length ? "programar_mes" : "limpiar_mes", entidad: "preventivo", entidadId: mes, detalle: { tareas: tareas.length } },
      conn
    );
  });
}

// Llena los meses vacios cuyo mes anterior ya empezo. Devuelve los meses programados.
async function autoProgramar(records, machines, hoy = new Date()) {
  const actual = mesDe(hoy);
  const vacios = await query(
    `SELECT m.mes FROM preventivo_meses m
     WHERE NOT EXISTS (SELECT 1 FROM preventivo_tareas t WHERE t.mes = m.mes) ORDER BY m.mes`
  );
  const hechos = [];
  for (const { mes } of vacios) {
    if (mesAnterior(mes) >= actual) continue;
    const tareas = programarMes(mes, records, machines);
    if (!tareas.length) continue;
    const ok = await tx(async (conn) => {
      // Otra peticion pudo programarlo mientras tanto.
      const [[r]] = await conn.query("SELECT COUNT(*) AS n FROM preventivo_tareas WHERE mes = ?", [mes]);
      if (Number(r.n)) return false;
      await insertarTareas(conn, mes, tareas);
      await auditoria.registrar({ user: null, accion: "programar_mes", entidad: "preventivo", entidadId: mes, detalle: { tareas: tareas.length, automatica: true } }, conn);
      return true;
    });
    if (ok) hechos.push(nombreMes(mes));
  }
  return hechos;
}

/* ---------- Estado y reporte de una tarea ---------- */

async function marcarEstado(id, estado, { user }) {
  estado = String(estado || "");
  if (estado && !ESTADOS.includes(estado)) throw new PreventivoError("Estado invalido");
  const t = await obtenerTarea(id);
  if (!t) throw new PreventivoError("No encontrado", 404);
  await query("UPDATE preventivo_tareas SET estado = ?, estado_por = ?, estado_en = ? WHERE id = ?", [
    estado,
    user ? user.username : null,
    new Date(),
    id,
  ]);
  await auditoria.registrar({
    user,
    accion: "estado_tarea",
    entidad: "preventivo",
    entidadId: id,
    anterior: t.estado,
    nuevo: estado,
    detalle: { mes: t.mes, fecha: t.fecha, maquina: t.maquina_codigo },
  });
}

function texto(v, max, campo) {
  const s = String(v == null ? "" : v).trim();
  if ([...s].length > max) throw new PreventivoError(`${campo}: maximo ${max} caracteres`);
  return s;
}

function validarReporte(body) {
  const responsable = texto(body.responsable, 255, "Responsable");
  const observaciones = texto(body.observaciones, 5000, "Observaciones");
  const puntosIn = Array.isArray(body.puntos) ? body.puntos : [];
  if (puntosIn.length > MAX_PUNTOS) throw new PreventivoError(`Maximo ${MAX_PUNTOS} puntos a revisar`);
  const puntos = puntosIn
    .map((p) => ({ punto: texto(p && p.punto, 255, "Punto a revisar"), ok: Boolean(p && p.ok) }))
    .filter((p) => p.punto);
  const evIn = Array.isArray(body.evidencias) ? body.evidencias : [];
  if (evIn.length > MAX_EVIDENCIAS) throw new PreventivoError(`Maximo ${MAX_EVIDENCIAS} evidencias por reporte`);
  const evidencias = [];
  for (const e of evIn) {
    const name = String((e && e.name) || "");
    if (!EVIDENCIA_RE.test(name)) throw new PreventivoError("Evidencia invalida");
    if (!evidencias.some((x) => x.name === name)) evidencias.push({ name });
  }
  return { responsable, observaciones, puntos, evidencias };
}

async function guardarReporte(id, body, { user, dataDir }) {
  const rep = validarReporte(body || {});
  for (const e of rep.evidencias) {
    if (!fs.existsSync(evidenciaPath(dataDir, e.name))) throw new PreventivoError(`La evidencia ${e.name} no existe`);
  }
  const t = await obtenerTarea(id);
  if (!t) throw new PreventivoError("No encontrado", 404);
  await query(
    `UPDATE preventivo_tareas SET reporte_responsable = ?, reporte_puntos = ?, reporte_observaciones = ?,
       reporte_evidencias = ?, reporte_por = ?, reporte_en = ? WHERE id = ?`,
    [
      rep.responsable,
      JSON.stringify(rep.puntos),
      rep.observaciones,
      JSON.stringify(rep.evidencias),
      user ? user.username : null,
      new Date(),
      id,
    ]
  );
  // Las evidencias que se quitaron del reporte se borran del disco.
  const nuevas = new Set(rep.evidencias.map((e) => e.name));
  borrarEvidencias(dataDir, parseJson(t.reporte_evidencias, []).map((e) => e.name).filter((n) => !nuevas.has(n)));
  await auditoria.registrar({
    user,
    accion: t.reporte_en ? "editar_reporte" : "crear_reporte",
    entidad: "preventivo",
    entidadId: id,
    detalle: { mes: t.mes, fecha: t.fecha, maquina: t.maquina_codigo, puntosOk: rep.puntos.filter((p) => p.ok).length, puntos: rep.puntos.length, evidencias: rep.evidencias.length },
  });
}

/* ---------- Evidencias (archivos en DATA_DIR/preventivo-evidencias) ---------- */

function evidenciaDir(dataDir) {
  return path.join(dataDir, "preventivo-evidencias");
}

function evidenciaPath(dataDir, name) {
  return path.join(evidenciaDir(dataDir), path.basename(name));
}

function evidenciaUrl(name) {
  return `/api/preventivo/evidencia/${encodeURIComponent(name)}`;
}

// Tipo real por los primeros bytes (no por la extension que manda el navegador).
function tipoArchivo(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  return null;
}

const MIME_EVIDENCIA = { jpg: "image/jpeg", png: "image/png", pdf: "application/pdf" };

function guardarEvidencia(dataDir, base64) {
  const buf = Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (buf.length < 100) throw new PreventivoError("Archivo vacio o invalido");
  if (buf.length > MAX_EVIDENCIA_BYTES) throw new PreventivoError("Maximo 5 MB por archivo");
  const ext = tipoArchivo(buf);
  if (!ext) throw new PreventivoError("Solo se permiten imagenes (JPG/PNG) o PDF");
  const name = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.mkdirSync(evidenciaDir(dataDir), { recursive: true });
  fs.writeFileSync(evidenciaPath(dataDir, name), buf);
  return { name, url: evidenciaUrl(name), size: buf.length };
}

function leerEvidencia(dataDir, name) {
  if (!EVIDENCIA_RE.test(name)) return null;
  const fp = evidenciaPath(dataDir, name);
  if (!fs.existsSync(fp)) return null;
  return { buf: fs.readFileSync(fp), mime: MIME_EVIDENCIA[path.extname(name).slice(1)] };
}

function borrarEvidencias(dataDir, names) {
  for (const n of names) {
    if (!EVIDENCIA_RE.test(n)) continue;
    try {
      fs.unlinkSync(evidenciaPath(dataDir, n));
    } catch {}
  }
}

async function evidenciasDeMes(mes) {
  const rows = await query("SELECT reporte_evidencias FROM preventivo_tareas WHERE mes = ? AND reporte_evidencias IS NOT NULL", [mes]);
  return rows.flatMap((r) => parseJson(r.reporte_evidencias, []).map((e) => e.name));
}

module.exports = {
  PreventivoError,
  ESTADOS,
  mesDe,
  mesAnterior,
  nombreMes,
  diasHabiles,
  programarMes,
  listar,
  crearMes,
  asegurarRestoAno,
  eliminarMes,
  reemplazarAgenda,
  autoProgramar,
  marcarEstado,
  guardarReporte,
  guardarEvidencia,
  leerEvidencia,
  insertarTareas,
};
