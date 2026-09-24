"use strict";

// Pruebas de integracion de punta a punta contra MySQL real.
//
//   npm test
//
// Requiere un archivo .env.test (o METRICOS_TEST_ENV_FILE) con una base de datos
// DE PRUEBA cuyo nombre termine en "_test" (se borra su contenido), p.ej.:
//   DB_HOST=127.0.0.1  DB_PORT=3306  DB_NAME=metricos_test  DB_USER=...  DB_PASSWORD=...
//   PYTHON_PATH=C:\Program Files\Python312\python.exe
//
// Levanta un simulador de la API koide, genera Excel sinteticos, migra JSON de
// prueba, arranca server.js y prueba cada modulo via HTTP.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const XLSX = require("xlsx");
const { parseEnv, ROOT } = require("../lib/env");

const envFile = process.env.METRICOS_TEST_ENV_FILE || path.join(ROOT, ".env.test");
if (!fs.existsSync(envFile)) {
  console.error(`No existe ${envFile}. Vea el encabezado de tests/integration.test.js`);
  process.exit(1);
}
const TEST_ENV = parseEnv(fs.readFileSync(envFile, "utf8"));
if (!/_test$/.test(TEST_ENV.DB_NAME || "")) {
  console.error("DB_NAME de pruebas debe terminar en _test (su contenido se borra).");
  process.exit(1);
}
const PYTHON = TEST_ENV.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3");
const EXCEL_PASSWORD = "PruebaExcel1";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "metricos-test-"));
const DATA_DIR = path.join(TMP, "data");
const XL_DIR = path.join(TMP, "excel");

/* ---------- Datos sinteticos ---------- */

function makeRecords(n, startId = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = new Date(Date.UTC(2026, 8, 1 + (i % 20), 8, i % 60));
    out.push({
      id: startId + i,
      record_date: start.toISOString().slice(0, 10),
      shift: "T1",
      group_name: "A",
      machine_id: 1 + (i % 3),
      operator_employee_number: String(1000 + i),
      operator_name: `OPERADOR ${i}`,
      product_id: null,
      downtime_start: start.toISOString(),
      downtime_end: i === 0 ? null : new Date(start.getTime() + 30 * 60000).toISOString(),
      downtime_minutes: i === 0 ? null : 30,
      responsible_area: "Mantenimiento",
      downtime_category: "Mecánico",
      problem_description: `Falla ñ ${i} "comillas" \\ diagonal`,
      responsible_person: i % 2 ? "Técnico" : null,
      machine_code: `M${1 + (i % 3)}`,
      machine_name: "MAQ",
      machine_process: "CORTE",
    });
  }
  return out;
}

const MACHINES = [1, 2, 3].map((id) => ({
  id,
  code: `M${id}`,
  name: `MAQ-${id}`,
  process: "CORTE",
  active: 1,
  created_at: "2026-05-26T05:41:12.023Z",
  updated_at: "2026-08-31T04:53:47.511Z",
  target_pcs_per_hour: 450,
  effective_hours_per_day: 21.599999999999998,
}));

