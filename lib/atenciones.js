"use strict";

// Atencion de paros por el operador de mantenimiento.
//
//   codigo de reporte -> validar -> ACEPTAR (EN_ATENCION) -> capturar trabajo +
//   evidencia -> FINALIZAR (codigo de cierre) -> la terminal valida el codigo (CERRADA)
//
// El reporte (paro) es del sistema externo (koide): aqui nunca se modifica.
// Se guarda la atencion + una copia del reporte al aceptarlo (trazabilidad).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { query, tx } = require("./db");

const FUENTE = "koide";
const ESTADOS = { EN_ATENCION: "EN_ATENCION", FINALIZADA: "FINALIZADA", CERRADA: "CERRADA" };

// Mismas reglas de evidencia que las contramedidas (server.js /fotos y app.js saveComplete).
const MAX_FOTOS = 2;
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

class AtencionError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ---------- Codigo de reporte ---------- */

// NO DETERMINADO — REQUIERE VERIFICACION: el formato del codigo que muestra la
// terminal. Hoy el unico identificador del paro disponible es el id del registro
// de koide (/api/downtime-records), asi que el codigo de reporte = ese id.
// Si la terminal usa otro codigo, solo hay que cambiar esta funcion y
// buscarReporte() en server.js.
function normalizarCodigoReporte(input) {
  const s = String(input == null ? "" : input).trim().replace(/^#/, "");
  if (!/^\d{1,10}$/.test(s)) return null;
  return String(Number(s));
}

function reporteResumen(r) {
  return {
    codigo: String(r.id),
    maquina: r.machine_code || null,
    maquinaNombre: r.machine_name || null,
    proceso: r.machine_process || null,
    fecha: r.record_date || null,
    turno: r.shift || null,
    grupo: r.group_name || null,
    categoria: r.downtime_category || null,
    descripcion: r.problem_description || null,
    reportadoPor: r.operator_name || null,
    inicio: r.downtime_start || null,
    estadoFuente: r.status || null,
  };
}

// Un paro puede atenderse mientras siga abierto en la fuente.
function motivoNoAtendible(r) {
  if (r.responsible_area && r.responsible_area !== "Mantenimiento") return "El reporte no es del area de Mantenimiento";
  if (r.downtime_end || String(r.status || "").trim() === "Finalizado") return "El paro ya esta finalizado en el sistema de captura";
  return null;
}

/* ---------- Codigo de cierre ---------- */

// Sin caracteres ambiguos (0/O, 1/I/L). 31^8 ~ 8.5e11 combinaciones.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generarCodigoCierre() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return s;
}

function formatoCierre(codigo) {
  return codigo ? `C-${codigo.slice(0, 4)}-${codigo.slice(4)}` : null;
}

function normalizarCodigoCierre(input) {
  let s = String(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 9 && s[0] === "C") s = s.slice(1);
  if (s.length !== 8 || [...s].some((c) => !ALFABETO.includes(c))) return null;
  return s;
}

/* ---------- Lectura ---------- */

function atencionPublica(a, fotos = []) {
  return {
    id: a.id,
    estado: a.estado,
    codigoReporte: a.codigo_reporte,
    reporte: reporteResumen(JSON.parse(a.reporte_snapshot)),
    aceptadoPor: a.aceptado_por_nombre || null,
    aceptadoEn: a.aceptado_en ? a.aceptado_en.toISOString() : null,
    tecnicoNumeroEmpleado: a.tecnico_numero_empleado,
    tecnicoNombre: a.tecnico_nombre,
    actionTaken: a.action_taken,
    comments: a.comments,
    finalizadoEn: a.finalizado_en ? a.finalizado_en.toISOString() : null,
    responseTimeMinutes: a.response_time_minutes,
    repairTimeMinutes: a.repair_time_minutes,
    codigoCierre: formatoCierre(a.codigo_cierre),
    cierreConfirmadoEn: a.cierre_confirmado_en ? a.cierre_confirmado_en.toISOString() : null,
    fotos: fotos.map((f) => ({ tipo: f.tipo, nombre: f.nombre, url: `/api/operador/atenciones/${a.id}/fotos/${encodeURIComponent(f.nombre)}` })),
  };
}

const SELECT_ATENCION = `SELECT a.*, u.nombre AS aceptado_por_nombre FROM paro_atenciones a
  JOIN usuarios u ON u.id = a.aceptado_por_usuario_id`;

