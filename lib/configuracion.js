"use strict";

// Configuracion del sistema: UNICA fuente de los parametros globales.
//
// Cada parametro se declara una sola vez en PARAMETROS (tipo, limites, valor
// por defecto y de donde se lee). Para agregar uno nuevo basta con declararlo
// aqui: la pantalla "Configuracion del sistema" y la API lo muestran solos.
//
//   fuente "local"  vive en la tabla configuracion_sistema (mig 007).
//   fuente "mes"    vive en KOIDE MES (mtto_parametros).
//   fuente "contramedidas"  sigue a CONTRAMEDIDAS_FUENTE: es el umbral de
//                   horas para recomendar una contramedida, que vive donde se
//                   detectan las recomendaciones (local en desarrollo; el MES
//                   cuando se integre). Cambiar de fuente no toca el modulo.
//
// Todo cambio queda en la tabla `auditoria` (quien, valor anterior y nuevo).

const { query, tx } = require("./db");
const historico = require("./historico");
const auditoria = require("./auditoria");
const fuenteCm = require("./contramedidasFuente");

class ConfigError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const CLAVE_UMBRAL = "contramedida_umbral_horas";

const PARAMETROS = [
  {
    clave: CLAVE_UMBRAL, fuente: "contramedidas", tipo: "numero", grupo: "Contramedidas", unidad: "horas", min: 0.01, max: 10000, decimales: 2, defecto: 20,
    etiqueta: "Umbral para recomendar contramedida",
    descripcion: "Horas acumuladas de paros cerrados de una misma categoría de falla en un equipo a partir de las cuales se recomienda una contramedida (≥ umbral).",
  },
  {
    clave: "programacion_automatica_activa", fuente: "local", tipo: "booleano", grupo: "Programación automática", defecto: true,
    etiqueta: "Programación automática de contramedidas",
    descripcion: "Al detectar una recomendación, buscar una fecha disponible y dejar una propuesta pendiente de aprobación.",
  },
  {
    clave: "programacion_dias_permitidos", fuente: "local", tipo: "dias_semana", grupo: "Programación automática", defecto: [1, 2, 3, 4, 5, 6],
    etiqueta: "Días permitidos para programar",
    descripcion: "Días de la semana en los que se puede programar una contramedida.",
  },
  {
    clave: "programacion_horizonte_dias", fuente: "local", tipo: "entero", grupo: "Programación automática", unidad: "días", min: 1, max: 120, defecto: 14,
    etiqueta: "Horizonte de búsqueda",
    descripcion: "Días hacia adelante (a partir de mañana) en los que se busca una fecha disponible.",
  },
  {
    clave: "programacion_max_por_dia", fuente: "local", tipo: "entero", grupo: "Programación automática", unidad: "por día", min: 1, max: 50, defecto: 1,
    etiqueta: "Máximo de contramedidas por día",
    descripcion: "Contramedidas programadas (confirmadas o pendientes de aprobación) que caben en un mismo día en la planta.",
  },
];
const POR_CLAVE = new Map(PARAMETROS.map((p) => [p.clave, p]));

// "local" | "mes" efectiva de un parametro.
function fuenteDe(p) {
  return p.fuente === "contramedidas" ? fuenteCm.fuente() : p.fuente;
}

/* ---------- Tipos: texto guardado <-> valor ---------- */

