"use strict";

// PROGRAMACION AUTOMATICA: une deteccion (MES) y planificacion (fechas) y deja
// PROPUESTAS pendientes de aprobacion. Nunca confirma: eso lo hace un
// administrador (lib/contramedidasAprobacion.js).
//
// Idempotente: una propuesta por ciclo (UNIQUE ciclo + INSERT IGNORE). Si el
// ciclo ya tiene propuesta en cualquier estado (pendiente, confirmada o
// rechazada) no se vuelve a proponer. Si no hay fecha disponible no se guarda
// nada: la recomendacion queda para programacion manual y se reintenta en la
// siguiente ejecucion (puede liberarse un dia).

const store = require("./store");
const auditoria = require("./auditoria");
const recomendaciones = require("./contramedidasRecomendaciones");
const planificacion = require("./contramedidasPlanificacion");

// Evita dos ejecuciones simultaneas en este proceso (temporizador + pantalla).
let enCurso = null;

async function ejecutar({ hoy, user = null } = {}) {
  if (enCurso) return enCurso;
  enCurso = ejecutarUnaVez({ hoy, user }).finally(() => {
    enCurso = null;
  });
  return enCurso;
}

async function ejecutarUnaVez({ hoy, user }) {
  const opciones = await planificacion.opciones({ hoy });
  const resultado = { activa: opciones.activa, creadas: [], sinFecha: [], existentes: 0 };
  if (!opciones.activa) return resultado;
  const d = await recomendaciones.detectar();
  const existentes = new Set((await store.listPropuestas({ ciclos: d.recomendaciones.map((r) => r.ciclo) })).map((p) => p.ciclo));
  resultado.existentes = existentes.size;
  const nuevas = d.recomendaciones.filter((r) => !existentes.has(r.ciclo));
  if (!nuevas.length) return resultado;
  const ocup = await planificacion.ocupacion();
  for (const r of nuevas) {
    const fecha = planificacion.buscarFecha(opciones, ocup, r.equipo);
    if (!fecha) {
      resultado.sinFecha.push({ ciclo: r.ciclo, equipo: r.equipo.codigo, categoria: r.categoria.nombre });
      continue;
    }
    const id = await store.insertPropuesta({
      ciclo: r.ciclo, recomendacionClave: r.clave, equipo: r.equipo, categoria: r.categoria,
      horasAcumuladas: r.horasAcumuladas, paros: r.paros, umbralHoras: r.umbralHoras ?? d.umbralHoras,
      contramedidaPreviaId: r.contramedidaPrevia ? r.contramedidaPrevia.id : null,
      origen: "AUTOMATICA", estado: "PENDIENTE_APROBACION", fechaPropuesta: fecha, creadaPor: user ? user.username : "sistema",
    });
    if (!id) continue; // otra ejecucion la creo primero
    // La propuesta ocupa su dia para las siguientes de esta misma ejecucion.
    ocup.programadas.push({ fecha, equipo: r.equipo.codigo });
    await auditoria.registrar({ user, accion: "PROGRAMACION_AUTOMATICA_CREADA", entidad: "contramedida_propuesta", entidadId: id,
      nuevo: { estado: "PENDIENTE_APROBACION", fechaPropuesta: fecha },
      detalle: { ciclo: r.ciclo, equipo: r.equipo.codigo, categoria: r.categoria.codigo, horasAcumuladas: r.horasAcumuladas } });
    resultado.creadas.push({ id, ciclo: r.ciclo, equipo: r.equipo.codigo, categoria: r.categoria.nombre, fechaPropuesta: fecha });
  }
  return resultado;
}

module.exports = { ejecutar };
