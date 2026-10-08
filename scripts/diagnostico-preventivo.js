"use strict";

// Diagnostico del Programa preventivo: que ve la app en ESTA base.
// Solo lectura. Ejecutar desde la carpeta de la app (la misma que usa el servicio):
//
//   node scripts/diagnostico-preventivo.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { loadEnvFile, env, ROOT } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "(sin git)";
  }
}

(async () => {
  console.log("Carpeta de la app:", ROOT);
  console.log("Commit:", git("log -1 --format=%h_%s"), "| cambios locales:", git("status --short") || "ninguno");
  console.log("Base:", `${env("DB_USER", "?")}@${env("DB_HOST", "?")}:${env("DB_PORT", "3306")}/${env("DB_NAME", "?")}`);

  const archivos = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const aplicadas = (await db.query("SELECT version, aplicada FROM schema_migraciones ORDER BY version")).map((r) => r.version);
  console.log("Migraciones en disco:", archivos.length, "| aplicadas en la base:", aplicadas.length);
  const faltan = archivos.filter((f) => !aplicadas.includes(f));
  console.log("Pendientes:", faltan.length ? faltan.join(", ") : "ninguna");
  console.log("Ultimas aplicadas:", aplicadas.slice(-3).join(", "));

  const meses = await db.query(
    `SELECT m.mes, COUNT(t.id) AS tareas, SUM(t.estado <> '') AS marcadas, SUM(t.reporte_en IS NOT NULL) AS reportes
       FROM preventivo_meses m LEFT JOIN preventivo_tareas t ON t.mes = m.mes GROUP BY m.mes ORDER BY m.mes`
  );
  console.log("\nMeses del programa preventivo:");
  for (const m of meses) console.log(`  ${m.mes}: ${m.tareas} tareas, ${Number(m.marcadas || 0)} marcadas, ${Number(m.reportes || 0)} con reporte`);
  if (!meses.length) console.log("  (ninguno)");

  const oct = await db.query(
    `SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha, orden, maquina_codigo, estado FROM preventivo_tareas
      WHERE mes = '2026-10' ORDER BY fecha, orden LIMIT 6`
  );
  console.log("\nPrimeras tareas de octubre 2026 (esperado: 01 CNC1 Realizado, 01 B8, 02 B13, 02 C12, 03 C8, 03 C19):");
  for (const t of oct) console.log(`  ${t.fecha} #${t.orden} ${t.maquina_codigo} ${t.estado || "-"}`);
  if (!oct.length) console.log("  (sin tareas)");

  const usuarios = await db.query("SELECT username, rol, activo FROM usuarios WHERE rol <> 'mantenimiento_op' ORDER BY username");
  console.log("\nCuentas (sin operadores):");
  for (const u of usuarios) console.log(`  ${u.username}: ${u.rol}${u.activo ? "" : " (inactiva)"}`);

  await db.closePool();
})().catch(async (err) => {
  console.error("ERROR:", err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