async function atencionPorReporte(ref) {
  const [a] = await query(`${SELECT_ATENCION} WHERE a.fuente = ? AND a.reporte_ref = ?`, [FUENTE, ref]);
  return a || null;
}

async function fotosDe(id) {
  return query("SELECT tipo, nombre FROM paro_atencion_fotos WHERE atencion_id = ? ORDER BY id", [id]);
}

function puedeVer(a, user) {
  return user.rol === "mantenimiento_admin" || a.aceptado_por_usuario_id === user.id;
}

/* ---------- Casos de uso ---------- */

// buscar(codigo) -> { record, aviso } | null   (inyectado desde server.js)
async function consultar(codigoInput, user, buscar) {
  const codigo = normalizarCodigoReporte(codigoInput);
  if (!codigo) throw new AtencionError(400, "Codigo de reporte invalido");
  const existente = await atencionPorReporte(codigo);
  const found = await buscar(codigo);
  if (!found && !existente) throw new AtencionError(404, "No existe un reporte con ese codigo");
  const record = found ? found.record : JSON.parse(existente.reporte_snapshot);
  let motivo = null;
  if (existente) {
    motivo =
      existente.estado === ESTADOS.EN_ATENCION
        ? `El reporte ya fue aceptado por ${existente.aceptado_por_nombre}`
        : "El reporte ya fue atendido";
  } else {
    motivo = motivoNoAtendible(record);
  }
  return {
    codigo,
    reporte: reporteResumen(record),
    puedeAceptar: !motivo,
    motivo,
    aviso: found ? found.aviso || null : null,
    atencion: existente && puedeVer(existente, user) ? atencionPublica(existente, await fotosDe(existente.id)) : null,
  };
}

async function aceptar(codigoInput, user, buscar) {
  const codigo = normalizarCodigoReporte(codigoInput);
  if (!codigo) throw new AtencionError(400, "Codigo de reporte invalido");
  const found = await buscar(codigo);
  const previa = await atencionPorReporte(codigo);
  if (previa) {
    throw new AtencionError(409, previa.estado === ESTADOS.EN_ATENCION ? `El reporte ya fue aceptado por ${previa.aceptado_por_nombre}` : "El reporte ya fue atendido");
  }
  if (!found) throw new AtencionError(404, "No existe un reporte con ese codigo");
  const record = found.record;
  const motivo = motivoNoAtendible(record);
  if (motivo) throw new AtencionError(409, motivo);

  const now = new Date();
  const start = record.downtime_start ? new Date(record.downtime_start) : null;
  let id;
  try {
    id = await tx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO paro_atenciones (fuente, reporte_ref, codigo_reporte, estado, reporte_snapshot, machine_code, machine_name,
           downtime_start, aceptado_por_usuario_id, aceptado_en, tecnico_numero_empleado, tecnico_nombre, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          FUENTE,
          String(record.id),
          codigo,
          ESTADOS.EN_ATENCION,
          JSON.stringify(record),
          record.machine_code || null,
          record.machine_name || null,
          start && !isNaN(start) ? start : null,
          user.id,
          now,
          user.numeroEmpleado || null,
          user.nombre,
          now,
          now,
        ]
      );
      await conn.query("INSERT INTO paro_atencion_eventos (atencion_id, evento, usuario_id, detalle, creado) VALUES (?, 'ACEPTADO', ?, ?, ?)", [
        r.insertId,
        user.id,
        `Reporte ${codigo}`,
        now,
      ]);
      return r.insertId;
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const a = await atencionPorReporte(codigo);
      throw new AtencionError(409, `El reporte ya fue aceptado por ${a ? a.aceptado_por_nombre : "otro usuario"}`);
    }
    throw err;
  }
  return obtener(id, user);
}

async function obtener(id, user) {
  const [a] = await query(`${SELECT_ATENCION} WHERE a.id = ?`, [Number(id)]);
  if (!a || !puedeVer(a, user)) throw new AtencionError(404, "Atencion no encontrada");
  return atencionPublica(a, await fotosDe(a.id));
}

