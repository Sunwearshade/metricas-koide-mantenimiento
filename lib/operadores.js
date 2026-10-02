"use strict";

// Gestion de las CUENTAS del personal de mantenimiento por el administrador
// (dashboard "Operadores de mantenimiento" y scripts/usuarios.js).
//
// Dos identidades distintas, un vinculo explicito:
//   usuarios (ESTE sistema)      identidad de AUTENTICACION: usuario, PIN o
//                                contrasena, rol, activo/inactivo.
//   mtto_personal (KOIDE MES)    identidad LABORAL: numero, nombre y estado del
//                                empleado; con ella el MES registra quien
//                                participo en cada paro.
//   usuarios.numero_empleado     el vinculo. Solo se asocia a un empleado que
//                                EXISTE y esta ACTIVO en el MES (validado en
//                                linea: si el MES no responde, no se asocia) y
//                                cada numero pertenece a UNA sola cuenta (mig
//                                008). Aqui no se copia el catalogo: nombre y
//                                estado del empleado se leen del MES.
//
// Roles:
//   mantenimiento_op     usuario + PIN de 4 digitos; numero OBLIGATORIO.
//   mantenimiento_admin  contrasena; con numero tambien atiende paros sin
//                        dejar de ser administrador; sin numero, solo consulta.
//   tecnico_consulta     contrasena; SOLO LECTURA; nunca lleva numero.

const auth = require("./auth");
const mes = require("./koideGeneral");

class OperadorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const { ADMIN, OP, CONSULTA } = auth.ROLES;
const ROLES_QUE_ATIENDEN = new Set([OP, ADMIN]);

function normalizarNumero(numero) {
  const n = String(numero == null ? "" : numero).trim();
  if (!/^[A-Za-z0-9-]{1,20}$/.test(n)) throw new OperadorError(400, `Numero de empleado invalido: ${numero}`);
  return n;
}

// Catalogo de personal de mantenimiento del MES: { personal, completo }.
async function catalogoMes() {
  if (!mes.configurado()) throw new OperadorError(503, "KOIDE MES no configurado (KOIDE_GENERAL_URL / KOIDE_GENERAL_TOKEN): no se puede validar el numero");
  try {
    return await mes.personal();
  } catch (err) {
    throw new OperadorError(503, `No se pudo consultar el catalogo de personal de KOIDE MES: ${err.message}`);
  }
}

// El empleado del MES con ese numero, si existe y esta activo; si no, 400 con
// el motivo exacto (no existe / inactivo).
async function tecnicoDelMes(numero) {
  const n = normalizarNumero(numero);
  const { personal, completo } = await catalogoMes();
  const t = (personal || []).find((p) => String(p.numeroEmpleado) === n);
  if (!t) {
    throw new OperadorError(400, completo
      ? `El numero ${n} no existe en el catalogo de personal de mantenimiento de KOIDE MES`
      : `El numero ${n} no existe o no esta activo en el catalogo de personal de mantenimiento de KOIDE MES`);
  }
  if (t.activo === false) {
    throw new OperadorError(400, `El numero ${n}${t.nombre ? ` (${t.nombre})` : ""} esta INACTIVO en el catalogo de personal de mantenimiento de KOIDE MES`);
  }
  return t;
}

async function assertNumeroLibre(numero, exceptoUsername = null) {
  const otro = (await auth.listUsers()).find((u) => String(u.numero_empleado || "") === numero && u.username !== exceptoUsername);
  if (otro) throw new OperadorError(409, `El numero de empleado ${numero} ya esta asociado a la cuenta ${otro.username}`);
}

function vista(u) {
  const bloqueadoHasta = u.bloqueado_hasta ? new Date(u.bloqueado_hasta) : null;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
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
    pinActualizado: iso(u.pin_actualizado),
    creado: iso(u.created_at),
    actualizado: iso(u.updated_at),
  };
}

