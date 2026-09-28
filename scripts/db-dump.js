"use strict";

// Genera db/metricos-dev.sql: volcado completo (estructura + datos) de la base
// de desarrollo, para reconstruirla sin repetir la migracion.
//
//   node scripts/db-dump.js [--out db/metricos-dev.sql]
//
// No incluye las filas de `sesiones` (tokens de sesion). Usa mysqldump
// (MYSQLDUMP_PATH en .env, o el de XAMPP / PATH).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadEnvFile, env, resolvePath, ROOT } = require("../lib/env");

loadEnvFile();

const i = process.argv.indexOf("--out");
const OUT = resolvePath(i === -1 ? "db/metricos-dev.sql" : process.argv[i + 1]);

function findMysqldump() {
  const candidates = [
    env("MYSQLDUMP_PATH", ""),
    "/Applications/XAMPP/xamppfiles/bin/mysqldump",
    "C:\\xampp\\mysql\\bin\\mysqldump.exe",
    "mysqldump",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  throw new Error("No se encontro mysqldump; defina MYSQLDUMP_PATH en .env");
}

const dump = findMysqldump();
const db = env("DB_NAME", "metricos");
const cnf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "metricos-dump-")), "cliente.cnf");
fs.writeFileSync(
  cnf,
  `[client]\nuser="${env("DB_USER", "metricos")}"\npassword="${env("DB_PASSWORD", "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nhost=${env("DB_HOST", "127.0.0.1")}\nport=${env("DB_PORT", "3306")}\n`,
  { mode: 0o600 }
);
const common = [`--defaults-extra-file=${cnf}`, "--single-transaction", "--skip-dump-date", "--no-tablespaces", "--default-character-set=utf8mb4", "--hex-blob"];
try {
  const datos = execFileSync(dump, [...common, "--routines", "--triggers", `--ignore-table=${db}.sesiones`, db], { maxBuffer: 1 << 30 });
  const sesiones = execFileSync(dump, [...common, "--no-data", db, "sesiones"], { maxBuffer: 1 << 20 });
  const header =
    `-- Metricos de Mantenimiento: base de DESARROLLO (${db}).\n` +
    `-- Generado con: node scripts/db-dump.js   (no incluye filas de sesiones)\n` +
    `-- Restaurar en una base vacia:\n` +
    `--   CREATE DATABASE metricos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n` +
    `--   mysql -u root metricos < db/metricos-dev.sql\n\n`;
  fs.writeFileSync(OUT, Buffer.concat([Buffer.from(header), datos, Buffer.from("\n"), sesiones]));
  console.log(`[db-dump] ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB)`);
} finally {
  fs.rmSync(path.dirname(cnf), { recursive: true, force: true });
}
