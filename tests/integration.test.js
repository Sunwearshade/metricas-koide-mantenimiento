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

// Dos fuentes, un solo servidor de prueba:
//   KOIDE MES (koide-general)  /api/mantenimiento/servicio/*  FUENTE OFICIAL.
//     Proceso "CORTE" (el de los datos sinteticos) = MIGRADO al MES.
//   koide-production-app       /api/auth/login, /api/downtime-records, /api/machines
//     DEPENDENCIA LEGACY: solo aporta procesos NO migrados (aqui "CNC").
let mesRecords = makeRecords(25);
let koideRecords = makeRecords(25); // lo que devuelve el sistema viejo (incluye CORTE, que debe ignorarse)
let koideLogins = 0;
const KOIDE_TOKEN = "tok-prueba";
const MES_TOKEN = "tok-servicio-mes";
const mesLlamadas = [];

// Estado del MES simulado para el flujo del tecnico (las reglas reales se
// prueban en koide-general: sim/tools/mtto_paros_check.js).
const MES_PARO = () => ({
  id: 1000001, origen: "terminal", estado: "DECLARADO", codigoAtencion: "482913", paroId: 77,
  equipo: { id: 1, codigo: "M1", nombre: "MAQ-1", proceso: "CORTE", idMaquina: "L1-BISEL" },
  fecha: "2026-09-28", turno: "1", grupo: null, inicio: "2026-09-28T14:00:00.000Z",
  reportadoPor: { numeroEmpleado: "1253", nombre: "OPERADOR" }, descripcionOperador: "no avanza",
  aceptadoEn: null, tecnico: null, categoria: null, problemaDetectado: null, accionRealizada: null, comentarios: null,
  esperaExterna: { enCurso: false, inicio: null, minutos: 0, nota: null },
  finalizadoEn: null, finalizadoPor: null, codigoCierre: null, cierre: null,
  tiempos: { respuesta_min: null, reparacion_min: null, paro_min: null, entrega_min: null, espera_externa_min: 0 },
  evidencias: [],
  participantes: [], responsableActual: null, duracion: { minutos: 0, enCurso: true }, historialAtencion: [],
});
let mesParo = MES_PARO();
// Participacion (mismas reglas que koide-general mig 087).
let mesRolActual = null; // X-Actor-Rol de la peticion en curso (mig 088)
function mesParticipa(numero, evento) {
  const rol = { INICIO_ATENCION: "inicio", TOMA_CONTINUIDAD: "continuidad", FINALIZA_ATENCION: "finalizo" }[evento];
  const tipoActor = mesRolActual === "mantenimiento_admin" ? "admin" : "operador";
  mesParo.historialAtencion.push({ evento, numeroEmpleado: numero, rolSnapshot: mesRolActual, tipoActor, en: new Date().toISOString() });
  let x = mesParo.participantes.find((y) => y.numeroEmpleado === numero);
  if (!x) mesParo.participantes.push((x = { numeroEmpleado: numero, nombre: `TEC ${numero}`, roles: [], minutosAsignados: 60 }));
  if (!x.roles.includes(rol)) x.roles.push(rol);
  x.rolSnapshot = mesRolActual; x.tipoActor = tipoActor;
  if (evento !== "FINALIZA_ATENCION") mesParo.responsableActual = numero;
}
const PERSONAL_MES = ["1382", "2000", "3000", "7777", "7778"].map((n) => ({ numeroEmpleado: n, nombre: `TECNICO ${n}` }));
const mesFotos = new Map();