function xlsxBuffer(rows, sheet = "Hoja1") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function writeFixtureData() {
  fs.mkdirSync(path.join(DATA_DIR, "contramedidas-fotos", "cmfoto1"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "documentos", "Check list"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "calendarios"), { recursive: true });
  const w = (f, obj) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(obj, null, 2));
  w("tiempo-muerto.json", {
    updatedAt: "2026-09-01T10:00:00.000Z",
    area: "Mantenimiento",
    source: "live",
    records: makeRecords(25),
    machines: MACHINES,
  });
  w("gastos.json", [
    { sheet: "1-ENERO", cotizacion: 9, proveedor: "P", producto: "X", observaciones: "", cantidad: 5.0, unidad: "PZA", precio_unitario: 1.5, importe: 7.5, iva: 1.2, total_partida: 8.7, po: "1", tiene_po: true, entregado: false, entregado_meses: [], fecha_elaboracion: "", fecha_entrega: "2026-01-02", mes_entrega: 0, moneda: "MXN", proyecto: "", termino_pago: "", comentario: "" },
  ]);
  w("entregas.json", [
    { proveedor: "P", material: "M", cantidad: 1, depto: "X-MTTO", serie: "S", po: 1, fecha_envio: "2026-01-01", fecha_estimada: "", dias: "", estatus: "ENTREGADO", observaciones: "", mes: 0 },
  ]);
  w("contramedidas.json", [
    { id: "cmfoto1", tipo: "Falla común", maquina: "M1", maquinaNombre: "MAQ-1", referencia: "M1", categoria: "", descripcion: "d", responsable: "R", fechaLimite: "2026-08-05", estado: "Completado", creada: "2026-08-19T14:48:10.344Z", trabajoRealizado: "hecho", fotos: ["foto_a.png"] },
    { id: "cmvieja2", tipo: "MTTR", maquina: "M2", maquinaNombre: "MAQ-2", referencia: "M2", categoria: "", descripcion: "", responsable: "R2", fechaLimite: "", estado: "Pendiente", creada: "2026-08-20T10:00:00.000Z", campoExtra: { a: 1 } },
  ]);
  fs.writeFileSync(path.join(DATA_DIR, "contramedidas-fotos", "cmfoto1", "foto_a.png"), Buffer.alloc(200, 7));
  fs.writeFileSync(path.join(DATA_DIR, "documentos", "Check list", "lista.pdf"), "pdf de prueba");
  const tpl = xlsxBuffer([["DOCUMENTO", "", "Codigo"], ["SEMANA", 32]], "bono");
  fs.writeFileSync(path.join(DATA_DIR, "template-bonos.xlsx"), tpl);
  w("bonos.json", {
    template: { sheet: "bono", ref: "A1:C2", cells: { A1: { v: "DOCUMENTO", t: "s", w: "DOCUMENTO" }, B2: { v: 32, t: "n", w: "32" }, A2: { v: "SEMANA", t: "s", w: "SEMANA" } }, merges: [], cols: [], maxRow: 1, maxCol: 2 },
    weeks: {
      "2026-W30": { key: "2026-W30", semana: 30, periodoIni: "2026-07-20", periodoFin: "2026-07-26", fecha: "2026-07-27", cells: { D9: "30", N13: "82%" }, guardado: "2026-08-10T17:28:51.392Z" },
      "2026-W28": { key: "2026-W28", semana: 28, periodoIni: "2026-07-06", periodoFin: "2026-07-12", fecha: "2026-07-13", cells: { N13: "71%", D9: "28" }, guardado: "2026-08-10T17:30:00.000Z" },
    },
    updatedAt: "2026-08-10T16:46:18.245Z",
  });
  w("calendarios.json", []);
}

/* ---------- Simulador de la API koide ---------- */

let koideRecords = makeRecords(25);
let koideLogins = 0;
const KOIDE_TOKEN = "tok-prueba";

function startKoide() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/api/auth/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body || "{}");
        if (b.department !== "Mantenimiento" || b.password !== "clave-koide") return send(401, { error: "bad" });
        koideLogins++;
        send(200, { token: KOIDE_TOKEN, department: "Mantenimiento", role: "Mantenimiento" });
      });
      return;
    }
    if (req.headers["x-auth-token"] !== KOIDE_TOKEN) return send(401, { error: "token" });
    if (req.url.startsWith("/api/downtime-records?responsibleArea=Mantenimiento")) return send(200, koideRecords);
    if (req.url === "/api/machines") return send(200, MACHINES);
    send(404, {});
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/* ---------- Servidor de la app ---------- */

let appProc = null;
let BASE = "";
let appEnv = null;

