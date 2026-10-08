"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const XLSX = require("xlsx");
const { loadEnvFile, env, resolvePath } = require("./lib/env");

loadEnvFile();

const db = require("./lib/db");
const store = require("./lib/store");
const auth = require("./lib/auth");
const atenciones = require("./lib/atenciones");
const operadores = require("./lib/operadores");
const historico = require("./lib/historico");
const auditoria = require("./lib/auditoria");
const configuracion = require("./lib/configuracion");
const contramedidas = require("./lib/contramedidas");
const fuenteCm = require("./lib/contramedidasFuente");
const recomendacionesCm = require("./lib/contramedidasRecomendaciones");
const programacionCm = require("./lib/contramedidasProgramacion");
const aprobacionCm = require("./lib/contramedidasAprobacion");
const preventivo = require("./lib/preventivo");

const ROOT = __dirname;
const PYTHON = env("PYTHON_PATH", process.platform === "win32" ? "python" : "python3");
const EXTRACT_SCRIPT = path.join(ROOT, "scripts", "extract_v4.py");
const ENTREGAS_SCRIPT = path.join(ROOT, "scripts", "extract_entregas.py");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = resolvePath(env("DATA_DIR", "data"));
const CONFIG_FILE = resolvePath(env("CONFIG_FILE", "config.json"));
const BONOS_XLSX = path.join(DATA_DIR, "template-bonos.xlsx");
const BONOS_XLSX_RUTA = "template-bonos.xlsx";
const CAL_DIR = path.join(DATA_DIR, "calendarios");
const DOC_DIR = path.join(DATA_DIR, "documentos");
const CM_FOTOS_DIR = path.join(DATA_DIR, "contramedidas-fotos");
const DOC_CATEGORIAS = [
  "Dibujos",
  "Lay out de planta",
  "Plan de mantenimiento mayor",
  "Indicadores 2026",
  "Check list",
  "Instrucciones de trabajo",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error("[config] No se pudo leer config.json:", err.message);
    process.exit(1);
  }
}

const config = readConfig();
const area = config.responsibleArea || "Mantenimiento";
const koideGeneral = require("./lib/koideGeneral");

// ---------------------------------------------------------------------------
// FUENTES DE PAROS
//
//   KOIDE MES (koide-general)  FUENTE OFICIAL. Sirve el MISMO formato que el
//                              sistema viejo (/compat/downtime-records y
//                              /compat/machines), asi que el dashboard y todas
//                              sus estadisticas no cambian.
//   koide-production-app       DEPENDENCIA LEGACY TEMPORAL (192.168.1.201:4000).
//                              Solo se consulta si KOIDE_BASE_URL esta definido,
//                              y SOLO para los procesos que aun no migran al MES
//                              (el MES dice cuales migraron: /equipos). Los
//                              registros legacy de procesos migrados se
//                              descartan (su historico ya vive en el MES con el
//                              mismo id). Quitar KOIDE_BASE_URL = legacy apagado.
// ---------------------------------------------------------------------------
const LEGACY_API = env("KOIDE_BASE_URL", config.koideBaseUrl || "").replace(/\/$/, "");

// Credenciales del sistema viejo: variables de entorno (.env); config.json solo como respaldo.
function koideLogin() {
  const fromConfig = config.koideLogin || {};
  return {
    department: env("KOIDE_DEPARTMENT", fromConfig.department || "Mantenimiento"),
    password: env("KOIDE_PASSWORD", fromConfig.password || ""),
  };
}

// Sin respuesta en este tiempo se usa la ultima copia guardada.
const KOIDE_TIMEOUT_MS = Number(env("KOIDE_TIMEOUT_MS", "20000"));
// Resincronizacion periodica con el MES para que el dashboard vea los paros de
// la terminal casi en tiempo real. KOIDE_GENERAL_REFRESH_SEC (default 20 s);
// KOIDE_GENERAL_REFRESH_MIN se respeta por compatibilidad. 0 = solo la diaria.
const REFRESH_MS = env("KOIDE_GENERAL_REFRESH_SEC", "") !== ""
  ? Number(env("KOIDE_GENERAL_REFRESH_SEC", "20")) * 1000
  : env("KOIDE_GENERAL_REFRESH_MIN", "") !== ""
    ? Number(env("KOIDE_GENERAL_REFRESH_MIN", "0")) * 60000
    : 20000;
let huellaDatos = null; // evita reescribir tiempo_muerto si nada cambio
let ultimaHuellaLog = null;

