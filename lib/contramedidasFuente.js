"use strict";

// De donde salen la DETECCION de contramedidas y el UMBRAL:
//
//   CONTRAMEDIDAS_FUENTE=local  (por defecto, desarrollo) la acumulacion se
//                               calcula aqui desde tiempo_muerto y el umbral
//                               vive en configuracion_sistema. No depende de
//                               ningun servicio externo.
//   CONTRAMEDIDAS_FUENTE=mes    KOIDE MES detecta y guarda el umbral
//                               (mtto_parametros); aqui solo se consume.
//
// El resto del modulo (planificacion, propuestas, aprobacion, auditoria) es el
// mismo con cualquier fuente.

const { env } = require("./env");

function fuente() {
  return String(env("CONTRAMEDIDAS_FUENTE", "local")).trim().toLowerCase() === "mes" ? "mes" : "local";
}

const esMes = () => fuente() === "mes";

module.exports = { fuente, esMes };