function startKoide() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      const url = req.url;
      // ---------------- KOIDE MES ----------------
      if (url.startsWith("/api/mantenimiento/servicio/")) {
        if (req.headers.authorization !== `Service ${MES_TOKEN}`) return send(401, { error: "token", code: "SERVICIO_NO_AUTENTICADO" });
        const actor = req.headers["x-actor-numero-empleado"] || null;
        mesRolActual = req.headers["x-actor-rol"] || null;
        mesLlamadas.push({ method: req.method, url, actor, rol: mesRolActual });
        // Mismas reglas que el MES: una accion de tecnico exige rol de mantenimiento.
        if (req.method === "POST" && actor && !["mantenimiento_op", "mantenimiento_admin"].includes(mesRolActual)) {
          return send(403, { error: "rol invalido", code: "ACTOR_ROL_INVALIDO" });
        }
        const r = url.slice("/api/mantenimiento/servicio".length);
        if (r.startsWith("/compat/downtime-records")) return send(200, mesRecords);
        if (r === "/compat/machines") return send(200, MACHINES);
        if (r === "/equipos") return send(200, { procesos: [{ codigo: "CORTE", migradoMes: true }, { codigo: "CNC", migradoMes: false }], equipos: [] });
        if (r === "/catalogos") return send(200, { categorias: [{ codigo: "sensor", nombre: "Sensor" }, { codigo: "falla_mecanica", nombre: "Falla mecánica" }], personal: PERSONAL_MES });
        let m = r.match(/^\/paros\/por-codigo\/(\d+)(\/aceptar)?$/);
        if (m) {
          if (m[1] !== mesParo.codigoAtencion) return send(404, { error: "No existe un paro con ese codigo de atencion" });
          if (!m[2]) return send(200, { codigo: m[1], puedeAceptar: mesParo.estado === "DECLARADO", motivo: mesParo.estado === "DECLARADO" ? null : "El paro ya fue aceptado por mantenimiento", paro: mesParo });
          if (!actor) return send(403, { error: "sin numero", code: "TECNICO_SIN_NUMERO" });
          if (mesParo.estado !== "DECLARADO") return send(409, { error: "El paro ya fue aceptado por mantenimiento" });
          Object.assign(mesParo, { estado: "EN_ATENCION", aceptadoEn: new Date().toISOString(), tecnico: { numeroEmpleado: actor, nombre: `TEC ${actor}` } });
          mesParticipa(actor, "INICIO_ATENCION");
          return send(200, mesParo);
        }
        if (r.startsWith("/atenciones")) {
          const numero = new URL(url, "http://x").searchParams.get("numero");
          const mio = mesParo.tecnico && (!numero || mesParo.participantes.some((x) => x.numeroEmpleado === numero));
          const vivo = ["EN_ATENCION", "EN_ESPERA_EXTERNA"].includes(mesParo.estado);
          return send(200, { abiertas: mio && vivo ? [mesParo] : [], recientes: mio && !vivo ? [mesParo] : [] });
        }
        m = r.match(/^\/paros\/(\d+)(\/[a-z-]+)?(\/(\d+))?$/);
        if (!m || Number(m[1]) !== mesParo.id) return send(404, { error: "Paro de mantenimiento no encontrado" });
        if (!m[2]) return send(200, mesParo);
        // Mismas reglas de identidad que el MES real (mttoParoService).
        if (["/espera-externa", "/reanudar", "/finalizar", "/continuidad"].includes(m[2])) {
          if (!actor) return send(403, { error: "El usuario de mantenimiento no tiene numero de empleado", code: "TECNICO_SIN_NUMERO" });
        }
        if (["/espera-externa", "/reanudar"].includes(m[2])
          && !mesParo.participantes.some((x) => x.numeroEmpleado === actor && (x.roles.includes("inicio") || x.roles.includes("continuidad")))) {
          return send(403, { error: "No participas en esta atencion", code: "TECNICO_NO_PARTICIPA" });
        }
        if (m[2] === "/continuidad") {
          if (!["EN_ATENCION", "EN_ESPERA_EXTERNA"].includes(mesParo.estado)) return send(409, { error: "La atencion ya fue finalizada" });
          if (mesParo.responsableActual !== actor) mesParticipa(actor, "TOMA_CONTINUIDAD");
          return send(200, mesParo);
        }
        if (m[2] === "/espera-externa") { mesParo.estado = "EN_ESPERA_EXTERNA"; mesParo.esperaExterna = { enCurso: true, inicio: new Date().toISOString(), minutos: 0, nota: b.nota || null }; return send(200, mesParo); }
        if (m[2] === "/reanudar") { mesParo.estado = "EN_ATENCION"; mesParo.esperaExterna = { ...mesParo.esperaExterna, enCurso: false, minutos: 7 }; return send(200, mesParo); }
        if (m[2] === "/finalizar") {
          if (mesParo.estado !== "EN_ATENCION") return send(409, { error: "La atencion ya fue finalizada" });
          if (!(b.fotos || []).some((f) => f.tipo === "despues")) return send(400, { error: "foto despues obligatoria", code: "EVIDENCIA_REQUERIDA" });
          mesParo.evidencias = b.fotos.map((f, i) => { mesFotos.set(i + 1, Buffer.from(f.base64, "base64")); return { id: i + 1, tipo: f.tipo, nombre: f.nombre, mime: "image/png" }; });
          Object.assign(mesParo, {
            estado: "PENDIENTE_CIERRE", categoria: { codigo: b.categoria, nombre: "Sensor" }, problemaDetectado: b.problemaDetectado,
            accionRealizada: b.accionRealizada, comentarios: b.comentarios, finalizadoEn: new Date().toISOString(),
            finalizadoPor: { numeroEmpleado: actor }, codigoCierre: "C-ABCD-EF23",
            participantes: mesParo.participantes, historialAtencion: mesParo.historialAtencion,
            tiempos: { respuesta_min: 12, reparacion_min: 40, paro_min: null, entrega_min: null, espera_externa_min: 7 },
          });
          mesParticipa(actor, "FINALIZA_ATENCION");
          return send(200, mesParo);
        }
        if (m[2] === "/evidencias" && mesFotos.has(Number(m[4]))) {
          res.writeHead(200, { "Content-Type": "image/png" });
          return res.end(mesFotos.get(Number(m[4])));
        }
        return send(404, {});
      }
      // ---------------- koide-production-app (legacy) ----------------
      if (url === "/api/auth/login" && req.method === "POST") {
        if (b.department !== "Mantenimiento" || b.password !== "clave-koide") return send(401, { error: "bad" });
        koideLogins++;
        return send(200, { token: KOIDE_TOKEN, department: "Mantenimiento", role: "Mantenimiento" });
      }
      if (req.headers["x-auth-token"] !== KOIDE_TOKEN) return send(401, { error: "token" });
      if (url.startsWith("/api/downtime-records?responsibleArea=Mantenimiento")) return send(200, koideRecords);
      if (url === "/api/machines") return send(200, MACHINES);
      send(404, {});
    });
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

