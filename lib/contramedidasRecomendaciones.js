"use strict";

// DETECCION de contramedidas: ¿algun equipo supero el umbral?
//
// Segun CONTRAMEDIDAS_FUENTE (lib/contramedidasFuente.js):
//   local  se calcula aqui (lib/contramedidasLocal.js) con el umbral de
//          Configuracion del sistema;
//   mes    la calcula KOIDE MES y aqui solo se consume.
// Con cualquier fuente, cada recomendacion se identifica por su CICLO:
//
//   ciclo = "EQUIPO|categoria#<id de la contramedida previa (local o del MES), o 0>"
//
// El ciclo solo cambia cuando se registra una contramedida para ese equipo
// + categoria (cobertura). Mientras no cambie es LA MISMA acumulacion, aunque
// sigan sumandose horas: por eso una acumulacion genera a lo mas una propuesta.

const historico = require("./historico");
const store = require("./store");
const fuenteCm = require("./contramedidasFuente");
const local = require("./contramedidasLocal");
const configuracion = require("./configuracion");
const planificacion = require("./contramedidasPlanificacion");

function cicloDe(r) {
  return `${r.clave}#${r.contramedidaPrevia && r.contramedidaPrevia.id != null ? r.contramedidaPrevia.id : 0}`;
}

// Recomendaciones vigentes, cada una con su ciclo.
async function detectar() {
  const d = fuenteCm.esMes()
    ? await historico.recomendaciones()
    : await local.recomendaciones(await configuracion.obtener(configuracion.CLAVE_UMBRAL));
  return { ...d, recomendaciones: (d.recomendaciones || []).map((r) => ({ ...r, ciclo: cicloDe(r) })) };
}

function resumenPropuesta(p) {
  return {
    estado: p.estado, propuestaId: p.id, origen: p.origen, fechaPropuesta: p.fechaPropuesta, fechaConfirmada: p.fechaConfirmada,
    motivo: p.motivo, resueltaPor: p.resueltaPor, resueltaEn: p.resueltaEn,
  };
}

// Para la pantalla: cada recomendacion con el estado de su programacion.
//   PENDIENTE_APROBACION | EN_APROBACION | CONFIRMADA | RECHAZADA  (hay propuesta)
//   SIN_FECHA            la busqueda automatica no encontro fecha: solo manual
//   SIN_PROPUESTA        hay fecha libre; se propondra en la siguiente ejecucion
//   AUTOMATICA_INACTIVA  la programacion automatica esta apagada
async function conProgramacion({ hoy } = {}) {
  const d = await detectar();
  const propuestas = new Map((await store.listPropuestas({ ciclos: d.recomendaciones.map((r) => r.ciclo) })).map((p) => [p.ciclo, p]));
  const faltan = d.recomendaciones.filter((r) => !propuestas.has(r.ciclo));
  let opciones = null;
  let ocup = null;
  if (faltan.length) {
    opciones = await planificacion.opciones({ hoy });
    if (opciones.activa) ocup = await planificacion.ocupacion();
  }
  const recomendaciones = d.recomendaciones.map((r) => {
    const p = propuestas.get(r.ciclo);
    if (p) return { ...r, programacion: resumenPropuesta(p) };
    if (!opciones.activa) return { ...r, programacion: { estado: "AUTOMATICA_INACTIVA" } };
    const fecha = planificacion.buscarFecha(opciones, ocup, r.equipo);
    return { ...r, programacion: fecha ? { estado: "SIN_PROPUESTA", fechaDisponible: fecha } : { estado: "SIN_FECHA" } };
  });
  return { ...d, fuente: fuenteCm.fuente(), recomendaciones };
}

module.exports = { cicloDe, detectar, conProgramacion };
