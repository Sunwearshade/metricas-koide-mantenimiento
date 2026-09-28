"use strict";

// Usuarios, contrasenas (scrypt) y sesiones (cookie HttpOnly + tabla sesiones).
// Sin dependencias externas: solo el modulo crypto de Node.

const crypto = require("crypto");
const { query } = require("./db");
const { env } = require("./env");

const ROLES = {
  ADMIN: "mantenimiento_admin",
  OP: "mantenimiento_op",
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

async function createUser({ nombre, username, password, rol, numeroEmpleado = null }) {
  if (!ROLES_VALIDOS.has(rol)) throw new Error(`Rol invalido: ${rol}`);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(String(username || ""))) throw new Error("Usuario invalido (3-60 letras, numeros, . _ -)");
  if (!String(nombre || "").trim()) throw new Error("Falta el nombre");
  const now = new Date();
  const r = await query(
    `INSERT INTO usuarios (nombre, username, password_hash, rol, numero_empleado, activo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [String(nombre).trim(), username, await hashPassword(password), rol, numeroEmpleado ? String(numeroEmpleado).trim() : null, now, now]
  );
  return r.insertId;
}

async function setPassword(username, password) {
  const r = await query("UPDATE usuarios SET password_hash = ?, updated_at = ? WHERE username = ?", [await hashPassword(password), new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
  await query("DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.username = ?", [username]);
}

async function setActive(username, activo) {
  const r = await query("UPDATE usuarios SET activo = ?, updated_at = ? WHERE username = ?", [activo ? 1 : 0, new Date(), username]);
  if (!r.affectedRows) throw new Error(`No existe el usuario ${username}`);
  if (!activo) await query("DELETE s FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.username = ?", [username]);
}

async function listUsers() {
  return query("SELECT id, nombre, username, rol, numero_empleado, activo, created_at, updated_at FROM usuarios ORDER BY id");
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
  if (!u) {
    await fakeVerify(password);
    registrarFallo(key);
    return { status: 401, error: "Usuario o contrasena incorrectos" };
  }
  const ok = await verifyPassword(String(password || ""), u.password_hash);
  if (!ok || !u.activo) {
    registrarFallo(key);
    return { status: 401, error: "Usuario o contrasena incorrectos" };
  }
  intentos.delete(key);
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
  // Registrar actividad como maximo cada 5 minutos (evita una escritura por peticion).
  if (Date.now() - row.ultimo_uso.getTime() > 5 * 60 * 1000) {
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
  hashPassword,
  verifyPassword,
  createUser,
  setPassword,
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
