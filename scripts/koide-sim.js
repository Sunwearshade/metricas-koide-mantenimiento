"use strict";

// Simulador de la API koide SOLO PARA DESARROLLO (cuando 192.168.1.201 no es
// alcanzable). Implementa exactamente lo que server.js consume:
//   POST /api/auth/login            { department, password } -> { token }
//   GET  /api/downtime-records?responsibleArea=...  (X-Auth-Token)
//   GET  /api/machines                              (X-Auth-Token)
// y agrega, para pruebas:
//   GET  /sim                       formulario para crear un paro abierto
//   POST /sim/paros                 { machine_code, descripcion, categoria } -> registro creado
//
// Parte de una COPIA en memoria de data/tiempo-muerto.json (no la modifica).
//
//   node scripts/koide-sim.js            (puerto 4000; KOIDE_SIM_PORT para cambiarlo)
//   .env de desarrollo: KOIDE_BASE_URL=http://127.0.0.1:4000  KOIDE_PASSWORD=sim

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEnvFile, env, resolvePath } = require("../lib/env");

loadEnvFile();

const PORT = Number(env("KOIDE_SIM_PORT", "4000"));
const PASSWORD = env("KOIDE_SIM_PASSWORD", "sim");
const src = path.join(resolvePath(env("DATA_DIR", "data")), "tiempo-muerto.json");
const base = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, "utf8")) : { records: [], machines: [] };
const records = base.records.slice();
const machines = base.machines.slice();
const TOKEN = crypto.randomBytes(12).toString("hex");
let nextId = Math.max(0, ...records.map((r) => r.id)) + 1;

function send(res, code, obj, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(d)));
      }
    });
  });
}

function crearParo({ machine_code, descripcion, categoria }) {
  const m = machines.find((x) => String(x.code).toUpperCase() === String(machine_code || "").toUpperCase());
  if (!m) throw new Error(`No existe la maquina ${machine_code}`);
  const now = new Date();
  const r = {
    id: nextId++,
    record_date: now.toISOString().slice(0, 10),
    shift: "T1",
    group_name: "A",
    machine_id: m.id,
    operator_employee_number: "0000",
    operator_name: "SIMULADOR",
    product_id: null,
    downtime_start: now.toISOString(),
    downtime_end: null,
    downtime_minutes: null,
    responsible_area: "Mantenimiento",
    downtime_category: categoria || "Falla mecánica",
    problem_description: descripcion || "Paro de prueba (simulador)",
    responsible_person: null,
    action_taken: null,
    status: "Abierto",
    started_by_employee_number: "0000",
    closed_by_employee_number: null,
    production_receiver_employee_number: null,
    production_receiver_name: null,
    captured_by_department: "Producción",
    comments: "Creado por koide-sim (desarrollo)",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    repair_start: null,
    repair_started_by_employee_number: null,
    response_time_minutes: null,
    repair_time_minutes: null,
    external_note: null,
    external_started_at: null,
    external_minutes: null,
    machine_code: m.code,
    machine_name: m.name,
    machine_process: m.process,
    product_item_number: null,
    product_description: null,
  };
  records.unshift(r);
  return r;
}

const FORM = () => `<!doctype html><meta charset="utf-8"><title>koide-sim</title>
<body style="font-family:system-ui;max-width:520px;margin:40px auto">
<h2>Simulador koide (desarrollo)</h2>
<form method="post" action="/sim/paros">
<p><label>Maquina <select name="machine_code">${machines.map((m) => `<option>${m.code}</option>`).join("")}</select></label></p>
<p><label>Problema <input name="descripcion" value="Paro de prueba (simulador)" size="40"></label></p>
<p><button>Crear paro abierto</button></p></form>
<h3>Paros abiertos</h3><ul>${records
  .filter((r) => !r.downtime_end)
  .map((r) => `<li><b>Codigo ${r.id}</b> · ${r.machine_code} · ${r.problem_description}</li>`)
  .join("")}</ul></body>`;

http
  .createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/api/auth/login" && req.method === "POST") {
      const b = await body(req);
      if (b.password !== PASSWORD) return send(res, 401, { error: "credenciales" });
      return send(res, 200, { token: TOKEN, department: b.department || "Mantenimiento", role: "Mantenimiento" });
    }
    if (url === "/sim" && req.method === "GET") return send(res, 200, FORM(), "text/html; charset=utf-8");
    if (url === "/sim/paros" && req.method === "POST") {
      try {
        const r = crearParo(await body(req));
        console.log(`[koide-sim] Paro creado: codigo ${r.id} (${r.machine_code})`);
        if ((req.headers["content-type"] || "").includes("json")) return send(res, 200, r);
        res.writeHead(303, { Location: "/sim" });
        return res.end();
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.headers["x-auth-token"] !== TOKEN) return send(res, 401, { error: "token" });
    if (url === "/api/downtime-records") {
      const area = new URL(req.url, "http://x").searchParams.get("responsibleArea");
      return send(res, 200, records.filter((r) => !area || r.responsible_area === area));
    }
    if (url === "/api/machines") return send(res, 200, machines);
    send(res, 404, { error: "no encontrado" });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`[koide-sim] http://127.0.0.1:${PORT}  (${records.length} paros de ${path.basename(src)}; crear paros en /sim)`);
  });
