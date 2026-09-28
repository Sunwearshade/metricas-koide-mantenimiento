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
// prueba, arranca server.js (conectado a MySQL a traves de un proxy TCP para
// simular caidas de la base) y prueba cada modulo via HTTP con sesion.

const test = require("node:test");
const net = require("net");
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

/* ---------- Proxy TCP hacia MySQL (para simular perdida de conexion) ---------- */

function startDbProxy(listenPort = 0) {
  const sockets = new Set();
  const srv = net.createServer((c) => {
    const u = net.connect(Number(TEST_ENV.DB_PORT || 3306), TEST_ENV.DB_HOST || "127.0.0.1");
    for (const x of [c, u]) sockets.add(x);
    const done = () => {
      c.destroy();
      u.destroy();
      sockets.delete(c);
      sockets.delete(u);
    };
    c.on("error", done).on("close", done);
    u.on("error", done).on("close", done);
    c.pipe(u);
    u.pipe(c);
  });
  return new Promise((resolve) =>
    srv.listen(listenPort, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        stop: () =>
          new Promise((r) => {
            srv.close(() => r());
            for (const x of sockets) x.destroy();
          }),
      })
    )
  );
}

/* ---------- Servidor de la app ---------- */

const TERMINAL_KEY = "clave-terminal-de-prueba";
const USUARIOS = {
  admin: { username: "admin_prueba", password: "admin-prueba-123", rol: "mantenimiento_admin", nombre: "Admin Prueba" },
  op: { username: "op_prueba", password: "op-prueba-123", rol: "mantenimiento_op", nombre: "Operador Prueba", numeroEmpleado: "1382" },
};
const jars = {}; // rol -> cookie de sesion

// Los scripts que se ejecutan con execFileSync bloquean este proceso (donde vive
// el proxy), asi que van directo a MySQL.
function directEnv() {
  return { ...appEnv, DB_PORT: String(TEST_ENV.DB_PORT || 3306) };
}

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
    TERMINAL_API_KEY: TERMINAL_KEY,
    KOIDE_LOOKUP_MIN_MS: "0",
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

async function login(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = r.headers.get("set-cookie");
  return { status: r.status, data: await r.json(), cookie: cookie ? cookie.split(";")[0] : null, setCookie: cookie };
}

// as: "admin" | "op" | null (sin sesion) | { headers } (encabezados propios)
async function api(method, url, body, as = "admin") {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (typeof as === "string" && jars[as]) headers.Cookie = jars[as];
  if (as && typeof as === "object") Object.assign(headers, as.headers);
  const r = await fetch(BASE + url, {
    method,
    headers,
    redirect: "manual",
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get("content-type") || "";
  const data = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

let koide;
let dbq;
let dbProxy;

test.before(async () => {
  writeFixtureData();
  execFileSync(PYTHON, [path.join(__dirname, "fixtures", "make_excels.py"), XL_DIR, EXCEL_PASSWORD]);
  koide = await startKoide();
  dbProxy = await startDbProxy();
  const port = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://127.0.0.1:${port}`;
  appEnv = childEnv({ PORT: String(port), KOIDE_BASE_URL: `http://127.0.0.1:${koide.address().port}`, DB_PORT: String(dbProxy.port) });

  // Base de pruebas limpia + esquema + migracion de los JSON sinteticos.
  // (El proceso de pruebas va directo a MySQL; la app pasa por el proxy.)
  Object.assign(process.env, { ...appEnv, DB_PORT: String(TEST_ENV.DB_PORT || 3306) });
  const db = require("../lib/db");
  dbq = db.query;
  const conn = await db.getPool().getConnection();
  await db.applySchema(conn);
  const [tables] = await conn.query("SHOW TABLES");
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of tables) await conn.query(`DELETE FROM \`${Object.values(t)[0]}\``);
  await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  conn.release();
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "migrate-json-to-mysql.js")], { env: directEnv(), cwd: TMP }).toString();
  assert.match(out, /RESULTADO: OK/);
  const auth = require("../lib/auth");
  for (const u of Object.values(USUARIOS)) await auth.createUser(u);
  await startApp();
  for (const [k, u] of Object.entries(USUARIOS)) jars[k] = (await login(u.username, u.password)).cookie;
});

