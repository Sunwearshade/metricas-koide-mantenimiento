"use strict";

// Usuarios, contrasenas (scrypt) y sesiones (cookie HttpOnly + tabla sesiones).
// Sin dependencias externas: solo el modulo crypto de Node.
//
// ACCESO OPERATIVO (mig 005): el operador de mantenimiento (mantenimiento_op)
// entra con usuario + PIN de 4 digitos; el administrador y el tecnico de
// consulta (mig 006, solo lectura), con contrasena. El
// PIN se guarda como hash scrypt (nunca en texto plano) y tiene limite de
// intentos POR CUENTA y persistente: 5 fallos seguidos -> bloqueo de 15 min;
// 10 -> bloqueo hasta que el administrador restablezca el PIN. La sesion del
// operador expira tras OP_SESSION_IDLE_MIN (30) minutos sin uso, para que en
// un equipo compartido cada tecnico actue con SU identidad.

const crypto = require("crypto");
const { query } = require("./db");
const { env } = require("./env");

const ROLES = {
  ADMIN: "mantenimiento_admin",
  OP: "mantenimiento_op",
  // (mig 006) SOLO LECTURA: desempeno de tecnicos, tiempo muerto, MTTR/MTBF e
  // historico de paros. Ninguna accion de escritura ni de tecnico.
  CONSULTA: "tecnico_consulta",
};
const ROLES_VALIDOS = new Set(Object.values(ROLES));

const COOKIE = "metricos_sid";

/* ---------- Contrasenas ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(secret, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

// PIN del operador: 4 digitos; se rechazan los triviales (1111, 1234, 4321...).
function validarPin(pin) {
  const s = String(pin == null ? "" : pin);
  if (!/^\d{4}$/.test(s)) throw new Error("El PIN debe tener exactamente 4 digitos");
  const d = [...s].map(Number);
  const pasos = d.slice(1).map((x, i) => x - d[i]);
  if (pasos.every((x) => x === 0)) throw new Error("PIN demasiado simple (digitos repetidos)");
  if (pasos.every((x) => x === 1) || pasos.every((x) => x === -1)) throw new Error("PIN demasiado simple (secuencia)");
  return s;
}

async function hashPin(pin) {
  return hashSecret(validarPin(pin));
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) throw new Error("La contrasena debe tener al menos 8 caracteres");
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || typeof password !== "string") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"), { N: +N, r: +r, p: +p, keylen: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

// Para comparar en tiempo constante aunque el usuario no exista.
let dummyHash = null;
async function fakeVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword("contrasena-de-relleno");
  await verifyPassword(String(password || ""), dummyHash);
}

/* ---------- Usuarios ---------- */

function publicUser(u) {
  return { id: u.id, nombre: u.nombre, username: u.username, rol: u.rol, numeroEmpleado: u.numero_empleado || null };
}

async function findUserByUsername(username) {
  const [u] = await query("SELECT * FROM usuarios WHERE username = ?", [String(username || "").trim()]);
  return u || null;
}