// Estado del vinculo cuenta -> empleado del MES, para que el administrador vea
// ANTES de que el tecnico lo sufra si su cuenta no podra atender paros.
//   ACTIVO | INACTIVO | NO_EXISTE | SIN_NUMERO | NO_APLICA (consulta) | DESCONOCIDO (MES sin respuesta)
function vinculo(o, porNumero, mesOk) {
  if (o.rol === CONSULTA) return { estado: "NO_APLICA", nombre: null };
  if (!o.numeroEmpleado) return { estado: "SIN_NUMERO", nombre: null };
  if (!mesOk) return { estado: "DESCONOCIDO", nombre: null };
  const t = porNumero.get(String(o.numeroEmpleado));
  if (!t) return { estado: "NO_EXISTE", nombre: null };
  return { estado: t.activo === false ? "INACTIVO" : "ACTIVO", nombre: t.nombre || null };
}

async function listarCuentas() {
  return (await auth.listUsers()).filter((u) => auth.ROLES_VALIDOS.has(u.rol)).map(vista);
}

// Personal del sistema: operadores (usuario + PIN), administradores
// (contrasena; con numero de empleado tambien atienden paros SIN dejar de ser
// administradores) y usuarios de consulta (contrasena, solo lectura, mig 006).
async function listar() {
  return listarCuentas();
}

// Listado para la vista de administracion: cada cuenta con el estado de su
// empleado en el MES y si hoy puede atender paros. Si el MES no responde, el
// listado sale igual (viene de la base de ESTE sistema) con estado DESCONOCIDO.
async function listarConMes() {
  const operadores = await listarCuentas();
  let cat = null;
  let error = null;
  try {
    cat = await catalogoMes();
  } catch (err) {
    error = err.message;
  }
  const porNumero = new Map(((cat && cat.personal) || []).map((p) => [String(p.numeroEmpleado), p]));
  for (const o of operadores) {
    o.empleado = vinculo(o, porNumero, Boolean(cat));
    o.atiendeParos = ROLES_QUE_ATIENDEN.has(o.rol) && o.activo && o.empleado.estado === "ACTIVO";
  }
  return { operadores, mes: { disponible: Boolean(cat), completo: Boolean(cat && cat.completo), error } };
}

// Empleados del MES para el selector del formulario: el catalogo completo con
// la cuenta que ya tiene cada numero (asignadoA). Solo se puede elegir uno
// activo y libre.
async function personalParaAsociar() {
  const { personal, completo } = await catalogoMes();
  const porNumero = new Map((await auth.listUsers()).filter((u) => u.numero_empleado).map((u) => [String(u.numero_empleado), u.username]));
  return {
    completo,
    personal: (personal || []).map((p) => ({
      numeroEmpleado: String(p.numeroEmpleado),
      nombre: p.nombre || null,
      activo: p.activo !== false,
      asignadoA: porNumero.get(String(p.numeroEmpleado)) || null,
    })),
  };
}

function error(err) {
  if (err instanceof OperadorError) return err;
  if (err && err.code === "ER_DUP_ENTRY") {
    return new OperadorError(409, /numero_empleado/.test(err.message) ? "Ese numero de empleado ya esta asociado a otra cuenta" : "Ya existe ese usuario");
  }
  return new OperadorError(400, err.message);
}

