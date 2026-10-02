"use strict";

// Cliente de KOIDE MES (koide-general), la FUENTE OFICIAL de los paros de
// mantenimiento desde la migracion de 2026-09 (antes: koide-production-app en
// 192.168.1.201:4000).
//
//   Autenticacion: token servidor-a-servidor  (KOIDE_GENERAL_TOKEN)
//                  `Authorization: Service <token>`
//   Quien actua:   el tecnico con sesion en ESTE sistema, por su numero de
//                  empleado (`X-Actor-Numero-Empleado`). El MES lo valida contra
//                  su catalogo de personal y lo registra en su bitacora.
//
// Todas las reglas (codigos, estados, evidencia, tiempos) viven en el MES; aqui
// solo se traduce HTTP.

const { env } = require("./env");

class KoideGeneralError extends Error {
  constructor(status, message, code = null, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function base() {
  return env("KOIDE_GENERAL_URL", "").replace(/\/$/, "");
}

function configurado() {
  return Boolean(base() && env("KOIDE_GENERAL_TOKEN", ""));
}

function timeoutMs() {
  return Number(env("KOIDE_GENERAL_TIMEOUT_MS", "20000"));
}

// actor: { numeroEmpleado, username } del usuario con sesion (opcional en lecturas)
async function request(method, url, { body, actor, raw = false, timeout } = {}) {
  if (!configurado()) throw new KoideGeneralError(503, "Integracion con KOIDE MES no configurada (KOIDE_GENERAL_URL / KOIDE_GENERAL_TOKEN)", "MES_NO_CONFIGURADO");
  const headers = { Authorization: `Service ${env("KOIDE_GENERAL_TOKEN", "")}` };
  if (actor && actor.numeroEmpleado) headers["X-Actor-Numero-Empleado"] = String(actor.numeroEmpleado);
  if (actor && actor.username) headers["X-Actor-Usuario"] = String(actor.username);
  if (actor && actor.rol) headers["X-Actor-Rol"] = String(actor.rol);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${base()}/api/mantenimiento/servicio${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout || timeoutMs()),
    });
  } catch (err) {
    throw new KoideGeneralError(503, `KOIDE MES no disponible (${err.name === "TimeoutError" ? "sin respuesta" : err.message})`, "MES_NO_DISPONIBLE");
  }
  if (raw && res.ok) return res;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    const status = res.status === 401 || res.status === 423 ? 502 : res.status; // credencial del SERVICIO: no es culpa del usuario
    throw new KoideGeneralError(status, data.error || `KOIDE MES respondio HTTP ${res.status}`, data.code || null, data.details || null);
  }
  return data;
}

// Catalogo COMPLETO de personal de mantenimiento (activos e inactivos). Un MES
// anterior sin /personal responde 404: se usa /catalogos (solo activos), y
// entonces "inactivo" y "no existe" no se distinguen.
async function personal() {
  try {
    const r = await request("GET", "/personal");
    return { personal: r.personal || [], completo: true };
  } catch (err) {
    if (!(err instanceof KoideGeneralError) || err.status !== 404) throw err;
    const c = await request("GET", "/catalogos");
    return { personal: (c.personal || []).map((p) => ({ ...p, activo: true })), completo: false };
  }
}

module.exports = {
  KoideGeneralError,
  configurado,
  // contrato heredado (mismo formato que koide-production-app)
  downtimeRecords: () => request("GET", "/compat/downtime-records?responsibleArea=Mantenimiento"),
  machines: () => request("GET", "/compat/machines"),
  equipos: () => request("GET", "/equipos"),
  catalogos: () => request("GET", "/catalogos"),
  personal,
  // flujo del tecnico
  porCodigo: (codigo, actor) => request("GET", `/paros/por-codigo/${encodeURIComponent(codigo)}`, { actor }),
  aceptar: (codigo, actor) => request("POST", `/paros/por-codigo/${encodeURIComponent(codigo)}/aceptar`, { body: {}, actor }),
  obtener: (id, actor) => request("GET", `/paros/${encodeURIComponent(id)}`, { actor }),
  atenciones: (numero, actor) => request("GET", `/atenciones${numero ? `?numero=${encodeURIComponent(numero)}` : ""}`, { actor }),
  esperaExterna: (id, nota, actor) => request("POST", `/paros/${encodeURIComponent(id)}/espera-externa`, { body: { nota }, actor }),
  reanudar: (id, actor) => request("POST", `/paros/${encodeURIComponent(id)}/reanudar`, { body: {}, actor }),
  continuidad: (id, actor) => request("POST", `/paros/${encodeURIComponent(id)}/continuidad`, { body: {}, actor }),
  // (MES mig 090) evidencia durante la atencion; finalizar CIERRA el paro.
  agregarEvidencia: (id, datos, actor) => request("POST", `/paros/${encodeURIComponent(id)}/evidencias`, { body: datos, actor, timeout: 60000 }),
  finalizar: (id, datos, actor) => request("POST", `/paros/${encodeURIComponent(id)}/finalizar`, { body: datos, actor, timeout: 60000 }),
  evidencia: (id, evidenciaId) => request("GET", `/paros/${encodeURIComponent(id)}/evidencias/${encodeURIComponent(evidenciaId)}`, { raw: true }),
  // historico general (cualquier proceso) y contramedidas por acumulacion
  historico: (query) => request("GET", `/historico${query ? `?${query}` : ""}`),
  recomendaciones: () => request("GET", "/contramedidas/recomendaciones"),
  contramedidas: (query) => request("GET", `/contramedidas${query ? `?${query}` : ""}`),
  registrarContramedida: (datos, actor) => request("POST", "/contramedidas", { body: datos, actor }),
  actualizarContramedida: (id, datos, actor) => request("PATCH", `/contramedidas/${encodeURIComponent(id)}`, { body: datos, actor }),
  parametros: () => request("GET", "/parametros"),
  // Umbral de contramedida: su unica fuente es el MES (mtto_parametros).
  fijarUmbral: (horas, actor) => request("PUT", "/parametros/contramedida-umbral", { body: { horas }, actor }),
};