// `password` es la contrasena del administrador o el PIN del operador.
async function createUser({ nombre, username, password, pin, rol, numeroEmpleado = null, activo = true }) {
  if (!ROLES_VALIDOS.has(rol)) throw new Error(`Rol invalido: ${rol}`);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(String(username || ""))) throw new Error("Usuario invalido (3-60 letras, numeros, . _ -)");
  if (!String(nombre || "").trim()) throw new Error("Falta el nombre");
  const numero = numeroEmpleado ? String(numeroEmpleado).trim() : null;
  if (rol === ROLES.OP && !numero) throw new Error("El operador de mantenimiento necesita numero de empleado");
  if (rol === ROLES.CONSULTA && numero) throw new Error("Un usuario de consulta no atiende paros: no lleva numero de empleado");
  if (numero) {
    const [otro] = await query("SELECT username FROM usuarios WHERE numero_empleado = ?", [numero]);
    if (otro) throw new Error(`El numero de empleado ${numero} ya lo tiene el usuario ${otro.username}`);
  }
  const hash = rol === ROLES.OP ? await hashPin(pin != null ? pin : password) : await hashPassword(password);
  const now = new Date();
  const r = await query(
    `INSERT INTO usuarios (nombre, username, password_hash, rol, numero_empleado, activo, pin_actualizado, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(nombre).trim(), username, hash, rol, numero, activo ? 1 : 0, rol === ROLES.OP ? now : null, now, now]
  );
  return r.insertId;
}

// Restablece el PIN de un operador: libera bloqueos y cierra sus sesiones.
async function setPin(username, pin) {
  const u = await findUserByUsername(username);
  if (!u) throw new Error(`No existe el usuario ${username}`);
  if (u.rol !== ROLES.OP) throw new Error("Solo los operadores de mantenimiento usan PIN");
  const now = new Date();
  await query(
    `UPDATE usuarios SET password_hash = ?, intentos_fallidos = 0, bloqueado_hasta = NULL, bloqueo_admin = 0,
            pin_actualizado = ?, updated_at = ? WHERE id = ?`,
    [await hashPin(pin), now, now, u.id]
  );
  await query("DELETE FROM sesiones WHERE usuario_id = ?", [u.id]);
  // Tambien el bloqueo en memoria (usuario+IP): si no, el operador seguiria
  // bloqueado hasta 5 min despues de que el administrador lo libero.
  const pref = `${String(username).toLowerCase()}|`;
  for (const k of [...intentos.keys()]) if (k.startsWith(pref)) intentos.delete(k);
}

async function setNombre(username, nombre) {
  if (!String(nombre || "").trim()) throw new Error("Falta el nombre");
  const r = await query("UPDATE usuarios SET nombre = ?, updated_at = ? WHERE username = ?", [String(nombre).trim().slice(0, 150), new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
}

async function setPassword(username, password) {
  const u = await findUserByUsername(username);
  if (u && u.rol === ROLES.OP) return setPin(username, password);
  const r = await query("UPDATE usuarios SET password_hash = ?, updated_at = ? WHERE username = ?", [await hashPassword(password), new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
  await query("DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.username = ?", [username]);
}

async function setActive(username, activo) {
  const r = await query("UPDATE usuarios SET activo = ?, updated_at = ? WHERE username = ?", [activo ? 1 : 0, new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
  if (!activo) await query("DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.username = ?", [username]);
}

// Asigna (o quita, con null) el numero de empleado de un usuario existente.
// La validacion contra el catalogo de tecnicos del MES la hace quien llama
// (scripts/usuarios.js). Un numero identifica a UNA persona: no se repite.
async function setNumeroEmpleado(username, numeroEmpleado) {
  const numero = numeroEmpleado == null ? null : String(numeroEmpleado).trim() || null;
  if (numero) {
    const [otro] = await query("SELECT username FROM usuarios WHERE numero_empleado = ? AND username <> ?", [numero, username]);
    if (otro) throw new Error(`El numero de empleado ${numero} ya lo tiene el usuario ${otro.username}`);
  }
  const r = await query("UPDATE usuarios SET numero_empleado = ?, updated_at = ? WHERE username = ?", [numero, new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
}

async function listUsers() {
  return query(`SELECT id, nombre, username, rol, numero_empleado, activo, intentos_fallidos, bloqueado_hasta, bloqueo_admin,
                       pin_actualizado, created_at, updated_at FROM usuarios ORDER BY id`);
}

// Personal activo CON numero (operadores y administradores que atienden paros):
// entra al roster de tecnicos del dashboard con su rol actual. El rol de
// consulta nunca atiende paros: no forma parte del roster.
async function operadoresActivos() {
  return query("SELECT nombre, numero_empleado, rol FROM usuarios WHERE activo = 1 AND numero_empleado IS NOT NULL AND rol IN (?, ?)", [ROLES.OP, ROLES.ADMIN]);
}

// Capacidades por rol (las aplica server.js; no dependen de la interfaz).
const CAPACIDADES = {
  [ROLES.ADMIN]: new Set(["dashboard", "escribir", "operador", "admin", "historico", "contramedidas"]),
  [ROLES.OP]: new Set(["operador"]),
  [ROLES.CONSULTA]: new Set(["dashboard", "historico"]),
};
function puede(user, capacidad) {
  return Boolean(user && CAPACIDADES[user.rol] && CAPACIDADES[user.rol].has(capacidad));
}

/* ---------- Bloqueo por cuenta (persistente, mig 005) ---------- */

const CUENTA_MAX_INTENTOS = 5;
const CUENTA_BLOQUEO_MS = 15 * 60 * 1000;
const CUENTA_BLOQUEO_DEFINITIVO = 10;

async function fallaCuenta(u) {
  const n = Number(u.intentos_fallidos || 0) + 1;
  const definitivo = u.rol === ROLES.OP && n >= CUENTA_BLOQUEO_DEFINITIVO;
  const temporal = !definitivo && n % CUENTA_MAX_INTENTOS === 0 ? new Date(Date.now() + CUENTA_BLOQUEO_MS) : null;
  await query("UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = COALESCE(?, bloqueado_hasta), bloqueo_admin = ? WHERE id = ?",
    [n, temporal, definitivo ? 1 : Number(u.bloqueo_admin || 0), u.id]);
}

/* ---------- Bloqueo por intentos fallidos (en memoria) ---------- */

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;
const intentos = new Map(); // clave -> { n, hasta }

function throttleKey(username, ip) {
  return `${String(username || "").toLowerCase()}|${ip || ""}`;
}

function bloqueadoHasta(key) {
  const e = intentos.get(key);
  if (!e || !e.hasta) return 0;
  if (e.hasta <= Date.now()) {
    intentos.delete(key);
    return 0;
  }
  return e.hasta;
}

function registrarFallo(key) {
  const e = intentos.get(key) || { n: 0, hasta: 0 };
  e.n += 1;
  if (e.n >= MAX_INTENTOS) {
    e.hasta = Date.now() + BLOQUEO_MS;
    e.n = 0;
  }
  intentos.set(key, e);
}

/* ---------- Sesiones ---------- */

function sessionHours() {
  const h = Number(env("SESSION_HOURS", "12"));
  return h > 0 ? h : 12;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Devuelve { user } | { error, status, retryAfter }
async function login(username, password, { ip, userAgent } = {}) {
  const key = throttleKey(username, ip);
  const hasta = bloqueadoHasta(key);
  if (hasta) return { status: 429, error: "Demasiados intentos. Espere unos minutos.", retryAfter: Math.ceil((hasta - Date.now()) / 1000) };
  const u = await findUserByUsername(username);
  const NO = "Usuario, PIN o contrasena incorrectos";
  if (!u) {
    await fakeVerify(password);
    registrarFallo(key);
    return { status: 401, error: NO };
  }
  if (Number(u.bloqueo_admin)) {
    return { status: 423, error: "Cuenta bloqueada por intentos fallidos: pide al administrador de mantenimiento que restablezca tu PIN" };
  }
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta).getTime() > Date.now()) {
    return { status: 429, error: "Demasiados intentos. Espere unos minutos.", retryAfter: Math.ceil((new Date(u.bloqueado_hasta).getTime() - Date.now()) / 1000) };
  }
  // El operador SOLO entra con PIN de 4 digitos (una contrasena larga no aplica).
  const secreto = String(password || "");
  const formaOk = u.rol !== ROLES.OP || /^\d{4}$/.test(secreto);
  const ok = formaOk && (await verifyPassword(secreto, u.password_hash));
  if (!ok || !u.activo) {
    registrarFallo(key);
    if (u.activo) await fallaCuenta(u);
    return { status: 401, error: NO };
  }
  intentos.delete(key);
  if (Number(u.intentos_fallidos) || u.bloqueado_hasta) await query("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?", [u.id]);
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expira = new Date(now.getTime() + sessionHours() * 3600 * 1000);
  await query("DELETE FROM sesiones WHERE expira < ?", [now]);
  await query("INSERT INTO sesiones (token_hash, usuario_id, creada, expira, ultimo_uso, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    sha256(token),
    u.id,
    now,
    expira,
    now,
    ip ? String(ip).slice(0, 64) : null,
    userAgent ? String(userAgent).slice(0, 255) : null,
  ]);
  return { user: publicUser(u), token, expira };
}

async function sessionUser(token) {
  if (!token) return null;
  const [row] = await query(
    `SELECT u.*, s.ultimo_uso, s.expira, s.token_hash FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = ? AND s.expira > ? AND u.activo = 1`,
    [sha256(token), new Date()]
  );
  if (!row) return null;
  // Operador: la sesion vence por inactividad (equipo compartido).
  const idleMin = Number(env("OP_SESSION_IDLE_MIN", "30"));
  if (row.rol === ROLES.OP && idleMin > 0 && Date.now() - row.ultimo_uso.getTime() > idleMin * 60 * 1000) {
    await query("DELETE FROM sesiones WHERE token_hash = ?", [row.token_hash]);
    return null;
  }
  // Registrar actividad como maximo cada minuto (evita una escritura por peticion).
  if (Date.now() - row.ultimo_uso.getTime() > 60 * 1000) {
    await query("UPDATE sesiones SET ultimo_uso = ? WHERE token_hash = ?", [new Date(), row.token_hash]);
  }
  return publicUser(row);
}

async function logout(token) {
  if (token) await query("DELETE FROM sesiones WHERE token_hash = ?", [sha256(token)]);
}

/* ---------- Cookies ---------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

function tokenFromReq(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function sessionCookie(token, expira) {
  const secure = env("COOKIE_SECURE", "0") === "1" ? "; Secure" : "";
  const maxAge = Math.max(0, Math.floor((expira.getTime() - Date.now()) / 1000));
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

module.exports = {
  ROLES,
  ROLES_VALIDOS,
  CAPACIDADES,
  puede,
  hashPassword,
  verifyPassword,
  createUser,
  setPassword,
  setPin,
  setNombre,
  validarPin,
  operadoresActivos,
  setNumeroEmpleado,
  setActive,
  listUsers,
  findUserByUsername,
  login,
  logout,
  sessionUser,
  tokenFromReq,
  sessionCookie,
  clearCookie,
};
