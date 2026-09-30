"use strict";

// Alta de una contramedida. Cuando nace de una recomendacion por acumulacion
// queda ligada a ella (recomendacion_clave), lo que fija la COBERTURA:
//   fuente local  la contramedida local es la cobertura (lib/contramedidasLocal.js);
//   fuente mes    ademas se registra en KOIDE MES, que fija la cobertura alla.
// Es el MISMO camino para:
//   * "Programar contramedida" (manual, POST /api/contramedidas), y
//   * la aprobacion de una propuesta automatica (lib/contramedidasAprobacion.js).
// La recomendacion deja de aparecer y solo vuelve con una acumulacion nueva.

const store = require("./store");
const historico = require("./historico");
const fuenteCm = require("./contramedidasFuente");

class ContramedidaError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function nuevoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function crear(body, user) {
  const cm = {
    id: nuevoId(),
    tipo: body.tipo || "Falla común",
    maquina: String(body.maquina || ""),
    maquinaNombre: String(body.maquinaNombre || ""),
    fallaComun: String(body.fallaComun || ""),
    referencia: String(body.referencia || body.maquina || ""),
    categoria: String(body.categoria || ""),
    descripcion: String(body.descripcion || ""),
    responsable: String(body.responsable || ""),
    fechaLimite: body.fechaLimite || "",
    estado: body.estado || "Pendiente",
    creada: new Date().toISOString(),
  };
  // Fuente local: la contramedida ligada a la recomendacion ES la cobertura.
  // Fuente mes: PRIMERO el MES (fija la cobertura alla), despues la copia local.
  if (!fuenteCm.esMes()) {
    if (body.recomendacionClave) cm.recomendacionClave = String(body.recomendacionClave).slice(0, 120);
  } else if (body.recomendacionClave || body.registrarEnMes) {
    try {
      const r = await historico.registrarEnMes({
        equipo: cm.maquina, categoria: body.categoriaCodigo || null, descripcion: [cm.tipo, cm.fallaComun, cm.descripcion].filter(Boolean).join(" · ").slice(0, 1000),
        responsable: cm.responsable, fechaProgramada: cm.fechaLimite || null, referenciaExterna: cm.id,
        origen: body.recomendacionClave ? "acumulacion" : "manual",
      }, user);
      cm.mesId = r.id;
      cm.recomendacionClave = body.recomendacionClave ? String(body.recomendacionClave).slice(0, 120) : null;
    } catch (err) {
      if (err instanceof historico.HistoricoError) {
        throw new ContramedidaError(err.status, `No se pudo registrar la contramedida en KOIDE MES: ${err.message}`, err.extra);
      }
      throw err;
    }
  }
  await store.insertContramedida(cm);
  return cm;
}

module.exports = { ContramedidaError, crear };