// Alta de un usuario de SOLO CONSULTA (tecnico_consulta): contrasena, sin
// numero de empleado (no atiende paros) y sin PIN.
async function altaConsulta({ nombre, username, password, numeroEmpleado }) {
  try {
    if (numeroEmpleado != null && String(numeroEmpleado).trim() !== "") throw new OperadorError(400, "Un usuario de consulta no atiende paros: no lleva numero de empleado");
    if (await auth.findUserByUsername(username)) throw new OperadorError(409, `Ya existe el usuario ${username}`);
    await auth.createUser({ nombre, username, password, rol: CONSULTA });
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

// Alta de una cuenta de mantenimiento. `rol` por defecto mantenimiento_op
// (contrato previo). Cualquier otro rol (p. ej. uno de produccion) se rechaza.
async function alta({ rol = OP, nombre, username, pin, password, numeroEmpleado, activo = true }) {
  if (rol === CONSULTA) return altaConsulta({ nombre, username, password, numeroEmpleado });
  try {
    if (!ROLES_QUE_ATIENDEN.has(rol)) {
      throw new OperadorError(400, `Rol no valido para una cuenta de mantenimiento: ${rol}. Use ${OP}, ${ADMIN} o ${CONSULTA}`);
    }
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(String(username || ""))) throw new OperadorError(400, "Usuario invalido (3-60 letras, numeros, . _ -)");
    if (await auth.findUserByUsername(username)) throw new OperadorError(409, `Ya existe el usuario ${username}`);
    const conNumero = numeroEmpleado != null && String(numeroEmpleado).trim() !== "";
    if (rol === OP && !conNumero) throw new OperadorError(400, "Un operador de mantenimiento necesita un empleado del catalogo de KOIDE MES");
    let t = null;
    if (conNumero) {
      t = await tecnicoDelMes(numeroEmpleado);
      await assertNumeroLibre(String(t.numeroEmpleado));
    }
    await auth.createUser({
      nombre: String(nombre || "").trim() || (t && t.nombre) || "",
      username,
      rol,
      pin: rol === OP ? pin : undefined,
      password: rol === OP ? undefined : password,
      numeroEmpleado: t ? t.numeroEmpleado : null,
      activo: activo !== false,
    });
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

async function obtener(username) {
  const u = await auth.findUserByUsername(username);
  return u && auth.ROLES_VALIDOS.has(u.rol) ? vista(u) : null;
}

// Cambios sobre una cuenta existente. `actor` = administrador con sesion (para
// no desactivarse a si mismo ni dejar el sistema sin administradores).
//
// Cambiar el empleado asociado NO toca la historia: el MES guarda en cada
// participacion el numero, el usuario y el rol DE ESE MOMENTO. La cuenta solo
// deja de actuar con el numero anterior (que queda libre para otra cuenta).
async function modificar(username, { nombre, numeroEmpleado, activo, pin, password } = {}, actor = null) {
  try {
    const u = await auth.findUserByUsername(username);
    if (!u || !auth.ROLES_VALIDOS.has(u.rol)) throw new OperadorError(404, "Usuario no encontrado");
    const hay = (v) => v !== undefined && v !== null && v !== "";

    // Consulta: nombre, contrasena y activo. Nunca numero (no atiende paros).
    if (u.rol === CONSULTA) {
      if (numeroEmpleado !== undefined && String(numeroEmpleado).trim() !== "") throw new OperadorError(400, "Un usuario de consulta no atiende paros: no lleva numero de empleado");
      if (nombre !== undefined) await auth.setNombre(username, nombre);
      if (hay(password) || hay(pin)) await auth.setPassword(username, String(hay(password) ? password : pin));
      if (activo !== undefined) await auth.setActive(username, Boolean(activo));
      return vista(await auth.findUserByUsername(username));
    }

    const esAdmin = u.rol === ADMIN;
    if (esAdmin && hay(pin)) throw new OperadorError(400, "Un administrador entra con contrasena: no lleva PIN");
    if (!esAdmin && hay(password)) throw new OperadorError(400, "Un operador de mantenimiento entra con PIN de 4 digitos, no con contrasena");
    if (esAdmin && activo === false) {
      if (actor && actor.username === username) throw new OperadorError(400, "No puedes desactivar tu propia cuenta");
      const otros = (await auth.listUsers()).filter((x) => x.rol === ADMIN && x.activo && x.username !== username);
      if (!otros.length) throw new OperadorError(400, "Es el unico administrador activo: no se puede desactivar");
    }

    if (numeroEmpleado !== undefined && String(numeroEmpleado).trim() !== String(u.numero_empleado || "")) {
      if (String(numeroEmpleado).trim() === "") {
        if (!esAdmin) throw new OperadorError(400, "Un operador de mantenimiento necesita numero de empleado");
        await auth.setNumeroEmpleado(username, null);
      } else {
        const t = await tecnicoDelMes(numeroEmpleado);
        await assertNumeroLibre(String(t.numeroEmpleado), username);
        await auth.setNumeroEmpleado(username, t.numeroEmpleado);
      }
    }
    if (nombre !== undefined) await auth.setNombre(username, nombre);
    if (hay(pin)) await auth.setPin(username, pin);
    if (hay(password)) await auth.setPassword(username, String(password));
    if (activo !== undefined) await auth.setActive(username, Boolean(activo));
    return vista(await auth.findUserByUsername(username));
  } catch (err) {
    throw error(err);
  }
}

module.exports = { OperadorError, tecnicoDelMes, listar, listarConMes, personalParaAsociar, obtener, alta, altaConsulta, modificar };
