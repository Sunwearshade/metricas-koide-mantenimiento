"use strict";

// Crea la base de datos, el usuario de la aplicacion y las tablas.
//
//   node scripts/db-setup.js            -> solo aplica db/schema.sql con el usuario de .env
//   node scripts/db-setup.js --admin    -> ademas crea BD + usuario usando
//                                          DB_ADMIN_USER / DB_ADMIN_PASSWORD (variables de entorno)
//
// Es idempotente: se puede ejecutar varias veces.

const mysql = require("mysql2/promise");
const { loadEnvFile, env } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");

function ident(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Nombre invalido: ${name}`);
  return "`" + name + "`";
}

async function createDbAndUser() {
  const opts = db.dbOptions();
  const adminUser = env("DB_ADMIN_USER", "root");
  const conn = await mysql.createConnection({
    host: opts.host,
    port: opts.port,
    user: adminUser,
    password: env("DB_ADMIN_PASSWORD", ""),
    charset: "utf8mb4",
  });
  try {
    const dbName = ident(opts.database);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
    if (!opts.password) throw new Error("DB_PASSWORD esta vacio en .env");
    // localhost = named pipe/socket; 127.0.0.1 y ::1 = TCP local.
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      await conn.query("CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?", [opts.user, host, opts.password]);
      await conn.query("ALTER USER ?@? IDENTIFIED BY ?", [opts.user, host, opts.password]);
      await conn.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES,
           LOCK TABLES, SHOW VIEW, TRIGGER ON ${dbName}.* TO ?@?`,
        [opts.user, host]
      );
    }
    console.log(`[db-setup] Base de datos ${opts.database} y usuario ${opts.user} listos (admin: ${adminUser}).`);
  } finally {
    await conn.end();
  }
}

async function main() {
  if (process.argv.includes("--admin")) await createDbAndUser();
  const conn = await db.getPool().getConnection();
  try {
    const n = await db.applySchema(conn);
    const [tables] = await conn.query("SHOW TABLES");
    console.log(`[db-setup] Esquema aplicado (${n} sentencias). Tablas: ${tables.map((t) => Object.values(t)[0]).join(", ")}`);
  } finally {
    conn.release();
    await db.closePool();
  }
}

main().catch((err) => {
  console.error("[db-setup] ERROR:", err.message);
  process.exit(1);
});
