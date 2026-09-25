"use strict";

// Login de la aplicacion: contrasenas con scrypt (nativo de Node) y sesiones
// en MariaDB (tablas usuarios / sesiones, migracion 0003).
//
// La cookie lleva un token aleatorio de 256 bits; en la base solo se guarda su
// SHA-256. Cookie HttpOnly + SameSite=Strict (Secure si SESSION_COOKIE_SECURE=1).

const crypto = require("crypto");
const { promisify } = require("util");
const { query } = require("./db");
const { env } = require("./env");

const scrypt = promisify(crypto.scrypt);

const COOKIE = "metricos_sesion";
const SESSION_HOURS = Number(env("SESSION_HOURS", "12"));
const COOKIE_SECURE = env("SESSION_COOKIE_SECURE", "0") === "1";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

/* ---------- Contrasenas ---------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(String(password), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const got = await scrypt(String(password), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// Hash fijo para gastar el mismo tiempo cuando el usuario no existe.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(password, dummyHash);
}

/* ---------- Limite de intentos (en memoria, por IP + usuario) ---------- */

const fallos = new Map();

function bloqueado(clave) {
  const f = fallos.get(clave);
  if (!f) return false;
  if (f.hasta && f.hasta > Date.now()) return true;
  if (f.hasta) fallos.delete(clave);
  return false;
}

function registrarFallo(clave) {
  const f = fallos.get(clave) || { n: 0, hasta: 0 };
  f.n += 1;
  if (f.n >= MAX_FALLOS) {
    f.hasta = Date.now() + BLOQUEO_MS;
    f.n = 0;
  }
  fallos.set(clave, f);
}

/* ---------- Sesiones ---------- */

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
    COOKIE_SECURE ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function clientIp(req) {
  return String(req.socket.remoteAddress || "").slice(0, 45);
}

// Devuelve { cookie, usuario } si las credenciales son correctas; si no, { error, status }.
async function login(req, usuario, password) {
  usuario = String(usuario || "").trim();
  password = String(password || "");
  if (!usuario || !password) return { status: 400, error: "Usuario y contraseña requeridos" };
  const clave = `${clientIp(req)}|${usuario.toLowerCase()}`;
  if (bloqueado(clave)) return { status: 429, error: "Demasiados intentos. Espere 15 minutos." };

  const [u] = await query("SELECT id, usuario, nombre, rol, password_hash FROM usuarios WHERE usuario = ? AND activo = 1", [
    usuario,
  ]);
  const ok = u ? await verifyPassword(password, u.password_hash) : (await dummyVerify(password), false);
  if (!ok) {
    registrarFallo(clave);
    return { status: 401, error: "Usuario o contraseña incorrectos" };
  }
  fallos.delete(clave);

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expira = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
  await query("DELETE FROM sesiones WHERE expira < ?", [now]);
  await query("INSERT INTO sesiones (token_sha256, usuario_id, creada, expira, ip) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    u.id,
    now,
    expira,
    clientIp(req),
  ]);
  await query("UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?", [now, u.id]);
  return {
    cookie: cookieHeader(token, SESSION_HOURS * 3600),
    usuario: { usuario: u.usuario, nombre: u.nombre, rol: u.rol },
  };
}

// Usuario de la sesion de la peticion, o null.
async function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const [s] = await query(
    `SELECT u.id, u.usuario, u.nombre, u.rol FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_sha256 = ? AND s.expira > ? AND u.activo = 1`,
    [sha256(token), new Date()]
  );
  return s || null;
}

// Borra la sesion de la peticion y devuelve la cookie que la invalida en el navegador.
async function logout(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) await query("DELETE FROM sesiones WHERE token_sha256 = ?", [sha256(token)]);
  return cookieHeader("", 0);
}

module.exports = { hashPassword, verifyPassword, login, logout, sessionUser };
