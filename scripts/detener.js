"use strict";

// Detiene la instancia de este servidor que se quedo escuchando en el puerto
// (p. ej. un `npm start` olvidado en otra terminal).
//
//   npm run stop
//
// Solo termina procesos `node` cuyo directorio de trabajo es este repositorio;
// si el puerto lo ocupa otro programa, lo informa y no lo toca.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadEnvFile, env, resolvePath } = require("../lib/env");

loadEnvFile();

const ROOT = path.resolve(__dirname, "..");

function puertoConfigurado() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(resolvePath(env("CONFIG_FILE", "config.json")), "utf8"));
  } catch {}
  return Number(env("PORT", config.serverPort || 4173));
}

function lsof(args) {
  try {
    return execFileSync("lsof", args, { encoding: "utf8" });
  } catch {
    return ""; // lsof sale con 1 cuando no hay coincidencias
  }
}

function procesoEnPuerto(port) {
  const pids = lsof(["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean);
  return [...new Set(pids)].map((pid) => {
    const campos = lsof(["-a", "-p", pid, "-d", "cwd", "-Fcn"]);
    const cmd = (campos.match(/^c(.*)$/m) || [])[1] || "?";
    const cwd = (campos.match(/^n(.*)$/m) || [])[1] || "?";
    return { pid: Number(pid), cmd, cwd };
  });
}

function sigueVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform === "win32") {
    console.error("En Windows use: netstat -ano | findstr :<puerto>  y luego  taskkill /PID <pid>");
    process.exit(1);
  }
  const port = puertoConfigurado();
  const procesos = procesoEnPuerto(port);
  if (!procesos.length) {
    console.log(`El puerto ${port} esta libre.`);
    return;
  }
  let ajenos = 0;
  for (const p of procesos) {
    if (p.cmd !== "node" || path.resolve(p.cwd) !== ROOT) {
      console.error(`El puerto ${port} lo ocupa otro programa (PID ${p.pid}, ${p.cmd}, ${p.cwd}); no se detiene.`);
      ajenos++;
      continue;
    }
    process.kill(p.pid, "SIGTERM");
    for (let i = 0; i < 60 && sigueVivo(p.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (sigueVivo(p.pid)) process.kill(p.pid, "SIGKILL");
    console.log(`Servidor anterior detenido (PID ${p.pid}); puerto ${port} libre.`);
  }
  if (ajenos) process.exit(1);
}

main();
