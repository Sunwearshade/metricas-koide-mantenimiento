"use strict";

// Gestion de OPERADORES DE MANTENIMIENTO por el administrador (dashboard y
// scripts/usuarios.js). Un operador es: nombre, usuario, PIN de 4 digitos,
// numero de empleado y activo/inactivo.
//
// numero_empleado es la identidad canonica ante KOIDE MES: debe existir y estar
// ACTIVO en su catalogo de personal de mantenimiento (mtto_personal). Se valida
// en linea contra el MES; si no responde, no se da de alta ni se cambia.

const auth = require("./auth");
const mes = require("./koideGeneral");

class OperadorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function tecnicoDelMes(numero) {
  const n = String(numero == null ? "" : numero).trim();
  if (!/^[A-Za-z0-9-]{1,20}$/.test(n)) throw new OperadorError(400, `Numero de empleado invalido: ${numero}`);
  if (!mes.configurado()) throw new OperadorError(503, "KOIDE MES no configurado (KOIDE_GENERAL_URL / KOIDE_GENERAL_TOKEN): no se puede validar el numero");
  let personal;
  try {
    ({ personal } = await mes.catalogos());
  } catch (err) {
    throw new OperadorError(503, `No se pudo validar el numero con KOIDE MES: ${err.message}`);
  }
  const t = (personal || []).find((p) => String(p.numeroEmpleado) === n);
  if (!t) throw new OperadorError(400, `El numero ${n} no existe o no esta activo en el catalogo de personal de mantenimiento de KOIDE MES`);
  return t;
}

function vista(u) {
  const bloqueadoHasta = u.bloqueado_hasta ? new Date(u.bloqueado_hasta) : null;
  return {
    id: u.id,
    nombre: u.nombre,
    username: u.username,
    rol: u.rol,
    numeroEmpleado: u.numero_empleado || null,
    activo: Boolean(u.activo),
    bloqueado: Boolean(Number(u.bloqueo_admin)) || Boolean(bloqueadoHasta && bloqueadoHasta.getTime() > Date.now()),
    bloqueoDefinitivo: Boolean(Number(u.bloqueo_admin)),
    intentosFallidos: Number(u.intentos_fallidos || 0),
    pinActualizado: u.pin_actualizado ? new Date(u.pin_actualizado).toISOString() : null,
  };
}

// Personal del sistema: operadores (usuario + PIN), administradores
// (contrasena; con numero de empleado tambien atienden paros SIN dejar de ser
// administradores) y usuarios de consulta (contrasena, solo lectura, mig 006).
async function listar() {
  return (await auth.listUsers()).filter((u) => auth.ROLES_VALIDOS.has(u.rol)).map(vista);
}

// Alta de un usuario de SOLO CONSULTA (tecnico_consulta): contrasena, sin
// numero de empleado (no atiende paros) y sin PIN.
async function altaConsulta({ nombre, username, password }) {
  try {
    if (await auth.findUserByUsername(username)) throw new OperadorError(409, `Ya existe el usuario ${username}`);
    await auth.createUser({ nombre, username, password, rol: auth.ROLES.CONSULTA });
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

function error(err) {
  if (err instanceof OperadorError) return err;
  return new OperadorError(400, err.message);
}

async function alta({ nombre, username, pin, numeroEmpleado, activo = true }) {
  try {
    const t = await tecnicoDelMes(numeroEmpleado);
    if (await auth.findUserByUsername(username)) throw new OperadorError(409, `Ya existe el usuario ${username}`);
    await auth.createUser({ nombre: String(nombre || "").trim() || t.nombre, username, pin, rol: auth.ROLES.OP, numeroEmpleado: t.numeroEmpleado, activo: activo !== false });
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

async function modificar(username, { nombre, numeroEmpleado, activo, pin } = {}) {
  try {
    const u = await auth.findUserByUsername(username);
    if (!u || !auth.ROLES_VALIDOS.has(u.rol)) throw new OperadorError(404, "Usuario no encontrado");
    const esAdmin = u.rol === auth.ROLES.ADMIN;
    // Consulta: solo nombre, contrasena y activo. Nunca numero (no atiende paros).
    if (u.rol === auth.ROLES.CONSULTA) {
      if (numeroEmpleado !== undefined && String(numeroEmpleado).trim() !== "") throw new OperadorError(400, "Un usuario de consulta no atiende paros: no lleva numero de empleado");
      if (nombre !== undefined) await auth.setNombre(username, nombre);
      if (pin !== undefined && pin !== null && pin !== "") await auth.setPassword(username, String(pin));
      if (activo !== undefined) await auth.setActive(username, Boolean(activo));
      return vista(await auth.findUserByUsername(username));
    }
    // Administrador: solo su numero de empleado (asignacion EXPLICITA; vacio lo
    // quita y queda en solo consulta). Su contrasena y su activacion no se
    // gestionan desde aqui.
    if (esAdmin && (pin !== undefined || activo !== undefined)) {
      throw new OperadorError(400, "A un administrador solo se le asigna o quita el numero de empleado desde aqui");
    }
    if (numeroEmpleado !== undefined && String(numeroEmpleado) !== String(u.numero_empleado || "")) {
      if (String(numeroEmpleado).trim() === "") {
        if (!esAdmin) throw new OperadorError(400, "Un operador de mantenimiento necesita numero de empleado");
        await auth.setNumeroEmpleado(username, null);
      } else {
        const t = await tecnicoDelMes(numeroEmpleado);
        await auth.setNumeroEmpleado(username, t.numeroEmpleado);
      }
    }
    if (nombre !== undefined) await auth.setNombre(username, nombre);
    if (pin !== undefined && pin !== null && pin !== "") await auth.setPin(username, pin);
    if (activo !== undefined) await auth.setActive(username, Boolean(activo));
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

module.exports = { OperadorError, tecnicoDelMes, listar, alta, altaConsulta, modificar };