test.after(async () => {
  await stopApp();
  koide && koide.close();
  dbProxy && (await dbProxy.stop());
  await require("../lib/db").closePool();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const count = async (table, where = "") => Number((await dbq(`SELECT COUNT(*) AS n FROM ${table} ${where}`))[0].n);

/* ---------- Pruebas ---------- */

test("archivos estaticos y proteccion de rutas", async () => {
  const r = await api("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal((await api("GET", "/app.js")).status, 200);
  const bad = await api("GET", "/..%2f..%2fconfig.json");
  assert.notEqual(bad.status, 200);
  const bad2 = await api("GET", "/..%2f..%2fconfig.json", null, null);
  assert.notEqual(bad2.status, 200);
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

/* ---------- Autenticacion y roles ---------- */

test("login: credenciales, cookie de sesion, me, logout, bloqueo", async () => {
  let r = await login(USUARIOS.admin.username, "incorrecta");
  assert.equal(r.status, 401);
  assert.equal(r.cookie, null);
  r = await login("no_existe", "x");
  assert.equal(r.status, 401);

  r = await login(USUARIOS.op.username, USUARIOS.op.password);
  assert.equal(r.status, 200);
  assert.equal(r.data.redirect, "/operador-mantenimiento");
  assert.equal(r.data.user.rol, "mantenimiento_op");
  assert.equal(r.data.user.password_hash, undefined, "nunca se expone el hash");
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
  const cookie = r.cookie;

  const me = await api("GET", "/api/auth/me", null, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, USUARIOS.op.username);
  assert.equal(me.data.user.numeroEmpleado, "1382");

  await api("POST", "/api/auth/logout", null, { headers: { Cookie: cookie } });
  assert.equal((await api("GET", "/api/auth/me", null, { headers: { Cookie: cookie } })).status, 401, "logout invalida la sesion en el servidor");
  assert.equal((await api("GET", "/api/operador/atenciones", null, { headers: { Cookie: "metricos_sid=falsa" } })).status, 401);

  // Contrasenas guardadas con hash (scrypt), nunca en claro.
  const [u] = await dbq("SELECT password_hash FROM usuarios WHERE username = ?", [USUARIOS.admin.username]);
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes(USUARIOS.admin.password));
  const [s] = await dbq("SELECT token_hash FROM sesiones LIMIT 1");
  assert.match(s.token_hash, /^[0-9a-f]{64}$/, "la base guarda solo el hash del token");

  // 5 intentos fallidos -> bloqueo temporal.
  for (let i = 0; i < 5; i++) await login("usuario_bloqueo", "x");
  assert.equal((await login("usuario_bloqueo", "x")).status, 429);

  // Usuario desactivado no puede entrar.
  await require("../lib/auth").createUser({ username: "op_inactivo", password: "inactivo-123", rol: "mantenimiento_op", nombre: "Inactivo" });
  await require("../lib/auth").setActive("op_inactivo", false);
  assert.equal((await login("op_inactivo", "inactivo-123")).status, 401);
});

test("autorizacion: el backend valida el rol (401/403)", async () => {
  const soloAdmin = [
    ["GET", "/api/data"],
    ["GET", "/api/refresh"],
    ["GET", "/api/bonos"],
    ["POST", "/api/bonos/week"],
    ["GET", "/api/gastos"],
    ["POST", "/api/gastos/refresh"],
    ["GET", "/api/entregas"],
    ["GET", "/api/contramedidas"],
    ["POST", "/api/contramedidas"],
    ["GET", "/api/calendarios"],
    ["GET", "/api/documentos"],
    ["DELETE", "/api/documentos/Dibujos/x.pdf"],
  ];
  for (const [m, u] of soloAdmin) {
    assert.equal((await api(m, u, m === "GET" ? null : {}, null)).status, 401, `${m} ${u} sin sesion`);
    assert.equal((await api(m, u, m === "GET" ? null : {}, "op")).status, 403, `${m} ${u} como operador`);
  }
  assert.equal((await api("GET", "/api/operador/atenciones", null, null)).status, 401);
  assert.equal((await api("GET", "/api/operador/atenciones", null, "op")).status, 200);
  assert.equal((await api("GET", "/api/operador/atenciones", null, "admin")).status, 200, "el admin tambien puede usar la pantalla de operador");

  // Paginas: sin sesion -> /login; operador -> su pantalla; admin -> dashboard.
  let r = await api("GET", "/", null, null);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/login");
  r = await api("GET", "/", null, "op");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/operador-mantenimiento");
  assert.equal((await api("GET", "/app.js", null, "op")).status, 403);
  assert.equal((await api("GET", "/operador-mantenimiento", null, "op")).status, 200);
  assert.equal((await api("GET", "/operador-mantenimiento/atender/1", null, "op")).status, 200);
  assert.equal((await api("GET", "/", null, "admin")).status, 200);
  assert.equal((await api("GET", "/login", null, null)).status, 200);
  const h = await api("GET", "/api/health", null, null);
  assert.equal(h.status, 200);
  assert.equal(h.data.db, true);
});

/* ---------- Operador de mantenimiento ---------- */

const PNG = (() => {
  const zlib = require("zlib");
  const crcT = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c >>> 0;
  }
  const crc = (b) => {
    let x = 0xffffffff;
    for (const v of b) x = crcT[(x ^ v) & 255] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(20, 0);
  ih.writeUInt32BE(20, 4);
  ih[8] = 8;
  ih[9] = 2;
  const raw = require("crypto").randomBytes((20 * 3 + 1) * 20); // ruido: no se comprime a < 100 bytes
  for (let y = 0; y < 20; y++) raw[y * 61] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();

let cierreGenerado = null;
let atencionId = null;

test("operador: codigo de reporte -> aceptar -> evidencia -> finalizar -> codigo de cierre", async () => {
  // Codigo con formato invalido / inexistente / paro ya finalizado.
  assert.equal((await api("GET", "/api/operador/reportes/ABC", null, "op")).status, 400);
  assert.equal((await api("GET", "/api/operador/reportes/99999", null, "op")).status, 404);
  let r = await api("GET", "/api/operador/reportes/1001", null, "op");
  assert.equal(r.status, 200);
  assert.equal(r.data.puedeAceptar, false, "el paro 1001 ya tiene hora de fin");
  assert.equal((await api("POST", "/api/operador/reportes/1001/aceptar", null, "op")).status, 409);

  // Reporte abierto (1000 no tiene downtime_end).
  r = await api("GET", "/api/operador/reportes/1000", null, "op");
  assert.equal(r.status, 200);
  assert.equal(r.data.puedeAceptar, true);
  assert.equal(r.data.reporte.maquina, "M1");
  const tmAntes = await dbq("SELECT payload FROM tiempo_muerto WHERE id = 1000");

  r = await api("POST", "/api/operador/reportes/1000/aceptar", null, "op");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "EN_ATENCION");
  assert.equal(r.data.aceptadoPor, USUARIOS.op.nombre);
  assert.equal(r.data.tecnicoNumeroEmpleado, "1382");
  atencionId = r.data.id;

  // Doble aceptacion (mismo u otro usuario) -> 409.
  assert.equal((await api("POST", "/api/operador/reportes/1000/aceptar", null, "op")).status, 409);
  assert.equal((await api("POST", "/api/operador/reportes/1000/aceptar", null, "admin")).status, 409);
  r = await api("GET", "/api/operador/reportes/1000", null, "op");
  assert.equal(r.data.puedeAceptar, false);
  assert.equal(r.data.atencion.id, atencionId);

  // Validaciones de la captura.
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: " " }, "op")).status, 400);
  const foto = (tipo, name = `${tipo}.png`, buf = PNG) => ({ tipo, name, base64: buf.toString("base64") });
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "x", fotos: [foto("antes"), foto("despues"), foto("antes")] }, "op")).status, 400, "max 2 fotos");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "x", fotos: [foto("antes", "a.gif")] }, "op")).status, 400, "solo jpg/png");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "x", fotos: [foto("antes", "a.png", Buffer.alloc(300, 1))] }, "op")).status, 400, "contenido que no es imagen");

  // Otro operador no ve ni finaliza la atencion ajena.
  await require("../lib/auth").createUser({ username: "op_otro", password: "op-otro-123", rol: "mantenimiento_op", nombre: "Otro" });
  const otro = (await login("op_otro", "op-otro-123")).cookie;
  assert.equal((await api("GET", `/api/operador/atenciones/${atencionId}`, null, { headers: { Cookie: otro } })).status, 404);
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "x" }, { headers: { Cookie: otro } })).status, 404);

  r = await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "Se cambió sensor ñ", comments: "ok", fotos: [foto("antes"), foto("despues", "d.PNG")] }, "op");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "FINALIZADA");
  assert.match(r.data.codigoCierre, /^C-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.data.fotos.length, 2);
  assert.equal(r.data.actionTaken, "Se cambió sensor ñ");
  assert.ok(r.data.responseTimeMinutes >= 0);
  assert.ok(r.data.repairTimeMinutes >= 0);
  cierreGenerado = r.data.codigoCierre;
  for (const f of r.data.fotos) {
    const g = await api("GET", f.url, null, "op");
    assert.equal(g.status, 200);
    assert.deepEqual(g.data, PNG);
    assert.equal((await api("GET", f.url, null, { headers: { Cookie: otro } })).status, 404);
  }
  const fotosDb = await dbq("SELECT ruta FROM paro_atencion_fotos WHERE atencion_id = ?", [atencionId]);
  assert.equal(fotosDb.length, 2);
  for (const f of fotosDb) assert.ok(fs.existsSync(path.join(DATA_DIR, f.ruta)));

  // Ya finalizada: no se puede volver a finalizar ni aceptar.
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { actionTaken: "x" }, "op")).status, 409);
  r = await api("GET", "/api/operador/reportes/1000", null, "op");
  assert.equal(r.data.motivo, "El reporte ya fue atendido");

  // El reporte original (espejo koide) no se modifico.
  assert.deepEqual(await dbq("SELECT payload FROM tiempo_muerto WHERE id = 1000"), tmAntes);

  // Trazabilidad.
  const ev = await dbq("SELECT evento, usuario_id FROM paro_atencion_eventos WHERE atencion_id = ? ORDER BY id", [atencionId]);
  assert.deepEqual(ev.map((e) => e.evento), ["ACEPTADO", "FINALIZADO"]);

  // Un paro recien creado en koide (no esta en la copia local) se encuentra
  // porque la consulta resincroniza.
  koideRecords = [{ ...makeRecords(1, 7000)[0], downtime_end: null, downtime_minutes: null }, ...makeRecords(30)];
  r = await api("GET", "/api/operador/reportes/7000", null, "op");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.puedeAceptar, true);
  koideRecords = makeRecords(30);
  await api("GET", "/api/refresh");
});

