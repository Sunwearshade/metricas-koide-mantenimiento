"use strict";

// Carga variables desde un archivo .env (KEY=VALUE) sin dependencias externas.
// Las variables ya definidas en el entorno del proceso tienen prioridad.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnvFile(file = process.env.METRICOS_ENV_FILE || path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return false;
  const vars = parseEnv(fs.readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function resolvePath(p, base = ROOT) {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

module.exports = { ROOT, parseEnv, loadEnvFile, env, resolvePath };
