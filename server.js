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
const API = env("KOIDE_BASE_URL", config.koideBaseUrl || "").replace(/\/$/, "");
const area = config.responsibleArea || "Mantenimiento";

// Credenciales de koide: variables de entorno (.env); config.json solo como respaldo.
function koideLogin() {
  const fromConfig = config.koideLogin || {};
  return {
    department: env("KOIDE_DEPARTMENT", fromConfig.department || "Mantenimiento"),
    password: env("KOIDE_PASSWORD", fromConfig.password || ""),
  };
}

let token = null;
let cache = null;
let lastUpdate = null;
let lastError = null;
let updating = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(koideLogin()),
  });
  if (!res.ok) {
    throw new Error(`Login koide fallo (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("Login koide no devolvio token");
  token = data.token;
  log(`[auth] Sesion iniciada (${data.department} / ${data.role})`);
}

async function apiGet(url, retry = true) {
  const res = await fetch(`${API}${url}`, {
    headers: { "X-Auth-Token": token || "" },
  });
  if (res.status === 401 && retry) {
    await login();
    return apiGet(url, false);
  }
  if (!res.ok) throw new Error(`API koide (HTTP ${res.status}) en ${url}`);
  return res.json();
}

async function refresh() {
  if (updating) return cache;
  updating = true;
  try {
    if (!token) await login();
    const [records, machines] = await Promise.all([
      apiGet(
        `/api/downtime-records?responsibleArea=${encodeURIComponent(area)}`
      ),
      apiGet("/api/machines"),
    ]);
    const payload = {
      updatedAt: new Date().toISOString(),
      area,
      source: "live",
      records: Array.isArray(records) ? records : [],
      machines: Array.isArray(machines) ? machines : [],
    };
    await store.saveTiempoMuerto(payload);
    cache = payload;
    lastUpdate = new Date();
    lastError = null;
    log(
      `[update] Descargados ${payload.records.length} registros y ${payload.machines.length} maquinas`
    );
  } catch (err) {
    lastError = err.message || String(err);
    log("[update] ERROR:", lastError);
  } finally {
    updating = false;
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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
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
    // Sin cache para las paginas: tras cerrar sesion, "Atras" no muestra la aplicacion.
    if (ext === ".html") headers["Cache-Control"] = "no-store";
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* ---------- Login ---------- */

// Rutas accesibles sin sesion. Todo lo demas requiere login.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/health", "/assets/koide-logo-cropped.png"]);

function serveLogin(res) {
  fs.readFile(path.join(PUBLIC_DIR, "login.html"), (err, data) => {
    if (err) return sendJson(res, 500, { error: "Falta login.html" });
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    res.end(data);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

// Devuelve true si la peticion ya fue respondida (login/logout/sin sesion).
async function handleAuth(req, res, url) {
  if (url === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req, 10e3);
    const r = await auth.login(req, body.usuario, body.password);
    if (r.error) {
      log(`[auth] Login fallido para "${String(body.usuario || "").slice(0, 60)}" desde ${req.socket.remoteAddress} (${r.status})`);
      sendJson(res, r.status, { error: r.error });
      return true;
    }
    log(`[auth] Sesion iniciada: ${r.usuario.usuario} desde ${req.socket.remoteAddress}`);
    res.writeHead(200, { "Content-Type": MIME[".json"], "Set-Cookie": r.cookie, "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, usuario: r.usuario }));
    return true;
  }
  if (url === "/api/auth/logout" && req.method === "POST") {
    const cookie = await auth.logout(req);
    res.writeHead(200, { "Content-Type": MIME[".json"], "Set-Cookie": cookie, "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (url === "/login" || url === "/login.html") {
    if (await auth.sessionUser(req)) redirect(res, "/");
    else serveLogin(res);
    return true;
  }
  if (PUBLIC_PATHS.has(url)) return false;

  const user = await auth.sessionUser(req);
  if (!user) {
    if (url.startsWith("/api/")) sendJson(res, 401, { error: "Sesion no iniciada o expirada" });
    else redirect(res, "/login");
    return true;
  }
  if (url === "/api/auth/me") {
    sendJson(res, 200, { usuario: user.usuario, nombre: user.nombre, rol: user.rol });
    return true;
  }
  return false;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
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

async function handleApi(req, res, url) {
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
  if (url === "/api/contramedidas" && req.method === "POST") {
    const body = await readBody(req);
    const cm = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      tipo: body.tipo || "Falla común",
      maquina: String(body.maquina || ""),
      maquinaNombre: String(body.maquinaNombre || ""),
      fallaComun: String(body.fallaComun || ""),
      referencia: String(body.referencia || body.maquina || ""),
      categoria: String(body.categoria || ""),
      descripcion: String(body.descripcion || ""),
      responsable: String(body.responsable || ""),
      fechaLimite: body.fechaLimite || "",
      estado: body.estado || "Pendiente",
      creada: new Date().toISOString(),
    };
    await store.insertContramedida(cm);
    sendJson(res, 200, cm);
    return true;
  }
  const m = url.match(/^\/api\/contramedidas\/([^/]+)$/);
  if (m && req.method === "PUT") {
    const body = await readBody(req);
    const actual = await store.getContramedida(m[1]);
    if (!actual) {
      sendJson(res, 404, { error: "No encontrada" });
      return true;
    }
    const cm = await store.updateContramedida({ ...actual, ...body, id: m[1] });
    sendJson(res, 200, cm);
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

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (await handleAuth(req, res, url)) return;
    if (url === "/api/data") {
      if (!cache) await refresh();
      if (!cache) return sendJson(res, 502, { error: "Aun no hay datos disponibles" });
      return sendJson(res, 200, {
        updatedAt: cache.updatedAt,
        area: cache.area,
        source: cache.source,
        lastError,
        count: cache.records.length,
        records: cache.records,
        machines: cache.machines || [],
        technicians: config.maintenanceTechnicians || [],
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
    if (url === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        updatedAt: lastUpdate ? lastUpdate.toISOString() : null,
        lastError,
        nextUpdate: nextRunDate().toISOString(),
      });
    }
    const cmHandled = await handleApi(req, res, url);
    if (cmHandled) return;
    serveStatic(req, res);  } catch (err) {
    console.error("[http] ERROR:", err);
    sendJson(res, 500, { error: "Error interno" });
  }
});

const port = Number(env("PORT", config.serverPort || 4173));
const host = env("HOST", undefined); // sin HOST escucha en todas las interfaces (LAN)

async function start() {
  await db.waitForDb({ log });
  await loadCache();
  server.listen(port, host, () => {
    log(`Metricos de Mantenimiento en http://${host || "localhost"}:${port}`);
    refresh().then(() => {
      if (lastError) log("[update] Reintente con /api/refresh");
    });
    scheduleDaily();
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
