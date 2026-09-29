"use strict";

// Atencion de paros por el operador de mantenimiento.
//
//   codigo de ATENCION (lo muestra la terminal de produccion) -> validar ->
//   ACEPTAR -> (espera externa) -> capturar categoria + problema + trabajo +
//   evidencia -> FINALIZAR -> codigo de CIERRE (lo teclea el operador de
//   produccion en la terminal; el MES lo valida y cierra el paro)
//
// Desde la migracion de 2026-09 el paro y su atencion viven en KOIDE MES
// (koide-general): este modulo es un CLIENTE. Toda regla de negocio
// (estados, codigos, evidencia obligatoria, tiempos) la aplica el MES; aqui
// solo se adapta la respuesta a la forma que usa la pantalla del operador y se
// conserva la regla de visibilidad de este sistema (un operador ve solo sus
// atenciones; el administrador, todas).
//
// Las tablas paro_atenciones / paro_atencion_fotos / paro_atencion_eventos
// (migracion 003) quedan SIN USO: el historico de atenciones es el del MES.

const mes = require("./koideGeneral");

class AtencionError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ESTADOS = {
  EN_ATENCION: "EN_ATENCION",
  EN_ESPERA_EXTERNA: "EN_ESPERA_EXTERNA",
  PENDIENTE_CIERRE: "PENDIENTE_CIERRE",
  CERRADO: "CERRADO",
};

const MAX_FOTOS = 2;
const MAX_FOTO_BYTES = 5 * 1024 * 1024;

// Identidad que viaja al MES: numero de empleado + usuario + ROL de metricas al
// momento de la accion. Un mantenimiento_admin con numero participa como
// admin (el MES lo registra con rol_snapshot = mantenimiento_admin).
function actorDe(user) {
  return { numeroEmpleado: user.numeroEmpleado || null, username: user.username, rol: user.rol };
}

// IDENTIDAD DEL TECNICO. numero_empleado es la identidad compartida con el MES
// (mtto_personal). Sin el no se ejecuta NINGUNA accion de tecnico: se corta
// aqui, antes de mandar al MES una peticion que terminaria en 403. Un
// mantenimiento_admin sin numero queda en modo consulta.
const SIN_NUMERO = "Tu usuario no tiene numero de empleado: solo puedes consultar. Pide al administrador que lo registre";
function exigirNumero(user) {
  if (!user.numeroEmpleado) throw new AtencionError(403, SIN_NUMERO, { code: "TECNICO_SIN_NUMERO" });
}

// VARIOS TECNICOS POR PARO (MES mig 087). Cualquier operador autenticado con
// numero puede INICIAR (codigo de atencion), TOMAR CONTINUIDAD o FINALIZAR; pausar
// y reanudar son de quien participa (inicio o tomo continuidad). El MES vuelve a
// validar todo y registra quien hizo cada accion.
const EN_CURSO = ["EN_ATENCION", "EN_ESPERA_EXTERNA"];
function participa(p, user) {
  const n = String(user.numeroEmpleado || "");
  return Boolean(n) && (p.participantes || []).some((x) => String(x.numeroEmpleado) === n
    && (x.roles.includes("inicio") || x.roles.includes("continuidad")));
}
function permisos(p, user) {
  const conNumero = Boolean(user.numeroEmpleado);
  const enCurso = EN_CURSO.includes(p.estado);
  const esParticipante = participa(p, user);
  return {
    esParticipante,
    puedeOperar: conNumero && enCurso && esParticipante,
    puedeTomarContinuidad: conNumero && enCurso && String(p.responsableActual || "") !== String(user.numeroEmpleado),
    puedeFinalizar: conNumero && p.estado === "EN_ATENCION",
  };
}

// Error del MES -> error HTTP de este sistema (mismo mensaje; el codigo viaja).
async function viaMes(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof mes.KoideGeneralError) throw new AtencionError(err.status, err.message, err.code ? { code: err.code, ...(err.details || {}) } : {});
    throw err;
  }
}

