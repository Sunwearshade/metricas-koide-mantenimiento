"use strict";

// Usuarios de DESARROLLO (solo si no existen). No usar en produccion:
// en produccion cree usuarios con scripts/usuarios.js.
//
//   node scripts/seed-dev.js
//
// Contrasenas de desarrollo documentadas en MIGRACION-MYSQL.md; se pueden
// cambiar con SEED_ADMIN_PASSWORD / SEED_OP_PASSWORD.

const { loadEnvFile, env } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const auth = require("../lib/auth");

const USUARIOS = [
  { username: "admin", nombre: "Administrador de Mantenimiento (dev)", rol: auth.ROLES.ADMIN, password: env("SEED_ADMIN_PASSWORD", "admin-dev-2026") },
  { username: "operador", nombre: "Operador de Mantenimiento (dev)", rol: auth.ROLES.OP, password: env("SEED_OP_PASSWORD", "operador-dev-2026") },
];

(async () => {
  if (env("NODE_ENV", "") === "production") throw new Error("seed-dev no se ejecuta con NODE_ENV=production");
  for (const u of USUARIOS) {
    if (await auth.findUserByUsername(u.username)) {
      console.log(`[seed-dev] ${u.username}: ya existe (sin cambios)`);
      continue;
    }
    await auth.createUser(u);
    console.log(`[seed-dev] ${u.username}: creado (${u.rol})`);
  }
  await db.closePool();
})().catch(async (err) => {
  console.error("[seed-dev] ERROR:", err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
