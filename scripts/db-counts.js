"use strict";

// Imprime en JSON el numero de filas de cada tabla (manifiesto de respaldos).

const { loadEnvFile } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");

(async () => {
  const tables = (await db.query("SHOW TABLES")).map((r) => Object.values(r)[0]).sort();
  const counts = {};
  for (const t of tables) counts[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  console.log(JSON.stringify(counts));
  await db.closePool();
})().catch(async (err) => {
  console.error(err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