async function misAtenciones(user) {
  const where = user.rol === "mantenimiento_admin" ? "" : "WHERE a.aceptado_por_usuario_id = ?";
  const params = user.rol === "mantenimiento_admin" ? [] : [user.id];
  const abiertas = await query(`${SELECT_ATENCION} ${where ? where + " AND" : "WHERE"} a.estado = 'EN_ATENCION' ORDER BY a.aceptado_en`, params);
  const recientes = await query(`${SELECT_ATENCION} ${where ? where + " AND" : "WHERE"} a.estado <> 'EN_ATENCION' ORDER BY a.finalizado_en DESC LIMIT 10`, params);
  return {
    abiertas: abiertas.map((a) => atencionPublica(a)),
    recientes: recientes.map((a) => atencionPublica(a)),
  };
}

function prepararFotos(fotos) {
  if (!Array.isArray(fotos)) return [];
  if (fotos.length > MAX_FOTOS) throw new AtencionError(400, `Maximo ${MAX_FOTOS} fotos`);
  return fotos.map((f) => {
    const tipo = f && f.tipo === "despues" ? "despues" : f && f.tipo === "antes" ? "antes" : null;
    if (!tipo) throw new AtencionError(400, "Cada foto debe indicar tipo 'antes' o 'despues'");
    const m = String(f.name || "").match(/\.(jpe?g|png)$/i);
    if (!m) throw new AtencionError(400, "Solo se aceptan fotos JPG o PNG");
    const buf = Buffer.from(String(f.base64 || ""), "base64");
    if (buf.length < 100) throw new AtencionError(400, "Foto vacia o invalida");
    if (buf.length > MAX_FOTO_BYTES) throw new AtencionError(400, "La foto excede 5 MB");
    const esPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const esJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!esPng && !esJpg) throw new AtencionError(400, "El archivo no es una imagen JPG/PNG valida");
    const ext = esPng ? "png" : "jpg";
    return { tipo, buf, nombre: `${tipo}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}.${ext}` };
  });
}

async function finalizar(id, user, body, dataDir) {
  const actionTaken = String((body && body.actionTaken) || "").trim();
  const comments = String((body && body.comments) || "").trim();
  if (!actionTaken) throw new AtencionError(400, "Escribe la descripcion del trabajo realizado");
  if (actionTaken.length > 5000 || comments.length > 5000) throw new AtencionError(400, "Texto demasiado largo (max. 5000)");
  const fotos = prepararFotos(body && body.fotos);

  const [a] = await query("SELECT * FROM paro_atenciones WHERE id = ?", [Number(id)]);
  if (!a || !puedeVer(a, user)) throw new AtencionError(404, "Atencion no encontrada");
  if (a.estado !== ESTADOS.EN_ATENCION) throw new AtencionError(409, "La atencion ya fue finalizada");

  // Archivos primero; si la transaccion falla se borran (no quedan huerfanos).
  const dir = path.join(dataDir, "atenciones-fotos", String(a.id));
  const escritos = [];
  try {
    if (fotos.length) fs.mkdirSync(dir, { recursive: true });
    for (const f of fotos) {
      fs.writeFileSync(path.join(dir, f.nombre), f.buf);
      escritos.push(path.join(dir, f.nombre));
    }
    const now = new Date();
    const resp = a.downtime_start ? Math.round((a.aceptado_en - a.downtime_start) / 60000) : null;
    const rep = Math.round((now - a.aceptado_en) / 60000);
    for (let intento = 0; ; intento++) {
      const codigo = generarCodigoCierre();
      try {
        await tx(async (conn) => {
          const [r] = await conn.query(
            `UPDATE paro_atenciones SET estado = 'FINALIZADA', action_taken = ?, comments = ?, finalizado_por_usuario_id = ?,
               finalizado_en = ?, response_time_minutes = ?, repair_time_minutes = ?, codigo_cierre = ?, updated_at = ?
             WHERE id = ? AND estado = 'EN_ATENCION'`,
            [actionTaken, comments || null, user.id, now, resp, rep, codigo, now, a.id]
          );
          if (!r.affectedRows) throw new AtencionError(409, "La atencion ya fue finalizada");
          for (const f of fotos) {
            await conn.query("INSERT INTO paro_atencion_fotos (atencion_id, tipo, nombre, ruta, creada) VALUES (?, ?, ?, ?, ?)", [
              a.id,
              f.tipo,
              f.nombre,
              `atenciones-fotos/${a.id}/${f.nombre}`,
              now,
            ]);
          }
          await conn.query("INSERT INTO paro_atencion_eventos (atencion_id, evento, usuario_id, detalle, creado) VALUES (?, 'FINALIZADO', ?, ?, ?)", [
            a.id,
            user.id,
            `Codigo de cierre ${formatoCierre(codigo)}`,
            now,
          ]);
        });
        break;
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY" && /cierre/.test(err.message) && intento < 5) continue;
        throw err;
      }
    }
  } catch (err) {
    for (const f of escritos) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    throw err;
  }
  return obtener(a.id, user);
}

