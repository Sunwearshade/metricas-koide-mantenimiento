"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { env, ROOT } = require("./env");

function dbOptions(overrides = {}) {
  return {
    host: env("DB_HOST", "127.0.0.1"),
    port: Number(env("DB_PORT", "3306")),
    user: env("DB_USER", "metricos"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "metricos"),
    charset: "utf8mb4",
    timezone: "Z", // DATETIME se guarda/lee en UTC
    dateStrings: ["DATE"], // DATE como 'YYYY-MM-DD'
    connectionLimit: Number(env("DB_POOL_SIZE", "10")),
    waitForConnections: true,
    ...overrides,
  };
}

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(dbOptions());
  return pool;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

async function query(sql, params) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

// Espera a que MySQL acepte conexiones (el servicio de MySQL puede arrancar
// despues que la app al reiniciar el servidor).
async function waitForDb({ retries = 30, delayMs = 2000, log = console.log } = {}) {
  for (let i = 1; ; i++) {
    try {
      await query("SELECT 1");
      return;
    } catch (err) {
      if (i >= retries) throw err;
      log(`[db] MySQL no disponible (${err.code || err.message}); reintento ${i}/${retries}...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
}

function splitSql(text) {
  return text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

// Aplica db/migrations/NNN_*.sql en orden y registra cada una en
// schema_migraciones. Todas las sentencias son CREATE ... IF NOT EXISTS, asi que
// volver a aplicarlas sobre una base existente no cambia datos.
async function applyMigrations(conn, { log = () => {} } = {}) {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
    version    VARCHAR(100) NOT NULL,
    aplicada   DATETIME(3)  NOT NULL,
    checksum   CHAR(64)     NOT NULL,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [done] = await conn.query("SELECT version, checksum FROM schema_migraciones");
  const applied = new Map(done.map((r) => [r.version, r.checksum]));
  const result = { aplicadas: [], existentes: [] };
  for (const file of migrationFiles()) {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const sum = crypto.createHash("sha256").update(text).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== sum) log(`[db] AVISO: ${file} cambio despues de aplicarse (no se vuelve a ejecutar)`);
      result.existentes.push(file);
      continue;
    }
    for (const sql of splitSql(text)) await conn.query(sql);
    await conn.query("INSERT INTO schema_migraciones (version, aplicada, checksum) VALUES (?, ?, ?)", [file, new Date(), sum]);
    result.aplicadas.push(file);
    log(`[db] Migracion aplicada: ${file}`);
  }
  return result;
}

// Compatibilidad: aplicar el esquema = aplicar las migraciones pendientes.
async function applySchema(conn) {
  const r = await applyMigrations(conn);
  return r.aplicadas.length;
}

// Errores que significan "no hay conexion con la base" (-> HTTP 503).
const CONN_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ER_CON_COUNT_ERROR",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
]);

function isConnectionError(err) {
  return !!err && (CONN_ERRORS.has(err.code) || err.fatal === true);
}

module.exports = {
  dbOptions,
  getPool,
  closePool,
  query,
  tx,
  waitForDb,
  applyMigrations,
  applySchema,
  migrationFiles,
  isConnectionError,
};