function childEnv(extra = {}) {
  return {
    ...process.env,
    ...TEST_ENV,
    METRICOS_ENV_FILE: path.join(TMP, "no-existe.env"),
    DATA_DIR,
    PYTHON_PATH: PYTHON,
    GASTOS_EXCEL_PATH: path.join(XL_DIR, "MANTENIMIENTO.xlsx"),
    ENTREGAS_EXCEL_PATH: path.join(XL_DIR, "TIEMPO DE ENTREGA.xlsx"),
    GASTOS_EXCEL_PASSWORD: EXCEL_PASSWORD,
    KOIDE_DEPARTMENT: "Mantenimiento",
    KOIDE_PASSWORD: "clave-koide",
    LOG_DIR: path.join(TMP, "logs"),
    ...extra,
  };
}

async function startApp() {
  appProc = spawn(process.execPath, [path.join(ROOT, "server.js")], { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  appProc.stdout.on("data", (d) => (out += d));
  appProc.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    if (appProc.exitCode !== null) throw new Error("server.js termino:\n" + out);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server.js no respondio:\n" + out);
}

function stopApp() {
  return new Promise((resolve) => {
    if (!appProc || appProc.exitCode !== null) return resolve();
    appProc.once("exit", resolve);
    appProc.kill("SIGTERM");
  });
}

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

let koide;
let dbq;

test.before(async () => {
  writeFixtureData();
  execFileSync(PYTHON, [path.join(__dirname, "fixtures", "make_excels.py"), XL_DIR, EXCEL_PASSWORD]);
  koide = await startKoide();
  const port = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://127.0.0.1:${port}`;
  appEnv = childEnv({ PORT: String(port), KOIDE_BASE_URL: `http://127.0.0.1:${koide.address().port}` });

  // Base de pruebas limpia + esquema + migracion de los JSON sinteticos.
  Object.assign(process.env, appEnv);
  const db = require("../lib/db");
  dbq = db.query;
  const conn = await db.getPool().getConnection();
  await db.applySchema(conn);
  const [tables] = await conn.query("SHOW TABLES");
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of tables) await conn.query(`DELETE FROM \`${Object.values(t)[0]}\``);
  await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  conn.release();
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "migrate-json-to-mysql.js")], { env: appEnv, cwd: TMP }).toString();
  assert.match(out, /RESULTADO: OK/);
  await startApp();
});

test.after(async () => {
  await stopApp();
  koide && koide.close();
  await require("../lib/db").closePool();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const count = async (table, where = "") => Number((await dbq(`SELECT COUNT(*) AS n FROM ${table} ${where}`))[0].n);

/* ---------- Pruebas ---------- */

test("archivos estaticos y proteccion de rutas", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal((await fetch(BASE + "/app.js")).status, 200);
  const bad = await fetch(BASE + "/..%2f..%2fconfig.json");
  assert.notEqual(bad.status, 200);
});

test("tiempo muerto: /api/data sirve lo migrado y /api/refresh sincroniza koide", async () => {
  let r = await api("GET", "/api/data");
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 25);
  assert.equal(r.data.machines.length, 3);
  assert.ok(Array.isArray(r.data.technicians));
  assert.ok(r.data.performance);
  assert.deepEqual(r.data.records[0], makeRecords(25)[0]);

  koideRecords = makeRecords(30);
  r = await api("GET", "/api/refresh");
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 30);
  assert.equal(r.data.source, "live");
  assert.equal(r.data.lastError, null);
  assert.ok(koideLogins >= 1, "debe iniciar sesion en koide con las credenciales de .env");
  assert.equal(await count("tiempo_muerto"), 30);
  const [row] = await dbq("SELECT record_date, machine_code, downtime_minutes, problem_description FROM tiempo_muerto WHERE id = 1001");
  assert.equal(row.record_date, "2026-09-02");
  assert.equal(row.machine_code, "M2");
  assert.equal(row.downtime_minutes, 30);
  assert.equal(row.problem_description, 'Falla ñ 1 "comillas" \\ diagonal');

  const h = await api("GET", "/api/health");
  assert.equal(h.data.ok, true);
  assert.ok(h.data.nextUpdate);
});

