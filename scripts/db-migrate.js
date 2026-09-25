"use strict";

// Ejecutor de migraciones versionadas para MariaDB 10.4 (XAMPP).
//
//   node scripts/db-migrate.js --plan         solo lectura: muestra que migraciones hay y cuales faltan
//   node scripts/db-migrate.js --crear-bd     (admin) crea la base DB_NAME y el usuario DB_USER
//   node scripts/db-migrate.js --aplicar      aplica las migraciones pendientes de db/migrations/mariadb
//
// --crear-bd usa DB_ADMIN_USER (por defecto root) y DB_ADMIN_PASSWORD, que se
// pasan como variables de entorno SOLO en esa ejecucion (no se guardan en .env).
//
// Reglas:
//   * Solo acepta MariaDB (el proyecto usa MariaDB 10.4.32 de XAMPP).
//   * Cada migracion aplicada se registra en schema_migrations con su SHA-256.
//     Si el archivo de una migracion aplicada cambio, se detiene sin hacer nada.
//   * Si la base tiene tablas pero no tiene schema_migrations, se detiene
//     (no aplica CREATE TABLE IF NOT EXISTS sobre tablas de origen desconocido).
//   * La sesion usa sql_mode estricto (sin truncamientos silenciosos) y UTC.
//   * No cambia la configuracion global de MariaDB/XAMPP.
//   * En MariaDB los CREATE/ALTER TABLE no son transaccionales: si una sentencia
//     falla, se detiene e informa cual; no borra nada automaticamente.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { loadEnvFile, env, ROOT } = require("../lib/env");

loadEnvFile();

const MIG_DIR = path.join(ROOT, "db", "migrations", "mariadb");
const STRICT_SQL_MODE =
  "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const APP_GRANTS =
  "SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, LOCK TABLES, SHOW VIEW, TRIGGER";

function log(...args) {
  console.log("[db-migrate]", ...args);
}

function fail(msg) {
  throw Object.assign(new Error(msg), { controlled: true });
}

function ident(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) fail(`Nombre invalido: ${name}`);
  return "`" + name + "`";
}

function dbConfig() {
  return {
    host: env("DB_HOST", "127.0.0.1"),
    port: Number(env("DB_PORT", "3306")),
    user: env("DB_USER", "metricos"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "metricos"),
  };
}

