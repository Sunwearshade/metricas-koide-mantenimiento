"use strict";

// PLANIFICACION de contramedidas: ¿existe una fecha disponible?
//
// No detecta (eso es KOIDE MES: lib/contramedidasRecomendaciones.js) ni aprueba
// (lib/contramedidasAprobacion.js). Solo responde que dias estan libres.
//
// Un dia es candidato si:
//   * esta entre manana y manana + horizonte - 1 (nunca hoy ni el pasado),
//   * su dia de la semana esta permitido (Configuracion del sistema),
//   * la planta no llego al maximo de contramedidas ese dia (contramedidas
//     abiertas con fecha + propuestas pendientes de aprobacion),
//   * el mismo equipo no tiene ya otra contramedida / propuesta ese dia,
//   * el calendario de mantenimiento (Excel) no tiene una actividad del mismo
//     equipo ese dia (mantenimiento incompatible).
// Si ningun dia cumple, devuelve null: NUNCA inventa una fecha.

const store = require("./store");
const configuracion = require("./configuracion");

/* ---------- Fechas (dia de planta = hora local del servidor) ---------- */

function fechaLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 1 = lunes ... 7 = domingo
function diaSemana(fecha) {
  const w = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

/* ---------- Equipos: comparacion tolerante (Excel escrito a mano) ---------- */

function normaliza(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// ¿La etiqueta de una fila del calendario se refiere a este equipo? Coincide
// por codigo o nombre como palabra completa ("M1" no coincide con "M10").
function etiquetaEsEquipo(etiqueta, equipo) {
  const e = ` ${normaliza(etiqueta)} `;
  if (e.trim() === "") return false;
  return [equipo.codigo, equipo.nombre].some((x) => {
    const n = normaliza(x);
    return n !== "" && e.includes(` ${n} `);
  });
}

/* ---------- Calendario de mantenimiento (Excel) -> actividades con fecha ----------
 * Misma lectura que la agenda semanal de la pantalla (public/app.js,
 * agendaSemanal): una celda con fecha en el encabezado (filas 1-4) marca la
 * columna; cada celda con texto debajo es una actividad de esa fecha y su
 * equipo es la etiqueta de texto mas cercana a la izquierda. */

function excelSerialToISO(serial) {
  const d = new Date(Date.UTC(1899, 11, 30));
  d.setUTCDate(d.getUTCDate() + Math.floor(serial));
  return d.toISOString().slice(0, 10);
}

function cellVDate(cell) {
  if (!cell || cell.t !== "n" || typeof cell.v !== "number") return null;
  return cell.v >= 20000 && cell.v <= 80000 ? excelSerialToISO(cell.v) : null;
}

function addrRC(addr) {
  const m = String(addr).match(/^([A-Z]+)(\d+)$/);
  if (!m) return { r: -1, c: -1 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { r: +m[2] - 1, c: col - 1 };
}

function colName(c) {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function rowLabel(cells, r, c) {
  for (let cc = c - 1; cc >= 0; cc--) {
    const cell = cells[colName(cc) + (r + 1)];
    if (cell && cell.w && !cellVDate(cell)) return String(cell.w).trim();
  }
  return "";
}

function actividadesCalendario(calendarios) {
  const out = [];
  for (const cal of calendarios || []) {
    for (const sh of cal.sheets || []) {
      const cells = sh.cells || {};
      const maxRow = sh.maxRow != null ? sh.maxRow : 60;
      for (const addr of Object.keys(cells)) {
        const fecha = cellVDate(cells[addr]);
        if (!fecha) continue;
        const { r, c } = addrRC(addr);
        if (r <= 3) {
          for (let rr = r + 1; rr <= maxRow; rr++) {
            const cell2 = cells[colName(c) + (rr + 1)];
            if (cell2 && cell2.w) out.push({ fecha, equipo: rowLabel(cells, rr, c), actividad: String(cell2.w).trim(), calendario: cal.name });
          }
        } else {
          out.push({ fecha, equipo: rowLabel(cells, r, c), actividad: String(cells[addr].w || "").trim(), calendario: cal.name });
        }
      }
    }
  }
  return out;
}

/* ---------- Ocupacion ---------- */

// Todo lo que ya ocupa dias. `excluirPropuestaId`: la propuesta que se esta
// reprogramando/aprobando no compite contra si misma.
async function ocupacion({ excluirPropuestaId = null } = {}) {
  const [cms, propuestas, calendarios] = await Promise.all([
    store.listContramedidas(),
    store.listPropuestas({ estados: ["PENDIENTE_APROBACION", "EN_APROBACION"] }),
    store.listCalendarios(),
  ]);
  const programadas = [];
  for (const c of cms) {
    if (c.estado === "Completado" || !c.fechaLimite) continue;
    programadas.push({ fecha: c.fechaLimite, equipo: c.maquina || c.referencia || "" });
  }
  for (const p of propuestas) {
    if (!p.fechaPropuesta || p.id === excluirPropuestaId) continue;
    programadas.push({ fecha: p.fechaPropuesta, equipo: p.equipo.codigo });
  }
  return { programadas, calendario: actividadesCalendario(calendarios) };
}

// Motivo por el que un dia NO sirve, o null si esta disponible (funcion pura).
function motivoNoDisponible(fecha, { hoy, diasPermitidos, horizonteDias, maxPorDia }, ocup, equipo) {
  const primero = sumarDias(hoy, 1);
  const ultimo = sumarDias(hoy, horizonteDias);
  if (fecha < primero) return "La fecha debe ser posterior a hoy";
  if (fecha > ultimo) return `Fuera del horizonte de programación (${horizonteDias} días)`;
  if (!diasPermitidos.includes(diaSemana(fecha))) return "Día de la semana no permitido para mantenimiento";
  const delDia = ocup.programadas.filter((x) => x.fecha === fecha);
  const eq = normaliza(equipo.codigo);
  if (delDia.some((x) => normaliza(x.equipo) === eq)) return "El equipo ya tiene otra contramedida ese día";
  if (delDia.length >= maxPorDia) return `Ese día ya tiene ${delDia.length} contramedida(s) programada(s) (máximo ${maxPorDia})`;
  const act = ocup.calendario.find((x) => x.fecha === fecha && etiquetaEsEquipo(x.equipo, equipo));
  if (act) return `El calendario de mantenimiento tiene "${act.actividad}" para este equipo ese día`;
  return null;
}

// Todas las fechas disponibles del horizonte, en orden (funcion pura).
function fechasDisponibles(opciones, ocup, equipo) {
  const out = [];
  for (let i = 1; i <= opciones.horizonteDias; i++) {
    const f = sumarDias(opciones.hoy, i);
    if (!motivoNoDisponible(f, opciones, ocup, equipo)) out.push(f);
  }
  return out;
}

// Primera fecha disponible o null (funcion pura).
function buscarFecha(opciones, ocup, equipo) {
  return fechasDisponibles(opciones, ocup, equipo)[0] || null;
}

// Opciones vigentes desde Configuracion del sistema.
async function opciones({ hoy } = {}) {
  const cfg = await configuracion.programacion();
  return { ...cfg, hoy: hoy || fechaLocal() };
}

module.exports = {
  fechaLocal, sumarDias, diaSemana, etiquetaEsEquipo, actividadesCalendario,
  ocupacion, motivoNoDisponible, fechasDisponibles, buscarFecha, opciones,
};