test("contramedidas: crear, editar, completar, fotos, borrar", async () => {
  let r = await api("GET", "/api/contramedidas");
  assert.equal(r.data.length, 2);
  assert.deepEqual(r.data[1].campoExtra, { a: 1 }, "campos no estandar se conservan");
  assert.equal(r.data[1].fechaLimite, "");

  r = await api("POST", "/api/contramedidas", { tipo: "Correctivo", maquina: "M3", maquinaNombre: "MAQ-3", fallaComun: "", responsable: "Ana", fechaLimite: "2026-10-01", estado: "Pendiente" });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal(r.data.referencia, "M3");
  assert.match(r.data.creada, /Z$/);
  const creada = r.data;

  r = await api("PUT", `/api/contramedidas/${id}`, { tipo: "MTTR", maquina: "M3", maquinaNombre: "MAQ-3", fallaComun: "x", responsable: "Luis", fechaLimite: "", estado: "En proceso" });
  assert.equal(r.status, 200);
  assert.equal(r.data.responsable, "Luis");
  assert.equal(r.data.fechaLimite, "");
  assert.equal(r.data.creada, creada.creada);

  r = await api("PUT", `/api/contramedidas/${id}`, { estado: "Completado", trabajoRealizado: "Se cambió el rodamiento" });
  assert.equal(r.data.trabajoRealizado, "Se cambió el rodamiento");

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]);
  r = await api("POST", `/api/contramedidas/${id}/fotos`, {
    fotos: [
      { name: "antes_a.png", base64: png.toString("base64") },
      { name: "despues_b.jpg", base64: png.toString("base64") },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.fotos.length, 2);
  assert.equal(await count("contramedida_fotos", `WHERE contramedida_id = '${id}'`), 2);
  const [foto] = await dbq("SELECT ruta FROM contramedida_fotos WHERE contramedida_id = ? ORDER BY orden", [id]);
  assert.ok(fs.existsSync(path.join(DATA_DIR, foto.ruta)), "la ruta guardada en MySQL apunta al archivo en disco");

  r = await api("POST", `/api/contramedidas/${id}/fotos`, { fotos: [{ name: "c.png", base64: png.toString("base64") }] });
  assert.equal(r.status, 400, "maximo 2 fotos");

  const nombreFoto = (await api("GET", "/api/contramedidas")).data.find((c) => c.id === id).fotos[0];
  const f = await api("GET", `/api/contramedidas/fotos/${id}/${nombreFoto}`);
  assert.equal(f.status, 200);
  assert.deepEqual(f.data, png);

  r = await api("GET", "/api/contramedidas");
  assert.equal(r.data.length, 3);
  const full = r.data.find((c) => c.id === id);
  assert.deepEqual(Object.keys(full), ["id", "tipo", "maquina", "maquinaNombre", "fallaComun", "referencia", "categoria", "descripcion", "responsable", "fechaLimite", "estado", "creada", "trabajoRealizado", "fotos"]);

  r = await api("DELETE", `/api/contramedidas/${id}`);
  assert.equal(r.status, 200);
  assert.equal((await api("GET", "/api/contramedidas")).data.length, 2);
  assert.equal(await count("contramedida_fotos", `WHERE contramedida_id = '${id}'`), 0);
  assert.equal((await api("PUT", "/api/contramedidas/noexiste", {})).status, 404);
});