const USUARIOS = {
  admin: { username: "admin_prueba", password: "admin-prueba-123", rol: "mantenimiento_admin", nombre: "Admin Prueba" },
  op: { username: "op_prueba", password: "4826", rol: "mantenimiento_op", nombre: "Operador Prueba", numeroEmpleado: "1382" },
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
    KOIDE_GENERAL_TOKEN: MES_TOKEN,
    KOIDE_GENERAL_REFRESH_MIN: "0",
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
  appEnv = childEnv({ PORT: String(port), KOIDE_BASE_URL: `http://127.0.0.1:${koide.address().port}`, KOIDE_GENERAL_URL: `http://127.0.0.1:${koide.address().port}`, DB_PORT: String(dbProxy.port) });

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

test("tiempo muerto: KOIDE MES es la fuente; el sistema viejo solo aporta procesos no migrados", async () => {
  let r = await api("GET", "/api/data");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.technicians));
  assert.ok(r.data.performance);

  // MES: 30 paros de CORTE (migrado). Sistema viejo: los mismos CORTE (se
  // ignoran: ya viven en el MES) + 1 paro de CNC (no migrado, se agrega).
  mesRecords = makeRecords(30);
  const cnc = { ...makeRecords(1, 9000)[0], machine_process: "CNC", machine_code: "CNC1" };
  koideRecords = [...makeRecords(30).map((x) => ({ ...x, problem_description: "VERSION VIEJA" })), cnc];
  const llamadasAntes = mesLlamadas.length;
  r = await api("GET", "/api/refresh");
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 31, "30 del MES + 1 CNC del sistema viejo");
  assert.equal(r.data.source, "live");
  assert.equal(r.data.lastError, null);
  assert.ok(mesLlamadas.slice(llamadasAntes).some((c) => c.url.startsWith("/api/mantenimiento/servicio/compat/downtime-records")), "consulta el MES");
  assert.ok(koideLogins >= 1, "el sistema viejo se consulta solo para procesos no migrados");
  assert.equal(await count("tiempo_muerto"), 31);
  const d = await api("GET", "/api/data");
  assert.equal(d.data.records.filter((x) => x.problem_description === "VERSION VIEJA").length, 0, "los registros CORTE del sistema viejo se descartan");
  assert.deepEqual(d.data.records.find((x) => x.id === 1000), makeRecords(30)[0], "el registro del MES llega tal cual (mismo formato)");
  assert.ok(d.data.records.some((x) => x.id === 9000));
  assert.equal(d.data.fuentes.mes.ok, true);
  assert.equal(d.data.fuentes.legacy.registros, 1);
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
  assert.deepEqual(sync.map((s) => [s.fuente, s.registros]), [["entregas", 3], ["gastos", 5], ["tiempo_muerto", 31]]);
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
  await require("../lib/auth").createUser({ username: "op_inactivo", pin: "8264", rol: "mantenimiento_op", nombre: "Inactivo", numeroEmpleado: "7778" });
  await require("../lib/auth").setActive("op_inactivo", false);
  assert.equal((await login("op_inactivo", "8264")).status, 401);
});

