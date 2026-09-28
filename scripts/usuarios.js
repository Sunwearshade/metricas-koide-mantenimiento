"use strict";

// Administracion de usuarios de la aplicacion.
//
//   node scripts/usuarios.js listar
//   node scripts/usuarios.js crear <username> <rol> "<nombre>" [numero_empleado]
//   node scripts/usuarios.js password <username>
//   node scripts/usuarios.js desactivar <username>
//   node scripts/usuarios.js activar <username>
//
// Roles: mantenimiento_admin | mantenimiento_op
// La contrasena se pide de forma oculta (o se toma de la variable USUARIO_PASSWORD
// para automatizar). Nunca se pasa como argumento de la linea de comandos.

const readline = require("readline");
const { loadEnvFile } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const auth = require("../lib/auth");

function preguntarOculto(texto) {
  if (process.env.USUARIO_PASSWORD) return Promise.resolve(process.env.USUARIO_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(texto)) rl.output.write(s);
    };
    rl.question(texto, (v) => {
      rl.close();
      process.stdout.write("\n");
      resolve(v);
    });
  });
}

async function pedirPassword() {
  const a = await preguntarOculto("Contrasena (min. 8): ");
  if (process.env.USUARIO_PASSWORD) return a;
  const b = await preguntarOculto("Repetir contrasena: ");
  if (a !== b) throw new Error("Las contrasenas no coinciden");
  return a;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "listar": {
      const rows = await auth.listUsers();
      console.table(rows.map((u) => ({ id: u.id, username: u.username, nombre: u.nombre, rol: u.rol, empleado: u.numero_empleado || "", activo: u.activo ? "si" : "no" })));
      break;
    }
    case "crear": {
      const [username, rol, nombre, numeroEmpleado] = args;
      if (!username || !rol || !nombre) throw new Error('Uso: crear <username> <rol> "<nombre>" [numero_empleado]');
      if (!auth.ROLES_VALIDOS.has(rol)) throw new Error(`Rol invalido. Use: ${[...auth.ROLES_VALIDOS].join(" | ")}`);
      if (await auth.findUserByUsername(username)) throw new Error(`Ya existe el usuario ${username}`);
      const id = await auth.createUser({ username, rol, nombre, numeroEmpleado, password: await pedirPassword() });
      console.log(`Usuario ${username} creado (id ${id}, rol ${rol}).`);
      break;
    }
    case "password": {
      const [username] = args;
      if (!username) throw new Error("Uso: password <username>");
      await auth.setPassword(username, await pedirPassword());
      console.log(`Contrasena de ${username} actualizada; sus sesiones abiertas se cerraron.`);
      break;
    }
    case "activar":
    case "desactivar": {
      const [username] = args;
      if (!username) throw new Error(`Uso: ${cmd} <username>`);
      await auth.setActive(username, cmd === "activar");
      console.log(`Usuario ${username} ${cmd === "activar" ? "activado" : "desactivado"}.`);
      break;
    }
    default:
      console.log("Comandos: listar | crear | password | activar | desactivar  (ver encabezado del script)");
  }
}

main()
  .then(() => db.closePool())
  .catch(async (err) => {
    console.error("[usuarios] ERROR:", err.message);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