function rutaFoto(dataDir, id, nombre) {
  if (!/^\d+$/.test(String(id))) return null;
  const base = path.basename(String(nombre || ""));
  if (!base || base !== nombre) return null;
  return path.join(dataDir, "atenciones-fotos", String(id), base);
}

async function fotoDe(id, nombre, user, dataDir) {
  const [a] = await query("SELECT id, aceptado_por_usuario_id FROM paro_atenciones WHERE id = ?", [Number(id)]);
  if (!a || !puedeVer(a, user)) return null;
  const [f] = await query("SELECT nombre FROM paro_atencion_fotos WHERE atencion_id = ? AND nombre = ?", [a.id, nombre]);
  if (!f) return null;
  const fp = rutaFoto(dataDir, a.id, f.nombre);
  return fp && fs.existsSync(fp) ? fp : null;
}

// La terminal de produccion valida el codigo de cierre que le dicta mantenimiento.
async function validarCierre(codigoInput, { terminal, codigoReporte } = {}) {
  const codigo = normalizarCodigoCierre(codigoInput);
  if (!codigo) throw new AtencionError(400, "Formato de codigo de cierre invalido", { valido: false });
  const [a] = await query(`${SELECT_ATENCION} WHERE a.codigo_cierre = ?`, [codigo]);
  if (!a) throw new AtencionError(404, "Codigo de cierre no encontrado", { valido: false });
  if (codigoReporte != null && String(codigoReporte) !== "") {
    const ref = normalizarCodigoReporte(codigoReporte);
    if (ref !== a.codigo_reporte) throw new AtencionError(409, "El codigo de cierre no corresponde a ese reporte", { valido: false });
  }
  let yaConfirmado = a.estado === ESTADOS.CERRADA;
  if (!yaConfirmado) {
    const now = new Date();
    await tx(async (conn) => {
      const [r] = await conn.query(
        "UPDATE paro_atenciones SET estado = 'CERRADA', cierre_confirmado_en = ?, cierre_confirmado_por = ?, updated_at = ? WHERE id = ? AND estado = 'FINALIZADA'",
        [now, terminal ? String(terminal).slice(0, 100) : null, now, a.id]
      );
      if (r.affectedRows) {
        await conn.query("INSERT INTO paro_atencion_eventos (atencion_id, evento, usuario_id, detalle, creado) VALUES (?, 'CIERRE_VALIDADO', NULL, ?, ?)", [
          a.id,
          `Terminal: ${terminal || "(sin identificar)"}`,
          now,
        ]);
      } else {
        yaConfirmado = true;
      }
    });
  }
  const [b] = await query(`${SELECT_ATENCION} WHERE a.id = ?`, [a.id]);
  return {
    valido: true,
    yaConfirmado,
    estado: b.estado,
    codigoReporte: b.codigo_reporte,
    codigoCierre: formatoCierre(b.codigo_cierre),
    maquina: b.machine_code,
    tecnico: b.tecnico_nombre,
    tecnicoNumeroEmpleado: b.tecnico_numero_empleado,
    aceptadoEn: b.aceptado_en.toISOString(),
    finalizadoEn: b.finalizado_en ? b.finalizado_en.toISOString() : null,
    cierreConfirmadoEn: b.cierre_confirmado_en ? b.cierre_confirmado_en.toISOString() : null,
    responseTimeMinutes: b.response_time_minutes,
    repairTimeMinutes: b.repair_time_minutes,
    actionTaken: b.action_taken,
  };
}

module.exports = {
  AtencionError,
  ESTADOS,
  normalizarCodigoReporte,
  normalizarCodigoCierre,
  formatoCierre,
  consultar,
  aceptar,
  obtener,
  misAtenciones,
  finalizar,
  fotoDe,
  validarCierre,
};
