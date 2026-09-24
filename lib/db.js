"use strict";

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

function schemaSql() {
  return fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8");
}

async function applySchema(conn) {
  const statements = schemaSql()
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const sql of statements) await conn.query(sql);
  return statements.length;
}

module.exports = { dbOptions, getPool, closePool, query, tx, waitForDb, applySchema };