test("bonos: plantilla, semanas, descarga", async () => {
  let r = await api("GET", "/api/bonos");
  assert.equal(r.data.updatedAt, "2026-08-10T16:46:18.245Z");
  assert.deepEqual(Object.keys(r.data.template.cells), ["A1", "B2", "A2"], "orden de celdas preservado");
  assert.deepEqual(Object.keys(r.data.weeks), ["2026-W30", "2026-W28"]);

  r = await api("POST", "/api/bonos/week", { key: "2026-W30", semana: 30, periodoIni: "2026-07-20", periodoFin: "2026-07-26", fecha: "2026-07-27", cells: { D9: "30", N13: "95%" } });
  assert.equal(r.status, 200);
  r = await api("POST", "/api/bonos/week", { key: "2026-W40", semana: 40, periodoIni: "", periodoFin: "", fecha: "", cells: {} });
  r = await api("GET", "/api/bonos");
  assert.deepEqual(Object.keys(r.data.weeks), ["2026-W30", "2026-W28", "2026-W40"], "reescribir una semana conserva su posicion");
  assert.equal(r.data.weeks["2026-W30"].cells.N13, "95%");
  assert.equal((await api("POST", "/api/bonos/week", { semana: 1 })).status, 400);

  r = await api("DELETE", "/api/bonos/week/2026-W28");
  r = await api("GET", "/api/bonos");
  assert.deepEqual(Object.keys(r.data.weeks), ["2026-W30", "2026-W40"]);

  const nueva = xlsxBuffer([["NUEVA PLANTILLA", "x"], ["SEMANA", 41]], "bono2");
  r = await api("POST", "/api/bonos", { name: "nueva.xlsx", base64: nueva.toString("base64") });
  assert.equal(r.status, 200);
  assert.equal(r.data.template.cells.A1.v, "NUEVA PLANTILLA");
  r = await api("GET", "/api/bonos");
  assert.equal(r.data.template.sheet, "bono2");
  assert.notEqual(r.data.updatedAt, "2026-08-10T16:46:18.245Z");
  assert.equal(Object.keys(r.data.weeks).length, 2, "subir plantilla no toca las semanas");
  const d = await api("GET", "/api/bonos/plantilla");
  assert.deepEqual(d.data, nueva);
  const [p] = await dbq("SELECT hoja, archivo_ruta FROM bonos_plantilla");
  assert.equal(p.hoja, "bono2");
  assert.equal(p.archivo_ruta, "template-bonos.xlsx");
});

test("calendarios: subir, marcar estatus, eliminar", async () => {
  const buf = xlsxBuffer([["EQUIPO", new Date(Date.UTC(2026, 8, 7))], ["PRENSA 1", "Preventivo"]], "CAL");
  let r = await api("POST", "/api/calendarios", { name: "cal.xlsx", base64: buf.toString("base64") });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal(r.data.sheets.length, 1);
  assert.ok(fs.existsSync(path.join(DATA_DIR, "calendarios", `${id}.xlsx`)));

  r = await api("POST", `/api/calendarios/${id}`, { status: { "0!B2": { estado: "Realizado", color: "#16a34a" } } });
  assert.equal(r.status, 200);
  r = await api("GET", "/api/calendarios");
  assert.equal(r.data.length, 1);
  assert.deepEqual(r.data[0].status, { "0!B2": { estado: "Realizado", color: "#16a34a" } });
  assert.deepEqual(Object.keys(r.data[0]), ["id", "name", "uploadedAt", "sheets", "status"]);
  const [row] = await dbq("SELECT archivo_ruta FROM calendarios WHERE id = ?", [id]);
  assert.equal(row.archivo_ruta, `calendarios/${id}.xlsx`);

  assert.equal((await api("POST", "/api/calendarios", { name: "x", base64: "" })).status, 400);
  r = await api("DELETE", `/api/calendarios/${id}`);
  assert.equal(r.status, 200);
  assert.equal((await api("GET", "/api/calendarios")).data.length, 0);
  assert.ok(!fs.existsSync(path.join(DATA_DIR, "calendarios", `${id}.xlsx`)));
  assert.equal((await api("DELETE", `/api/calendarios/${id}`)).status, 404);
});