// Lee las migraciones del disco. El checksum ignora BOM y CRLF para que un
// checkout de git (core.autocrlf) no cambie la huella del archivo.
function readMigrations() {
  if (!fs.existsSync(MIG_DIR)) fail(`No existe ${MIG_DIR}`);
  const files = fs
    .readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const seen = new Set();
  return files.map((file) => {
    const version = file.slice(0, 4);
    if (seen.has(version)) fail(`Version repetida: ${version}`);
    seen.add(version);
    const sql = fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    return {
      version,
      nombre: file.replace(/\.sql$/, ""),
      file,
      sql,
      checksum: crypto.createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  });
}

// Mismo criterio que lib/db.js applySchema: separa por ";" al final de linea
// y quita comentarios de linea completa.
function statements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

async function connect(opts) {
  const conn = await mysql.createConnection({ charset: "utf8mb4", timezone: "Z", connectTimeout: 10000, ...opts });
  await conn.query(`SET SESSION sql_mode = '${STRICT_SQL_MODE}'`);
  await conn.query("SET SESSION time_zone = '+00:00'");
  return conn;
}

async function checkEngine(conn) {
  const [[v]] = await conn.query("SELECT @@version AS version, @@version_comment AS comentario");
  if (!/mariadb/i.test(`${v.version} ${v.comentario}`)) {
    fail(`El servidor no es MariaDB (${v.version} / ${v.comentario}). El proyecto usa MariaDB 10.4.32 de XAMPP.`);
  }
  log(`Servidor: ${v.version} (${v.comentario})`);
  return v.version;
}

/* ---------- --crear-bd ---------- */

async function crearBd() {
  const cfg = dbConfig();
  if (!cfg.password) fail("DB_PASSWORD esta vacio en .env");
  const adminUser = env("DB_ADMIN_USER", "root");
  if (process.env.DB_ADMIN_PASSWORD === undefined) {
    fail(
      "Defina DB_ADMIN_PASSWORD en el entorno de esta ejecucion (puede ser vacia si root no tiene contrasena: DB_ADMIN_PASSWORD=). No se guarda en .env."
    );
  }
  const conn = await connect({ host: cfg.host, port: cfg.port, user: adminUser, password: process.env.DB_ADMIN_PASSWORD });
  try {
    await checkEngine(conn);
    const dbName = ident(cfg.database);

    const [[existe]] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [cfg.database]
    );
    if (existe.n) {
      const [[t]] = await conn.query(
        "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
        [cfg.database]
      );
      if (t.n) fail(`La base ${cfg.database} ya existe y tiene ${t.n} tablas. No se modifica.`);
      log(`La base ${cfg.database} ya existe y esta vacia; se reutiliza.`);
    } else {
      await conn.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci`);
      log(`Base ${cfg.database} creada (utf8mb4 / utf8mb4_unicode_520_ci).`);
    }

    // Usuario de la aplicacion: solo localhost y 127.0.0.1, permisos solo sobre su base.
    // Si ya existe, NO se cambia su contrasena (se informa y se detiene).
    for (const host of ["localhost", "127.0.0.1"]) {
      const [[u]] = await conn.query("SELECT COUNT(*) AS n FROM mysql.user WHERE user = ? AND host = ?", [cfg.user, host]);
      if (u.n) fail(`El usuario '${cfg.user}'@'${host}' ya existe. No se modifica su contrasena; reviselo manualmente.`);
    }
    for (const host of ["localhost", "127.0.0.1"]) {
      await conn.query("CREATE USER ?@? IDENTIFIED BY ?", [cfg.user, host, cfg.password]);
      await conn.query(`GRANT ${APP_GRANTS} ON ${dbName}.* TO ?@?`, [cfg.user, host]);
      log(`Usuario '${cfg.user}'@'${host}' creado con permisos solo sobre ${cfg.database}.`);
    }
  } finally {
    await conn.end();
  }
}

/* ---------- --plan / --aplicar ---------- */

async function estado(conn, dbName) {
  const [tablas] = await conn.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    [dbName]
  );
  const nombres = tablas.map((r) => r.t);
  let aplicadas = new Map();
  if (nombres.includes("schema_migrations")) {
    const [rows] = await conn.query("SELECT version, nombre, checksum_sha256, aplicada FROM schema_migrations ORDER BY version");
    aplicadas = new Map(rows.map((r) => [r.version, r]));
  }
  return { tablas: nombres, aplicadas };
}

function compara(migs, aplicadas) {
  const pendientes = [];
  for (const m of migs) {
    const a = aplicadas.get(m.version);
    if (!a) {
      pendientes.push(m);
      continue;
    }
    if (a.checksum_sha256 !== m.checksum) {
      fail(
        `La migracion ${m.file} ya fue aplicada pero su contenido cambio (checksum ${a.checksum_sha256.slice(0, 12)} vs ${m.checksum.slice(0, 12)}). ` +
          "No se edita una migracion aplicada: cree una nueva."
      );
    }
    if (pendientes.length) fail(`La migracion ${m.version} esta aplicada pero hay anteriores pendientes: orden inconsistente.`);
  }
  for (const v of aplicadas.keys()) {
    if (!migs.some((m) => m.version === v)) fail(`schema_migrations tiene la version ${v}, que no existe en disco.`);
  }
  return pendientes;
}

async function planOAplicar(aplicar) {
  const migs = readMigrations();
  const cfg = dbConfig();
  if (!cfg.password) fail("DB_PASSWORD esta vacio en .env");
  const conn = await connect(cfg);
  try {
    await checkEngine(conn);
    const { tablas, aplicadas } = await estado(conn, cfg.database);
    if (tablas.length && !tablas.includes("schema_migrations")) {
      fail(`La base ${cfg.database} tiene ${tablas.length} tablas sin schema_migrations (${tablas.join(", ")}). No se aplica nada.`);
    }
    const pendientes = compara(migs, aplicadas);

    log(`Base: ${cfg.database}  |  migraciones en disco: ${migs.length}  |  aplicadas: ${aplicadas.size}  |  pendientes: ${pendientes.length}`);
    for (const m of migs) {
      const a = aplicadas.get(m.version);
      log(`  ${m.version}  ${m.nombre.padEnd(32)} ${m.checksum.slice(0, 12)}  ${a ? "aplicada " + a.aplicada.toISOString() : "PENDIENTE (" + statements(m.sql).length + " sentencias)"}`);
    }
    if (!aplicar) {
      log("Modo --plan: no se ejecuto nada.");
      return;
    }

    for (const m of pendientes) {
      const t0 = Date.now();
      const sts = statements(m.sql);
      log(`Aplicando ${m.file} (${sts.length} sentencias)...`);
      for (let i = 0; i < sts.length; i++) {
        try {
          await conn.query(sts[i]);
        } catch (err) {
          fail(
            `Fallo la sentencia ${i + 1}/${sts.length} de ${m.file}: ${err.code || ""} ${err.message}\n` +
              `Sentencia: ${sts[i].slice(0, 300)}\n` +
              "No se registro la migracion. Las sentencias anteriores de este archivo (DDL) pudieron quedar aplicadas: revise antes de reintentar."
          );
        }
      }
      await conn.query(
        "INSERT INTO schema_migrations (version, nombre, checksum_sha256, aplicada, duracion_ms) VALUES (?, ?, ?, ?, ?)",
        [m.version, m.nombre, m.checksum, new Date(), Date.now() - t0]
      );
      log(`  OK ${m.version} (${Date.now() - t0} ms)`);
    }
    log(pendientes.length ? "Migraciones aplicadas." : "No habia migraciones pendientes.");
  } finally {
    await conn.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--crear-bd")) return crearBd();
  if (args.includes("--aplicar")) return planOAplicar(true);
  if (args.includes("--plan")) return planOAplicar(false);
  console.log("Uso: node scripts/db-migrate.js --plan | --crear-bd | --aplicar");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error("[db-migrate] ERROR:", err.message);
  process.exit(1);
});