test("terminal: validar codigo de cierre", async () => {
  const url = "/api/terminal/cierres/validar";
  const key = { headers: { "X-Terminal-Key": TERMINAL_KEY } };
  assert.equal((await api("POST", url, { codigoCierre: cierreGenerado }, null)).status, 401, "sin clave");
  assert.equal((await api("POST", url, { codigoCierre: cierreGenerado }, "admin")).status, 401, "una sesion de usuario no sirve");
  assert.equal((await api("POST", url, { codigoCierre: cierreGenerado }, { headers: { "X-Terminal-Key": "otra" } })).status, 401);
  let r = await api("POST", url, { codigoCierre: "XYZ" }, key);
  assert.equal(r.status, 400);
  assert.equal(r.data.valido, false);
  r = await api("POST", url, { codigoCierre: "C-AAAA-AAAA" }, key);
  assert.equal(r.status, 404);
  r = await api("POST", url, { codigoCierre: cierreGenerado, codigoReporte: "1001" }, key);
  assert.equal(r.status, 409, "codigo de otro reporte");

  // Acepta minusculas / sin guiones.
  r = await api("POST", url, { codigoCierre: cierreGenerado.toLowerCase().replace(/-/g, ""), codigoReporte: "1000", terminal: "TERM-01" }, key);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.valido, true);
  assert.equal(r.data.yaConfirmado, false);
  assert.equal(r.data.estado, "CERRADA");
  assert.equal(r.data.codigoReporte, "1000");
  r = await api("POST", url, { codigoCierre: cierreGenerado }, key);
  assert.equal(r.status, 200);
  assert.equal(r.data.yaConfirmado, true, "validar de nuevo es idempotente");
  const [a] = await dbq("SELECT estado, cierre_confirmado_por FROM paro_atenciones WHERE id = ?", [atencionId]);
  assert.deepEqual({ ...a }, { estado: "CERRADA", cierre_confirmado_por: "TERM-01" });
  const ev = await dbq("SELECT evento FROM paro_atencion_eventos WHERE atencion_id = ? ORDER BY id", [atencionId]);
  assert.deepEqual(ev.map((e) => e.evento), ["ACEPTADO", "FINALIZADO", "CIERRE_VALIDADO"]);
});

