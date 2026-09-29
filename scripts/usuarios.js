"use strict";

// Administracion de usuarios de la aplicacion.
//
//   node scripts/usuarios.js listar
//   node scripts/usuarios.js crear <username> <rol> "<nombre>" [numero_empleado]
//   node scripts/usuarios.js password <username>
//   node scripts/usuarios.js desactivar <username>
//   node scripts/usuarios.js pin <username>            (operador: PIN de 4 digitos)
//   node scripts/usuarios.js empleado <username> <numero_empleado>
//   node scripts/usuarios.js empleado <username> --quitar
//
// numero_empleado es la identidad del tecnico ante KOIDE MES: debe existir y
// estar ACTIVO en su catalogo de personal de mantenimiento (mtto_personal).
// Se valida en linea contra el MES (KOIDE_GENERAL_URL / KOIDE_GENERAL_TOKEN);
// si el MES no responde, no se asigna.
//   node scripts/usuarios.js activar <username>
//
// Roles: mantenimiento_admin | mantenimiento_op
// La contrasena (administrador) o el PIN (operador, 4 digitos) se piden de forma
// oculta (o se toman de USUARIO_PASSWORD para automatizar). Nunca se pasan como
// argumento de la linea de comandos. Los operadores tambien se administran desde
// el dashboard (Operadores de mantenimiento).

const readline = require("readline");
const { loadEnvFile } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const auth = require("../lib/auth");
const { tecnicoDelMes } = require("../lib/operadores");

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

async function pedirPassword(texto = "Contrasena (min. 8): ") {
  const a = await preguntarOculto(texto);
  if (process.env.USUARIO_PASSWORD) return a;
  const b = await preguntarOculto("Repetir: ");
  if (a !== b) throw new Error("No coinciden");
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
      if (numeroEmpleado) await tecnicoDelMes(numeroEmpleado);
      const esOp = rol === auth.ROLES.OP;
      const secreto = await pedirPassword(esOp ? "PIN (4 digitos): " : undefined);
      const id = await auth.createUser({ username, rol, nombre, numeroEmpleado, password: esOp ? undefined : secreto, pin: esOp ? secreto : undefined });
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
    case "pin": {
      const [username] = args;
      if (!username) throw new Error("Uso: pin <username>");
      await auth.setPin(username, await pedirPassword("PIN (4 digitos): "));
      console.log(`PIN de ${username} restablecido; bloqueos liberados y sesiones cerradas.`);
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
    case "empleado": {
      const [username, numero] = args;
      if (!username || !numero) throw new Error("Uso: empleado <username> <numero_empleado> | empleado <username> --quitar");
      if (!(await auth.findUserByUsername(username))) throw new Error(`No existe el usuario ${username}`);
      if (numero === "--quitar") {
        await auth.setNumeroEmpleado(username, null);
        console.log(`Usuario ${username} sin numero de empleado: queda en modo consulta para acciones de tecnico.`);
        break;
      }
      const t = await tecnicoDelMes(numero);
      await auth.setNumeroEmpleado(username, t.numeroEmpleado);
      console.log(`Usuario ${username} -> numero de empleado ${t.numeroEmpleado} (${t.nombre} en KOIDE MES).`);
      break;
    }
    default:
      console.log("Comandos: listar | crear | password | pin | activar | desactivar | empleado  (ver encabezado del script)");
  }
}

main()
  .then(() => db.closePool())
  .catch(async (err) => {
    console.error("[usuarios] ERROR:", err.message);
    await db.closePool().catch(() => {});
    process.exit(1);
  });