function decodificar(p, texto) {
  if (texto === undefined || texto === null) return p.defecto;
  const s = String(texto).trim();
  if (p.tipo === "booleano") return s === "1" || s.toLowerCase() === "true";
  if (p.tipo === "dias_semana") return [...new Set(s.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
  const n = Number(s);
  return Number.isFinite(n) ? n : p.defecto;
}

function codificar(p, valor) {
  if (p.tipo === "booleano") return valor ? "1" : "0";
  if (p.tipo === "dias_semana") return valor.join(",");
  return String(valor);
}

// Valida y normaliza un valor recibido de la pantalla/API. Lanza ConfigError.
function validar(p, valor) {
  const nombre = p.etiqueta;
  if (p.tipo === "booleano") {
    if (typeof valor === "boolean") return valor;
    if (valor === 1 || valor === "1" || valor === "true") return true;
    if (valor === 0 || valor === "0" || valor === "false") return false;
    throw new ConfigError(400, `${nombre}: valor inválido (sí/no)`);
  }
  if (p.tipo === "dias_semana") {
    const lista = Array.isArray(valor) ? valor : String(valor ?? "").split(",");
    const dias = [...new Set(lista.map(Number))].sort();
    if (!dias.length || dias.some((n) => !Number.isInteger(n) || n < 1 || n > 7)) throw new ConfigError(400, `${nombre}: selecciona al menos un día válido`);
    return dias;
  }
  const n = typeof valor === "number" ? valor : Number(String(valor ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n)) throw new ConfigError(400, `${nombre}: debe ser un número`);
  if (p.tipo === "entero" && !Number.isInteger(n)) throw new ConfigError(400, `${nombre}: debe ser un número entero`);
  if (n < p.min || n > p.max) throw new ConfigError(400, `${nombre}: debe estar entre ${p.min} y ${p.max}${p.unidad ? ` ${p.unidad}` : ""}`);
  return p.decimales != null ? Math.round(n * 10 ** p.decimales) / 10 ** p.decimales : n;
}

/* ---------- Lectura ---------- */

async function filasLocales() {
  const rows = await query("SELECT clave, valor, actualizado_por, updated_at FROM configuracion_sistema");
  return new Map(rows.map((r) => [r.clave, r]));
}

async function parametrosMes() {
  const r = await historico.parametros();
  return new Map((r.parametros || []).map((x) => [x.clave, x]));
}

function vista(p, valor, meta) {
  const { defecto, ...def } = p;
  return { ...def, fuente: fuenteDe(p), valor, porDefecto: defecto, ...meta };
}

// Todos los parametros con su valor vigente (para la pantalla).
async function listar() {
  const locales = await filasLocales();
  let mes = null;
  let errorMes = null;
  if (PARAMETROS.some((p) => fuenteDe(p) === "mes")) {
    try {
      mes = await parametrosMes();
    } catch (err) {
      errorMes = err.message;
    }
  }
  return PARAMETROS.map((p) => {
    if (fuenteDe(p) === "mes") {
      if (!mes) return vista(p, null, { disponible: false, error: `No se pudo leer de KOIDE MES: ${errorMes}` });
      const x = mes.get(p.clave);
      return vista(p, x ? decodificar(p, x.valor) : p.defecto, { disponible: true, actualizado: x ? x.actualizado || null : null, actualizadoPor: null });
    }
    const r = locales.get(p.clave);
    return vista(p, r ? decodificar(p, r.valor) : p.defecto, {
      disponible: true, actualizado: r && r.updated_at ? r.updated_at.toISOString() : null, actualizadoPor: r ? r.actualizado_por : null,
    });
  });
}

// Valor vigente de un parametro (lanza si el MES no responde para los del MES).
async function obtener(clave) {
  const p = POR_CLAVE.get(clave);
  if (!p) throw new ConfigError(404, `Parámetro desconocido: ${clave}`);
  if (fuenteDe(p) === "mes") {
    const x = (await parametrosMes()).get(clave);
    return x ? decodificar(p, x.valor) : p.defecto;
  }
  const r = (await filasLocales()).get(clave);
  return r ? decodificar(p, r.valor) : p.defecto;
}

// Parametros que usa el motor de busqueda de fechas (todos locales).
async function programacion() {
  const locales = await filasLocales();
  const v = (clave) => {
    const p = POR_CLAVE.get(clave);
    const r = locales.get(clave);
    return r ? decodificar(p, r.valor) : p.defecto;
  };
  return {
    activa: v("programacion_automatica_activa"),
    diasPermitidos: v("programacion_dias_permitidos"),
    horizonteDias: v("programacion_horizonte_dias"),
    maxPorDia: v("programacion_max_por_dia"),
  };
}

/* ---------- Escritura ---------- */

// cambios: { clave: valor, ... }. Valida TODO antes de escribir nada.
// Devuelve [{ clave, anterior, nuevo }] de lo que realmente cambio.
async function guardar(cambios, user) {
  if (!cambios || typeof cambios !== "object" || Array.isArray(cambios)) throw new ConfigError(400, "Sin cambios que guardar");
  const pedidos = Object.entries(cambios).map(([clave, valor]) => {
    const p = POR_CLAVE.get(clave);
    if (!p) throw new ConfigError(400, `Parámetro desconocido: ${clave}`);
    return { p, nuevo: validar(p, valor) };
  });
  if (!pedidos.length) throw new ConfigError(400, "Sin cambios que guardar");

  const aplicados = [];
  const locales = pedidos.filter((x) => fuenteDe(x.p) === "local");
  if (locales.length) {
    await tx(async (conn) => {
      const [rows] = await conn.query("SELECT clave, valor FROM configuracion_sistema WHERE clave IN (?) FOR UPDATE", [locales.map((x) => x.p.clave)]);
      const actuales = new Map(rows.map((r) => [r.clave, r.valor]));
      for (const { p, nuevo } of locales) {
        const anterior = decodificar(p, actuales.get(p.clave));
        if (codificar(p, anterior) === codificar(p, nuevo) && actuales.has(p.clave)) continue;
        await conn.query(
          `INSERT INTO configuracion_sistema (clave, valor, tipo, descripcion, actualizado_por, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado_por = VALUES(actualizado_por), updated_at = VALUES(updated_at)`,
          [p.clave, codificar(p, nuevo), p.tipo, p.descripcion.slice(0, 255), user.username, new Date()]);
        await auditoria.registrar({ user, accion: "CONFIGURACION_MODIFICADA", entidad: "configuracion", entidadId: p.clave,
          anterior: codificar(p, anterior), nuevo: codificar(p, nuevo), detalle: { parametro: p.etiqueta } }, conn);
        aplicados.push({ clave: p.clave, anterior, nuevo });
      }
    });
  }
  for (const { p, nuevo } of pedidos.filter((x) => fuenteDe(x.p) === "mes")) {
    if (p.clave !== CLAVE_UMBRAL) throw new ConfigError(400, `El parámetro ${p.clave} no se puede modificar desde aquí`);
    let r;
    let leido = null;
    try {
      const x = (await parametrosMes()).get(p.clave);
      leido = x ? x.valor : null;
      r = await historico.fijarUmbral(nuevo, user);
    } catch (err) {
      if (err instanceof historico.HistoricoError) throw new ConfigError(err.status, `No se pudo guardar en KOIDE MES: ${err.message}`, err.extra);
      throw err;
    }
    // El MES devuelve el valor que reemplazo; si es una version anterior del
    // MES sin ese dato, se usa el leido justo antes de escribir.
    const previo = r && r.anterior != null ? r.anterior : leido;
    const anterior = previo != null ? decodificar(p, previo) : null;
    if (anterior !== null && anterior === nuevo) continue;
    await auditoria.registrar({ user, accion: "CONFIGURACION_MODIFICADA", entidad: "configuracion", entidadId: p.clave,
      anterior: anterior === null ? null : codificar(p, anterior), nuevo: codificar(p, nuevo), detalle: { parametro: p.etiqueta, fuente: "KOIDE MES" } });
    aplicados.push({ clave: p.clave, anterior, nuevo });
  }
  return aplicados;
}

module.exports = { ConfigError, PARAMETROS, CLAVE_UMBRAL, listar, obtener, programacion, guardar, validar };