let token = null;
let cache = null;
let lastUpdate = null;
let lastError = null;
let fuentes = {};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function login() {
  const res = await fetch(`${LEGACY_API}/api/auth/login`, {
    signal: AbortSignal.timeout(KOIDE_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(koideLogin()),
  });
  if (!res.ok) {
    throw new Error(`Login koide (legacy) fallo (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("Login koide (legacy) no devolvio token");
  token = data.token;
  log(`[legacy] Sesion iniciada (${data.department} / ${data.role})`);
}

async function apiGet(url, retry = true) {
  const res = await fetch(`${LEGACY_API}${url}`, {
    signal: AbortSignal.timeout(KOIDE_TIMEOUT_MS),
    headers: { "X-Auth-Token": token || "" },
  });
  if (res.status === 401 && retry) {
    await login();
    return apiGet(url, false);
  }
  if (!res.ok) throw new Error(`API koide legacy (HTTP ${res.status}) en ${url}`);
  return res.json();
}

// Si ya hay una sincronizacion en curso, la peticion NO se conforma con ella
// (pudo empezar antes del cambio que se quiere ver, p. ej. un paro recien
// cerrado en la terminal): se encola UNA mas, compartida por todas las que
// lleguen mientras tanto.
let refreshing = null;
let encolado = null;
function refresh() {
  if (refreshing) {
    if (!encolado) {
      encolado = refreshing.catch(() => {}).then(() => {
        encolado = null;
        return refresh();
      });
    }
    return encolado;
  }
  refreshing = doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function leerLegacy() {
  if (!token) await login();
  return apiGet(`/api/downtime-records?responsibleArea=${encodeURIComponent(area)}`);
}

async function doRefresh() {
  const errores = [];
  const estado = {};
  try {
    let records;
    let machines;
    if (koideGeneral.configurado()) {
      const [mesRecords, mesMachines, catalogo] = await Promise.all([
        koideGeneral.downtimeRecords(),
        koideGeneral.machines(),
        koideGeneral.equipos(),
      ]);
      const migrados = new Set(catalogo.procesos.filter((p) => p.migradoMes).map((p) => p.codigo));
      records = Array.isArray(mesRecords) ? mesRecords : [];
      machines = Array.isArray(mesMachines) ? mesMachines : [];
      estado.mes = { ok: true, registros: records.length, procesosMigrados: [...migrados] };
      if (LEGACY_API) {
        // DEPENDENCIA LEGACY TEMPORAL: procesos aun no migrados.
        try {
          const ids = new Set(records.map((r) => r.id));
          const legacy = (await leerLegacy()).filter(
            (r) => !migrados.has(String(r.machine_process || "").toUpperCase()) && !ids.has(r.id)
          );
          records = records.concat(legacy);
          estado.legacy = { ok: true, registros: legacy.length, nota: "solo procesos no migrados al MES" };
        } catch (err) {
          // Sin el sistema viejo se conserva la ultima copia de ESOS procesos.
          const previos = cache ? cache.records.filter((r) => !migrados.has(String(r.machine_process || "").toUpperCase())) : [];
          records = records.concat(previos.filter((r) => !records.some((x) => x.id === r.id)));
          estado.legacy = { ok: false, error: err.message, registrosDeCopia: previos.length };
          errores.push(`legacy: ${err.message}`);
        }
      } else {
        estado.legacy = { omitido: true };
      }
    } else {
      // Sin MES configurado: comportamiento anterior (solo sistema viejo).
      if (!LEGACY_API) throw new Error("Sin fuente de paros: configure KOIDE_GENERAL_URL/KOIDE_GENERAL_TOKEN");
      if (!token) await login();
      [records, machines] = await Promise.all([leerLegacy(), apiGet("/api/machines")]);
      estado.legacy = { ok: true, registros: records.length, nota: "MES no configurado" };
    }
    const payload = {
      updatedAt: new Date().toISOString(),
      area,
      source: "live",
      records,
      machines,
    };
    const huella = require("crypto").createHash("sha1").update(JSON.stringify([records, machines])).digest("hex");
    if (huella !== huellaDatos || !cache) {
      await store.saveTiempoMuerto(payload);
      huellaDatos = huella;
    }
    cache = payload;
    lastUpdate = new Date();
    lastError = errores.length ? errores.join("; ") : null;
    fuentes = estado;
    if (huella !== ultimaHuellaLog) {
      ultimaHuellaLog = huella;
      log(`[update] ${payload.records.length} registros y ${payload.machines.length} maquinas (${JSON.stringify(estado)})`);
    }
  } catch (err) {
    lastError = err.message || String(err);
    fuentes = { ...estado, error: lastError };
    log("[update] ERROR:", lastError);
  }
  return cache;
}

async function loadCache() {
  try {
    const saved = await store.loadTiempoMuerto();
    if (saved) {
      cache = { ...saved, source: "cache" };
      lastUpdate = new Date(cache.updatedAt);
      log(`[cache] Cargados ${cache.records.length} registros de la cache local`);
    }
  } catch (err) {
    console.error("[cache] Error al leer cache:", err.message);
  }
}

function nextRunDate() {
  const hour = config.dailyUpdateHour ?? 7;
  const minute = config.dailyUpdateMinute ?? 0;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleDaily() {
  const schedule = () => {
    const next = nextRunDate();
    const ms = next.getTime() - Date.now();
    log(
      `[schedule] Proxima actualizacion automatica: ${next.toLocaleString("es-MX", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })}`
    );
    setTimeout(async () => {
      await refresh();
      schedule();
    }, ms);
  };
  schedule();
}

function serveStatic(req, res, urlPath) {
  if (!urlPath) {
    try {
      urlPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      urlPath = "/";
    }
    if (urlPath === "/") urlPath = "/index.html";
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Prohibido");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No encontrado");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    // Las paginas dependen de la sesion: que el navegador no las guarde en cache.
    if (ext === ".html") headers["Cache-Control"] = "no-store";
    res.writeHead(200, headers);
    res.end(data);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// Si el cuerpo excede maxBytes se descarta y se resuelve {} (antes la peticion
// quedaba colgada); los manejadores responden 400 como con un cuerpo vacio.
function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > maxBytes) {
        tooLarge = true;
        data = "";
        log(`[http] Cuerpo mayor a ${maxBytes} bytes descartado en ${req.url}`);
      }
    });
    req.on("end", () => {
      if (tooLarge) return resolve({});
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/* ---------- Bonos (plantilla Excel + semanas) ---------- */

function parseWorksheet(ws) {
  const cells = {};
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell || cell.v === undefined || cell.v === null || cell.v === "") continue;
      const rec = { v: cell.v };
      if (cell.t) rec.t = cell.t;
      if (cell.z) rec.z = cell.z;
      if (cell.w !== undefined) rec.w = cell.w;
      else {
        try {
          rec.w = XLSX.utils.format_cell(cell);
        } catch {
          rec.w = String(cell.v);
        }
      }
      if (cell.s && cell.s.patternType === "solid" && cell.s.fgColor && cell.s.fgColor.rgb) {
        rec.fill = cell.s.fgColor.rgb;
      }
      cells[addr] = rec;
    }
  }
  const merges = (ws["!merges"] || []).map((m) => ({ s: m.s, e: m.e }));
  const cols = (ws["!cols"] || []).map((c) => (c && c.wch ? { wch: c.wch } : null));
  let maxRow = -1;
  let maxCol = -1;
  let minRow = range.e.r;
  let minCol = range.e.c;
  for (const addr of Object.keys(cells)) {
    const cell = XLSX.utils.decode_cell(addr);
    if (cell.r > maxRow) maxRow = cell.r;
    if (cell.c > maxCol) maxCol = cell.c;
    if (cell.r < minRow) minRow = cell.r;
    if (cell.c < minCol) minCol = cell.c;
  }
  for (const m of merges) {
    if (m.e.r > maxRow) maxRow = m.e.r;
    if (m.e.c > maxCol) maxCol = m.e.c;
    if (m.s.r < minRow) minRow = m.s.r;
    if (m.s.c < minCol) minCol = m.s.c;
  }
  return {
    ref: ws["!ref"],
    cells,
    merges,
    cols,
    maxRow,
    maxCol,
  };
}

function parseTemplate(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellStyles: true });
  const sheet = wb.SheetNames[0];
  return Object.assign(parseWorksheet(wb.Sheets[sheet]), { sheet });
}

function parseSheets(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellStyles: true });
  return wb.SheetNames.map((name) =>
    Object.assign(parseWorksheet(wb.Sheets[name]), { sheet: name })
  );
}

/* ---------- Calendarios de mantenimiento (Excel) ---------- */

function calFile(id) {
  return path.join(CAL_DIR, id + ".xlsx");
}

/* ---------- Documentos ---------- */

function docCatPath(cat) {
  const key = DOC_CATEGORIAS.find((c) => c === String(cat || ""));
  if (!key) return null;
  return path.join(DOC_DIR, key);
}

function docSanitize(name) {
  return path
    .basename(String(name || "archivo"))
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim() || "archivo";
}

// El disco sigue siendo la fuente de la lista (igual que antes); la tabla
// "documentos" se sincroniza con lo que hay en la carpeta en cada consulta.
async function docList(cat) {
  const dir = docCatPath(cat);
  if (!dir) return [];
  const files = docListDisk(dir);
  await store.syncDocumentos(path.basename(dir), files);
  return files;
}

function docListDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f !== "." && f !== "..")
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

// Los scripts Python leen DB_* / rutas de Excel del mismo entorno (.env).
const PY_OPTS = { timeout: 120000, cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" } };

/* ---------- Configuracion del sistema y programacion de contramedidas ----------
 * Solo llega aqui mantenimiento_admin (autorizacion por rol en el servidor);
 * las escrituras vuelven a exigir la capacidad "admin" por si cambian los roles. */

const ERRORES_CM = [configuracion.ConfigError, aprobacionCm.AprobacionError, historico.HistoricoError, contramedidas.ContramedidaError];

async function handleProgramacionCm(req, res, url, user) {
  const soloAdmin = () => {
    if (auth.puede(user, "admin")) return true;
    sendJson(res, 403, { error: "Solo un administrador puede hacer este cambio" });
    return false;
  };
  try {
    if (url === "/api/configuracion" && req.method === "GET") {
      sendJson(res, 200, { parametros: await configuracion.listar() });
      return true;
    }
    if (url === "/api/configuracion" && req.method === "PUT") {
      if (!soloAdmin()) return true;
      const body = await readBody(req);
      const cambios = await configuracion.guardar(body.valores, user);
      for (const c of cambios) log(`[config] ${user.username} cambio ${c.clave}: ${JSON.stringify(c.anterior)} -> ${JSON.stringify(c.nuevo)}`);
      sendJson(res, 200, { cambios, parametros: await configuracion.listar() });
      return true;
    }
    if (url === "/api/auditoria" && req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      sendJson(res, 200, await auditoria.listar({ entidad: q.get("entidad"), entidadId: q.get("entidadId"), limite: q.get("limite") }));
      return true;
    }
    // Ejecuta la programacion automatica (idempotente). La pantalla la llama al
    // abrir Contramedidas; ademas corre sola cada CONTRAMEDIDAS_AUTO_MS.
    if (url === "/api/contramedidas/programacion-automatica" && req.method === "POST") {
      if (!soloAdmin()) return true;
      const r = await programacionCm.ejecutar({ user });
      for (const c of r.creadas) log(`[contramedidas] Propuesta automatica #${c.id}: ${c.equipo} · ${c.categoria} para el ${c.fechaPropuesta} (pendiente de aprobacion)`);
      sendJson(res, 200, r);
      return true;
    }
    if (url === "/api/contramedidas/propuestas" && req.method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      const estados = (q.get("estado") || "").split(",").filter(Boolean);
      sendJson(res, 200, estados.length === 1 && estados[0] === "PENDIENTE_APROBACION" ? await aprobacionCm.pendientes() : await aprobacionCm.listar({ estados }));
      return true;
    }
    const mp = url.match(/^\/api\/contramedidas\/propuestas\/(\d+)\/(aprobar|rechazar|reprogramar|fechas-disponibles)$/);
    if (mp && mp[2] === "fechas-disponibles" && req.method === "GET") {
      sendJson(res, 200, await aprobacionCm.fechasDisponibles(mp[1]));
      return true;
    }
    if (mp && req.method === "POST") {
      if (!soloAdmin()) return true;
      const body = await readBody(req);
      if (mp[2] === "aprobar") {
        const r = await aprobacionCm.aprobar(mp[1], user);
        log(`[contramedidas] ${user.username} aprobo la propuesta #${mp[1]} (${r.propuesta.equipo.codigo}) para el ${r.propuesta.fechaConfirmada}; contramedida ${r.contramedida.id}${r.contramedida.mesId ? ` (MES #${r.contramedida.mesId})` : ""}`);
        sendJson(res, 200, r);
      } else if (mp[2] === "rechazar") {
        const p = await aprobacionCm.rechazar(mp[1], body.motivo, user);
        log(`[contramedidas] ${user.username} rechazo la propuesta #${mp[1]} (${p.equipo.codigo}): ${p.motivo}`);
        sendJson(res, 200, p);
      } else {
        const p = await aprobacionCm.reprogramar(mp[1], body.fecha, body.motivo, user);
        log(`[contramedidas] ${user.username} reprogramo la propuesta #${mp[1]} (${p.equipo.codigo}) al ${p.fechaPropuesta}: ${p.motivo}`);
        sendJson(res, 200, p);
      }
      return true;
    }
  } catch (err) {
    if (ERRORES_CM.some((E) => err instanceof E)) {
      sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
      return true;
    }
    throw err;
  }
  return false;
}

// Programacion automatica periodica (0 = solo desde la pantalla).
const CM_AUTO_MS = Number(env("CONTRAMEDIDAS_AUTO_MS", String(30 * 60 * 1000)));

async function programacionAutomaticaPeriodica() {
  try {
    const r = await programacionCm.ejecutar();
    for (const c of r.creadas) log(`[contramedidas] Propuesta automatica #${c.id}: ${c.equipo} · ${c.categoria} para el ${c.fechaPropuesta} (pendiente de aprobacion)`);
  } catch (err) {
    log(`[contramedidas] Programacion automatica no disponible: ${err.message}`);
  }
}

async function handleApi(req, res, url, user) {
  if (url === "/api/gastos" && req.method === "GET") {
    try {
      const data = await store.loadGastos();
      sendJson(res, 200, data === null ? {} : data);
    } catch (err) {
      console.error("[gastos] Error al leer de MySQL:", err.message);
      sendJson(res, 200, {});
    }
    return true;
  }
  if (url === "/api/gastos/refresh" && req.method === "POST") {
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(PYTHON, [EXTRACT_SCRIPT], PY_OPTS, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
      await new Promise((resolve, reject) => {
        execFile(PYTHON, [ENTREGAS_SCRIPT], PY_OPTS, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
      sendJson(res, 200, { ok: true, output: result });
    } catch (err) {
      sendJson(res, 500, { error: "Error al extraer datos: " + err.message });
    }
    return true;
  }
  if (url === "/api/entregas" && req.method === "GET") {
    try {
      const data = await store.loadEntregas();
      sendJson(res, 200, data === null ? [] : data);
    } catch (err) {
      console.error("[entregas] Error al leer de MySQL:", err.message);
      sendJson(res, 200, []);
    }
    return true;
  }
  if (url === "/api/entregas/refresh" && req.method === "POST") {
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(PYTHON, [ENTREGAS_SCRIPT], PY_OPTS, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
      sendJson(res, 200, { ok: true, output: result });
    } catch (err) {
      sendJson(res, 500, { error: "Error al extraer tiempos de entrega: " + err.message });
    }
    return true;
  }
  if (url === "/api/calendarios" && req.method === "GET") {
    sendJson(res, 200, await store.listCalendarios());
    return true;
  }
  if (url === "/api/calendarios" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const buf = Buffer.from(String(body.base64 || ""), "base64");
      if (buf.length < 100) throw new Error("Archivo vacio o invalido");
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      fs.mkdirSync(CAL_DIR, { recursive: true });
      fs.writeFileSync(calFile(id), buf);
      const entry = {
        id,
        name: String(body.name || "calendario.xlsx"),
        uploadedAt: new Date().toISOString(),
        sheets: parseSheets(buf),
        status: {},
      };
      try {
        await store.insertCalendario(entry);
      } catch (err) {
        try {
          fs.unlinkSync(calFile(id));
        } catch {}
        throw err;
      }
      log(`[cal] Calendario cargado: ${entry.name} (${buf.length} bytes, ${entry.sheets.length} hojas)`);
      sendJson(res, 200, entry);
    } catch (err) {
      sendJson(res, 400, { error: "No se pudo procesar el archivo: " + err.message });
    }
    return true;
  }
  const mCal = url.match(/^\/api\/calendarios\/([^/]+)$/);
  if (mCal && req.method === "POST") {
    const body = await readBody(req);
    const entry = await store.getCalendario(mCal[1]);
    if (!entry) {
      sendJson(res, 404, { error: "No encontrado" });
      return true;
    }
    if (body.status && typeof body.status === "object") entry.status = body.status;
    await store.updateCalendario(entry);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (mCal && req.method === "DELETE") {
    const removed = await store.getCalendario(mCal[1]);
    if (!removed) {
      sendJson(res, 404, { error: "No encontrado" });
      return true;
    }
    await store.deleteCalendario(removed.id);
    try {
      fs.unlinkSync(calFile(removed.id));
    } catch {}
    log(`[cal] Calendario eliminado: ${removed.name}`);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url === "/api/bonos" && req.method === "GET") {
    const bonos = await store.loadBonos();
    sendJson(res, 200, { updatedAt: bonos.updatedAt || null, template: bonos.template, weeks: bonos.weeks });
    return true;
  }
  if (url === "/api/bonos" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const buf = Buffer.from(String(body.base64 || ""), "base64");
      if (buf.length < 100) throw new Error("Archivo vacio o invalido");
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(BONOS_XLSX, buf);
      const template = parseTemplate(buf);
      const { weeks, ...bonos } = await store.loadBonos();
      bonos.template = template;
      bonos.updatedAt = new Date().toISOString();
      await store.saveBonosPlantilla(bonos, BONOS_XLSX_RUTA);
      log(`[bonos] Plantilla cargada: ${body.name || "sin nombre"} (${buf.length} bytes)`);
      sendJson(res, 200, { template: bonos.template });
    } catch (err) {
      sendJson(res, 400, { error: "No se pudo procesar el archivo: " + err.message });
    }
    return true;
  }
  if (url === "/api/bonos/week" && req.method === "POST") {
    const body = await readBody(req);
    const key = String(body.key || "").trim();
    if (!key) {
      sendJson(res, 400, { error: "Falta la clave de semana" });
      return true;
    }
    await store.saveBonoSemana({
      key,
      semana: body.semana != null ? body.semana : null,
      periodoIni: body.periodoIni || "",
      periodoFin: body.periodoFin || "",
      fecha: body.fecha || "",
      cells: body.cells || {},
      guardado: new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true });
    return true;
  }
  const mw = url.match(/^\/api\/bonos\/week\/([^/]+)$/);
  if (mw && req.method === "DELETE") {
    await store.deleteBonoSemana(decodeURIComponent(mw[1]));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url === "/api/bonos/plantilla" && req.method === "GET") {
    if (!fs.existsSync(BONOS_XLSX)) {
      sendJson(res, 404, { error: "No hay plantilla" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="plantilla-bonos.xlsx"',
    });
    res.end(fs.readFileSync(BONOS_XLSX));
    return true;
  }
  if (url === "/api/contramedidas" && req.method === "GET") {
    sendJson(res, 200, await store.listContramedidas());
    return true;
  }
  // Recomendaciones por acumulacion de fallas (equipo + categoria >= umbral),
  // calculadas por KOIDE MES para CUALQUIER proceso. Se muestran debajo de
  // "Agendar contramedida"; al programar una, se registra tambien en el MES.
  if (url === "/api/contramedidas/recomendaciones" && req.method === "GET") {
    try {
      sendJson(res, 200, await recomendacionesCm.conProgramacion());
    } catch (err) {
      if (err instanceof historico.HistoricoError) sendJson(res, err.status, { error: err.message, ...err.extra });
      else throw err;
    }
    return true;
  }
  if (url === "/api/contramedidas" && req.method === "POST") {
    const body = await readBody(req);
    // Programada a mano desde una recomendacion: se ubica su ciclo ANTES de
    // registrarla (despues el MES ya la da por atendida) para dejarla en
    // "Contramedidas confirmadas" con origen manual.
    let reco = null;
    if (body.recomendacionClave) {
      try {
        const d = await recomendacionesCm.detectar();
        reco = d.recomendaciones.find((r) => (body.recomendacionCiclo ? r.ciclo === body.recomendacionCiclo : r.clave === body.recomendacionClave)) || null;
      } catch {}
    }
    let cm;
    try {
      cm = await contramedidas.crear(body, user);
    } catch (err) {
      if (err instanceof contramedidas.ContramedidaError) {
        sendJson(res, err.status, { error: err.message, ...err.extra });
        return true;
      }
      throw err;
    }
    if (cm.mesId) log(`[contramedidas] ${user.username} programo la contramedida ${cm.id} (${cm.maquina}) registrada en el MES como #${cm.mesId}`);
    else if (cm.recomendacionClave) log(`[contramedidas] ${user.username} programo la contramedida ${cm.id} (${cm.maquina}) para la recomendacion ${cm.recomendacionClave}`);
    if (reco && cm.recomendacionClave) {
      try {
        await aprobacionCm.registrarManual(cm, reco, user);
      } catch (err) {
        log(`[contramedidas] AVISO: no se pudo registrar la programacion manual de ${cm.id} (${reco.ciclo}): ${err.message}`);
      }
    }
    sendJson(res, 200, cm);
    return true;
  }
  if (await handleProgramacionCm(req, res, url, user)) return true;
  const m = url.match(/^\/api\/contramedidas\/([^/]+)$/);
  if (m && req.method === "PUT") {
    const body = await readBody(req);
    const actual = await store.getContramedida(m[1]);
    if (!actual) {
      sendJson(res, 404, { error: "No encontrada" });
      return true;
    }
    const cm = await store.updateContramedida({ ...actual, ...body, id: m[1] });
    // Espejo del estado en el MES (si la contramedida nacio de una recomendacion).
    let mesSync = null;
    if (cm.mesId) {
      try {
        await historico.actualizarEnMes(cm.mesId, { estado: body.estado, trabajoRealizado: body.trabajoRealizado, responsable: body.responsable, fechaProgramada: body.fechaLimite }, user);
        mesSync = true;
      } catch (err) {
        mesSync = false;
        log(`[contramedidas] AVISO: no se pudo reflejar la contramedida ${cm.id} en el MES (#${cm.mesId}): ${err.message}`);
      }
    }
    sendJson(res, 200, mesSync === null ? cm : { ...cm, mesSync });
    return true;
  }
  if (m && req.method === "DELETE") {
    await store.deleteContramedida(m[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }
  const mCmFotos = url.match(/^\/api\/contramedidas\/([^/]+)\/fotos$/);
  if (mCmFotos && req.method === "POST") {
    const id = mCmFotos[1];
    const cm = await store.getContramedida(id);
    if (!cm) {
      sendJson(res, 404, { error: "Contramedida no encontrada" });
      return true;
    }
    const body = await readBody(req, 60e6);
    const fotos = Array.isArray(body.fotos) ? body.fotos : [];
    if (fotos.length + (cm.fotos || []).length > 2) {
      sendJson(res, 400, { error: "Máximo 2 fotos por contramedida" });
      return true;
    }
    const dir = path.join(CM_FOTOS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    for (const f of fotos) {
      const ext = (f.name || "").match(/\.(jpe?g|png)$/i) ? RegExp.$1.toLowerCase() : "jpg";
      const fname = `foto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}.${ext}`;
      try {
        const buf = Buffer.from(String(f.base64 || ""), "base64");
        if (buf.length < 100) continue;
        if (buf.length > 5 * 1024 * 1024) continue;
        fs.writeFileSync(path.join(dir, fname), buf);
        names.push(fname);
      } catch {}
    }
    cm.fotos = [...(cm.fotos || []), ...names];
    await store.updateContramedida(cm);
    sendJson(res, 200, { ok: true, fotos: cm.fotos });
    return true;
  }
  const mCmFoto = url.match(/^\/api\/contramedidas\/fotos\/([^/]+)\/([^/]+)$/);
  if (mCmFoto && req.method === "GET") {
    const id = mCmFoto[1];
    const name = path.basename(decodeURIComponent(mCmFoto[2]));
    const fp = path.join(CM_FOTOS_DIR, id, name);
    if (!fs.existsSync(fp)) {
      sendJson(res, 404, { error: "Foto no encontrada" });
      return true;
    }
    const ext = path.extname(name).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
    res.end(fs.readFileSync(fp));
    return true;
  }
  if (url === "/api/documentos" && req.method === "GET") {
    sendJson(
      res,
      200,
      await Promise.all(DOC_CATEGORIAS.map(async (c) => ({ categoria: c, archivos: (await docList(c)) || [] })))
    );
    return true;
  }
  const mDoc = url.match(/^\/api\/documentos\/([^/]+)$/);
  if (mDoc && req.method === "POST") {
    const dir = docCatPath(decodeURIComponent(mDoc[1]));
    if (!dir) {
      sendJson(res, 400, { error: "Categoría inválida" });
      return true;
    }
    const body = await readBody(req, 50e6);
    try {
      const buf = Buffer.from(String(body.base64 || ""), "base64");
      if (buf.length < 1) throw new Error("Archivo vacío o inválido");
      const name = docSanitize(body.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
      log(`[docs] Subido "${name}" en ${path.basename(dir)} (${buf.length} bytes)`);
      sendJson(res, 200, { ok: true, archivos: await docList(mDoc[1]) });
    } catch (err) {
      sendJson(res, 400, { error: "No se pudo subir el archivo: " + err.message });
    }
    return true;
  }
  const mDocFile = url.match(/^\/api\/documentos\/([^/]+)\/([^/]+)$/);
  if (mDocFile && req.method === "GET") {
    const dir = docCatPath(decodeURIComponent(mDocFile[1]));
    const name = docSanitize(decodeURIComponent(mDocFile[2]));
    const fp = dir ? path.join(dir, name) : null;
    if (!fp || !fs.existsSync(fp)) {
      sendJson(res, 404, { error: "No encontrado" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(fs.readFileSync(fp));
    return true;
  }
  if (mDocFile && req.method === "DELETE") {
    const dir = docCatPath(decodeURIComponent(mDocFile[1]));
    const name = docSanitize(decodeURIComponent(mDocFile[2]));
    const fp = dir ? path.join(dir, name) : null;
    if (!fp || !fs.existsSync(fp)) {
      sendJson(res, 404, { error: "No encontrado" });
      return true;
    }
    fs.unlinkSync(fp);
    log(`[docs] Eliminado "${name}" de ${path.basename(dir)}`);
    sendJson(res, 200, { ok: true, archivos: await docList(mDocFile[1]) });
    return true;
  }
  return false;
}

/* ---------- Autenticacion, roles y operador de mantenimiento ---------- */

const { ADMIN, OP, CONSULTA } = auth.ROLES;
const HOME = { [ADMIN]: "/", [OP]: "/operador-mantenimiento", [CONSULTA]: "/" };

// Archivos que se sirven sin sesion (pantalla de login y recursos comunes).
const PUBLIC_FILES = new Set(["/login.html", "/login.js", "/acceso.css", "/styles.css", "/favicon.ico"]);
// Archivos para cualquier usuario con sesion.
const SESSION_FILES = new Set(["/sesion.js", "/vendor/chart.umd.min.js"]);
// Pantalla del operador (mantenimiento_op y mantenimiento_admin).
const OP_FILES = new Set(["/operador.html", "/operador.js"]);

function staticPath(req) {
  let p;
  try {
    p = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    return null;
  }
  p = path.posix.normalize(p.replace(/\\/g, "/"));
  if (p === "/login") return "/login.html";
  if (p === "/operador-mantenimiento" || p.startsWith("/operador-mantenimiento/")) return "/operador.html";
  if (p === "/") return "/index.html";
  return p;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function clientIp(req) {
  return req.socket.remoteAddress || "";
}

async function handleAuth(req, res, url, user) {
  if (url === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req, 10e3);
    const r = await auth.login(body.username, body.password, { ip: clientIp(req), userAgent: req.headers["user-agent"] });
    if (!r.user) {
      const headers = { "Content-Type": "application/json; charset=utf-8" };
      if (r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
      res.writeHead(r.status, headers);
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": auth.sessionCookie(r.token, r.expira), "Cache-Control": "no-store" });
    res.end(JSON.stringify({ user: r.user, redirect: HOME[r.user.rol] || "/login", expira: r.expira.toISOString() }));
    log(`[auth] Sesion iniciada: ${r.user.username} (${r.user.rol})`);
    return true;
  }
  if (url === "/api/auth/logout" && req.method === "POST") {
    await auth.logout(auth.tokenFromReq(req));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": auth.clearCookie() });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (url === "/api/auth/me" && req.method === "GET") {
    if (!user) return sendJson(res, 401, { error: "Sesion no iniciada" }), true;
    sendJson(res, 200, { user, home: HOME[user.rol], capacidades: [...(auth.CAPACIDADES[user.rol] || [])] });
    return true;
  }
  return false;
}

function sendError(res, err) {
  if (err instanceof atenciones.AtencionError) return sendJson(res, err.status, { error: err.message, ...err.extra });
  throw err;
}

async function handleOperador(req, res, url, user) {
  try {
    if (url === "/api/operador/atenciones" && req.method === "GET") {
      return sendJson(res, 200, await atenciones.misAtenciones(user));
    }
    if (url === "/api/operador/catalogos" && req.method === "GET") {
      return sendJson(res, 200, await atenciones.catalogos());
    }
    let m = url.match(/^\/api\/operador\/reportes\/([^/]+)$/);
    if (m && req.method === "GET") {
      return sendJson(res, 200, await atenciones.consultar(decodeURIComponent(m[1]), user));
    }
    m = url.match(/^\/api\/operador\/reportes\/([^/]+)\/aceptar$/);
    if (m && req.method === "POST") {
      const a = await atenciones.aceptar(decodeURIComponent(m[1]), user);
      log(`[operador] Paro ${a.codigoReporte} aceptado por ${user.username}`);
      refresh().catch(() => {});
      return sendJson(res, 200, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)$/);
    if (m && req.method === "GET") return sendJson(res, 200, await atenciones.obtener(m[1], user));
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/espera-externa$/);
    if (m && req.method === "POST") {
      const a = await atenciones.esperaExterna(m[1], user, await readBody(req, 10e3));
      refresh().catch(() => {});
      return sendJson(res, 200, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/continuidad$/);
    if (m && req.method === "POST") {
      const a = await atenciones.tomarContinuidad(m[1], user);
      log(`[operador] Paro ${a.codigoReporte}: continuidad tomada por ${user.username} (#${user.numeroEmpleado})`);
      refresh().catch(() => {});
      return sendJson(res, 200, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/reanudar$/);
    if (m && req.method === "POST") {
      const a = await atenciones.reanudar(m[1], user);
      refresh().catch(() => {});
      return sendJson(res, 200, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/evidencias$/);
    if (m && req.method === "POST") {
      const body = await readBody(req, 35e6);
      const a = await atenciones.agregarEvidencia(m[1], user, body);
      log(`[operador] Paro ${a.codigoReporte}: evidencia agregada por ${user.username} (#${user.numeroEmpleado})`);
      return sendJson(res, 201, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/finalizar$/);
    if (m && req.method === "POST") {
      const body = await readBody(req, 35e6);
      const a = await atenciones.finalizar(m[1], user, body);
      log(`[operador] Paro ${a.codigoReporte} finalizado y CERRADO por ${user.username} (#${user.numeroEmpleado})`);
      refresh().catch(() => {});
      return sendJson(res, 200, a);
    }
    m = url.match(/^\/api\/operador\/atenciones\/(\d+)\/fotos\/(\d+)$/);
    if (m && req.method === "GET") {
      const f = await atenciones.fotoDe(m[1], m[2], user);
      if (!f) return sendJson(res, 404, { error: "Foto no encontrada" });
      res.writeHead(200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=86400" });
      return res.end(f.buffer);
    }
    sendJson(res, 404, { error: "No encontrado" });
  } catch (err) {
    sendError(res, err);
  }
}

// El codigo de cierre lo genera y lo valida KOIDE MES: la terminal de
// produccion habla SOLO con el MES (Capture Terminal -> koide-general). Este
// endpoint (que nunca llego a usarse) se retira.
async function handleTerminal(req, res) {
  return sendJson(res, 410, {
    error: "El codigo de cierre se valida en KOIDE MES (POST /api/tiempo-operativo/:id/cerrar). Este endpoint fue retirado.",
    code: "VALIDACION_EN_MES",
  });
}

// Historico general de paros (KOIDE MES, cualquier proceso). Solo lectura:
// administrador y tecnico_consulta.
async function handleHistorico(req, res, url, user) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Solo lectura" }), true;
  try {
    if (url === "/api/historico/catalogos") {
      const c = await koideGeneral.catalogos();
      return sendJson(res, 200, { categorias: c.categorias || [], procesos: c.procesos || [], personal: c.personal || [] }), true;
    }
    if (url === "/api/historico/paros") {
      const params = Object.fromEntries(new URL(req.url, "http://x").searchParams);
      return sendJson(res, 200, await historico.consultar(params)), true;
    }
    let m = url.match(/^\/api\/historico\/paros\/(\d+)$/);
    if (m) return sendJson(res, 200, await historico.detalle(m[1])), true;
    m = url.match(/^\/api\/historico\/paros\/(\d+)\/evidencias\/(\d+)$/);
    if (m) {
      const f = await historico.evidencia(m[1], m[2]);
      if (!f) return sendJson(res, 404, { error: "Evidencia no encontrada" }), true;
      res.writeHead(200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=86400" });
      res.end(f.buffer);
      return true;
    }
  } catch (err) {
    if (err instanceof historico.HistoricoError) return sendJson(res, err.status, { error: err.message, ...err.extra }), true;
    if (err instanceof koideGeneral.KoideGeneralError) return sendJson(res, err.status, { error: err.message, code: err.code }), true;
    throw err;
  }
  return false;
}

// Operadores de mantenimiento (usuario + PIN + numero de empleado): los
// administra el administrador de mantenimiento.
// Roster de tecnicos del dashboard: el de config.json + los operadores activos
// dados de alta aqui (el nombre de config tiene prioridad).
async function rosterTecnicos() {
  const base = (config.maintenanceTechnicians || []).map((t) => ({ ...t }));
  const ya = new Set(base.map((t) => String(t.employee_number || "").trim()));
  try {
    for (const o of await auth.operadoresActivos()) {
      const n = String(o.numero_empleado).trim();
      if (!ya.has(n)) { base.push({ employee_number: n, name: o.nombre, role: o.rol }); ya.add(n); }
      else { const t = base.find((x) => String(x.employee_number).trim() === n); if (t && !t.role) t.role = o.rol; }
    }
  } catch (err) {
    log(`[auth] roster: no se pudieron leer los operadores (${err.message})`);
  }
  return base;
}

// Auditoria de cuentas: sin secretos (PIN/contrasena solo como "cambiado").
function resumenCuenta(o) {
  return o ? { username: o.username, nombre: o.nombre, rol: o.rol, numeroEmpleado: o.numeroEmpleado, activo: o.activo } : null;
}

async function handleOperadoresAdmin(req, res, url, user) {
  try {
    if (url === "/api/admin/operadores" && req.method === "GET") return sendJson(res, 200, await operadores.listarConMes()), true;
    // Empleados del catalogo de KOIDE MES para asociar a una cuenta (con la
    // cuenta que ya tiene cada numero). No se guarda copia aqui.
    if (url === "/api/admin/personal-mes" && req.method === "GET") return sendJson(res, 200, await operadores.personalParaAsociar()), true;
    if (url === "/api/admin/operadores" && req.method === "POST") {
      const b = await readBody(req, 10e3);
      const o = await operadores.alta({ rol: b.rol || undefined, nombre: b.nombre, username: b.username, pin: b.pin, password: b.password, numeroEmpleado: b.numeroEmpleado, activo: b.activo });
      log(`[admin] ${user.username} dio de alta la cuenta ${o.username} (${o.rol}${o.numeroEmpleado ? ` #${o.numeroEmpleado}` : ""})`);
      await auditoria.registrar({ user, accion: "alta_cuenta", entidad: "usuario", entidadId: o.username, nuevo: resumenCuenta(o) });
      return sendJson(res, 201, o), true;
    }
    const m = url.match(/^\/api\/admin\/operadores\/([A-Za-z0-9._-]{3,60})$/);
    if (m && req.method === "PATCH") {
      const b = await readBody(req, 10e3);
      const antes = await operadores.obtener(m[1]);
      const o = await operadores.modificar(m[1], { nombre: b.nombre, numeroEmpleado: b.numeroEmpleado, activo: b.activo, pin: b.pin, password: b.password }, user);
      const que = Object.keys(b).filter((k) => ["nombre", "numeroEmpleado", "activo", "pin", "password"].includes(k)).join(", ");
      log(`[admin] ${user.username} modifico la cuenta ${o.username}: ${que}`);
      await auditoria.registrar({ user, accion: "modificar_cuenta", entidad: "usuario", entidadId: o.username, anterior: resumenCuenta(antes), nuevo: resumenCuenta(o),
        detalle: { campos: que, secretoCambiado: Boolean(b.pin || b.password) } });
      return sendJson(res, 200, o), true;
    }
  } catch (err) {
    if (err instanceof operadores.OperadorError) return sendJson(res, err.status, { error: err.message }), true;
    if (err instanceof koideGeneral.KoideGeneralError) return sendJson(res, err.status, { error: err.message }), true;
    throw err;
  }
  return false;
}

/* ---------- Programa de mantenimiento preventivo mensual (mig 009) ---------- */

async function handlePreventivo(req, res, url, user) {
  try {
    if (url === "/api/preventivo" && req.method === "GET") {
      await preventivo.asegurarRestoAno();
      if (cache) {
        const hechos = await preventivo.autoProgramar(cache.records, cache.machines);
        if (hechos.length) log(`[prev] Programacion automatica mensual generada: ${hechos.join(", ")}`);
      }
      sendJson(res, 200, await preventivo.listar(config));
      return true;
    }
    if (url === "/api/preventivo" && req.method === "POST") {
      const body = await readBody(req);
      if (!(await preventivo.crearMes(body.mes, { user }))) throw new preventivo.PreventivoError("El mes ya existe");
      log(`[prev] Mes creado: ${body.mes}`);
      sendJson(res, 200, { ok: true, mes: body.mes });
      return true;
    }
    if (url === "/api/preventivo/evidencia" && req.method === "POST") {
      const body = await readBody(req, 8e6);
      const r = preventivo.guardarEvidencia(DATA_DIR, body.base64);
      log(`[prev] Evidencia subida: ${r.name} (${r.size} bytes)`);
      sendJson(res, 200, { ok: true, name: r.name, url: r.url });
      return true;
    }
    const mEv = url.match(/^\/api\/preventivo\/evidencia\/([^/]+)$/);
    if (mEv && req.method === "GET") {
      const ev = preventivo.leerEvidencia(DATA_DIR, decodeURIComponent(mEv[1]));
      if (!ev) {
        sendJson(res, 404, { error: "No encontrado" });
        return true;
      }
      res.writeHead(200, { "Content-Type": ev.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400" });
      res.end(ev.buf);
      return true;
    }
    const mTarea = url.match(/^\/api\/preventivo\/tareas\/(\d+)\/(estado|reporte)$/);
    if (mTarea && req.method === "PUT") {
      const id = Number(mTarea[1]);
      const body = await readBody(req);
      if (mTarea[2] === "estado") await preventivo.marcarEstado(id, body.estado, { user });
      else await preventivo.guardarReporte(id, body, { user, dataDir: DATA_DIR });
      sendJson(res, 200, { ok: true });
      return true;
    }
    const mAccion = url.match(/^\/api\/preventivo\/(\d{4}-\d{2})\/(programar|limpiar)$/);
    if (mAccion && req.method === "POST") {
      const mes = mAccion[1];
      let tareas = [];
      if (mAccion[2] === "programar") {
        tareas = preventivo.programarMes(mes, cache ? cache.records : [], cache ? cache.machines : []);
        if (!tareas.length) {
          throw new preventivo.PreventivoError(
            `Sin datos de paros de ${preventivo.nombreMes(preventivo.mesAnterior(mes))}; el mes queda sin programacion.`,
            409
          );
        }
      }
      await preventivo.reemplazarAgenda(mes, tareas, { user });
      log(`[prev] ${mAccion[2] === "programar" ? "Programacion regenerada" : "Agenda limpiada"}: ${mes} (${tareas.length} tareas)`);
      sendJson(res, 200, { ok: true, tareas: tareas.length });
      return true;
    }
    const mMes = url.match(/^\/api\/preventivo\/(\d{4}-\d{2})$/);
    if (mMes && req.method === "DELETE") {
      await preventivo.eliminarMes(mMes[1], { user, dataDir: DATA_DIR });
      log(`[prev] Mes eliminado: ${mMes[1]}`);
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (err) {
    if (err instanceof preventivo.PreventivoError) {
      sendJson(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
  return false;
}

async function handleApp(req, res, url, user) {
  if (url.startsWith("/api/preventivo") && (await handlePreventivo(req, res, url, user))) return;
  if (url.startsWith("/api/admin/") && (await handleOperadoresAdmin(req, res, url, user))) return;
  if (url === "/api/data") {
    if (!cache) await refresh();
    if (!cache) return sendJson(res, 502, { error: "Aun no hay datos disponibles" });
    return sendJson(res, 200, {
      updatedAt: cache.updatedAt,
      area: cache.area,
      source: cache.source,
      lastError,
      fuentes,
      count: cache.records.length,
      records: cache.records,
      machines: cache.machines || [],
      technicians: await rosterTecnicos(),
      performance: config.performance || null,
      bonos: config.bonos || null,
      calendarios: config.calendarios || null,
    });
  }
  if (url === "/api/refresh") {
    await refresh();
    if (!cache) return sendJson(res, 502, { error: "No se pudo actualizar" });
    return sendJson(res, 200, {
      updatedAt: cache.updatedAt,
      source: cache.source,
      lastError,
      count: cache.records.length,
    });
  }
  const handled = await handleApi(req, res, url, user);
  if (!handled) sendJson(res, 404, { error: "No encontrado" });
}

async function handleHealth(res) {
  let dbOk = true;
  try {
    await db.query("SELECT 1");
  } catch {
    dbOk = false;
  }
  return sendJson(res, dbOk ? 200 : 503, {
    ok: dbOk,
    db: dbOk,
    updatedAt: lastUpdate ? lastUpdate.toISOString() : null,
    lastError,
    fuentes,
    mes: koideGeneral.configurado(),
    nextUpdate: nextRunDate().toISOString(),
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/api/health") return await handleHealth(res);
    if (url.startsWith("/api/terminal/")) return await handleTerminal(req, res);

    const isApi = url.startsWith("/api/");
    const file = isApi ? null : staticPath(req);
    if (!isApi && file !== null && PUBLIC_FILES.has(file)) return serveStatic(req, res, file);
    if (!isApi && file !== null && file.startsWith("/assets/")) return serveStatic(req, res, file);

    const user = await auth.sessionUser(auth.tokenFromReq(req));
    if (url.startsWith("/api/auth/")) {
      if (await handleAuth(req, res, url, user)) return;
      return sendJson(res, 404, { error: "No encontrado" });
    }
    if (!user) {
      if (isApi) return sendJson(res, 401, { error: "Sesion no iniciada o expirada" });
      return redirect(res, "/login");
    }

    // AUTORIZACION POR ROL (en el backend; la interfaz solo refleja):
    //   mantenimiento_admin  todo
    //   mantenimiento_op     solo /api/operador/* (atencion de paros)
    //   tecnico_consulta     SOLO LECTURA: /api/data, /api/refresh, /api/historico/*
    //                        (desempeno, tiempo muerto, MTTR/MTBF, historico).
    //                        Ninguna escritura, ninguna accion de tecnico.
    if (isApi) {
      if (url.startsWith("/api/operador/")) {
        if (!auth.puede(user, "operador")) return sendJson(res, 403, { error: "Sin permiso" });
        return await handleOperador(req, res, url, user);
      }
      if (url.startsWith("/api/historico/")) {
        if (!auth.puede(user, "historico")) return sendJson(res, 403, { error: "Sin permiso" });
        if (await handleHistorico(req, res, url, user)) return;
        return sendJson(res, 404, { error: "No encontrado" });
      }
      if (user.rol === CONSULTA) {
        if (req.method === "GET" && (url === "/api/data" || url === "/api/refresh")) return await handleApp(req, res, url, user);
        return sendJson(res, 403, { error: "Sin permiso: tu usuario es de solo consulta" });
      }
      // Todo lo demas es el dashboard administrativo (funcionalidad existente).
      if (user.rol !== ADMIN) return sendJson(res, 403, { error: "Sin permiso" });
      return await handleApp(req, res, url, user);
    }

    if (file === null) return sendJson(res, 400, { error: "Ruta invalida" });
    if (SESSION_FILES.has(file)) return serveStatic(req, res, file);
    if (OP_FILES.has(file)) {
      if (!auth.puede(user, "operador")) return redirect(res, HOME[user.rol] || "/login");
      return serveStatic(req, res, file);
    }
    if (!auth.puede(user, "dashboard")) {
      if (file === "/index.html") return redirect(res, HOME[user.rol] || "/login");
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Sin permiso");
    }
    serveStatic(req, res, file);
  } catch (err) {
    if (db.isConnectionError(err)) {
      console.error("[http] Base de datos no disponible:", err.code || err.message);
      if (!res.headersSent) return sendJson(res, 503, { error: "Base de datos no disponible. Intente de nuevo en unos momentos." });
      return res.end();
    }
    console.error("[http] ERROR:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Error interno" });
    else res.end();
  }
});

const port = Number(env("PORT", config.serverPort || 4173));
const host = env("HOST", undefined); // sin HOST escucha en todas las interfaces (LAN)

async function start() {
  await db.waitForDb({ log });
  const conn = await db.getPool().getConnection();
  try {
    await db.applyMigrations(conn, { log });
  } finally {
    conn.release();
  }
  const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1");
  if (!Number(n)) log("[auth] AVISO: no hay usuarios activos. Cree uno con: node scripts/usuarios.js crear <usuario> mantenimiento_admin \"<nombre>\"");
  await loadCache();
  server.on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(`[inicio] El puerto ${port} ya esta en uso (probablemente otro "npm start" sigue corriendo).`);
    console.error(`[inicio] Detengalo con: npm run stop   (o use otro puerto: PORT=${port + 1} npm start)`);
    db.closePool().finally(() => process.exit(1));
  });
  server.listen(port, host, () => {
    log(`Metricos de Mantenimiento en http://${host || "localhost"}:${port}`);
    refresh().then(() => {
      if (lastError) log("[update] Reintente con /api/refresh");
    });
    scheduleDaily();
    if (koideGeneral.configurado() && REFRESH_MS > 0) {
      setInterval(() => refresh(), REFRESH_MS).unref();
      log(`[schedule] Resincronizacion con KOIDE MES cada ${Math.round(REFRESH_MS / 1000)} s`);
    }
    if ((!fuenteCm.esMes() || koideGeneral.configurado()) && CM_AUTO_MS > 0) {
      setInterval(programacionAutomaticaPeriodica, CM_AUTO_MS).unref();
      log(`[schedule] Programacion automatica de contramedidas cada ${Math.round(CM_AUTO_MS / 60000)} min`);
    }
  });
}

start().catch((err) => {
  console.error("[inicio] No se pudo conectar a MySQL:", err.message);
  process.exit(1);
});

function shutdown(signal) {
  log(`[inicio] ${signal} recibido, cerrando...`);
  server.close(() => db.closePool().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
