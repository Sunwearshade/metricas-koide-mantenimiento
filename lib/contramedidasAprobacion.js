"use strict";

// APROBACION de contramedidas: ¿el administrador acepta esa fecha?
//
//   PENDIENTE_APROBACION --aprobar-->     CONFIRMADA  (se registra en KOIDE MES
//                                         por el mismo camino que "Programar
//                                         contramedida": fija la cobertura y la
//                                         acumulacion se reinicia como hoy)
//   PENDIENTE_APROBACION --reprogramar--> PENDIENTE_APROBACION (otra fecha disponible)
//   PENDIENTE_APROBACION --rechazar-->    RECHAZADA   (no toca el MES; ese ciclo
//                                         no se vuelve a proponer solo, pero se
//                                         puede programar a mano)
//
// Programar a mano desde una recomendacion deja la fila del ciclo en
// CONFIRMADA / MANUAL (registrarManual), para que aparezca en "Contramedidas
// confirmadas" junto con las automaticas.

const { tx } = require("./db");
const store = require("./store");
const auditoria = require("./auditoria");
const contramedidas = require("./contramedidas");
const recomendaciones = require("./contramedidasRecomendaciones");
const planificacion = require("./contramedidasPlanificacion");

class AprobacionError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ESTADOS = ["PENDIENTE_APROBACION", "EN_APROBACION", "CONFIRMADA", "RECHAZADA"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function motivoValido(motivo, requerido, accion) {
  const m = String(motivo || "").trim();
  if (requerido && m.length < 3) throw new AprobacionError(400, `Indica el motivo del ${accion}`);
  if (m.length > 500) throw new AprobacionError(400, "El motivo es demasiado largo (máx. 500 caracteres)");
  return m || null;
}

async function propuestaPendiente(id) {
  const p = await store.getPropuesta(Number(id));
  if (!p) throw new AprobacionError(404, "Propuesta no encontrada");
  if (p.estado !== "PENDIENTE_APROBACION") throw new AprobacionError(409, `La propuesta ya no está pendiente (estado: ${p.estado})`);
  return p;
}

async function listar({ estados } = {}) {
  const e = (estados || []).filter((x) => ESTADOS.includes(x));
  return store.listPropuestas({ estados: e.length ? e : undefined });
}

// Pendientes con la marca `vigente`: si el MES ya no muestra la recomendacion
// de ese ciclo (alguien la atendio directamente en el MES), aprobarla crearia
// una segunda cobertura. null = no se pudo consultar el MES.
async function pendientes() {
  const lista = await store.listPropuestas({ estados: ["PENDIENTE_APROBACION", "EN_APROBACION"] });
  if (!lista.length) return lista;
  let ciclos = null;
  try {
    ciclos = new Set((await recomendaciones.detectar()).recomendaciones.map((r) => r.ciclo));
  } catch {}
  return lista.map((p) => ({ ...p, vigente: ciclos ? ciclos.has(p.ciclo) : null }));
}

async function fechasDisponibles(id, { hoy } = {}) {
  const p = await store.getPropuesta(Number(id));
  if (!p) throw new AprobacionError(404, "Propuesta no encontrada");
  const [opciones, ocup] = await Promise.all([planificacion.opciones({ hoy }), planificacion.ocupacion({ excluirPropuestaId: p.id })]);
  return { propuestaId: p.id, fechaActual: p.fechaPropuesta, fechas: planificacion.fechasDisponibles(opciones, ocup, p.equipo) };
}

async function validarFecha(p, fecha, { hoy } = {}) {
  if (!DATE_RE.test(String(fecha || ""))) throw new AprobacionError(400, "Fecha inválida (AAAA-MM-DD)");
  const [opciones, ocup] = await Promise.all([planificacion.opciones({ hoy }), planificacion.ocupacion({ excluirPropuestaId: p.id })]);
  const motivo = planificacion.motivoNoDisponible(fecha, opciones, ocup, p.equipo);
  if (motivo) throw new AprobacionError(409, `La fecha ${fecha} no está disponible: ${motivo}`, { code: "FECHA_NO_DISPONIBLE" });
}

async function aprobar(id, user, { hoy } = {}) {
  const p = await propuestaPendiente(id);
  // Reclamo atomico: solo una aprobacion a la vez registra en el MES.
  if (!(await store.updatePropuesta(p.id, ["PENDIENTE_APROBACION"], { estado: "EN_APROBACION" }))) {
    throw new AprobacionError(409, "La propuesta ya no está pendiente");
  }
  const regresar = () => store.updatePropuesta(p.id, ["EN_APROBACION"], { estado: "PENDIENTE_APROBACION" });
  let cm;
  try {
    const vigente = (await recomendaciones.detectar()).recomendaciones.find((r) => r.ciclo === p.ciclo);
    if (!vigente) {
      throw new AprobacionError(409, "Esta recomendación ya fue atendida (su acumulación ya está cubierta por otra contramedida). Rechaza la propuesta.", { code: "RECOMENDACION_NO_VIGENTE" });
    }
    await validarFecha(p, p.fechaPropuesta, { hoy });
    cm = await contramedidas.crear({
      tipo: p.categoria.nombre || "Falla común", maquina: p.equipo.codigo, maquinaNombre: p.equipo.nombre || "",
      descripcion: vigente.recomendacion || "", responsable: "", fechaLimite: p.fechaPropuesta, estado: "Pendiente",
      recomendacionClave: p.recomendacionClave, categoriaCodigo: p.categoria.codigo,
    }, user);
    await tx(async (conn) => {
      await store.updatePropuesta(p.id, ["EN_APROBACION"], {
        estado: "CONFIRMADA", fechaConfirmada: p.fechaPropuesta, resueltaPor: user.username, resueltaEn: new Date(),
        contramedidaId: cm.id, mesId: cm.mesId || null, horasAcumuladas: vigente.horasAcumuladas, paros: vigente.paros,
      }, conn);
      await auditoria.registrar({ user, accion: "CONTRAMEDIDA_APROBADA", entidad: "contramedida_propuesta", entidadId: p.id,
        anterior: { estado: "PENDIENTE_APROBACION" }, nuevo: { estado: "CONFIRMADA", fechaConfirmada: p.fechaPropuesta },
        detalle: { ciclo: p.ciclo, contramedidaId: cm.id, mesId: cm.mesId || null } }, conn);
    });
  } catch (err) {
    if (!cm) await regresar().catch(() => {});
    if (err instanceof contramedidas.ContramedidaError) throw new AprobacionError(err.status, err.message, err.extra);
    throw err;
  }
  return { propuesta: await store.getPropuesta(p.id), contramedida: cm };
}

async function rechazar(id, motivo, user) {
  const m = motivoValido(motivo, true, "rechazo");
  const p = await propuestaPendiente(id);
  const ok = await tx(async (conn) => {
    const aplicado = await store.updatePropuesta(p.id, ["PENDIENTE_APROBACION"], { estado: "RECHAZADA", motivo: m, resueltaPor: user.username, resueltaEn: new Date() }, conn);
    if (aplicado) {
      await auditoria.registrar({ user, accion: "CONTRAMEDIDA_RECHAZADA", entidad: "contramedida_propuesta", entidadId: p.id,
        anterior: { estado: "PENDIENTE_APROBACION", fechaPropuesta: p.fechaPropuesta }, nuevo: { estado: "RECHAZADA" }, detalle: { motivo: m, ciclo: p.ciclo } }, conn);
    }
    return aplicado;
  });
  if (!ok) throw new AprobacionError(409, "La propuesta ya no está pendiente");
  return store.getPropuesta(p.id);
}

async function reprogramar(id, fecha, motivo, user, { hoy } = {}) {
  const m = motivoValido(motivo, true, "cambio de fecha");
  const p = await propuestaPendiente(id);
  if (fecha === p.fechaPropuesta) throw new AprobacionError(400, "Selecciona una fecha distinta a la propuesta");
  await validarFecha(p, fecha, { hoy });
  const ok = await tx(async (conn) => {
    const aplicado = await store.updatePropuesta(p.id, ["PENDIENTE_APROBACION"], { fechaPropuesta: fecha, motivo: m, reprogramaciones: p.reprogramaciones + 1 }, conn);
    if (aplicado) {
      await auditoria.registrar({ user, accion: "CONTRAMEDIDA_REPROGRAMADA", entidad: "contramedida_propuesta", entidadId: p.id,
        anterior: { fechaPropuesta: p.fechaPropuesta }, nuevo: { fechaPropuesta: fecha }, detalle: { motivo: m, ciclo: p.ciclo } }, conn);
    }
    return aplicado;
  });
  if (!ok) throw new AprobacionError(409, "La propuesta ya no está pendiente");
  return store.getPropuesta(p.id);
}

// "Programar contramedida" manual desde una recomendacion (ya registrada en el
// MES y guardada localmente): la fila del ciclo queda CONFIRMADA / MANUAL.
// Si habia una propuesta automatica pendiente o rechazada para ese ciclo, la
// programacion manual la sustituye (queda en auditoria).
async function registrarManual(cm, reco, user) {
  const campos = {
    estado: "CONFIRMADA", origen: "MANUAL", fechaConfirmada: cm.fechaLimite || null, resueltaPor: user.username, resueltaEn: new Date(),
    contramedidaId: cm.id, mesId: cm.mesId || null,
  };
  await tx(async (conn) => {
    const previa = await store.getPropuestaPorCiclo(reco.ciclo, conn);
    let id = previa ? previa.id : null;
    if (previa) {
      // Ya confirmada (p.ej. pantalla desactualizada): no se sobrescribe.
      if (!(await store.updatePropuesta(previa.id, ["PENDIENTE_APROBACION", "RECHAZADA"], campos, conn))) return;
    } else {
      id = await store.insertPropuesta({
        ciclo: reco.ciclo, recomendacionClave: cm.recomendacionClave, equipo: reco.equipo || { codigo: cm.maquina, nombre: cm.maquinaNombre },
        categoria: reco.categoria || { codigo: null, nombre: cm.tipo }, horasAcumuladas: reco.horasAcumuladas ?? null, paros: reco.paros ?? null,
        umbralHoras: reco.umbralHoras ?? null, contramedidaPreviaId: reco.contramedidaPrevia ? reco.contramedidaPrevia.id : null,
        origen: "MANUAL", estado: "CONFIRMADA", fechaConfirmada: campos.fechaConfirmada, resueltaPor: user.username,
        contramedidaId: cm.id, mesId: cm.mesId || null, creadaPor: user.username,
      }, conn);
    }
    await auditoria.registrar({ user, accion: "CONTRAMEDIDA_PROGRAMADA_MANUAL", entidad: "contramedida_propuesta", entidadId: id,
      anterior: previa ? { estado: previa.estado, origen: previa.origen, fechaPropuesta: previa.fechaPropuesta } : null,
      nuevo: { estado: "CONFIRMADA", origen: "MANUAL", fechaConfirmada: campos.fechaConfirmada }, detalle: { ciclo: reco.ciclo, contramedidaId: cm.id, mesId: cm.mesId || null } }, conn);
  });
}

module.exports = { AprobacionError, ESTADOS, listar, pendientes, fechasDisponibles, aprobar, rechazar, reprogramar, registrarManual };