test("operadores: alta por el administrador (usuario + PIN + numero del MES), PIN seguro y limite de intentos", async () => {
  // Solo el administrador gestiona operadores.
  assert.equal((await api("GET", "/api/admin/operadores", null, "op")).status, 403);
  assert.equal((await api("POST", "/api/admin/operadores", { username: "x" }, "op")).status, 403);
  assert.equal((await api("GET", "/api/admin/operadores", null, null)).status, 401);

  const alta = (b) => api("POST", "/api/admin/operadores", { nombre: "Roberto", username: "roberto", pin: "5926", numeroEmpleado: "7777", ...b });
  let r = await alta({ numeroEmpleado: "9999" });
  assert.equal(r.status, 400, "numero que no existe en el catalogo del MES");
  assert.match(r.data.error, /catalogo de personal/);
  assert.equal((await alta({ pin: "12a4" })).status, 400, "PIN de 4 digitos");
  assert.equal((await alta({ pin: "12345" })).status, 400);
  assert.equal((await alta({ pin: "1111" })).status, 400, "PIN trivial");
  assert.equal((await alta({ pin: "1234" })).status, 400, "PIN en secuencia");
  assert.equal((await alta({ numeroEmpleado: "1382" })).status, 400, "numero ya usado por otro operador");
  r = await alta({});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.numeroEmpleado, "7777");
  assert.equal(r.data.activo, true);
  assert.equal((await alta({})).status, 409, "usuario repetido");
  const lista = (await api("GET", "/api/admin/operadores")).data.operadores;
  assert.ok(lista.some((o) => o.username === "roberto" && o.numeroEmpleado === "7777"));
  assert.ok(lista.every((o) => !("password_hash" in o)));

  // PIN cifrado (scrypt), nunca en texto plano.
  const [u] = await dbq("SELECT password_hash FROM usuarios WHERE username = 'roberto'");
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes("5926"));

  // Entra con usuario + PIN; una contrasena larga o un PIN incorrecto no.
  r = await login("roberto", "5926");
  assert.equal(r.status, 200);
  assert.equal(r.data.user.numeroEmpleado, "7777");
  assert.equal((await login("roberto", "5926-extra")).status, 401);
  assert.equal((await login("usuario_inexistente", "5926")).status, 401, "usuario invalido");

  // El roster del dashboard incluye a los operadores activos.
  const data = (await api("GET", "/api/data")).data;
  assert.ok(data.technicians.some((t) => String(t.employee_number) === "7777"));

  // Limite de intentos POR CUENTA y persistente: 5 fallos -> bloqueo temporal.
  // (el intento con "5926-extra" ya conto como el primer fallo)
  for (let i = 0; i < 4; i++) assert.equal((await login("roberto", "0000")).status, 401);
  const [b1] = await dbq("SELECT intentos_fallidos, bloqueado_hasta FROM usuarios WHERE username = 'roberto'");
  assert.equal(Number(b1.intentos_fallidos), 5);
  assert.ok(b1.bloqueado_hasta, "bloqueo guardado en la base (sobrevive reinicios)");
  assert.equal((await login("roberto", "5926")).status, 429, "bloqueado aunque el PIN sea correcto");

  // 10 fallos -> bloqueo que solo libera el administrador.
  await dbq("UPDATE usuarios SET intentos_fallidos = 9, bloqueado_hasta = NULL WHERE username = 'op_prueba'");
  const opLock = await login(USUARIOS.op.username, "0000");
  assert.equal(opLock.status, 401);
  r = await login(USUARIOS.op.username, USUARIOS.op.password);
  assert.equal(r.status, 423, "bloqueo definitivo");
  assert.match(r.data.error, /administrador/);
  r = await api("PATCH", `/api/admin/operadores/${USUARIOS.op.username}`, { pin: "4826" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.bloqueado, false);
  const re = await login(USUARIOS.op.username, USUARIOS.op.password);
  assert.equal(re.status, 200, "el administrador restablecio el PIN");
  jars.op = re.cookie;

  // Desactivar: no entra y sus sesiones se cierran.
  // Restablecer el PIN libera TODOS los bloqueos (base y memoria).
  assert.equal((await api("PATCH", "/api/admin/operadores/roberto", { pin: "5926" })).status, 200);
  const l1 = await login("roberto", "5926");
  assert.equal(l1.status, 200, "entra de inmediato tras restablecer el PIN");
  const s1 = l1.cookie;
  r = await api("PATCH", "/api/admin/operadores/roberto", { activo: false });
  assert.equal(r.data.activo, false);
  assert.equal((await api("GET", "/api/auth/me", null, { headers: { Cookie: s1 } })).status, 401);
  assert.equal((await login("roberto", "5926")).status, 401);
  // Cambio de numero: tambien validado contra el MES.
  assert.equal((await api("PATCH", "/api/admin/operadores/roberto", { numeroEmpleado: "9999" })).status, 400);
  assert.equal((await api("PATCH", "/api/admin/operadores/roberto", { activo: true })).data.activo, true);
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

test("operador: codigo de atencion -> aceptar -> espera externa -> finalizar -> codigo de cierre (via KOIDE MES)", async () => {
  mesParo = MES_PARO();
  // Formato del codigo de atencion (6 digitos, sin cero inicial) e inexistente.
  assert.equal((await api("GET", "/api/operador/reportes/ABC", null, "op")).status, 400);
  assert.equal((await api("GET", "/api/operador/reportes/012345", null, "op")).status, 400);
  assert.equal((await api("GET", "/api/operador/reportes/999999", null, "op")).status, 404);

  let r = await api("GET", "/api/operador/reportes/482913", null, "op");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.puedeAceptar, true);
  assert.equal(r.data.reporte.maquina, "M1");
  assert.equal(r.data.reporte.linea, "L1-BISEL");
  assert.equal(r.data.reporte.descripcion, "no avanza");

  // El admin sin numero de empleado consulta, pero no puede aceptar: se corta
  // en Metricas, sin llamar al MES.
  r = await api("GET", "/api/operador/reportes/482913", null, "admin");
  assert.equal(r.status, 200);
  assert.equal(r.data.puedeAceptar, false, "sin numero no se ofrece aceptar");
  assert.match(r.data.motivo, /no tiene numero de empleado/);
  let antesMes = mesLlamadas.length;
  r = await api("POST", "/api/operador/reportes/482913/aceptar", null, "admin");
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "TECNICO_SIN_NUMERO");
  assert.equal(mesLlamadas.length, antesMes, "no se manda al MES una peticion sin identidad");
  r = await api("POST", "/api/operador/reportes/482913/aceptar", null, "op");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "EN_ATENCION");
  assert.equal(r.data.tecnicoNumeroEmpleado, "1382");
  atencionId = r.data.id;
  const acept = mesLlamadas.filter((c) => c.url.endsWith("/aceptar")).pop();
  assert.equal(acept.actor, "1382", "el MES recibe el numero de empleado del tecnico");
  assert.equal((await api("POST", "/api/operador/reportes/482913/aceptar", null, "op")).status, 409);

  // Otro operador (usuario + PIN) VE la atencion en curso y puede tomar continuidad.
  await require("../lib/auth").createUser({ username: "op_otro", pin: "5173", rol: "mantenimiento_op", nombre: "Otro", numeroEmpleado: "2000" });
  const otro = (await login("op_otro", "5173")).cookie;
  r = await api("GET", `/api/operador/atenciones/${atencionId}`, null, { headers: { Cookie: otro } });
  assert.equal(r.status, 200);
  assert.equal(r.data.esParticipante, false);
  assert.equal(r.data.puedeTomarContinuidad, true);
  assert.equal(r.data.puedeFinalizar, true, "cualquier tecnico autenticado puede finalizar");
  assert.equal(r.data.puedeOperar, false, "sin continuidad no pausa ni reanuda");
  r = await api("GET", "/api/operador/atenciones", null, { headers: { Cookie: otro } });
  assert.equal(r.data.enCurso.length, 1, "aparece en 'paros en atencion por otros tecnicos'");

  // El tecnico que inicio puede operar; el admin sin numero solo consulta.
  r = await api("GET", `/api/operador/atenciones/${atencionId}`, null, "op");
  assert.equal(r.data.puedeOperar, true);
  assert.equal(r.data.esParticipante, true);
  r = await api("GET", `/api/operador/atenciones/${atencionId}`, null, "admin");
  assert.equal(r.status, 200, "el admin ve la atencion (monitoreo)");
  assert.equal(r.data.puedeOperar, false, "admin sin numero: solo lectura");
  assert.equal(r.data.tecnicoNumeroEmpleado, "1382");
  // Un admin CON numero que no participa ve la atencion pero no la pausa.
  await require("../lib/auth").createUser({ username: "admin_tec", password: "admin-tec-123", rol: "mantenimiento_admin", nombre: "Admin Tecnico", numeroEmpleado: "3000" });
  const adminTec = { headers: { Cookie: (await login("admin_tec", "admin-tec-123")).cookie } };
  r = await api("GET", `/api/operador/atenciones/${atencionId}`, null, adminTec);
  assert.equal(r.data.puedeOperar, false);

  // Catalogo de categorias (del MES).
  r = await api("GET", "/api/operador/catalogos", null, "op");
  assert.equal(r.status, 200);
  assert.ok(r.data.categorias.some((c) => c.codigo === "sensor"));

  // Acciones de tecnico rechazadas en Metricas, antes del MES.
  antesMes = mesLlamadas.length;
  for (const [quien, code] of [["admin", "TECNICO_SIN_NUMERO"], [adminTec, "TECNICO_NO_PARTICIPA"]]) {
    for (const [accion, body] of [["espera-externa", { nota: "x" }], ["reanudar", null]]) {
      r = await api("POST", `/api/operador/atenciones/${atencionId}/${accion}`, body, quien);
      assert.equal(r.status, 403, `${accion}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, code);
    }
  }
  assert.ok(!mesLlamadas.slice(antesMes).some((c) => c.method === "POST"), "ninguna accion rechazada llego al MES");

  // Espera externa y reanudar.
  r = await api("POST", `/api/operador/atenciones/${atencionId}/espera-externa`, { nota: "se fabrica pieza" }, "op");
  assert.equal(r.data.estado, "EN_ESPERA_EXTERNA");
  r = await api("GET", "/api/operador/atenciones", null, "op");
  assert.equal(r.data.abiertas.length, 1, "la atencion en espera sigue en curso");
  r = await api("POST", `/api/operador/atenciones/${atencionId}/reanudar`, null, "op");
  assert.equal(r.data.estado, "EN_ATENCION");
  assert.equal(r.data.esperaExterna.minutos, 7);

  // Validaciones tempranas (el MES vuelve a validar).
  const foto = (tipo, name = `${tipo}.png`, buf = PNG) => ({ tipo, name, base64: buf.toString("base64") });
  const base = { categoria: "sensor", problemaDetectado: "Sensor sucio", actionTaken: "Se limpio", fotos: [foto("antes"), foto("despues")] };
  const fin = (extra) => api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { ...base, ...extra }, "op");
  assert.equal((await fin({ categoria: "" })).status, 400, "categoria obligatoria");
  assert.equal((await fin({ problemaDetectado: " " })).status, 400, "problema obligatorio");
  assert.equal((await fin({ actionTaken: "" })).status, 400, "trabajo obligatorio");
  assert.equal((await fin({ fotos: [foto("antes")] })).status, 400, "foto despues obligatoria");
  assert.equal((await fin({ fotos: [foto("antes", "a.gif"), foto("despues")] })).status, 400, "solo jpg/png");
  assert.equal((await fin({ fotos: [foto("antes"), foto("despues"), foto("antes")] })).status, 400, "max 2 fotos");

  // Finalizar sin numero de empleado -> 403 sin llegar al MES.
  antesMes = mesLlamadas.length;
  r = await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, base, "admin");
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "TECNICO_SIN_NUMERO");
  assert.match(r.data.error, /no tiene numero de empleado/);
  assert.ok(!mesLlamadas.slice(antesMes).some((c) => c.url.endsWith("/finalizar")), "no se llamo al MES");
  r = await api("POST", `/api/operador/atenciones/${atencionId}/continuidad`, null, "admin");
  assert.equal(r.data.code, "TECNICO_SIN_NUMERO", "sin numero tampoco toma continuidad");

  // Otro tecnico TOMA CONTINUIDAD: se suma sin borrar a quien inicio.
  const otroH = { headers: { Cookie: otro } };
  r = await api("POST", `/api/operador/atenciones/${atencionId}/continuidad`, null, otroH);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/continuidad")).pop().actor, "2000", "el MES recibe el numero de quien toma continuidad");
  assert.deepEqual(r.data.participantes.map((x) => `${x.numeroEmpleado}:${x.roles.join("+")}`), ["1382:inicio", "2000:continuidad"]);
  assert.equal(r.data.responsableActual, "2000");
  assert.equal(r.data.tecnicoNumeroEmpleado, "1382", "quien inicio no se sobrescribe");
  assert.equal(r.data.puedeOperar, true, "ya participa: puede pausar/reanudar");

  // Lo FINALIZA el segundo tecnico (distinto de quien inicio).
  r = await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, base, otroH);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "PENDIENTE_CIERRE");
  assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/finalizar")).pop().actor, "2000", "finaliza con SU numero de empleado");
  assert.deepEqual(r.data.participantes.map((x) => `${x.numeroEmpleado}:${x.roles.join("+")}`), ["1382:inicio", "2000:continuidad+finalizo"]);
  assert.ok(r.data.participantes.every((x) => x.minutosAsignados === 60), "cada participante con el tiempo completo");
  assert.match(r.data.codigoCierre, /^C-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.data.categoria.codigo, "sensor");
  assert.equal(r.data.problemaDetectado, "Sensor sucio");
  assert.equal(r.data.actionTaken, "Se limpio");
  assert.equal(r.data.fotos.length, 2);
  cierreGenerado = r.data.codigoCierre;
  // Doble finalizacion: el MES la rechaza (409) y el codigo no cambia.
  const doble = await fin({ problemaDetectado: "otra cosa" });
  assert.equal(doble.status, 409, JSON.stringify(doble.data));
  assert.equal((await api("GET", `/api/operador/atenciones/${atencionId}`, null, "op")).data.codigoCierre, cierreGenerado);
  for (const f of r.data.fotos) {
    const g = await api("GET", f.url, null, "op");
    assert.equal(g.status, 200);
    assert.deepEqual(g.data, PNG);
    assert.equal((await api("GET", f.url, null, { headers: { Cookie: otro } })).status, 200, "la evidencia la ve todo mantenimiento");
  }
  // Nada se escribe en las tablas locales de atenciones: el MES es la fuente.
  assert.equal(await count("paro_atenciones"), 0);
  r = await api("GET", "/api/operador/atenciones", null, "op");
  assert.equal(r.data.recientes[0].codigoCierre, cierreGenerado);
});

test("admin participante: un mantenimiento_admin con numero atiende paros sin dejar de ser admin", async () => {
  const auth = require("../lib/auth");
  const paroPrevio = mesParo; // las pruebas siguientes usan el paro del flujo anterior
  try {
  // Asignacion EXPLICITA del numero al admin (validada contra el catalogo del MES).
  await auth.createUser({ username: "admin_jona", password: "admin-jona-123", rol: "mantenimiento_admin", nombre: "Jonathan (admin)" });
  let r = await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "9999" });
  assert.equal(r.status, 400, "numero inexistente en el MES");
  r = await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "7778" });
  assert.equal(r.status, 400, "numero ya usado por otro usuario");
  r = await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "3000" });
  assert.equal(r.status, 400, "3000 lo tiene admin_tec");
  await dbq("UPDATE usuarios SET numero_empleado = NULL WHERE username = 'admin_tec'");
  r = await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "3000" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rol, "mantenimiento_admin", "sigue siendo admin");
  assert.equal((await api("PATCH", "/api/admin/operadores/admin_jona", { pin: "5926" })).status, 400, "al admin no se le pone PIN");
  const lista = (await api("GET", "/api/admin/operadores")).data.operadores;
  assert.ok(lista.some((o) => o.username === "admin_jona" && o.rol === "mantenimiento_admin" && o.numeroEmpleado === "3000"));
  const jona = { headers: { Cookie: (await login("admin_jona", "admin-jona-123")).cookie } };
  // Sigue siendo administrador: el dashboard y la pantalla de atencion.
  assert.equal((await api("GET", "/api/data", null, jona)).status, 200, "conserva sus funciones administrativas");
  assert.ok((await api("GET", "/api/data", null, jona)).data.technicians.some((t) => String(t.employee_number) === "3000" && t.role === "mantenimiento_admin"), "roster con su rol");

  // Paro nuevo: el admin INICIA, un operador toma continuidad y el admin FINALIZA.
  mesParo = MES_PARO();
  r = await api("GET", "/api/operador/reportes/482913", null, jona);
  assert.equal(r.data.puedeAceptar, true, "el admin con numero puede iniciar");
  r = await api("POST", "/api/operador/reportes/482913/aceptar", null, jona);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const acc = mesLlamadas.filter((c) => c.url.endsWith("/aceptar")).pop();
  assert.deepEqual([acc.actor, acc.rol], ["3000", "mantenimiento_admin"], "el MES recibe numero + rol mantenimiento_admin");
  assert.equal(r.data.participantes[0].rolSnapshot, "mantenimiento_admin");
  assert.equal(r.data.participantes[0].tipoActor, "admin");
  r = await api("POST", `/api/operador/atenciones/${r.data.id}/continuidad`, null, "op");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.participantes.map((x) => `${x.numeroEmpleado}:${x.tipoActor}`), ["3000:admin", "1382:operador"]);
  const foto = { tipo: "despues", name: "d.png", base64: PNG.toString("base64") };
  r = await api("POST", `/api/operador/atenciones/${r.data.id}/finalizar`, { categoria: "sensor", problemaDetectado: "p", actionTaken: "t", fotos: [foto] }, jona);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "PENDIENTE_CIERRE");
  assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/finalizar")).pop().rol, "mantenimiento_admin");
  assert.ok(r.data.participantes.every((x) => x.minutosAsignados === 60), "tiempo completo para cada participante");
  const id = r.data.id;
  // Metricas NO cierra el paro (solo Capture Terminal con el codigo).
  assert.equal((await api("POST", `/api/operador/atenciones/${id}/cerrar`, { codigoCierre: r.data.codigoCierre }, jona)).status, 404);
  assert.equal((await api("POST", "/api/terminal/cierres/validar", { codigoCierre: r.data.codigoCierre }, jona)).status, 410);

  // Cambiar despues su rol NO cambia lo historico (rol_snapshot del MES).
  await dbq("UPDATE usuarios SET rol = 'mantenimiento_op' WHERE username = 'admin_jona'");
  r = await api("GET", `/api/operador/atenciones/${id}`, null, "op");
  assert.equal(r.data.participantes.find((x) => x.numeroEmpleado === "3000").rolSnapshot, "mantenimiento_admin");
  await dbq("UPDATE usuarios SET rol = 'mantenimiento_admin' WHERE username = 'admin_jona'");

  // Admin SIN numero: solo consulta (no se manda al MES).
  const antes = mesLlamadas.length;
  mesParo = MES_PARO();
  r = await api("POST", "/api/operador/reportes/482913/aceptar", null, "admin");
  assert.equal(r.data.code, "TECNICO_SIN_NUMERO");
  assert.equal(mesLlamadas.slice(antes).filter((c) => c.method === "POST").length, 0);
  // Quitar el numero al admin (explicito) lo deja en solo consulta.
  assert.equal((await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "" })).data.numeroEmpleado, null);
  } finally {
    mesParo = paroPrevio;
  }
});

test("terminal: la validacion del codigo de cierre ya no vive aqui (410 -> KOIDE MES)", async () => {
  const r = await api("POST", "/api/terminal/cierres/validar", { codigoCierre: cierreGenerado }, null);
  assert.equal(r.status, 410);
  assert.equal(r.data.code, "VALIDACION_EN_MES");
});

test("sin KOIDE MES disponible: el operador recibe un error claro y el dashboard conserva su copia", async () => {
  const prev = appEnv;
  await stopApp();
  appEnv = { ...prev, KOIDE_GENERAL_URL: "http://127.0.0.1:9" };
  await startApp();
  try {
    const r = await api("GET", "/api/operador/reportes/482913", null, "op");
    assert.equal(r.status, 503);
    assert.match(r.data.error, /KOIDE MES no disponible/);
    const d = await api("GET", "/api/data");
    assert.equal(d.status, 200);
    assert.ok(d.data.count > 0, "sigue sirviendo la ultima copia");
    const h = await api("GET", "/api/health", null, null);
    assert.ok(h.data.lastError);
  } finally {
    await stopApp();
    appEnv = prev;
    await startApp();
  }
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
  assert.equal(r.data.estado, "PENDIENTE_CIERRE");
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
