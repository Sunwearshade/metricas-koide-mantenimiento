"use strict";

// Historico general de paros y contramedidas por acumulacion de fallas.
//
// TODO vive en KOIDE MES (koide-general, mig 090): este modulo es un CLIENTE
// de solo traduccion. No copia paros a la base local (el MES es la unica
// fuente); solo adapta filtros/respuestas a la pantalla.
//
//   GET historico       cualquier paro terminado de cualquier proceso
//                       (biselado, CNC, prensas, corte...), con filtros
//   GET detalle         un paro con bitacora completa y evidencias
//   GET evidencia       la imagen (proxy binario)
//   GET recomendaciones equipo + categoria con >= umbral de horas acumuladas
//   registrar           al agendar una contramedida desde una recomendacion,
//                       se registra tambien en el MES: fija la cobertura y la
//                       recomendacion deja de aparecer hasta acumular de nuevo

const mes = require("./koideGeneral");

class HistoricoError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function viaMes(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof mes.KoideGeneralError) throw new HistoricoError(err.status, err.message, err.code ? { code: err.code, ...(err.details || {}) } : {});
    throw err;
  }
}

const FILTROS = ["desde", "hasta", "fecha", "proceso", "equipo", "categoria", "tecnico", "estado", "q", "limite", "offset"];

function queryDe(params) {
  const q = new URLSearchParams();
  for (const k of FILTROS) {
    const v = params && params[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") q.set(k, String(v).trim().slice(0, 120));
  }
  return q.toString();
}

// Fila de la pantalla: todo lo que el modelo del MES conoce del paro.
function filaPublica(p) {
  return {
    id: p.id,
    origen: p.origen,
    estado: p.estado,
    proceso: p.proceso,
    area: p.equipo && p.equipo.area,
    ubicacion: p.equipo && p.equipo.ubicacion,
    equipo: p.equipo,
    linea: p.linea || null,
    terminal: p.terminal || null,
    fecha: p.fecha,
    turno: p.turno ? `T${String(p.turno).replace(/^T/, "")}` : null,
    grupo: p.grupo || null,
    categoria: p.categoria,
    problemaDetectado: p.problemaDetectado,
    descripcionOperador: p.descripcionOperador,
    accionRealizada: p.accionRealizada,
    comentarios: p.comentarios,
    reportadoPor: p.reportadoPor,
    tecnicos: p.tecnicos || [],
    responsableActual: p.responsableActual || null,
    inicio: p.inicio,
    inicioAtencion: p.aceptadoEn,
    finalizadoEn: p.finalizadoEn,
    fin: p.cierre ? p.cierre.en : null,
    cierre: p.cierre,
    tiempoTotalMin: p.tiempoTotalMin != null ? p.tiempoTotalMin : p.tiempos && p.tiempos.paro_min,
    respuestaMin: p.tiempos ? p.tiempos.respuesta_min : null,
    reparacionMin: p.tiempos ? p.tiempos.reparacion_min : null,
    esperaExternaMin: p.esperaExternaMin != null ? p.esperaExternaMin : p.esperaExterna && p.esperaExterna.minutos,
    esperaExterna: p.esperaExterna,
    codigoAtencion: p.codigoAtencion,
    codigoCierre: p.codigoCierre || null,
    eventosCount: p.eventosCount != null ? p.eventosCount : p.eventos ? p.eventos.length : null,
    eventos: p.eventos || null,
    evidencias: (p.evidencias || []).map((e) => ({
      id: e.id, tipo: e.tipo, etapa: e.etapa, nombre: e.nombre, descripcion: e.descripcion, mime: e.mime, bytes: e.bytes,
      subidoPor: e.subidoPor, creado: e.creado, url: `/api/historico/paros/${p.id}/evidencias/${e.id}`,
    })),
  };
}

async function consultar(params) {
  const r = await viaMes(() => mes.historico(queryDe(params)));
  return { total: r.total, limite: r.limite, offset: r.offset, filas: (r.filas || []).map(filaPublica) };
}

async function detalle(id) {
  const p = await viaMes(() => mes.obtener(id));
  return filaPublica(p);
}

// { buffer, mime } | null
async function evidencia(id, evidenciaId) {
  try {
    const res = await mes.evidencia(id, evidenciaId);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "image/jpeg" };
  } catch (err) {
    if (err instanceof mes.KoideGeneralError && err.status === 404) return null;
    throw err;
  }
}

async function recomendaciones() {
  return viaMes(() => mes.recomendaciones());
}

// Registra en el MES la contramedida que cubre una recomendacion (equipo +
// categoria). `actor` = usuario de metricas que la agenda.
async function registrarEnMes({ equipo, categoria, descripcion, responsable, fechaProgramada, referenciaExterna, origen }, user) {
  return viaMes(() => mes.registrarContramedida({
    equipo, categoria: categoria || null, descripcion: descripcion || null, responsable: responsable || null,
    fechaProgramada: fechaProgramada || null, referenciaExterna: referenciaExterna || null, origen: origen || "acumulacion",
  }, { username: user && user.username, rol: user && user.rol, numeroEmpleado: user && user.numeroEmpleado }));
}

// Estado de metricas -> estado del MES.
const ESTADO_MES = { Pendiente: "PROGRAMADA", "En proceso": "EN_PROCESO", Completado: "COMPLETADA" };
async function actualizarEnMes(mesId, { estado, trabajoRealizado, responsable, fechaProgramada, descripcion }, user) {
  const datos = {};
  if (estado !== undefined && ESTADO_MES[estado]) datos.estado = ESTADO_MES[estado];
  if (trabajoRealizado !== undefined) datos.trabajoRealizado = trabajoRealizado;
  if (responsable !== undefined) datos.responsable = responsable;
  if (fechaProgramada !== undefined) datos.fechaProgramada = fechaProgramada || null;
  if (descripcion !== undefined) datos.descripcion = descripcion;
  if (!Object.keys(datos).length) return null;
  return viaMes(() => mes.actualizarContramedida(mesId, datos, { username: user && user.username, rol: user && user.rol }));
}

// Parametros del subdominio en el MES (umbral de contramedida).
async function parametros() {
  return viaMes(() => mes.parametros());
}

async function fijarUmbral(horas, user) {
  return viaMes(() => mes.fijarUmbral(horas, { username: user && user.username, rol: user && user.rol }));
}

module.exports = { HistoricoError, consultar, detalle, evidencia, recomendaciones, registrarEnMes, actualizarEnMes, parametros, fijarUmbral, filaPublica };
