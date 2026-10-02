"use strict";

// Usuarios de DESARROLLO (solo si no existen). No usar en produccion:
// en produccion cree usuarios con scripts/usuarios.js.
//
//   node scripts/seed-dev.js
//
// Contrasenas de desarrollo documentadas en MIGRACION-MYSQL.md; se pueden
// cambiar con SEED_ADMIN_PASSWORD. El operador de desarrollo solo con
// SEED_OP_NUMERO + SEED_OP_PIN (usar mejor Operadores de mantenimiento).

const { loadEnvFile, env } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const auth = require("../lib/auth");

const USUARIOS = [
  { username: "admin", nombre: "Administrador de Mantenimiento (dev)", rol: auth.ROLES.ADMIN, password: env("SEED_ADMIN_PASSWORD", "admin-dev-2026") },
];
// Un operador necesita un empleado del catalogo de KOIDE MES y un PIN de 4
// digitos: solo se siembra si se indican (SEED_OP_NUMERO / SEED_OP_PIN).
if (env("SEED_OP_NUMERO", "") && env("SEED_OP_PIN", "")) {
  USUARIOS.push({ username: "operador", nombre: "Operador de Mantenimiento (dev)", rol: auth.ROLES.OP, pin: env("SEED_OP_PIN", ""), numeroEmpleado: env("SEED_OP_NUMERO", "") });
}

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
