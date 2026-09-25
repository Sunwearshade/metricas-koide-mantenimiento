"use strict";

// Crea el usuario administrador inicial de la aplicacion.
//
//   node scripts/crear-admin.js               crea ADMIN_USER si no existe (si existe, no lo toca)
//   node scripts/crear-admin.js --restablecer  cambia la contrasena de ADMIN_USER
//
// Lee ADMIN_USER (por defecto "admin") y ADMIN_PASSWORD del entorno o de .env.
// La contrasena se guarda solo como hash scrypt (lib/auth.js). Despues de crear
// el usuario se puede borrar ADMIN_PASSWORD de .env: la aplicacion no la usa.

const { loadEnvFile, env } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const { hashPassword } = require("../lib/auth");

async function main() {
  const usuario = env("ADMIN_USER", "admin").trim();
  const password = process.env.ADMIN_PASSWORD || "";
  const restablecer = process.argv.includes("--restablecer");
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(usuario)) throw new Error("ADMIN_USER invalido (3-60 caracteres: letras, numeros . _ -)");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres (defina la variable en .env o en el entorno)");

  const [existe] = await db.query("SELECT id FROM usuarios WHERE usuario = ?", [usuario]);
  const now = new Date();
  if (existe && !restablecer) {
    console.log(`[crear-admin] El usuario '${usuario}' ya existe; no se modifica. Use --restablecer para cambiar su contrasena.`);
    return;
  }
  const hash = await hashPassword(password);
  if (existe) {
    await db.query("UPDATE usuarios SET password_hash = ?, activo = 1, actualizado = ? WHERE id = ?", [hash, now, existe.id]);
    await db.query("DELETE FROM sesiones WHERE usuario_id = ?", [existe.id]);
    console.log(`[crear-admin] Contrasena de '${usuario}' restablecida; sus sesiones abiertas se cerraron.`);
  } else {
    await db.query(
      "INSERT INTO usuarios (usuario, nombre, password_hash, rol, activo, creado) VALUES (?, ?, ?, 'admin', 1, ?)",
      [usuario, "Administrador", hash, now]
    );
    console.log(`[crear-admin] Usuario administrador '${usuario}' creado.`);
  }
}

main()
  .catch((err) => {
    console.error("[crear-admin] ERROR:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.closePool());
