"use strict";

// Bitacora de cambios importantes (tabla `auditoria`, mig 007): quien, cuando,
// que accion, sobre que entidad y valor anterior/nuevo. Complementa el log de
// archivo (server.js log()) con un registro consultable.

const { query } = require("./db");

function texto(v) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

// user: usuario con sesion, o null para acciones del sistema (programacion automatica).
async function registrar({ user, accion, entidad, entidadId = null, anterior = null, nuevo = null, detalle = null }, conn) {
  const sql = `INSERT INTO auditoria (en, usuario, rol, accion, entidad, entidad_id, valor_anterior, valor_nuevo, detalle)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [new Date(), user ? user.username : "sistema", user ? user.rol : null, accion, entidad,
    entidadId === null ? null : String(entidadId), texto(anterior), texto(nuevo), texto(detalle)];
  if (conn) await conn.query(sql, params);
  else await query(sql, params);
}

async function listar({ entidad, entidadId, limite = 100 } = {}) {
  const where = [];
  const params = [];
  if (entidad) { where.push("entidad = ?"); params.push(entidad); }
  if (entidadId) { where.push("entidad_id = ?"); params.push(String(entidadId)); }
  const n = Math.min(Math.max(Number(limite) || 100, 1), 500);
  const rows = await query(
    `SELECT id, en, usuario, rol, accion, entidad, entidad_id, valor_anterior, valor_nuevo, detalle FROM auditoria
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${n}`, params);
  return rows.map((r) => ({
    id: Number(r.id), en: r.en.toISOString(), usuario: r.usuario, rol: r.rol, accion: r.accion, entidad: r.entidad,
    entidadId: r.entidad_id, anterior: r.valor_anterior, nuevo: r.valor_nuevo, detalle: r.detalle,
  }));
}

module.exports = { registrar, listar };