/* ---------- Migracion repetida ---------- */

test("migracion: se puede repetir sin duplicar ni revivir datos borrados", async () => {
  const tablas = ["tiempo_muerto", "maquinas", "gastos", "entregas", "contramedidas", "contramedida_fotos", "bonos_semanas", "bonos_plantilla", "calendarios", "documentos", "migracion_registros"];
  const antes = {};
  for (const t of tablas) antes[t] = await count(t);
  const run = () => execFileSync(process.execPath, [path.join(ROOT, "scripts", "migrate-json-to-mysql.js")], { env: directEnv(), cwd: TMP }).toString();

  let out = run();
  assert.match(out, /Nada nuevo que migrar/);
  assert.match(out, /RESULTADO: OK/);
  for (const t of tablas) assert.equal(await count(t), antes[t], `${t} no cambia al repetir`);

  // cmvieja2 viene del JSON: se borra desde la app y la migracion NO la revive.
  assert.equal((await api("DELETE", "/api/contramedidas/cmvieja2")).status, 200);
  out = run();
  assert.match(out, /borradas despues en la app/);
  assert.match(out, /RESULTADO: OK/);
  assert.equal(await count("contramedidas", "WHERE id = 'cmvieja2'"), 0);

  // --force ya no existe.
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scripts", "migrate-json-to-mysql.js"), "--force"], { env: directEnv(), cwd: TMP, stdio: "pipe" }));
  // El JSON de origen nunca se modifica.
  assert.ok(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "contramedidas.json"), "utf8")).some((c) => c.id === "cmvieja2"));
});

