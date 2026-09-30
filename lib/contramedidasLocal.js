"use strict";

// DETECCION LOCAL de contramedidas (CONTRAMEDIDAS_FUENTE=local): la misma regla
// que KOIDE MES (mttoContramedidaService), calculada sobre la copia local de
// los paros (tabla tiempo_muerto).
//
//   * Se agrupan los paros TERMINADOS (con inicio y fin) por EQUIPO + CATEGORIA
//     y se suma su tiempo (fin - inicio). Paros sin categoria no acumulan.
//   * Recomienda cuando horas >= umbral (alcanzaUmbral).
//   * COBERTURA: una contramedida local registrada desde una recomendacion
//     (contramedidas.recomendacion_clave = "EQUIPO|categoria") cubre los paros
//     con inicio <= su fecha de creacion; la recomendacion vuelve a aparecer
//     solo con horas nuevas. Borrar esa contramedida quita la cobertura (como
//     una contramedida CANCELADA en el MES).
//
// La clave usa el codigo de categoria del MES ("Falla mecánica" ->
// "falla_mecanica"), asi que las contramedidas ya registradas siguen cubriendo.

const { query } = require("./db");
const store = require("./store");

// Regla de DETECCION (unica en este sistema).
function alcanzaUmbral(horas, umbral) {
  return Number(horas) >= Number(umbral);
}

function codigoCategoria(nombre) {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function redondea(x, d = 1) {
  const f = 10 ** d;
  return Math.round(Number(x) * f) / f;
}

// Ultima contramedida por clave: { id, cubreHasta(ms), iso }.
async function coberturas() {
  const cob = new Map();
  for (const c of await store.listContramedidas()) {
    if (!c.recomendacionClave || !c.creada) continue;
    const ms = Date.parse(c.creada);
    if (!Number.isFinite(ms)) continue;
    const prev = cob.get(c.recomendacionClave);
    if (!prev || ms > prev.ms) cob.set(c.recomendacionClave, { id: c.id, ms, iso: new Date(ms).toISOString() });
  }
  return cob;
}

async function acumulacion(umbral) {
  const [paros, cob, maquinas] = await Promise.all([
    query(`SELECT id, machine_code, downtime_category, downtime_start, downtime_end,
                  TIMESTAMPDIFF(SECOND, downtime_start, downtime_end) / 60 AS minutos
             FROM tiempo_muerto
            WHERE downtime_start IS NOT NULL AND downtime_end IS NOT NULL AND downtime_end >= downtime_start
              AND machine_code IS NOT NULL AND machine_code <> ''
              AND downtime_category IS NOT NULL AND downtime_category <> ''`),
    coberturas(),
    query("SELECT id, code, name, process FROM maquinas"),
  ]);
  const eqPor = new Map(maquinas.map((m) => [m.code, m]));
  const grupos = new Map();
  for (const p of paros) {
    const cat = codigoCategoria(p.downtime_category);
    if (!cat) continue;
    const clave = `${p.machine_code}|${cat}`;
    const c = cob.get(clave) || null;
    if (c && p.downtime_start.getTime() <= c.ms) continue; // cubierto por una contramedida
    if (!grupos.has(clave)) grupos.set(clave, { clave, codigo: p.machine_code, cat, catNombre: p.downtime_category, minutos: 0, paros: 0, desde: null, hasta: null, ids: [], cobertura: c });
    const g = grupos.get(clave);
    g.minutos += Number(p.minutos) || 0;
    g.paros += 1;
    g.ids.push(p.id);
    if (!g.desde || p.downtime_start < g.desde) g.desde = p.downtime_start;
    if (!g.hasta || p.downtime_end > g.hasta) g.hasta = p.downtime_end;
  }
  const filas = [...grupos.values()].map((g) => {
    const e = eqPor.get(g.codigo);
    const horas = redondea(g.minutos / 60, 1);
    const alcanza = alcanzaUmbral(horas, umbral);
    return {
      clave: g.clave,
      equipo: { id: e ? e.id : null, codigo: g.codigo, nombre: e ? e.name : null, proceso: e ? e.process : null, idMaquina: null, area: null, ubicacion: null },
      categoria: { codigo: g.cat, nombre: g.catNombre },
      horasAcumuladas: horas,
      minutosAcumulados: Math.round(g.minutos),
      paros: g.paros,
      parosIds: g.ids,
      desde: g.desde ? g.desde.toISOString() : null,
      hasta: g.hasta ? g.hasta.toISOString() : null,
      umbralHoras: umbral,
      alcanzaUmbral: alcanza,
      contramedidaPrevia: g.cobertura ? { id: g.cobertura.id, cubreHasta: g.cobertura.iso } : null,
      recomendacion: alcanza ? `${g.codigo} — ${g.catNombre} — ${horas} h acumuladas. Se recomienda programar una contramedida / mantenimiento profundo.` : null,
    };
  }).sort((a, b) => b.horasAcumuladas - a.horasAcumuladas);
  return { umbralHoras: umbral, filas };
}

// Mismo formato que GET /contramedidas/recomendaciones del MES.
async function recomendaciones(umbral) {
  const a = await acumulacion(umbral);
  const filas = a.filas.filter((f) => f.alcanzaUmbral);
  return { umbralHoras: a.umbralHoras, total: filas.length, recomendaciones: filas };
}

module.exports = { alcanzaUmbral, codigoCategoria, acumulacion, recomendaciones };