function normalizarCodigoAtencion(input) {
  const s = String(input == null ? "" : input).replace(/[\s-]/g, "").replace(/^#/, "");
  return /^[1-9]\d{5}$/.test(s) ? s : null;
}

function reporteResumen(p) {
  return {
    codigo: p.codigoAtencion,
    maquina: p.equipo.codigo,
    maquinaNombre: p.equipo.nombre,
    proceso: p.equipo.proceso,
    linea: p.equipo.idMaquina,
    fecha: p.fecha,
    turno: p.turno ? `T${String(p.turno).replace(/^T/, "")}` : null,
    grupo: p.grupo,
    descripcion: p.descripcionOperador,
    reportadoPor: p.reportadoPor ? p.reportadoPor.nombre || p.reportadoPor.numeroEmpleado : null,
    inicio: p.inicio,
    estadoFuente: p.estado,
  };
}

// Forma que ya consumia public/operador.js (+ campos nuevos del MES).
// `puedeOperar`: la pantalla muestra acciones de tecnico solo si es true.
function atencionPublica(p, user) {
  const iso = (x) => x || null;
  return {
    id: p.id,
    ...(user ? permisos(p, user) : { esParticipante: false, puedeOperar: false, puedeTomarContinuidad: false, puedeFinalizar: false }),
    // Todos los tecnicos que participaron; cada uno con el tiempo COMPLETO del paro.
    participantes: (p.participantes || []).map((x) => ({
      numeroEmpleado: x.numeroEmpleado, nombre: x.nombre, roles: x.roles, desde: iso(x.primeraVez), minutosAsignados: x.minutosAsignados,
      rolSnapshot: x.rolSnapshot || null, tipoActor: x.tipoActor || null,
    })),
    responsableActual: p.responsableActual || null,
    duracion: p.duracion || null,
    historialAtencion: p.historialAtencion || [],
    estado: p.estado,
    codigoReporte: p.codigoAtencion,
    reporte: reporteResumen(p),
    aceptadoPor: p.tecnico ? p.tecnico.nombre || p.tecnico.numeroEmpleado : null,
    aceptadoEn: p.aceptadoEn,
    tecnicoNumeroEmpleado: p.tecnico ? p.tecnico.numeroEmpleado : null,
    tecnicoNombre: p.tecnico ? p.tecnico.nombre : null,
    categoria: p.categoria,
    problemaDetectado: p.problemaDetectado,
    actionTaken: p.accionRealizada,
    comments: p.comentarios,
    esperaExterna: p.esperaExterna,
    finalizadoEn: p.finalizadoEn,
    responseTimeMinutes: p.tiempos ? p.tiempos.respuesta_min : null,
    repairTimeMinutes: p.tiempos ? p.tiempos.reparacion_min : null,
    codigoCierre: p.codigoCierre,
    cierreConfirmadoEn: p.cierre && p.cierre.modo === "codigo" ? p.cierre.en : null,
    fotos: (p.evidencias || []).map((e) => ({
      tipo: e.tipo,
      nombre: e.nombre,
      url: `/api/operador/atenciones/${p.id}/fotos/${e.id}`,
    })),
  };
}

// Todo el personal de mantenimiento ve las atenciones (para tomar continuidad);
// las acciones dependen de permisos().
function puedeVer(p, user) {
  return user.rol === "mantenimiento_admin" || user.rol === "mantenimiento_op";
}

/* ---------- Casos de uso ---------- */

async function consultar(codigoInput, user) {
  const codigo = normalizarCodigoAtencion(codigoInput);
  if (!codigo) throw new AtencionError(400, "Codigo de atencion invalido (6 digitos)");
  const r = await viaMes(() => mes.porCodigo(codigo, actorDe(user)));
  const p = r.paro;
  return {
    codigo,
    reporte: reporteResumen(p),
    puedeAceptar: Boolean(r.puedeAceptar && user.numeroEmpleado),
    motivo: r.puedeAceptar && !user.numeroEmpleado ? SIN_NUMERO : r.motivo,
    aviso: null,
    atencion: p.tecnico && puedeVer(p, user) && p.estado !== "DECLARADO" ? atencionPublica(p, user) : null,
  };
}

async function aceptar(codigoInput, user) {
  const codigo = normalizarCodigoAtencion(codigoInput);
  if (!codigo) throw new AtencionError(400, "Codigo de atencion invalido (6 digitos)");
  exigirNumero(user);
  return atencionPublica(await viaMes(() => mes.aceptar(codigo, actorDe(user))), user);
}

async function cargarVisible(id, user) {
  const p = await viaMes(() => mes.obtener(id, actorDe(user)));
  if (!puedeVer(p, user)) throw new AtencionError(404, "Atencion no encontrada");
  return p;
}

async function obtener(id, user) {
  return atencionPublica(await cargarVisible(id, user), user);
}

// Pausar / reanudar: solo quien participa (el MES vuelve a validarlo).
async function exigirParticipante(id, user) {
  exigirNumero(user);
  const p = await cargarVisible(id, user);
  if (!participa(p, user)) {
    throw new AtencionError(403, "No participas en esta atencion: toma continuidad para poder operarla", { code: "TECNICO_NO_PARTICIPA" });
  }
  return p;
}

// abiertas / recientes: donde PARTICIPE. enCurso: atenciones de OTROS tecnicos
// en las que se puede tomar continuidad.
async function misAtenciones(user) {
  const numero = user.rol === "mantenimiento_admin" ? null : user.numeroEmpleado;
  const todas = await viaMes(() => mes.atenciones(null, actorDe(user)));
  if (!numero) {
    return {
      abiertas: user.rol === "mantenimiento_admin" ? todas.abiertas.map((p) => atencionPublica(p, user)) : [],
      recientes: user.rol === "mantenimiento_admin" ? todas.recientes.map((p) => atencionPublica(p, user)) : [],
      enCurso: [],
    };
  }
  const mias = await viaMes(() => mes.atenciones(numero, actorDe(user)));
  const ids = new Set(mias.abiertas.map((p) => p.id));
  return {
    abiertas: mias.abiertas.map((p) => atencionPublica(p, user)),
    recientes: mias.recientes.map((p) => atencionPublica(p, user)),
    enCurso: todas.abiertas.filter((p) => !ids.has(p.id)).map((p) => atencionPublica(p, user)),
  };
}

async function tomarContinuidad(id, user) {
  exigirNumero(user);
  await cargarVisible(id, user);
  return atencionPublica(await viaMes(() => mes.continuidad(id, actorDe(user))), user);
}

async function esperaExterna(id, user, body) {
  await exigirParticipante(id, user);
  return atencionPublica(await viaMes(() => mes.esperaExterna(id, String((body && body.nota) || "").trim() || null, actorDe(user))), user);
}

async function reanudar(id, user) {
  await exigirParticipante(id, user);
  return atencionPublica(await viaMes(() => mes.reanudar(id, actorDe(user))), user);
}

// Validacion temprana (mensajes inmediatos al operador); el MES vuelve a
// validar todo y es el que decide.
function prepararFotos(fotos) {
  if (!Array.isArray(fotos)) return [];
  if (fotos.length > MAX_FOTOS) throw new AtencionError(400, `Maximo ${MAX_FOTOS} fotos`);
  return fotos.map((f) => {
    const tipo = f && (f.tipo === "antes" || f.tipo === "despues") ? f.tipo : null;
    if (!tipo) throw new AtencionError(400, "Cada foto debe indicar tipo 'antes' o 'despues'");
    if (!/\.(jpe?g|png)$/i.test(String(f.name || ""))) throw new AtencionError(400, "Solo se aceptan fotos JPG o PNG");
    const b64 = String(f.base64 || "");
    if (Math.floor((b64.length * 3) / 4) > MAX_FOTO_BYTES + 3) throw new AtencionError(400, "La foto excede 5 MB");
    return { tipo, nombre: String(f.name), base64: b64 };
  });
}

async function finalizar(id, user, body) {
  exigirNumero(user);
  const actionTaken = String((body && body.actionTaken) || "").trim();
  const problema = String((body && body.problemaDetectado) || "").trim();
  const categoria = String((body && body.categoria) || "").trim();
  if (!categoria) throw new AtencionError(400, "Selecciona la categoria de falla");
  if (!problema) throw new AtencionError(400, "Describe el problema detectado");
  if (!actionTaken) throw new AtencionError(400, "Escribe la descripcion del trabajo realizado");
  const fotos = prepararFotos(body && body.fotos);
  if (!fotos.some((f) => f.tipo === "despues")) throw new AtencionError(400, "La foto \"despues\" es obligatoria");
  await cargarVisible(id, user);
  const p = await viaMes(() =>
    mes.finalizar(id, {
      categoria,
      problemaDetectado: problema,
      accionRealizada: actionTaken,
      comentarios: String((body && body.comments) || "").trim() || null,
      fotos,
    }, actorDe(user))
  );
  return atencionPublica(p, user);
}

// Devuelve { buffer, mime } de la evidencia o null.
async function fotoDe(id, evidenciaId, user) {
  try {
    await obtener(id, user);
    const res = await mes.evidencia(id, evidenciaId);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "image/jpeg" };
  } catch (err) {
    if (err instanceof AtencionError && err.status === 404) return null;
    if (err instanceof mes.KoideGeneralError && err.status === 404) return null;
    throw err;
  }
}

async function catalogos() {
  return viaMes(() => mes.catalogos());
}

module.exports = {
  AtencionError,
  ESTADOS,
  normalizarCodigoAtencion,
  consultar,
  aceptar,
  obtener,
  misAtenciones,
  esperaExterna,
  reanudar,
  tomarContinuidad,
  finalizar,
  fotoDe,
  catalogos,
};