test("persistencia de sesiones y atenciones tras reiniciar", async () => {
  await stopApp();
  await startApp();
  const r = await api("GET", `/api/operador/atenciones/${atencionId}`, null, "op");
  assert.equal(r.status, 200, "la sesion sigue valida despues de reiniciar");
  assert.equal(r.data.estado, "CERRADA");
  assert.equal(r.data.codigoCierre, cierreGenerado);
});

/* ---------- Perdida de conexion con MySQL ---------- */

test("perdida de conexion MySQL: responde 503 y se recupera sola", async () => {
  const port = dbProxy.port;
  await dbProxy.stop();
  let r = await api("GET", "/api/contramedidas");
  assert.equal(r.status, 503, JSON.stringify(r.data));
  assert.match(r.data.error, /Base de datos no disponible/);
  assert.equal((await api("GET", "/api/health", null, null)).status, 503);
  assert.equal((await login(USUARIOS.admin.username, USUARIOS.admin.password)).status, 503);
  assert.equal(appProc.exitCode, null, "el servidor sigue vivo");

  dbProxy = await startDbProxy(port);
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    r = await api("GET", "/api/contramedidas");
    ok = r.status === 200;
    if (!ok) await new Promise((res) => setTimeout(res, 250));
  }
  assert.ok(ok, "se recupera cuando MySQL vuelve");
  assert.equal((await api("GET", "/api/health", null, null)).status, 200);
});