test("documentos: listar, subir, descargar, borrar (rutas en MySQL)", async () => {
  let r = await api("GET", "/api/documentos");
  assert.equal(r.data.length, 6);
  assert.deepEqual(r.data.find((c) => c.categoria === "Check list").archivos.map((a) => a.name), ["lista.pdf"]);
  assert.equal(await count("documentos"), 1);

  r = await api("POST", "/api/documentos/Dibujos", { name: "plano ñ.dwg", base64: Buffer.from("contenido").toString("base64") });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.archivos.map((a) => a.name), ["plano ñ.dwg"]);
  const [doc] = await dbq("SELECT ruta, tamano FROM documentos WHERE categoria = 'Dibujos'");
  assert.equal(doc.ruta, "documentos/Dibujos/plano ñ.dwg");
  assert.equal(Number(doc.tamano), 9);

  r = await api("GET", `/api/documentos/Dibujos/${encodeURIComponent("plano ñ.dwg")}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.toString(), "contenido");

  // Un archivo copiado a mano en la carpeta aparece (igual que antes) y se registra.
  fs.writeFileSync(path.join(DATA_DIR, "documentos", "Dibujos", "manual.txt"), "x");
  r = await api("GET", "/api/documentos");
  assert.equal(r.data.find((c) => c.categoria === "Dibujos").archivos.length, 2);
  assert.equal(await count("documentos", "WHERE categoria = 'Dibujos'"), 2);

  r = await api("DELETE", `/api/documentos/Dibujos/${encodeURIComponent("plano ñ.dwg")}`);
  assert.equal(r.status, 200);
  assert.equal(await count("documentos", "WHERE categoria = 'Dibujos'"), 1);
  assert.equal((await api("POST", "/api/documentos/NoExiste", { name: "a", base64: "YQ==" })).status, 400);
});

test("gastos y entregas: lectura migrada y actualizacion via Python", async () => {
  let r = await api("GET", "/api/gastos");
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].cantidad, 5);
  r = await api("GET", "/api/entregas");
  assert.equal(r.data.length, 1);

  r = await api("POST", "/api/gastos/refresh");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.output, /Total items extraidos: 5/);
  r = await api("GET", "/api/gastos");
  assert.equal(r.data.length, 5);
  assert.equal(r.data[1].po, "15001", "PO heredado de la cotizacion");
  assert.equal(r.data[1].total_partida, 63.8);
  assert.equal(r.data[0].entregado, true);
  assert.equal(await count("gastos"), 5);
  r = await api("GET", "/api/entregas");
  assert.equal(r.data.length, 3, "solo MTTO y sin CANCELADO");
  assert.equal(r.data[1].dias, "N/A");

  r = await api("POST", "/api/entregas/refresh");
  assert.equal(r.status, 200);
  assert.match(r.data.output, /TIEMPOS DE ENTREGA \(MTTO\): 3 partidas/);
  const sync = await dbq("SELECT fuente, registros FROM fuentes_sync ORDER BY fuente");
  assert.deepEqual(sync.map((s) => [s.fuente, s.registros]), [["entregas", 3], ["gastos", 5], ["tiempo_muerto", 30]]);
});

test("error de Python no borra los datos existentes", async () => {
  const antes = (await api("GET", "/api/gastos")).data;
  await stopApp();
  const prev = appEnv;
  appEnv = { ...appEnv, GASTOS_EXCEL_PATH: path.join(XL_DIR, "no-existe.xlsx") };
  await startApp();
  const r = await api("POST", "/api/gastos/refresh");
  assert.equal(r.status, 500);
  assert.match(r.data.error, /Error al extraer datos/);
  assert.deepEqual((await api("GET", "/api/gastos")).data, antes);
  await stopApp();
  appEnv = prev;
  await startApp();
});

test("persistencia tras reiniciar el servidor", async () => {
  const antes = await Promise.all(["/api/contramedidas", "/api/bonos", "/api/calendarios", "/api/gastos", "/api/entregas"].map((u) => api("GET", u)));
  await stopApp();
  const tAntes = await count("tiempo_muerto");
  koideRecords = makeRecords(30);
  await startApp();
  const despues = await Promise.all(["/api/contramedidas", "/api/bonos", "/api/calendarios", "/api/gastos", "/api/entregas"].map((u) => api("GET", u)));
  for (let i = 0; i < antes.length; i++) assert.deepEqual(despues[i].data, antes[i].data);
  const d = await api("GET", "/api/data");
  assert.equal(d.data.count, tAntes);
});
