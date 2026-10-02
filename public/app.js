"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  records: [],
  machines: [],
  technicians: [],
  updatedAt: null,
  source: null,
  desde: "",
  hasta: "",
  categoria: "",
  tipo: "",
  unidad: "horas",
  mes: "",
  cm: [],
  cmEditId: null,
  bonosCfg: null,
  bonos: { template: null, weeks: {} },
  calCfg: null,
  calendarios: { list: [], activeId: null },
  documentos: { list: [] },
  cmCompleting: null,
  cmCalMonth: new Date().getMonth(),
  cmCalYear: new Date().getFullYear(),
  gastos: null,
  gastosTab: 0,
  dolarRate: 17,
  entregas: null,
  entregasTab: -1,
  // Rol y capacidades del usuario con sesion (las aplica el servidor; aqui
  // solo se ocultan vistas y acciones que el backend rechazaria).
  capacidades: null,
  // Contramedidas por acumulacion (KOIDE MES) y la recomendacion en captura.
  recomendaciones: [],
  cmRecomendacion: null,
  // Programacion automatica: propuestas y Configuracion del sistema.
  cmPendientes: [],
  cmPropActual: null,
  cfg: { parametros: [] },
  // Historico de paros (KOIDE MES).
  hist: { filas: [], total: 0, offset: 0, limite: 100, catalogos: null },
};

const TIPOS_MAQUINA = {
  CNC: "CNC's",
  B: "Biselado",
  C: "Cortadoras",
  P: "Prensas",
};

const techRoster = new Map();

function buildTechRoster() {
  techRoster.clear();
  techRolActual.clear();
  for (const t of state.technicians || []) {
    const n = String(t.employee_number || "").trim();
    if (n) techRoster.set(n, String(t.name || "").trim());
    if (n && t.role) techRolActual.set(n, t.role);
  }
}

/* ---- Config del control de desempeño (config.json -> performance) ---- */

const PERF = {
  shiftHours: 8,
  pesos: { respuesta: 0.25, reparacion: 0.3, productividad: 0.25, cumplimiento: 0.2 },
  reincidenciaDias: [7, 15, 30],
  clasificacion: [
    { min: 90, label: "Excelente", cls: "ok" },
    { min: 85, label: "Muy bueno", cls: "ok" },
    { min: 80, label: "Bueno", cls: "ok" },
    { min: 70, label: "Requiere seguimiento", cls: "warn" },
    { min: 0, label: "Requiere acción", cls: "open" },
  ],
  bandasRespuesta: [
    { max: 15, score: 100 },
    { max: 30, score: 80 },
    { max: 60, score: 60 },
    { max: Infinity, score: 40 },
  ],
  categorias: [
    { tipo: "Ajuste", match: "ajuste", minutos: 30, puntos: 1 },
    { tipo: "Sensor", match: "sensor", minutos: 45, puntos: 2 },
    { tipo: "Eléctrico", match: "electr", minutos: 60, puntos: 2 },
    { tipo: "Neumático", match: "neumatic", minutos: 60, puntos: 2 },
    { tipo: "Hidráulico", match: "hidraulic", minutos: 120, puntos: 3 },
    { tipo: "Cambio de componente", match: "cambio|componente", minutos: 120, puntos: 3 },
    { tipo: "Mecánico", match: "mecan", minutos: 90, puntos: 2 },
  ],
};

function applyPerfConfig(p) {
  if (!p) return;
  if (p.shiftHours) PERF.shiftHours = Number(p.shiftHours) || 8;
  if (p.weights) {
    const w = p.weights;
    PERF.pesos.respuesta = w.respuesta != null ? Number(w.respuesta) : 0.25;
    PERF.pesos.reparacion = w.reparacion != null ? Number(w.reparacion) : 0.3;
    PERF.pesos.productividad = w.productividad != null ? Number(w.productividad) : 0.25;
    PERF.pesos.cumplimiento = w.cumplimiento != null ? Number(w.cumplimiento) : 0.2;
  }
  if (Array.isArray(p.reincidenciaDias)) PERF.reincidenciaDias = p.reincidenciaDias.map(Number);
  if (Array.isArray(p.clasificacion)) {
    PERF.clasificacion = p.clasificacion.map((c) => ({
      min: Number(c.min) || 0,
      label: String(c.label || "Sin datos"),
      cls: ["ok", "warn", "open", "info"].includes(c.cls) ? c.cls : "info",
    }));
  }
  if (Array.isArray(p.responseBands)) {
    PERF.bandasRespuesta = p.responseBands.map((b) => ({
      max: b.max != null ? Number(b.max) : Infinity,
      score: Number(b.score) || 40,
    }));
  }
  if (Array.isArray(p.standardTimes)) {
    PERF.categorias = p.standardTimes.map((c) => ({
      tipo: String(c.tipo || "Otro"),
      match: String(c.match || ""),
      minutos: Number(c.minutos) || 90,
      puntos: Number(c.puntos) || 2,
    }));
  }
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function medianOf(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function categoriaInfo(categoria) {
  const n = norm(categoria);
  for (const c of PERF.categorias) {
    if (c.match && new RegExp(c.match).test(n)) return c;
  }
  return { tipo: "Otro", match: "", minutos: 90, puntos: 2 };
}

function scoreRespuesta(min) {
  for (const b of PERF.bandasRespuesta) if (min <= b.max) return b.score;
  return 40;
}

function clasifica(idx) {
  if (idx == null) return { label: "Sin datos", cls: "info" };
  for (const c of PERF.clasificacion) {
    if (idx >= c.min) return { label: c.label, cls: c.cls };
  }
  return { label: "Requiere acción", cls: "open" };
}

function scoreCls(s) {
  if (s == null) return "info";
  if (s >= 80) return "ok";
  if (s >= 70) return "warn";
  return "open";
}

function indicePonderado(t) {
  const dims = [
    ["respuesta", t.scoreRespuesta],
    ["reparacion", t.scoreReparacion],
    ["productividad", t.scoreProductividad],
    ["cumplimiento", t.scoreCumplimiento],
  ];
  let pesoTotal = 0;
  let suma = 0;
  for (const [k, v] of dims) {
    if (v == null) continue;
    const p = PERF.pesos[k] || 0;
    pesoTotal += p;
    suma += v * p;
  }
  return pesoTotal ? suma / pesoTotal : null;
}

function techNombre(num) {
  return techRoster.get(String(num)) || "";
}

// Rol de sistema del personal (mig 088 del MES): el HISTORICO sale del
// rol_snapshot de cada participacion; el roster aporta el rol actual.
const ROL_SISTEMA_TXT = { mantenimiento_admin: "Administrador", mantenimiento_op: "Operador" };
const techRolActual = new Map();
function rolTxt(rol) {
  return ROL_SISTEMA_TXT[rol] || "";
}

const ESTADO_CM = { "Pendiente": "warn", "En proceso": "info", "Completado": "ok" };
const TIPO_CM_CLS = { "MTTR": "mttr", "MTBF": "mtbf", "Falla mecánica": "falla", "Falla eléctrica": "falla", "Falla común": "falla", "Preventivo": "mtbf", "Correctivo": "mttr" };

function tipoDeMaquina(code) {
  const s = String(code || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("CNC")) return "CNC's";
  if (s.startsWith("B")) return "Biselado";
  if (s.startsWith("C")) return "Cortadoras";
  if (s.startsWith("P")) return "Prensas";
  return "";
}

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

let chartMaquinas = null;
let chartDias = null;
let chartMttr = null;
let chartMtbf = null;
const chartTipos = {
  biselado: null,
  cortadoras: null,
  prensas: null,
  cnc: null,
};
const chartTiposMttr = {
  biselado: null,
  cortadoras: null,
  prensas: null,
  cnc: null,
};
const chartTiposMtbf = {
  biselado: null,
  cortadoras: null,
  prensas: null,
  cnc: null,
};
const techCharts = {
  indice: null,
  respuesta: null,
  reparacion: null,
  radar: null,
};

let lastTecList = [];
let lastTecGlobals = {};
let reincIndex = null;

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function today() {
  return isoDate(new Date());
}

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  return dt.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtHours(min) {
  if (min == null || isNaN(min)) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function fmtHorasH(valor) {
  if (valor == null || isNaN(valor)) return "—";
  return `${valor.toFixed(2)} h`;
}

function fmtNum(n) {
  return n.toLocaleString("es-MX");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- Carga de datos ---------------- */

async function loadData(quiet = false) {
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.records = data.records || [];
    liveFirma = firmaRegistros(state.records);
    state.machines = data.machines || [];
    state.technicians = data.technicians || [];
    state.performance = data.performance || null;
    state.bonosCfg = data.bonos || null;
    state.calCfg = data.calendarios || null;
    applyPerfConfig(state.performance);
    buildTechRoster();
    state.updatedAt = data.updatedAt;
    state.source = data.source;
    renderHeader();
    populateCategories();
    populateTipos();
    populateMonths();
    renderAll();
  } catch (err) {
    if (!quiet) {
      setHeaderStatus("Error al cargar datos", true);
      console.error(err);
    }
  }
}

async function refreshData() {
  const btn = $("btn-refresh");
  btn.disabled = true;
  $("btn-refresh").querySelector(".btn-spinner").hidden = false;
  setHeaderStatus("Actualizando…");
  try {
    const res = await fetch("/api/refresh");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadData(true);
    setHeaderStatus("Datos actualizados");
  } catch (err) {
    setHeaderStatus("No se pudo actualizar (revise el servidor Koide)", true);
    console.error(err);
  } finally {
    btn.disabled = false;
    $("btn-refresh").querySelector(".btn-spinner").hidden = true;
    setTimeout(() => {
      if (state.updatedAt) setHeaderStatus("Actualizado");
    }, 4000);
  }
}

function setHeaderStatus(msg, error = false) {
  const el = $("last-update");
  el.textContent = msg;
  el.style.background = error ? "rgba(220,38,38,0.85)" : "rgba(255,255,255,0.12)";
}

function renderHeader() {
  if (!state.updatedAt) {
    setHeaderStatus("Sin datos");
    $("source-info").textContent = "—";
    return;
  }
  setHeaderStatus("Actualizado " + fmtDateTime(state.updatedAt));
  $("source-info").textContent =
    state.source === "live" ? "datos en vivo" : "desde caché local";
}

/* ---------------- Filtros ---------------- */

function applyFilters() {
  const desde = state.desde;
  const hasta = state.hasta;
  const categoria = state.categoria;
  const tipo = state.tipo;
  return state.records.filter((r) => {
    const d = String(r.record_date || "").slice(0, 10);
    if (desde && d < desde) return false;
    if (hasta && d > hasta) return false;
    if (categoria && String(r.downtime_category || "") !== categoria) return false;
    if (tipo && tipoDeMaquina(r.machine_code) !== tipo) return false;
    return true;
  });
}

function populateCategories() {
  const sel = $("filtro-categoria");
  const current = sel.value;
  const set = new Set();
  for (const r of state.records) {
    const c = String(r.downtime_category || "").trim();
    if (c) set.add(c);
  }
  const list = [...set].sort((a, b) => a.localeCompare(b, "es"));
  sel.innerHTML = '<option value="">Todas</option>';
  for (const c of list) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
  sel.value = list.includes(current) ? current : "";
}

function populateTipos() {
  const sel = $("filtro-tipo");
  const current = sel.value;
  const set = new Set();
  for (const r of state.records) {
    const t = tipoDeMaquina(r.machine_code);
    if (t) set.add(t);
  }
  const list = [...set].sort((a, b) => a.localeCompare(b, "es"));
  sel.innerHTML = '<option value="">Todas</option>';
  for (const t of list) {
    const letter = Object.keys(TIPOS_MAQUINA).find((k) => TIPOS_MAQUINA[k] === t);
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = `${t} (${letter})`;
    sel.appendChild(opt);
  }
  sel.value = list.includes(current) ? current : "";
}

function populateMaquinaSelect() {
  const sel = $("cm-maquina");
  const current = sel.value;
  const machines = (state.machines || []).slice().sort((a, b) =>
    String(a.code || "").localeCompare(String(b.code || ""), "es", { numeric: true })
  );
  sel.innerHTML = '<option value="">— Seleccionar equipo —</option>';
  for (const m of machines) {
    const o = document.createElement("option");
    o.value = m.code;
    o.textContent = `${m.code} — ${m.name || ""}`;
    sel.appendChild(o);
  }
  sel.value = current || "";
}

function populateResponsables() {
  const sel = $("cm-responsable");
  const current = sel.value;
  const techs = (state.technicians || []).slice().sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "es")
  );
  sel.innerHTML = '<option value="">— Seleccionar técnico —</option>';
  for (const t of techs) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = t.name;
    sel.appendChild(o);
  }
  sel.value = current || "";
}

function fallasPorMaquina(machineCode, rows) {
  if (!rows) rows = applyFilters();
  const machineId = (state.machines || []).find((m) => m.code === machineCode);
  const mid = machineId ? machineId.id : null;
  if (!mid) return { total: 0, cats: [], recurrente: null, fallas: [] };

  const recs = rows.filter((r) => String(r.machine_id) === String(mid));
  const total = recs.length;

  const catMap = new Map();
  for (const r of recs) {
    const c = String(r.downtime_category || "").trim() || "Sin categoría";
    if (!catMap.has(c)) catMap.set(c, { categoria: c, paros: 0, minutos: 0 });
    const e = catMap.get(c);
    e.paros += 1;
    if (r.downtime_minutes != null && !isNaN(r.downtime_minutes)) e.minutos += r.downtime_minutes;
  }
  const cats = [...catMap.values()]
    .map((e) => ({ ...e, pct: total > 0 ? (e.paros / total) * 100 : 0 }))
    .sort((a, b) => b.paros - a.paros);

  const recurrente = fallaRecurrente(mid, rows);

  const fallas = fallasDeMaquina(mid, rows);

  return { total, cats, recurrente, fallas };
}

function comunFallaPorMaquina(rows) {
  const map = new Map();
  for (const r of rows) {
    const c = r.machine_code != null ? String(r.machine_code).trim() : "";
    if (!c) continue;
    const cat = String(r.downtime_category || "").trim() || "Sin categoría";
    if (!map.has(c)) map.set(c, new Map());
    const cm = map.get(c);
    cm.set(cat, (cm.get(cat) || 0) + 1);
  }
  const out = new Map();
  for (const [code, catMap] of map) {
    let best = null;
    let n = 0;
    for (const [cat, count] of catMap) {
      if (count > n) {
        n = count;
        best = cat;
      }
    }
    out.set(code, { categoria: best, paros: n });
  }
  return out;
}

function onMaquinaChange() {
  const code = $("cm-maquina").value;
  const box = $("cm-falla-box");
  if (!code) {
    box.hidden = true;
    return;
  }
  const maq = (state.machines || []).find((m) => m.code === code);
  $("cm-falla-maq").textContent = `${code} — ${maq ? maq.name : ""}`;
  const { total, cats, recurrente, fallas } = fallasPorMaquina(code);
  const catsEl = $("cm-falla-cats");
  catsEl.innerHTML = "";

  if (total === 0) {
    catsEl.innerHTML = `<span class="falla-hint-item">Sin registros de tiempo muerto para ${escapeHtml(code)}</span>`;
    box.hidden = false;
    return;
  }

  if (recurrente) {
    const meta = [];
    meta.push(`${recurrente.n} ${recurrente.n === 1 ? "vez" : "veces"}`);
    if (recurrente.minutos) meta.push(fmtHours(recurrente.minutos));
    if (recurrente.categoria) meta.push(escapeHtml(recurrente.categoria));
    catsEl.innerHTML += `<div class="falla-recurrente"><strong>Falla más recurrente:</strong> ${escapeHtml(recurrente.desc)} <span class="falla-rec-meta">${meta.join(" · ")}</span></div>`;
  }

  if (cats.length > 0) {
    let catHtml = `<div class="falla-cats-title">Por categoría (${total} registros):</div>`;
    for (const c of cats.slice(0, 5)) {
      catHtml += `<span class="falla-hint-item">${escapeHtml(c.categoria)} <strong>${c.paros}×</strong> (${fmtHours(c.minutos)})</span>`;
    }
    catsEl.innerHTML += catHtml;
  }

  box.hidden = false;
}

/* ---------------- Agregados ---------------- */

function aggregateByMachine(records) {
  const map = new Map();
  for (const r of records) {
    const key = String(r.machine_id);
    if (!map.has(key)) {
      map.set(key, {
        machine_id: r.machine_id,
        code: r.machine_code || "?",
        name: r.machine_name || "—",
        process: r.machine_process || "—",
        paros: 0,
        minutos: 0,
        cerrados: 0,
        reparacionMin: 0,
        conReparacion: 0,
        respuestaMin: 0,
        respuestas: 0,
      });
    }
    const m = map.get(key);
    m.paros += 1;
    if (r.downtime_minutes != null && !isNaN(r.downtime_minutes)) {
      m.minutos += Number(r.downtime_minutes);
      m.cerrados += 1;
    }
    if (r.repair_time_minutes != null && !isNaN(r.repair_time_minutes)) {
      m.reparacionMin += Number(r.repair_time_minutes);
      m.conReparacion += 1;
    }
    if (r.response_time_minutes != null && !isNaN(r.response_time_minutes)) {
      m.respuestaMin += Number(r.response_time_minutes);
      m.respuestas += 1;
    }
  }
  return [...map.values()].sort(
    (a, b) => b.reparacionMin - a.reparacionMin || b.minutos - a.minutos || b.paros - a.paros
  );
}

function sortByCode(list) {
  return [...list].sort((a, b) =>
    String(a.code).localeCompare(String(b.code), "en", { numeric: true })
  );
}

function mergeCatalogAll(byMachine) {
  const byCode = new Map(byMachine.map((m) => [String(m.code).trim().toUpperCase(), m]));
  const seen = new Set();
  const merged = [];
  for (const c of state.machines || []) {
    const code = String(c.code || "").trim().toUpperCase();
    if (!code) continue;
    seen.add(code);
    const agg = byCode.get(code);
    merged.push(
      agg || {
        machine_id: c.id,
        code: c.code,
        name: c.name || "—",
        process: c.process || "—",
        paros: 0,
        minutos: 0,
        cerrados: 0,
        reparacionMin: 0,
        conReparacion: 0,
        respuestaMin: 0,
        respuestas: 0,
      }
    );
  }
  for (const m of byMachine) {
    const code = String(m.code).trim().toUpperCase();
    if (!seen.has(code)) merged.push(m);
  }
  return sortByCode(merged);
}

function mergeCatalog(byMachine, tipo) {
  return mergeCatalogAll(byMachine).filter((m) => tipoDeMaquina(m.code) === tipo);
}

function mergeByCode(list) {
  const map = new Map(list.map((m) => [String(m.code).trim().toUpperCase(), m]));
  const seen = new Set();
  const out = [];
  for (const c of state.machines || []) {
    const code = String(c.code || "").trim().toUpperCase();
    if (!code) continue;
    seen.add(code);
    const s = map.get(code);
    out.push(
      s || {
        machine_id: c.id,
        code: c.code,
        name: c.name || "—",
        process: c.process || "—",
        tipo: tipoDeMaquina(c.code),
        fallas: 0,
        reparaciones: 0,
        tiempoReparacion: 0,
        mttrH: null,
        mtbfH: null,
      }
    );
  }
  for (const m of list) {
    if (!seen.has(String(m.code).trim().toUpperCase())) out.push(m);
  }
  return sortByCode(out);
}

function aggregateByDay(records) {
  const map = new Map();
  for (const r of records) {
    const d = String(r.record_date || "").slice(0, 10);
    if (!map.has(d)) map.set(d, { paros: 0, minutos: 0 });
    const e = map.get(d);
    e.paros += 1;
    if (r.repair_time_minutes != null && !isNaN(r.repair_time_minutes)) {
      e.minutos += Number(r.repair_time_minutes);
    }
  }
  return [...map.entries()]
    .map(([fecha, v]) => ({ fecha, ...v }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

function horasOperacionRows(records) {
  const meses = new Set();
  for (const r of records) {
    const d = String(r.record_date || "").slice(0, 7);
    if (d.length === 7) meses.add(d);
  }
  let total = 0;
  for (const ym of meses) {
    const [y, m] = ym.split("-").map(Number);
    const diasMes = new Date(y, m, 0).getDate();
    let domingos = 0;
    for (let d = 1; d <= diasMes; d++) {
      if (new Date(y, m - 1, d).getDay() === 0) domingos++;
    }
    total += 22 * (diasMes - domingos);
  }
  return total;
}

function computeMTTRMTBF(records) {
  const horasOperacion = horasOperacionRows(records);

  const map = new Map();
  for (const r of records) {
    const key = String(r.machine_id);
    if (!map.has(key)) {
      map.set(key, {
        machine_id: r.machine_id,
        code: r.machine_code || "?",
        name: r.machine_name || "—",
        tipo: tipoDeMaquina(r.machine_code),
        fallas: 0,
        reparaciones: 0,
        tiempoReparacion: 0,
      });
    }
    const m = map.get(key);
    m.fallas += 1;
    if (r.repair_time_minutes != null && !isNaN(r.repair_time_minutes)) {
      m.reparaciones += 1;
      m.tiempoReparacion += Number(r.repair_time_minutes);
    }
  }

  let totalFallas = 0;
  let totalReparaciones = 0;
  let totalTiempoReparacion = 0;
  for (const m of map.values()) {
    m.mttrH = m.fallas ? m.tiempoReparacion / 60 / m.fallas : null;
    m.mtbfH = m.fallas ? horasOperacion / m.fallas : null;
    totalFallas += m.fallas;
    totalReparaciones += m.reparaciones;
    totalTiempoReparacion += m.tiempoReparacion;
  }

  const list = [...map.values()];
  const mttrGlobal = totalFallas ? totalTiempoReparacion / 60 / totalFallas : null;
  const mtbfGlobal = totalFallas ? horasOperacion / totalFallas : null;

  const tipos = [];
  for (const tipo of Object.values(TIPOS_MAQUINA)) {
    const machines = list.filter((m) => m.tipo === tipo);
    if (machines.length === 0) continue;
    const fallas = machines.reduce((s, m) => s + m.fallas, 0);
    const tiempo = machines.reduce((s, m) => s + m.tiempoReparacion, 0);
    const mttrH = fallas ? tiempo / 60 / fallas : null;
    const mtbfH = fallas ? horasOperacion / fallas : null;
    tipos.push({ tipo, fallas, reparaciones: fallas, mttrH, mtbfH });
  }

  return {
    list: list.sort((a, b) => (b.mttrH ?? -1) - (a.mttrH ?? -1) || (a.mtbfH ?? 1e9) - (b.mtbfH ?? 1e9)),
    fallas: totalFallas,
    reparaciones: totalReparaciones,
    tiempoReparacionTotal: totalTiempoReparacion,
    horasOperacion,
    mttrGlobal,
    mtbfGlobal,
    tipos,
  };
}

function fallasComunes(records) {
  const map = new Map();
  for (const r of records) {
    const c = String(r.downtime_category || "").trim() || "Sin categoría";
    if (!map.has(c)) map.set(c, { categoria: c, paros: 0, minutos: 0 });
    const e = map.get(c);
    e.paros += 1;
    if (r.downtime_minutes != null && !isNaN(r.downtime_minutes)) e.minutos += r.downtime_minutes;
  }
  const total = [...map.values()].reduce((s, e) => s + e.paros, 0) || 1;
  return [...map.values()]
    .map((e) => ({ ...e, pct: (e.paros / total) * 100 }))
    .sort((a, b) => b.paros - a.paros)
    .slice(0, 10);
}

/* ---------------- Pestañas por mes ---------------- */

function mesesDisponibles() {
  const set = new Set();
  for (const r of state.records) {
    const d = String(r.record_date || "").slice(0, 7);
    if (d.length === 7) set.add(d);
  }
  return [...set].sort().reverse();
}

function labelMes(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function populateMonths() {
  const box = $("month-tabs");
  const current = state.mes;
  box.innerHTML = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "month-tab" + (current === "" ? " active" : "");
  all.textContent = "Todo";
  all.addEventListener("click", () => selectMes(""));
  box.appendChild(all);

  for (const ym of mesesDisponibles()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "month-tab" + (current === ym ? " active" : "");
    btn.textContent = labelMes(ym);
    btn.addEventListener("click", () => selectMes(ym));
    box.appendChild(btn);
  }
}

function selectMes(ym) {
  state.mes = ym;
  state.rango = "";
  if (ym) {
    const [y, m] = ym.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    state.desde = `${ym}-01`;
    state.hasta = `${ym}-${String(lastDay).padStart(2, "0")}`;
    $("fecha-desde").value = state.desde;
    $("fecha-hasta").value = state.hasta;
  } else {
    state.desde = "";
    state.hasta = "";
    $("fecha-desde").value = "";
    $("fecha-hasta").value = "";
  }
  markActiveRange();
  populateMonths();
  renderAll();
}

/* ---------------- Top 3 ---------------- */

function fallaRecurrente(machineId, rows) {
  const recs = rows.filter((r) => String(r.machine_id) === String(machineId));
  const count = new Map();
  for (const r of recs) {
    const desc = String(r.problem_description || "").trim() || "Sin descripción";
    if (!count.has(desc)) {
      count.set(desc, { desc, n: 0, minutos: 0, categoria: r.downtime_category || "" });
    }
    const e = count.get(desc);
    e.n += 1;
    if (r.downtime_minutes != null && !isNaN(r.downtime_minutes)) e.minutos += r.downtime_minutes;
  }
  let best = null;
  for (const e of count.values()) {
    if (!best || e.n > best.n || (e.n === best.n && e.minutos > best.minutos)) best = e;
  }
  return best;
}

function fallasDeMaquina(machineId, rows) {
  return rows
    .filter((r) => String(r.machine_id) === String(machineId))
    .sort((a, b) => {
      const ma = a.downtime_minutes != null ? a.downtime_minutes : -1;
      const mb = b.downtime_minutes != null ? b.downtime_minutes : -1;
      return mb - ma || String(b.record_date).localeCompare(String(a.record_date));
    });
}

function renderTop3(rows, byMachine) {
  const top = byMachine.slice(0, 3);
  const grid = $("top3-grid");
  grid.innerHTML = "";
  $("top3-periodo").textContent = `Periodo: ${state.desde || "inicio"} a ${state.hasta || "hoy"}`;

  if (top.length === 0) {
    grid.innerHTML = '<p class="panel-hint">Sin datos en el periodo seleccionado.</p>';
    return;
  }

  for (let i = 0; i < top.length; i++) {
    const m = top[i];
    const falla = fallaRecurrente(m.machine_id, rows);
    const fallas = fallasDeMaquina(m.machine_id, rows);

    let fallaHtml = '<div class="falla-box"><span class="fb-label">Falla más recurrente</span><p class="fb-desc">—</p></div>';
    if (falla) {
      const meta = [];
      meta.push(`${falla.n} ${falla.n === 1 ? "vez" : "veces"}`);
      if (falla.minutos) meta.push(fmtHours(falla.minutos));
      if (falla.categoria) meta.push(escapeHtml(falla.categoria));
      fallaHtml = `
        <div class="falla-box">
          <span class="fb-label">Falla más recurrente</span>
          <p class="fb-desc">${escapeHtml(falla.desc)}</p>
          <span class="fb-meta">${meta.join(" · ")}</span>
        </div>`;
    }

    let dropHtml = "";
    if (fallas.length) {
      const items = fallas
        .map(
          (f) => `
          <li class="fb-item">
            <span class="fb-item-desc">${escapeHtml(f.problem_description || "Sin descripción")}</span>
            <span class="fb-item-meta">${[
              f.downtime_category,
              f.downtime_minutes != null ? fmtHours(f.downtime_minutes) : null,
              f.record_date ? fmtDate(f.record_date) : null,
              f.status,
            ]
              .filter(Boolean)
              .join(" · ")}</span>
          </li>`
        )
        .join("");
      dropHtml = `
        <details class="fb-drop">
          <summary>Lista de fallas del equipo (${fallas.length})</summary>
          <ul class="fb-list">${items}</ul>
        </details>`;
    }

    const card = document.createElement("div");
    card.className = "top3-card";
    card.innerHTML = `
      <span class="rank r${i + 1}">${i + 1}</span>
      <div class="top3-machine"><strong>${escapeHtml(m.code)}</strong> · ${escapeHtml(m.name)}</div>
      <div class="top3-meta">
        <span>Tipo: <b>${tipoDeMaquina(m.code) || "—"}</b></span>
        <span>Paros: <b>${fmtNum(m.paros)}</b></span>
        <span>Reparación: <b>${fmtHours(m.reparacionMin || 0)}</b></span>
      </div>
      ${fallaHtml}
      ${dropHtml}`;
    grid.appendChild(card);
  }
}

/* ---------------- Render ---------------- */

function renderAll() {
  renderAbiertos();
  const rows = applyFilters();
  const byMachine = aggregateByMachine(rows);

  renderTop3(rows, byMachine);
  renderKpis(rows, byMachine);
  renderChartMaquinas(byMachine);
  renderTiposResumen(byMachine);
  if (!$("view-tiempo").hidden) renderChartsTipos(byMachine);
  renderChartDias(aggregateByDay(rows));
  renderTablaResumen(byMachine, rows);
  renderTablaDetalle(rows);
  renderActiveFilters();

  renderMTTRView(rows, !$("view-mttr").hidden);
  renderTecnicos(rows, !$("view-tecnicos").hidden);
  renderFallasComunes(rows);
  populateMaquinaSelect();
  populateResponsables();
}

function renderActiveFilters() {
  const box = $("active-filters");
  box.innerHTML = "";
  const chips = [];

  if (state.categoria) {
    chips.push({
      tag: "Categoría",
      label: state.categoria,
      clear: () => {
        state.categoria = "";
        $("filtro-categoria").value = "";
        renderAll();
      },
    });
  }

  if (state.tipo) {
    chips.push({
      tag: "Tipo de máquina",
      label: `${state.tipo} (${Object.keys(TIPOS_MAQUINA).find((k) => TIPOS_MAQUINA[k] === state.tipo)})`,
      clear: () => {
        state.tipo = "";
        $("filtro-tipo").value = "";
        renderAll();
      },
    });
  }

  box.hidden = chips.length === 0;
  for (const c of chips) {
    const chip = document.createElement("span");
    chip.className = "active-filter-chip";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.title = "Quitar filtro";
    btn.addEventListener("click", c.clear);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = c.tag;
    chip.appendChild(tag);
    chip.appendChild(document.createTextNode(c.label));
    chip.appendChild(btn);
    box.appendChild(chip);
  }
}

function renderKpis(rows, byMachine) {
  const total = byMachine.reduce((s, m) => s + m.minutos, 0);
  const totalRep = byMachine.reduce((s, m) => s + (m.reparacionMin || 0), 0);
  const conRep = byMachine.reduce((s, m) => s + (m.conReparacion || 0), 0);
  const paros = rows.length;
  const prom = conRep ? totalRep / conRep : 0;
  let respTotal = 0;
  let respCount = 0;
  for (const r of rows) {
    if (r.response_time_minutes != null && !isNaN(r.response_time_minutes)) {
      respTotal += Number(r.response_time_minutes);
      respCount += 1;
    }
  }
  const respProm = respCount ? respTotal / respCount : 0;
  const top = byMachine[0];

  $("kpi-total").textContent = total ? fmtHours(total) : "0 min";
  $("kpi-total-sub").textContent = `${fmtNum(total)} minutos en el periodo`;
  $("kpi-reparacion").textContent = totalRep ? fmtHours(totalRep) : "0 min";
  $("kpi-reparacion-sub").textContent = `${fmtNum(totalRep)} minutos en el periodo`;
  $("kpi-paros").textContent = fmtNum(paros);
  $("kpi-promedio").textContent = prom ? Math.round(prom).toLocaleString("es-MX") : "—";
  $("kpi-respuesta-total").textContent = respTotal ? fmtHours(respTotal) : "0 min";
  $("kpi-respuesta-total-sub").textContent = `${fmtNum(respTotal)} minutos en el periodo`;
  $("kpi-respuesta-prom").textContent = respProm ? Math.round(respProm).toLocaleString("es-MX") : "—";
  $("kpi-maquina").textContent = top ? `${top.code} · ${top.name}` : "—";
  $("kpi-maquina-sub").textContent = top ? `${fmtNum(top.reparacionMin || 0)} minutos` : "Sin registros";
}

function chartColors() {
  const c = document.createElement("canvas").getContext("2d");
  const g = c.createLinearGradient(0, 0, 0, 400);
  g.addColorStop(0, "#0891b2");
  g.addColorStop(1, "#0e7490");
  const o = c.createLinearGradient(0, 0, 0, 400);
  o.addColorStop(0, "#f59e0b");
  o.addColorStop(1, "#d97706");
  return { g, o, line: "#0e7490", fill: "rgba(14,116,144,0.15)" };
}

function renderChartMaquinas(byMachine) {
  const ctx = $("chart-maquinas").getContext("2d");
  const { g } = chartColors();
  const top = mergeCatalogAll(byMachine);
  const fallas = comunFallaPorMaquina(applyFilters());
  const labels = top.map((m) => (m.code ? `${m.code}` : m.name));
  let data;
  let yLabel;
  let fmtTooltip;
  if (state.unidad === "paros") {
    data = top.map((m) => m.paros);
    yLabel = "Número de paros";
    fmtTooltip = (v) => `${v} paros`;
  } else if (state.unidad === "minutos") {
    data = top.map((m) => m.reparacionMin || 0);
    yLabel = "Minutos de reparación";
    fmtTooltip = (v) => fmtHours(v);
  } else {
    data = top.map((m) => m.reparacionMin || 0);
    yLabel = "Horas de reparación";
    fmtTooltip = (v) => fmtHours(v);
  }

  if (chartMaquinas) chartMaquinas.destroy();
  chartMaquinas = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: yLabel,
          data,
          backgroundColor: top.map(() => g),
          borderRadius: 6,
          maxBarThickness: 52,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = top[items[0].dataIndex];
              return m ? `${m.code} · ${m.name}` : "";
            },
            label: (item) => {
              const m = top[item.dataIndex];
              const extra = state.unidad !== "paros" ? ` · ${m.paros} paros` : "";
              const lines = [fmtTooltip(item.parsed.y) + extra];
              const f = m ? fallas.get(String(m.code)) : null;
              if (f && f.categoria) lines.push(`Falla más común: ${f.categoria} (${f.paros}×)`);
              return lines;
            },
          },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { weight: "600" }, maxRotation: 45, minRotation: 0 },
        },
        y: {
          beginAtZero: true,
          grid: { color: "#f1f5f9" },
          title: { display: true, text: yLabel },
        },
      },
    },
  });

  $("chart-hint").textContent =
    byMachine.length === 0 && (state.machines || []).length === 0
      ? "No hay registros de tiempo muerto para el rango seleccionado."
      : "Todas las máquinas del catálogo, ordenadas por tiempo de reparación.";
}

function renderChartTipo(canvasId, chartRef, machines, colors) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const top = machines;
  const fallas = comunFallaPorMaquina(applyFilters());
  const labels = top.map((m) => m.code);
  const data = top.map((m) => m.reparacionMin || 0);

  if (chartRef) chartRef.destroy();
  return new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Minutos de reparación",
          data,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 46,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = top[items[0].dataIndex];
              return m ? `${m.code} · ${m.name}` : "";
            },
            label: (item) => {
              const m = top[item.dataIndex];
              const f = m ? fallas.get(String(m.code)) : null;
              const lines = [`${fmtHours(item.parsed.y)} (${item.parsed.y} min)`];
              if (f && f.categoria) lines.push(`Falla más común: ${f.categoria} (${f.paros}×)`);
              return lines;
            },
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: "600" }, maxRotation: 45 } },
        y: {
          beginAtZero: true,
          grid: { color: "#f1f5f9" },
          title: { display: true, text: "Minutos" },
        },
      },
    },
  });
}

function renderChartsTipos(byMachine) {
  const tipos = [
    { tipo: "Biselado", id: "chart-biselado", key: "biselado", color: "#0e7490" },
    { tipo: "Cortadoras", id: "chart-cortadoras", key: "cortadoras", color: "#0891b2" },
    { tipo: "Prensas", id: "chart-prensas", key: "prensas", color: "#f59e0b" },
    { tipo: "CNC's", id: "chart-cnc", key: "cnc", color: "#dc2626" },
  ];
  for (const t of tipos) {
    const machines = mergeCatalog(byMachine, t.tipo);
    if (machines.length === 0) continue;
    chartTipos[t.key] = renderChartTipo(t.id, chartTipos[t.key], machines, t.color);
  }
}

function renderTiposResumen(byMachine) {
  const orden = ["Biselado", "Cortadoras", "Prensas", "CNC's"];
  const colores = { Biselado: "#0e7490", Cortadoras: "#0891b2", Prensas: "#f59e0b", "CNC's": "#dc2626" };
  const map = new Map();
  for (const tipo of orden) map.set(tipo, { tipo, reparacionMin: 0, paros: 0 });
  for (const m of byMachine) {
    const t = tipoDeMaquina(m.code);
    if (!t || !map.has(t)) continue;
    const e = map.get(t);
    e.reparacionMin += m.reparacionMin || 0;
    e.paros += m.paros;
  }
  const list = orden.map((t) => map.get(t));
  const total = list.reduce((s, e) => s + e.reparacionMin, 0) || 1;
  const el = $("tipos-resumen");
  if (!el) return;
  el.innerHTML = list
    .map(
      (e) => `
      <div class="kpi" style="border-left-color:${colores[e.tipo]}">
        <span class="kpi-label">${e.tipo}</span>
        <span class="kpi-value kpi-value-sm">${e.reparacionMin ? fmtHours(e.reparacionMin) : "0 min"}</span>
        <span class="kpi-sub">${fmtNum(e.paros)} paros · ${((e.reparacionMin / total) * 100).toFixed(1)}% del total</span>
      </div>`
    )
    .join("");
}

function renderChartTipoMetric(canvasId, chartRef, machines, colors, getValue, fmtVal, unitLabel) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const top = machines;
  const labels = top.map((m) => m.code);
  const data = top.map((m) => getValue(m));

  if (chartRef) chartRef.destroy();
  return new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: unitLabel,
          data,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 46,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = top[items[0].dataIndex];
              return m ? `${m.code} · ${m.name}` : "";
            },
            label: (item) => (item.parsed.y == null ? "Sin registros" : fmtVal(item.parsed.y)),
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: "600" }, maxRotation: 45 } },
        y: { beginAtZero: true, grid: { color: "#f1f5f9" }, title: { display: true, text: unitLabel } },
      },
    },
  });
}

function renderChartsTiposMttr(list) {
  const tipos = [
    { tipo: "Biselado", id: "chart-mttr-biselado", key: "biselado", color: "#f59e0b" },
    { tipo: "Cortadoras", id: "chart-mttr-cortadoras", key: "cortadoras", color: "#d97706" },
    { tipo: "Prensas", id: "chart-mttr-prensas", key: "prensas", color: "#b45309" },
    { tipo: "CNC's", id: "chart-mttr-cnc", key: "cnc", color: "#92400e" },
  ];
  for (const t of tipos) {
    const machines = mergeByCode(list).filter((m) => m.tipo === t.tipo);
    if (machines.length === 0) continue;
    chartTiposMttr[t.key] = renderChartTipoMetric(
      t.id,
      chartTiposMttr[t.key],
      machines,
      t.color,
      (m) => m.mttrH,
      (v) => (v == null ? "Sin registros" : `${fmtHorasH(v)} · ${v.toFixed(2)} h`),
      "MTTR (horas)"
    );
  }
}

function renderChartsTiposMtbf(list) {
  const tipos = [
    { tipo: "Biselado", id: "chart-mtbf-biselado", key: "biselado", color: "#0e7490" },
    { tipo: "Cortadoras", id: "chart-mtbf-cortadoras", key: "cortadoras", color: "#0891b2" },
    { tipo: "Prensas", id: "chart-mtbf-prensas", key: "prensas", color: "#155e75" },
    { tipo: "CNC's", id: "chart-mtbf-cnc", key: "cnc", color: "#164e63" },
  ];
  for (const t of tipos) {
    const machines = mergeByCode(list).filter((m) => m.tipo === t.tipo);
    if (machines.length === 0) continue;
    chartTiposMtbf[t.key] = renderChartTipoMetric(
      t.id,
      chartTiposMtbf[t.key],
      machines,
      t.color,
      (m) => m.mtbfH,
      (v) => (v == null ? "Sin registros" : `${fmtHorasH(v)} · ${v.toFixed(2)} h`),
      "MTBF (horas)"
    );
  }
}

function renderChartDias(byDay) {
  const ctx = $("chart-dias").getContext("2d");
  const { line, fill } = chartColors();
  const labels = byDay.map((d) => d.fecha);
  const data = byDay.map((d) => d.minutos);

  if (chartDias) chartDias.destroy();
  chartDias = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Minutos de reparación",
          data,
          borderColor: line,
          backgroundColor: fill,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: line,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            label: (item) => `${fmtHours(item.parsed.y)} (${item.parsed.y} min)`,
          },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 12, maxRotation: 45 },
        },
        y: {
          beginAtZero: true,
          grid: { color: "#f1f5f9" },
          title: { display: true, text: "Minutos" },
        },
      },
    },
  });
}

function renderTablaResumen(byMachine, rows) {
  let list = byMachine;
  if (state.tipo) {
    list = byMachine.filter((m) => tipoDeMaquina(m.code) === state.tipo);
  }
  list = [...list].sort((a, b) =>
    String(a.code).localeCompare(String(b.code), "en", { numeric: true })
  );
  const totalMin = list.reduce((s, m) => s + (m.reparacionMin || 0), 0) || 1;
  const tbody = $("tabla-resumen").querySelector("tbody");
  tbody.innerHTML = "";
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="panel-hint">Sin datos en el periodo.</td></tr>';
    return;
  }
  for (const m of list) {
    const pct = ((m.reparacionMin || 0) / totalMin) * 100;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${m.code}</strong> · ${m.name}</td>
      <td>${m.process}</td>
      <td class="num">${fmtNum(m.paros)}</td>
      <td class="num">${fmtNum(m.reparacionMin || 0)}</td>
      <td class="num">${pct.toFixed(1)}%</td>`;
    tr.style.cursor = "pointer";
    tr.title = "Haz clic para filtrar / quitar por tipo de máquina";
    tr.addEventListener("click", () => {
      const t = tipoDeMaquina(m.code);
      const active = t && t === state.tipo;
      state.tipo = active ? "" : t;
      $("filtro-tipo").value = state.tipo;
      renderAll();
    });
    tbody.appendChild(tr);
  }
  void rows;
}

// Estados del contrato de paros. "Abierto" / "En reparación" / "Finalizado"
// vienen del sistema anterior; KOIDE MES agrega "En espera externa" y
// "Pendiente de cierre" (atención terminada, falta validar el código en la
// terminal de producción).
function claseStatus(status) {
  if (status === "Finalizado") return "ok";
  if (status === "En reparación" || status === "En espera externa") return "warn";
  if (status === "Pendiente de cierre") return "info";
  return "open";
}

// Paros vivos (no finalizados), sin importar el periodo seleccionado. Los
// campos que aún no existen se muestran como pendientes, nunca se estiman.
// Tecnicos que participaron en un paro (KOIDE MES): quien inicio, quien tomo
// continuidad y quien finalizo. Regla de planta: CADA uno recibe el tiempo
// COMPLETO del paro (no se divide ni se promedia).
const ROL_TXT = { inicio: "inició", continuidad: "continuidad", finalizo: "finalizó" };
// 60 -> "1:00 h" (formato de planta para el tiempo asignado a cada tecnico).
function fmtHM(min) {
  if (min == null || isNaN(min)) return "—";
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")} h`;
}
function participantesDe(r) {
  if (Array.isArray(r.participants) && r.participants.length) return r.participants;
  const out = [];
  const add = (n, rol) => {
    const k = String(n || "").trim();
    if (!k) return;
    let x = out.find((y) => y.employee_number === k);
    if (!x) out.push((x = { employee_number: k, name: techNombre(k) || null, roles: [], assigned_minutes: r.downtime_minutes ?? null }));
    if (!x.roles.includes(rol)) x.roles.push(rol);
  };
  add(r.repair_started_by_employee_number, "inicio");
  add(r.closed_by_employee_number, "finalizo");
  return out;
}
function participantesHtml(r, minutosVivo) {
  const lista = participantesDe(r);
  if (!lista.length) return "";
  const total = r.total_downtime_minutes ?? minutosVivo ?? r.downtime_minutes;
  return `<ul class="part-list">${lista.map((x) => {
    const actual = r.current_technician_employee_number === x.employee_number && r.status && r.status !== "Finalizado" && r.status !== "Pendiente de cierre";
    const min = x.assigned_minutes ?? total;
    const rs = rolTxt(x.role_snapshot);
    return `<li data-numero="${escapeHtml(x.employee_number)}" data-rol="${escapeHtml(x.role_snapshot || "")}"><strong>${escapeHtml(x.name || techNombre(x.employee_number) || x.employee_number)}</strong>
      <span class="muted">${escapeHtml(x.employee_number)}</span>${rs ? ` · <span class="rol-tag rol-${x.role_snapshot === "mantenimiento_admin" ? "admin" : "op"}">${rs}</span>` : ""} · ${escapeHtml(x.roles.map((y) => ROL_TXT[y] || y).join(", "))}${actual ? " · <em>atiende ahora</em>" : ""}
      <span class="part-min">${fmtHM(min)}</span></li>`;
  }).join("")}</ul>`;
}

function renderAbiertos() {
  const panel = $("abiertos-panel");
  if (!panel) return;
  const vivos = state.records
    .filter((r) => r.status && r.status !== "Finalizado")
    .sort((a, b) => String(a.downtime_start || "").localeCompare(String(b.downtime_start || "")));
  panel.hidden = vivos.length === 0;
  $("abiertos-cuenta").textContent = `${fmtNum(vivos.length)} ${vivos.length === 1 ? "paro" : "paros"}`;
  const pendiente = '<span class="pendiente">pendiente</span>';
  const ahora = Date.now();
  $("tabla-abiertos").querySelector("tbody").innerHTML = vivos
    .map((r) => {
      const ini = r.downtime_start ? new Date(r.downtime_start).getTime() : NaN;
      const trans = Number.isFinite(ini) ? Math.max(0, Math.round((ahora - ini) / 60000)) : null;
      const tecTxt = participantesHtml(r, trans) || pendiente;
      return `<tr>
        <td><strong>${escapeHtml(r.machine_code || "?")}</strong> · ${escapeHtml(r.machine_name || "")}</td>
        <td>${fmtDateTime(r.downtime_start)}</td>
        <td class="num">${trans != null ? fmtHours(trans) : "—"}</td>
        <td><span class="badge-status ${claseStatus(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${tecTxt}</td>
        <td class="num">${r.response_time_minutes != null ? `${fmtNum(r.response_time_minutes)} min` : pendiente}</td>
        <td class="num">${r.repair_time_minutes != null ? `${fmtNum(r.repair_time_minutes)} min` : pendiente}</td>
        <td>${r.downtime_category ? escapeHtml(r.downtime_category) : pendiente}</td>
        <td>${r.problem_description ? escapeHtml(r.problem_description) : pendiente}</td>
      </tr>`;
    })
    .join("");
}

// TIEMPO REAL: el servidor se sincroniza con KOIDE MES cada pocos segundos;
// el dashboard vuelve a leer /api/data y repinta SOLO las vistas de paros (no
// las de captura: bonos, calendarios, contramedidas), y solo si algo cambió.
const LIVE_MS = 20000;
let liveFirma = null;
function firmaRegistros(recs) {
  let h = recs.length;
  for (const r of recs) h = (h * 31 + String(r.id).length + String(r.status || "").length + String(r.updated_at || "").length + String(r.repair_time_minutes ?? "").length) >>> 0;
  // participants_employee_numbers: tomar continuidad no cambia estado ni
  // updated_at del paro, pero SI debe repintar a los tecnicos.
  return `${recs.length}:${h}:${recs.map((r) => `${r.id}:${r.status}:${r.updated_at}:${r.participants_employee_numbers || ""}`).slice(0, 50).join(",")}`;
}
async function liveTick() {
  if (document.hidden) return;
  const vista = ["tiempo", "mttr", "tecnicos"].find((v) => $(`view-${v}`) && !$(`view-${v}`).hidden);
  if (!vista) return;
  try {
    const res = await fetch("/api/data");
    if (!res.ok) return;
    const data = await res.json();
    const firma = firmaRegistros(data.records || []);
    if (firma === liveFirma) {
      renderAbiertos(); // solo avanza el "transcurrido"
      return;
    }
    liveFirma = firma;
    state.records = data.records || [];
    state.machines = data.machines || [];
    state.updatedAt = data.updatedAt;
    state.source = data.source;
    renderHeader();
    populateCategories();
    populateTipos();
    populateMonths();
    renderAll();
  } catch {
    /* sin red: se conserva lo último conocido */
  }
}

function renderTablaDetalle(rows) {
  const tbody = $("tabla-detalle").querySelector("tbody");
  $("detalle-cuenta").textContent = `${fmtNum(rows.length)} registros`;
  tbody.innerHTML = "";
  const sorted = [...rows].sort((a, b) => {
    const da = String(a.record_date || "");
    const db = String(b.record_date || "");
    if (da !== db) return da < db ? 1 : -1;
    const ta = a.downtime_start || "";
    const tb = b.downtime_start || "";
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="panel-hint">Sin registros.</td></tr>';
    return;
  }
  for (const r of sorted) {
    const status = r.status || "—";
    const cls = claseStatus(status);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(r.record_date)}</td>
      <td><strong>${r.machine_code || "?"}</strong> · ${r.machine_name || ""}</td>
      <td>${r.shift || "—"}</td>
      <td>${r.group_name || "—"}</td>
      <td>${escapeHtml(r.downtime_category || "—")}</td>
      <td>${escapeHtml(r.problem_description || "—")}</td>
      <td>${fmtDateTime(r.downtime_start)}</td>
      <td>${fmtDateTime(r.downtime_end)}</td>
      <td class="num">${r.downtime_minutes != null ? fmtNum(r.downtime_minutes) : "—"}</td>
      <td class="num">${r.repair_time_minutes != null ? fmtNum(r.repair_time_minutes) : "—"}</td>
      <td>${participantesHtml(r) || "—"}</td>
      <td><span class="badge-status ${cls}">${escapeHtml(status)}</span></td>`;
    tbody.appendChild(tr);
  }
}

/* ---------------- Vista MTTR / MTBF ---------------- */

function renderMTTRView(rows, includeCharts) {
  const stats = computeMTTRMTBF(rows);

  $("kpi-mttr").textContent = fmtHorasH(stats.mttrGlobal);
  $("kpi-mtbf").textContent = fmtHorasH(stats.mtbfGlobal);
  $("kpi-reparaciones").textContent = fmtNum(stats.reparaciones);
  $("kpi-fallas").textContent = fmtNum(stats.fallas);

  $("fm-mttr-num").textContent = `${fmtNum(stats.tiempoReparacionTotal)} min`;
  $("fm-mttr-div").textContent = `${fmtNum(stats.fallas)} fallas`;
  $("fm-mttr-res").textContent = fmtHorasH(stats.mttrGlobal);

  $("fm-mtbf-op").textContent = `${fmtNum(stats.horasOperacion)} h`;
  $("fm-mtbf-div").textContent = fmtNum(stats.fallas);
  $("fm-mtbf-res").textContent = fmtHorasH(stats.mtbfGlobal);

  const tipoSlug = {
    "Biselado": "biselado",
    "Cortadoras": "cortadoras",
    "Prensas": "prensas",
    "CNC's": "cnc",
  };
  const tipoMap = {};
  for (const t of stats.tipos) tipoMap[t.tipo] = t;
  for (const [tipo, slug] of Object.entries(tipoSlug)) {
    const t = tipoMap[tipo];
    $("kpi-mttr-" + slug).textContent = t ? fmtHorasH(t.mttrH) : "—";
    $("kpi-mtbf-" + slug).textContent = t ? fmtHorasH(t.mtbfH) : "—";
  }

  const tbody = $("tabla-mttr").querySelector("tbody");
  tbody.innerHTML = "";
  if (stats.list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="panel-hint">Sin datos en el periodo.</td></tr>';
  } else {
    for (const m of stats.list) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${m.code}</strong> · ${m.name}</td>
        <td>${m.tipo || "—"}</td>
        <td class="num">${fmtNum(m.fallas)}</td>
        <td class="num">${fmtNum(m.reparaciones)}</td>
        <td class="num">${fmtNum(m.tiempoReparacion)}</td>
        <td class="num">${fmtHorasH(m.mttrH)}</td>
        <td class="num">${fmtHorasH(m.mtbfH)}</td>`;
      tbody.appendChild(tr);
    }
  }

  if (includeCharts && !$("view-mttr").hidden) {
    renderChartMttr(stats.list);
    renderChartMtbf(stats.list);
    renderChartsTiposMttr(stats.list);
    renderChartsTiposMtbf(stats.list);
  }
}

function renderChartMttr(list) {
  const ctx = $("chart-mttr").getContext("2d");
  const { o } = chartColors();
  const top = mergeByCode(list);
  const data = top.map((m) => m.mttrH);

  if (chartMttr) chartMttr.destroy();
  chartMttr = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((m) => m.code),
      datasets: [
        {
          label: "MTTR (horas)",
          data,
          backgroundColor: o,
          borderRadius: 6,
          maxBarThickness: 52,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = top[items[0].dataIndex];
              return m ? `${m.code} · ${m.name}` : "";
            },
            label: (item) =>
              item.parsed.y == null
                ? "Sin registros"
                : `${fmtHorasH(item.parsed.y)} · ${item.parsed.y.toFixed(2)} h`,
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: "600" }, maxRotation: 45 } },
        y: { beginAtZero: true, grid: { color: "#f1f5f9" }, title: { display: true, text: "Horas" } },
      },
    },
  });
}

function renderChartMtbf(list) {
  const ctx = $("chart-mtbf").getContext("2d");
  const { g } = chartColors();
  const top = mergeByCode(list);
  const data = top.map((m) => m.mtbfH);

  if (chartMtbf) chartMtbf.destroy();
  chartMtbf = new Chart(ctx, {
    type: "bar",
    data: {
      labels: top.map((m) => m.code),
      datasets: [
        {
          label: "MTBF (horas)",
          data,
          backgroundColor: g,
          borderRadius: 6,
          maxBarThickness: 52,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = top[items[0].dataIndex];
              return m ? `${m.code} · ${m.name}` : "";
            },
            label: (item) =>
              item.parsed.y == null
                ? "Sin registros"
                : `${fmtHorasH(item.parsed.y)} · ${item.parsed.y.toFixed(2)} h`,
          },
        },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: "600" }, maxRotation: 45 } },
        y: { beginAtZero: true, grid: { color: "#f1f5f9" }, title: { display: true, text: "Horas" } },
      },
    },
  });
}

/* ---------------- Vista Contramedidas ---------------- */

function renderFallasComunes(rows) {
  const tbody = $("tabla-fallas").querySelector("tbody");
  const list = fallasComunes(rows);
  tbody.innerHTML = "";
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="panel-hint">Sin datos en el periodo.</td></tr>';
    return;
  }
  for (const f of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(f.categoria)}</td>
      <td class="num">${fmtNum(f.paros)}</td>
      <td class="num">${fmtNum(f.minutos)}</td>
      <td class="num">${f.pct.toFixed(1)}%</td>
      <td><button type="button" class="btn btn-sm solo-escritura" data-falla="${escapeHtml(f.categoria)}">Agregar contramedida</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-falla]").forEach((btn) => {
    btn.addEventListener("click", () => {
      resetForm();
      $("cm-tipo").value = "Falla común";
      $("view-contramedidas").scrollIntoView({ behavior: "smooth", block: "start" });
      $("cm-maquina").focus();
    });
  });
}

async function loadContramedidas() {
  try {
    const res = await fetch("/api/contramedidas");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.cm = await res.json();
    renderContramedidas();
  } catch (err) {
    console.error("Error al cargar contramedidas:", err);
  }
}

function renderContramedidas() {
  const tbody = $("tabla-contramedidas").querySelector("tbody");
  $("cm-cuenta").textContent = `${state.cm.length} contramedidas`;
  populateMaquinaSelect();
  populateResponsables();
  tbody.innerHTML = "";
  const sorted = [...state.cm].sort((a, b) =>
    String(b.creada || "").localeCompare(String(a.creada || ""))
  );
  if (sorted.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="panel-hint">Aún no hay contramedidas registradas.</td></tr>';
    renderCmCalendar();
    return;
  }
  for (const c of sorted) {
    const cls = ESTADO_CM[c.estado] || "warn";
    const tipoCls = TIPO_CM_CLS[c.tipo] || "falla";
    let falla = c.fallaComun || "";
    if (!falla && c.maquina) {
      const allRows = state.records || [];
      const { recurrente } = fallasPorMaquina(c.maquina, allRows);
      if (recurrente) falla = recurrente.desc;
    }
    if (!falla) falla = "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.maquina || c.referencia || "—")}</td>
      <td><span class="badge-tipo ${tipoCls}">${escapeHtml(c.tipo)}</span></td>
      <td class="td-falla">${escapeHtml(falla)}</td>
      <td>${escapeHtml(c.responsable)}</td>
      <td>${c.fechaLimite ? fmtDate(c.fechaLimite) : "—"}</td>
      <td><span class="badge-status ${cls}">${escapeHtml(c.estado)}</span></td>
      <td>${fmtDate(c.creada)}</td>
      <td class="td-acciones">
        ${c.estado === "Completado"
          ? `<button type="button" class="btn btn-sm btn-ghost" data-report="${c.id}">Ver reporte</button>`
          : `<button type="button" class="btn btn-sm btn-ok" data-complete="${c.id}">Completar</button>`}
        <button type="button" class="btn btn-sm btn-ghost" data-edit="${c.id}">Editar</button>
        <button type="button" class="btn btn-sm btn-danger" data-del="${c.id}">×</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cm = state.cm.find((x) => x.id === btn.dataset.edit);
      if (!cm) return;
      $("cm-tipo").value = cm.tipo || "Falla común";
      $("cm-maquina").value = cm.maquina || "";
      onMaquinaChange();
      $("cm-responsable").value = cm.responsable;
      $("cm-fecha").value = cm.fechaLimite || "";
      $("cm-estado").value = cm.estado;
      state.cmEditId = cm.id;
      $("form-titulo").textContent = "Editar contramedida";
      $("cm-save").textContent = "Guardar cambios";
      $("cm-cancel").hidden = false;
      $("view-contramedidas").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  tbody.querySelectorAll("button[data-complete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cm = state.cm.find((x) => x.id === btn.dataset.complete);
      if (!cm) return;
      openCompleteModal(cm);
    });
  });
  tbody.querySelectorAll("button[data-report]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cm = state.cm.find((x) => x.id === btn.dataset.report);
      if (!cm) return;
      openReportModal(cm);
    });
  });
  tbody.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Borrar esta contramedida?")) return;
      try {
        const res = await fetch(`/api/contramedidas/${btn.dataset.del}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadContramedidas();
      } catch (err) {
        alert("No se pudo borrar: " + err.message);
      }
    });
  });
  renderCmCalendar();
}

function resetForm() {
  state.cmEditId = null;
  state.cmRecomendacion = null;
  const hint = $("cm-reco-en-captura");
  if (hint) hint.remove();
  $("form-contramedida").reset();
  $("cm-estado").value = "Pendiente";
  $("form-titulo").textContent = "Agregar contramedida";
  $("cm-save").textContent = "Guardar contramedida";
  $("cm-cancel").hidden = true;
  $("cm-falla-box").hidden = true;
}

function setupFotoPreview(inputId, previewId) {
  const input = $(inputId);
  const prev = $(previewId);
  input.onchange = () => {
    prev.innerHTML = "";
    const f = input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = document.createElement("img");
      img.src = ev.target.result;
      img.className = "cm-foto-thumb";
      prev.appendChild(img);
    };
    reader.readAsDataURL(f);
  };
}

function openCompleteModal(cm) {
  state.cmCompleting = cm.id;
  const maqLabel = cm.maquina ? `${cm.maquina} — ${cm.maquinaNombre || ""}` : cm.referencia || "—";
  $("cm-complete-ref").textContent = maqLabel;
  $("cm-complete-trabajo").value = cm.trabajoRealizado || "";
  $("cm-foto-antes").value = "";
  $("cm-foto-despues").value = "";
  $("cm-preview-antes").innerHTML = "";
  $("cm-preview-despues").innerHTML = "";
  if (cm.fotos && cm.fotos.length) {
    for (const f of cm.fotos) {
      const label = f.includes("antes") ? "cm-preview-antes" : "cm-preview-despues";
      const img = document.createElement("img");
      img.src = `/api/contramedidas/fotos/${cm.id}/${f}`;
      img.className = "cm-foto-thumb";
      $(label).appendChild(img);
    }
  }
  setupFotoPreview("cm-foto-antes", "cm-preview-antes");
  setupFotoPreview("cm-foto-despues", "cm-preview-despues");
  $("modal-complete").classList.remove("hidden-modal");
  $("cm-complete-trabajo").focus();
}

function closeCompleteModal() {
  $("modal-complete").classList.add("hidden-modal");
  state.cmCompleting = null;
}

function openReportModal(cm) {
  const el = $("modal-report-content");
  const maqLabel = cm.maquina ? `${cm.maquina} — ${cm.maquinaNombre || ""}` : cm.referencia || "—";
  let fotosHtml = "";
  if (cm.fotos && cm.fotos.length) {
    for (const f of cm.fotos) {
      const label = f.includes("antes") ? "ANTES" : "DESPUÉS";
      fotosHtml += `
        <div class="report-foto">
          <span class="report-foto-label">${label}</span>
          <img src="/api/contramedidas/fotos/${cm.id}/${f}" alt="${label}" />
        </div>`;
    }
  }
  el.innerHTML = `
    <div class="report-header">
      <div><strong>Equipo:</strong> ${escapeHtml(maqLabel)}</div>
      <div><strong>Categoría:</strong> <span class="badge-tipo ${TIPO_CM_CLS[cm.tipo] || "falla"}">${escapeHtml(cm.tipo)}</span></div>
      <div><strong>Falla detectada:</strong> ${escapeHtml(cm.fallaComun || "—")}</div>
      <div><strong>Responsable:</strong> ${escapeHtml(cm.responsable)}</div>
      <div><strong>Fecha límite:</strong> ${cm.fechaLimite ? fmtDate(cm.fechaLimite) : "—"}</div>
      <div><strong>Creada:</strong> ${fmtDate(cm.creada)}</div>
    </div>
    <div class="report-section">
      <h3>Trabajo realizado</h3>
      <p>${escapeHtml(cm.trabajoRealizado || "Sin descripción")}</p>
    </div>
    <div class="report-section">
      <h3>Evidencia fotográfica</h3>
      ${fotosHtml || '<p class="panel-hint">Sin fotos adjuntas</p>'}
    </div>`;
  $("modal-report").classList.remove("hidden-modal");
}

function closeReportModal() {
  $("modal-report").classList.add("hidden-modal");
}

function renderCmCalendar() {
  const y = state.cmCalYear;
  const m = state.cmCalMonth;
  const mesNombres = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  $("cm-cal-mes").textContent = `${mesNombres[m]} ${y}`;

  const primerDia = new Date(y, m, 1).getDay();
  const diasMes = new Date(y, m + 1, 0).getDate();
  const hoy = new Date();
  const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;

  const cmByFecha = new Map();
  for (const c of state.cm) {
    if (!c.fechaLimite) continue;
    if (!cmByFecha.has(c.fechaLimite)) cmByFecha.set(c.fechaLimite, []);
    cmByFecha.get(c.fechaLimite).push(c);
  }

  const el = $("cm-calendar");
  el.innerHTML = "";
  for (const d of ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]) {
    const h = document.createElement("div");
    h.className = "cm-cal-header";
    h.textContent = d;
    el.appendChild(h);
  }

  for (let i = 0; i < primerDia; i++) {
    const empty = document.createElement("div");
    empty.className = "cm-cal-day empty";
    el.appendChild(empty);
  }

  for (let dia = 1; dia <= diasMes; dia++) {
    const fecha = `${y}-${String(m + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cm-cal-day" + (fecha === hoyStr ? " today" : "");
    const num = document.createElement("div");
    num.className = "cm-cal-day-num";
    num.textContent = dia;
    cell.appendChild(num);

    const items = cmByFecha.get(fecha) || [];
    for (const c of items) {
      const item = document.createElement("div");
      const cls = c.estado === "Completado" ? "cumplida" : c.estado === "En proceso" ? "proceso" : "pendiente";
      item.className = "cm-cal-item " + cls;
      item.textContent = `${c.referencia} — ${c.descripcion}`;
      item.title = `${c.tipo}: ${c.referencia}\n${c.descripcion}\nResponsable: ${c.responsable}\nEstado: ${c.estado}`;
      cell.appendChild(item);
    }
    el.appendChild(cell);
  }
}

function cmCalNav(delta) {
  state.cmCalMonth += delta;
  if (state.cmCalMonth > 11) { state.cmCalMonth = 0; state.cmCalYear++; }
  if (state.cmCalMonth < 0) { state.cmCalMonth = 11; state.cmCalYear--; }
  renderCmCalendar();
}

async function saveComplete() {
  const id = state.cmCompleting;
  if (!id) return;
  const trabajo = $("cm-complete-trabajo").value.trim();
  if (!trabajo) {
    alert("Escribe la descripción del trabajo realizado.");
    return;
  }
  const fAntes = $("cm-foto-antes").files[0] || null;
  const fDespues = $("cm-foto-despues").files[0] || null;
  for (const f of [fAntes, fDespues]) {
    if (f && f.size > 5 * 1024 * 1024) {
      alert(`La foto "${f.name}" excede 5 MB.`);
      return;
    }
  }
  try {
    const res = await fetch(`/api/contramedidas/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado: "Completado", trabajoRealizado: trabajo }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (fAntes || fDespues) {
      const fotos = [];
      async function toB64(file, label) {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.readAsDataURL(file);
        });
        fotos.push({ name: label + "_" + file.name, base64: b64 });
      }
      if (fAntes) await toB64(fAntes, "antes");
      if (fDespues) await toB64(fDespues, "despues");
      const up = await fetch(`/api/contramedidas/${id}/fotos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fotos }),
      });
      if (!up.ok) throw new Error(`Error subiendo fotos: HTTP ${up.status}`);
    }
    closeCompleteModal();
    await loadContramedidas();
  } catch (err) {
    alert("No se pudo completar: " + err.message);
  }
}

$("cm-cancel").addEventListener("click", resetForm);

$("cm-maquina").addEventListener("change", onMaquinaChange);

$("cm-complete-save").addEventListener("click", saveComplete);
$("cm-complete-cancel").addEventListener("click", closeCompleteModal);
$("cm-complete-cancel2").addEventListener("click", closeCompleteModal);
$("modal-complete").addEventListener("click", (e) => {
  if (e.target === $("modal-complete")) closeCompleteModal();
});
$("cm-cal-prev").addEventListener("click", () => cmCalNav(-1));
$("cm-cal-next").addEventListener("click", () => cmCalNav(1));
$("cm-report-close").addEventListener("click", closeReportModal);
$("modal-report").addEventListener("click", (e) => {
  if (e.target === $("modal-report")) closeReportModal();
});

$("form-contramedida").addEventListener("submit", async (e) => {
  e.preventDefault();
  const maquina = $("cm-maquina").value;
  if (!maquina) {
    alert("Selecciona un equipo / máquina.");
    return;
  }
  const tipo = $("cm-tipo").value;
  if (!tipo) {
    alert("Selecciona una categoría.");
    return;
  }
  const maq = (state.machines || []).find((m) => m.code === maquina);
  const allRows = state.records || [];
  const { recurrente } = fallasPorMaquina(maquina, allRows);
  const fallaComun = recurrente ? recurrente.desc : "";
  const payload = {
    tipo,
    maquina,
    maquinaNombre: maq ? maq.name : "",
    fallaComun,
    responsable: $("cm-responsable").value.trim(),
    fechaLimite: $("cm-fecha").value,
    estado: $("cm-estado").value,
  };
  // Programada desde una recomendacion por acumulacion: se registra tambien
  // en KOIDE MES (equipo + categoria) para que la recomendacion se de por
  // atendida. Solo aplica si sigue siendo el mismo equipo.
  const reco = state.cmRecomendacion;
  if (!state.cmEditId && reco && reco.equipo === maquina) {
    payload.recomendacionClave = reco.clave;
    payload.recomendacionCiclo = reco.ciclo;
    payload.categoriaCodigo = reco.categoriaCodigo;
    payload.descripcion = reco.recomendacion || "";
  }
  try {
    const res = state.cmEditId
      ? await fetch(`/api/contramedidas/${state.cmEditId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/contramedidas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    resetForm();
    await loadContramedidas();
    if (reco) refrescarProgramacionCm();
  } catch (err) {
    alert("No se pudo guardar: " + err.message);
  }
});

/* ---------------- Vista Desempeño de técnicos ---------------- */

function extractTecnicos(value) {
  const out = [];
  for (const part of String(value || "").split(/[,\s/]+/)) {
    const t = part.trim();
    if (t && /\d/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

function computeTecnicos(rows, soloRoster = true) {
  const map = new Map();
  // participants_employee_numbers (KOIDE MES): tambien quienes tomaron
  // continuidad. Cada tecnico recibe el paro COMPLETO.
  const fields = ["repair_started_by_employee_number", "closed_by_employee_number", "participants_employee_numbers"];

  reincIndex = new Map();
  for (const r of rows) {
    const ts = new Date(r.downtime_start || r.record_date).getTime();
    if (isNaN(ts)) continue;
    const desc = norm(r.problem_description);
    if (!desc) continue;
    const key = `${String(r.machine_code || "").trim()}|${desc}`;
    if (!reincIndex.has(key)) reincIndex.set(key, []);
    reincIndex.get(key).push({ t: ts, id: r.id != null ? r.id : `${r.machine_code}-${r.downtime_start}` });
  }

  const seen = new Set();
  for (const r of rows) {
    const nums = [];
    for (const f of fields) {
      for (const v of extractTecnicos(r[f])) {
        if ((!soloRoster || techRoster.has(v)) && !nums.includes(v)) nums.push(v);
      }
    }
    if (nums.length === 0) continue;
    const rec = {
      r,
      fin: String(r.status).trim() === "Finalizado",
      cat: categoriaInfo(r.downtime_category),
      respuesta:
        r.response_time_minutes != null && !isNaN(r.response_time_minutes)
          ? Number(r.response_time_minutes)
          : null,
      reparacion:
        r.repair_time_minutes != null && !isNaN(r.repair_time_minutes)
          ? Number(r.repair_time_minutes)
          : null,
    };
    for (const n of nums) {
      if (!map.has(n)) map.set(n, { numero: n, paros: 0, parosList: [], rolesSistema: new Set() });
      const t = map.get(n);
      t.paros += 1;
      t.parosList.push(rec);
      // Rol con el que participo EN ESTE paro (rol_snapshot del MES).
      const p = Array.isArray(r.participants) ? r.participants.find((x) => String(x.employee_number) === n) : null;
      for (const rs of (p && p.system_roles && p.system_roles.length ? p.system_roles : p && p.role_snapshot ? [p.role_snapshot] : [])) t.rolesSistema.add(rs);
    }
    if (!seen.has(rec)) seen.add(rec);
  }

  const list = [...map.values()];

  for (const t of list) {
    const base = t.parosList.filter((x) => x.fin);
    const respMins = [];
    const resScores = [];
    const repMins = [];
    const repEff = [];
    let repBase = 0;
    let cumpl = 0;
    let puntos = 0;
    const dias = new Set();
    for (const rec of base) {
      const d = String(rec.r.record_date || (rec.r.downtime_start || "").slice(0, 10));
      if (d) dias.add(d);
      puntos += rec.cat.puntos;
      if (rec.respuesta != null) {
        respMins.push(rec.respuesta);
        resScores.push(scoreRespuesta(rec.respuesta));
      }
      if (rec.reparacion != null) {
        repMins.push(rec.reparacion);
        repBase += 1;
        repEff.push(Math.min(100, (rec.cat.minutos / rec.reparacion) * 100));
        if (rec.reparacion <= rec.cat.minutos) cumpl += 1;
      }
    }
    t.finalizados = base.length;
    t.medianaRespuesta = medianOf(respMins);
    t.medianaReparacion = medianOf(repMins);
    t.puntos = puntos;
    t.horas = dias.size * PERF.shiftHours;
    t.ptsHora = t.horas ? puntos / t.horas : 0;
    t.scoreRespuesta = medianOf(resScores);
    t.scoreReparacion = medianOf(repEff);
    t.cumplimiento = repBase ? (cumpl / repBase) * 100 : null;
    t.scoreCumplimiento = t.cumplimiento;

    t.reinc = { 7: 0, 15: 0, 30: 0 };
    for (const rec of base) {
      for (const d of PERF.reincidenciaDias) {
        if (reincide(rec, d)) t.reinc[d] = (t.reinc[d] || 0) + 1;
      }
    }
    t.reinc30 = t.reinc[30] || 0;
    t.calidad30 = t.finalizados ? (1 - t.reinc30 / t.finalizados) * 100 : null;
    // Sin participaciones con rol registrado: el rol actual del roster.
    if (!t.rolesSistema.size && techRolActual.has(t.numero)) t.rolesSistema.add(techRolActual.get(t.numero));
    t.rolesSistema = [...t.rolesSistema];
  }

  const maxPtsH = Math.max(...list.map((t) => t.ptsHora), 0);
  for (const t of list) {
    t.scoreProductividad = maxPtsH > 0 ? Math.min(100, (t.ptsHora / maxPtsH) * 100) : null;
  }
  for (const t of list) t.indice = indicePonderado(t);
  list.sort((a, b) => (b.indice ?? -1) - (a.indice ?? -1));

  const globalResp = [];
  const globalRep = [];
  let gCump = 0;
  let gCumpBase = 0;
  for (const rec of seen) {
    if (rec.respuesta != null) globalResp.push(rec.respuesta);
    if (rec.reparacion != null) {
      globalRep.push(rec.reparacion);
      gCumpBase += 1;
      if (rec.reparacion <= rec.cat.minutos) gCump += 1;
    }
  }

  const indices = list.map((t) => t.indice).filter((v) => v != null);
  const globals = {
    list,
    tecnicos: list.length,
    paros: list.reduce((s, t) => s + t.paros, 0),
    globalRespuesta: medianOf(globalResp),
    globalReparacion: medianOf(globalRep),
    globalCumplimiento: gCumpBase ? (gCump / gCumpBase) * 100 : null,
    globalIndice: indices.length ? indices.reduce((s, v) => s + v, 0) / indices.length : null,
  };
  lastTecGlobals = globals;
  return globals;
}

function reincide(rec, dias) {
  const r = rec.r;
  const ts = new Date(r.downtime_start || r.record_date).getTime();
  if (isNaN(ts)) return false;
  const desc = norm(r.problem_description);
  if (!desc) return false;
  const key = `${String(r.machine_code || "").trim()}|${desc}`;
  const entries = reincIndex && reincIndex.get(key);
  if (!entries) return false;
  const id = r.id != null ? r.id : `${r.machine_code}-${r.downtime_start}`;
  const limit = ts + dias * 86400000;
  for (const e of entries) {
    if (e.id === id) continue;
    if (e.t > ts && e.t <= limit) return true;
  }
  return false;
}

function tecTooltip(labelsArr, fmt) {
  return {
    title: (items) => {
      const num = labelsArr[items[0].dataIndex];
      const nm = techNombre(num);
      return nm ? `${num} · ${nm}` : `Técnico #${num}`;
    },
    label: (item) =>
      item.dataset.type === "line"
        ? item.dataset.label
        : item.parsed.y == null
          ? "Sin registros"
          : fmt(item.parsed.y),
  };
}

function tecBarOptions(labelsArr, yTitle, fmt, yMax) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      tooltip: { callbacks: tecTooltip(labelsArr, fmt) },
      legend: { display: false },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { weight: "600" }, maxRotation: 45 } },
      y: {
        beginAtZero: true,
        ...(yMax ? { max: yMax } : {}),
        grid: { color: "#f1f5f9" },
        title: { display: true, text: yTitle },
      },
    },
  };
}

function scoreCell(score, sub) {
  if (score == null) {
    return `<span class="cell-score cell-score-null">—</span><span class="cell-sub">${escapeHtml(sub || "")}</span>`;
  }
  return `<span class="cell-score ${scoreCls(score)}">${score.toFixed(0)}</span><span class="cell-sub">${escapeHtml(sub || "")}</span>`;
}

function renderTecCharts(list) {
  lastTecList = list;

  const porIndice = [...list].sort((a, b) => (b.indice ?? -1) - (a.indice ?? -1));
  const idxLabels = porIndice.map((t) => t.numero);
  if (techCharts.indice) techCharts.indice.destroy();
  techCharts.indice = new Chart($("chart-tec-indice").getContext("2d"), {
    type: "bar",
    data: {
      labels: idxLabels.map((n) => `#${n}`),
      datasets: [
        {
          label: "Índice (pts)",
          data: porIndice.map((t) => (t.indice == null ? null : +t.indice.toFixed(1))),
          backgroundColor: porIndice.map((t) => {
            const c = clasifica(t.indice);
            return c.cls === "ok" ? "#16a34a" : c.cls === "warn" ? "#f59e0b" : "#dc2626";
          }),
          borderRadius: 6,
          maxBarThickness: 46,
        },
        {
          type: "line",
          label: "Excelente (90)",
          data: porIndice.map(() => 90),
          borderColor: "#16a34a",
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "Bueno (80)",
          data: porIndice.map(() => 80),
          borderColor: "#0e7490",
          borderDash: [3, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
        {
          type: "line",
          label: "Requiere acción (70)",
          data: porIndice.map(() => 70),
          borderColor: "#dc2626",
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: tecBarOptions(idxLabels, "Puntos (0–100)", (v) => `${v.toFixed(1)} pts`, 100),
  });

  const porRespuesta = [...list].sort((a, b) => (b.medianaRespuesta ?? -1) - (a.medianaRespuesta ?? -1));
  const resLabels = porRespuesta.map((t) => t.numero);
  if (techCharts.respuesta) techCharts.respuesta.destroy();
  techCharts.respuesta = new Chart($("chart-tec-respuesta").getContext("2d"), {
    type: "bar",
    data: {
      labels: resLabels.map((n) => `#${n}`),
      datasets: [
        {
          label: "Mediana (min)",
          data: porRespuesta.map((t) => (t.medianaRespuesta == null ? null : +t.medianaRespuesta.toFixed(1))),
          backgroundColor: "#f59e0b",
          borderRadius: 6,
          maxBarThickness: 46,
        },
        {
          type: "line",
          label: "Objetivo 15 min",
          data: porRespuesta.map(() => 15),
          borderColor: "#dc2626",
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: tecBarOptions(resLabels, "Minutos", (v) => `${v.toFixed(1)} min`),
  });

  const porReparacion = [...list].sort((a, b) => (b.medianaReparacion ?? -1) - (a.medianaReparacion ?? -1));
  const repLabels = porReparacion.map((t) => t.numero);
  const repLine = lastTecGlobals.globalReparacion;
  if (techCharts.reparacion) techCharts.reparacion.destroy();
  techCharts.reparacion = new Chart($("chart-tec-reparacion").getContext("2d"), {
    type: "bar",
    data: {
      labels: repLabels.map((n) => `#${n}`),
      datasets: [
        {
          label: "Mediana (min)",
          data: porReparacion.map((t) => (t.medianaReparacion == null ? null : +t.medianaReparacion.toFixed(1))),
          backgroundColor: "#0e7490",
          borderRadius: 6,
          maxBarThickness: 46,
        },
        ...(repLine == null
          ? []
          : [
              {
                type: "line",
                label: "Mediana del equipo",
                data: repLabels.map(() => +repLine.toFixed(1)),
                borderColor: "#dc2626",
                borderDash: [6, 4],
                borderWidth: 2,
                pointRadius: 0,
                fill: false,
              },
            ]),
      ],
    },
    options: tecBarOptions(repLabels, "Minutos", (v) => `${v.toFixed(1)} min`),
  });

  renderTecRadar($("tec-radar-select").value);
}

function renderTecRadar(numero) {
  const t = lastTecList.find((x) => x.numero === numero);
  if (techCharts.radar) techCharts.radar.destroy();
  if (!t) return;
  techCharts.radar = new Chart($("chart-tec-radar").getContext("2d"), {
    type: "radar",
    data: {
      labels: ["Respuesta", "Reparación", "Productividad", "Cumplimiento"],
      datasets: [
        {
          label: `#${t.numero}`,
          data: [
            t.scoreRespuesta,
            t.scoreReparacion,
            t.scoreProductividad,
            t.scoreCumplimiento,
          ].map((v) => (v == null ? null : +v.toFixed(1))),
          backgroundColor: "rgba(14,116,144,0.18)",
          borderColor: "#0e7490",
          pointBackgroundColor: "#0e7490",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `${item.label}: ${item.parsed.r == null ? "Sin datos" : item.parsed.r.toFixed(1)} pts`,
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 20, backdropColor: "transparent" },
          grid: { color: "#e2e8f0" },
          angleLines: { color: "#e2e8f0" },
        },
      },
    },
  });
}

function populateTecSelects(list) {
  const sync = (sel, prev) => {
    sel.innerHTML = "";
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.numero;
      opt.textContent = `#${t.numero} — ${techNombre(t.numero) || "Sin nombre"}`;
      sel.appendChild(opt);
    }
    sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : list[0] ? list[0].numero : "";
    return sel.value;
  };
  sync($("tec-radar-select"), $("tec-radar-select").value);
  sync($("tec-detalle-select"), $("tec-detalle-select").value);
}

function renderTecDetalle(numero) {
  const t = lastTecList.find((x) => x.numero === numero);
  const resumen = $("tec-detalle-resumen");
  const tbody = $("tabla-tec-detalle").querySelector("tbody");
  tbody.innerHTML = "";
  if (!t) {
    resumen.innerHTML = "";
    tbody.innerHTML = '<tr><td colspan="10" class="panel-hint">Seleccione un técnico.</td></tr>';
    return;
  }
  const nombre = techNombre(t.numero);
  resumen.innerHTML = `
    <span><b>${escapeHtml(nombre || `Técnico #${t.numero}`)}</b> · #${escapeHtml(t.numero)}</span>
    <span>Respuesta mediana <b>${t.medianaRespuesta != null ? t.medianaRespuesta.toFixed(1) : "—"}</b> min</span>
    <span>Reparación mediana <b>${t.medianaReparacion != null ? t.medianaReparacion.toFixed(1) : "—"}</b> min</span>
    <span>Cumplimiento <b>${t.cumplimiento != null ? t.cumplimiento.toFixed(0) : "—"}%</b></span>
    <span>Puntos complejidad <b>${fmtNum(t.puntos)}</b></span>
    <span>Horas estimadas <b>${fmtNum(t.horas)}</b></span>
    <span>Reincidencias <b>7d ${t.reinc[7] || 0}</b> · <b>15d ${t.reinc[15] || 0}</b> · <b>30d ${t.reinc[30] || 0}</b></span>
    <span>Calidad reparación 30d <b>${t.calidad30 != null ? t.calidad30.toFixed(0) : "—"}%</b></span>`;
  const paros = [...t.parosList].sort((a, b) =>
    String(b.r.downtime_start || "").localeCompare(String(a.r.downtime_start || ""))
  );
  for (const rec of paros) {
    const r = rec.r;
    const atiempo = rec.reparacion != null ? rec.reparacion <= rec.cat.minutos : null;
    const reinc30 = reincide(rec, 30);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${fmtDate(r.record_date)}</td>
      <td>${escapeHtml(r.machine_code || "")} · ${escapeHtml(r.machine_name || "")}</td>
      <td>${escapeHtml(rec.cat.tipo)}</td>
      <td>${escapeHtml(r.problem_description || "")}</td>
      <td class="num">${rec.respuesta != null ? rec.respuesta : "—"}</td>
      <td class="num">${rec.reparacion != null ? rec.reparacion : "—"}</td>
      <td class="num">${rec.cat.minutos}</td>
      <td>${atiempo == null ? "—" : atiempo ? '<span class="badge-status ok">A tiempo</span>' : '<span class="badge-status open">Fuera</span>'}</td>
      <td>${reinc30 ? '<span class="badge-status warn">Reincide</span>' : '<span class="badge-status ok">OK</span>'}</td>
      <td>${escapeHtml(r.status || "")}</td>`;
    tbody.appendChild(tr);
  }
  if (!paros.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="panel-hint">Sin paros en el periodo.</td></tr>';
  }
}

function renderTecnicos(rows, includeCharts) {
  const calc = computeTecnicos(rows);
  const { tecnicos, paros, globalRespuesta, globalReparacion, globalCumplimiento, globalIndice } = calc;
  // Filtro por rol con el que participaron (Operador / Administrador).
  const rolF = $("tec-rol-filtro") ? $("tec-rol-filtro").value : "";
  const list = rolF ? calc.list.filter((t) => t.rolesSistema.includes(rolF)) : calc.list;

  $("kpi-tec-tecnicos").textContent = fmtNum(tecnicos);
  $("kpi-tec-paros").textContent = fmtNum(paros);
  $("kpi-tec-indice").textContent = globalIndice != null ? globalIndice.toFixed(0) : "—";
  $("kpi-tec-respuesta").textContent =
    globalRespuesta != null ? `${globalRespuesta.toFixed(0)} min` : "—";
  $("kpi-tec-reparacion").textContent =
    globalReparacion != null ? `${globalReparacion.toFixed(0)} min` : "—";
  $("kpi-tec-cumplimiento").textContent =
    globalCumplimiento != null ? `${globalCumplimiento.toFixed(0)}%` : "—";

  const tbody = $("tabla-tecnicos").querySelector("tbody");
  $("tecnico-cuenta").textContent = `${list.length} técnicos en el periodo`;
  tbody.innerHTML = "";
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="panel-hint">Sin datos en el periodo.</td></tr>';
  } else {
    for (const t of list) {
      const c = clasifica(t.indice);
      const nombre = techNombre(t.numero);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>#${escapeHtml(t.numero)}</strong><span class="cell-sub">${escapeHtml(nombre || "")}${t.rolesSistema.length ? ` · ${escapeHtml(t.rolesSistema.map(rolTxt).filter(Boolean).join(" / "))}` : ""}</span></td>
        <td class="num">${fmtNum(t.paros)}</td>
        <td class="num">${fmtNum(t.puntos)}</td>
        <td>${scoreCell(t.scoreRespuesta, t.medianaRespuesta != null ? `mediana ${t.medianaRespuesta.toFixed(1)} min` : "sin datos")}</td>
        <td>${scoreCell(t.scoreReparacion, t.medianaReparacion != null ? `mediana ${t.medianaReparacion.toFixed(1)} min` : "sin datos")}</td>
        <td>${scoreCell(t.scoreProductividad, `${t.ptsHora ? t.ptsHora.toFixed(2) : "0.00"} pts/h`)}</td>
        <td>${scoreCell(t.scoreCumplimiento, `${t.cumplimiento != null ? t.cumplimiento.toFixed(0) : "—"}% a tiempo`)}</td>
        <td class="num"><span class="cell-indice">${t.indice != null ? t.indice.toFixed(1) : "—"}</span></td>
        <td><span class="badge-status ${c.cls}">${c.label}</span></td>`;
      tbody.appendChild(tr);
    }
  }

  populateTecSelects(list);
  if (includeCharts && !$("view-tecnicos").hidden) {
    renderTecCharts(list);
  }
  renderTecDetalle($("tec-detalle-select").value);
}

$("tec-radar-select").addEventListener("change", (e) => renderTecRadar(e.target.value));
$("tec-rol-filtro").addEventListener("change", () => renderTecnicos(applyFilters(), true));
$("tec-detalle-select").addEventListener("change", (e) => renderTecDetalle(e.target.value));

/* ---------------- Menú de secciones ---------------- */

function switchView(name) {
  document.querySelectorAll(".menu-item").forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`.menu-item[data-view="${name}"]`);
  if (btn) btn.classList.add("active");
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.id !== `view-${name}`;
  });
  if (name === "mttr") {
    renderMTTRView(applyFilters(), true);
  }
  if (name === "tecnicos") {
    renderTecnicos(applyFilters(), true);
  }
  if (name === "tiempo") {
    renderChartsTipos(aggregateByMachine(applyFilters()));
  }
  if (name === "bonos") {
    renderBonosView();
  }
  if (name === "calendarios") {
    renderCalView();
  }
  if (name === "contramedidas") {
    populateMaquinaSelect();
    populateResponsables();
    refrescarProgramacionCm({ ejecutar: true });
  }
  if (name === "configuracion") {
    renderConfiguracion();
  }
  if (name === "historico") {
    renderHistoricoView();
  }
  if (name === "documentos") {
    renderDocView();
  }
  if (name === "gastos") {
    renderGastos();
  }
  if (name === "entregas") {
    renderEntregas();
  }
  if (name === "operadores") {
    renderOperadores();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function rerenderActual() {
  const active = document.querySelector(".menu-item.active");
  if (!active || !active.dataset.view) return;
  const name = active.dataset.view;
  if (name === "mttr") renderMTTRView(applyFilters(), true);
  if (name === "tecnicos") renderTecnicos(applyFilters(), true);
  if (name === "tiempo") renderChartsTipos(aggregateByMachine(applyFilters()));
  if (name === "bonos") renderBonosView();
  if (name === "calendarios") renderCalView();
  if (name === "contramedidas") {
    populateMaquinaSelect();
    populateResponsables();
  }
  if (name === "documentos") renderDocView();
  if (name === "gastos") renderGastos();
  if (name === "entregas") renderEntregas();
}

async function autoRefreshTodo() {
  if (state.capacidades && !state.capacidades.includes("escribir")) {
    await loadData(true);
    rerenderActual();
    return;
  }
  await Promise.allSettled([
    loadData(true),
    loadContramedidas(),
    loadBonos(),
    loadCalendarios(),
    loadDocumentos(),
    fetch("/api/gastos/refresh", { method: "POST" }).catch(() => null),
    fetch("/api/entregas/refresh", { method: "POST" }).catch(() => null),
  ]);
  await Promise.allSettled([loadGastos(), loadEntregas()]);
  rerenderActual();
}

document.querySelectorAll(".menu-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

/* ---------------- Eventos ---------------- */

function setRange(from, to) {
  state.mes = "";
  state.desde = from;
  state.hasta = to;
  $("fecha-desde").value = from;
  $("fecha-hasta").value = to;
  markActiveRange();
  populateMonths();
  renderAll();
}

function markActiveRange() {
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  const range = state.rango;
  if (range) {
    const chip = document.querySelector(`.chip[data-range="${range}"]`);
    if (chip) chip.classList.add("active");
  }
}

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  state.rango = "30";
  setRange(isoDate(from), isoDate(to));
}

$("fecha-desde").addEventListener("change", (e) => {
  state.desde = e.target.value;
  state.rango = "";
  state.mes = "";
  markActiveRange();
  populateMonths();
  renderAll();
});

$("fecha-hasta").addEventListener("change", (e) => {
  state.hasta = e.target.value;
  state.rango = "";
  state.mes = "";
  markActiveRange();
  populateMonths();
  renderAll();
});

$("filtro-tipo").addEventListener("change", (e) => {
  state.tipo = e.target.value;
  renderAll();
});

$("filtro-categoria").addEventListener("change", (e) => {
  state.categoria = e.target.value;
  renderAll();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const range = chip.dataset.range;
    state.rango = range;
    const to = new Date();
    if (range === "today") {
      setRange(isoDate(to), isoDate(to));
      return;
    }
    if (range === "month") {
      const from = new Date(to.getFullYear(), to.getMonth(), 1);
      setRange(isoDate(from), isoDate(to));
      return;
    }
    if (range === "all") {
      setRange("", "");
      return;
    }
    const from = new Date();
    from.setDate(from.getDate() - (Number(range) - 1));
    setRange(isoDate(from), isoDate(to));
  });
});

document.querySelectorAll('input[name="unidad"]').forEach((radio) => {
  radio.addEventListener("change", (e) => {
    state.unidad = e.target.value;
    renderChartMaquinas(aggregateByMachine(applyFilters()));
  });
});

$("btn-refresh").addEventListener("click", refreshData);

/* ---------------- Bonos semanales ---------------- */

let bonoActual = null; // { key, sem, ini, fin, fecha, overlay: { addr: texto } }

function lunesDe(iso) {
  const d = new Date(iso + "T00:00:00");
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return isoDate(d);
}

function lunesActual() {
  return lunesDe(isoDate(new Date()));
}

function lunesInicial() {
  let maxD = "";
  for (const r of state.records || []) {
    const d = String(r.record_date || "").slice(0, 10);
    if (d > maxD) maxD = d;
  }
  const base = maxD || isoDate(new Date());
  const l = lunesDe(base);
  const now = new Date();
  if (l === lunesDe(isoDate(now)) && now.getDay() !== 0) {
    return sumarDias(l, -7);
  }
  return l;
}

function sumarDias(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function fechaCorta(iso) {
  if (!iso) return "";
  const d = iso.slice(8, 10), m = iso.slice(5, 7), y = iso.slice(0, 4);
  return `${d}/${m}/${y}`;
}

function isoWeekNumber(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((t - firstThursday) / 604800000);
}

function semanaInfo(lunes) {
  const ini = lunes;
  const fin = sumarDias(lunes, 6);
  const fecha = sumarDias(lunes, 7);
  const d = new Date(lunes + "T00:00:00");
  const sem = isoWeekNumber(d);
  const key = `${String(d.getFullYear()).padStart(4, "0")}-W${String(sem).padStart(2, "0")}`;
  return { key, sem, ini, fin, fecha };
}

function lunesDeSemanaISO(year, week) {
  const jan4 = new Date(year, 0, 4);
  const dow = (jan4.getDay() + 6) % 7;
  jan4.setDate(jan4.getDate() - dow);
  jan4.setDate(jan4.getDate() + (week - 1) * 7);
  return isoDate(jan4);
}

function parseBusqueda(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})\s*[-/]\s*W\s*(\d{1,2})$/i);
  if (m) return { week: +m[2], year: +m[1] };
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3]) };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    const a = +m[1], b = +m[2];
    let day, month;
    if (b > 12) { day = b; month = a; }
    else if (a > 12) { day = a; month = b; }
    else { day = a; month = b; }
    return { date: new Date(year, month - 1, day) };
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) return { week: +m[1], year: new Date().getFullYear() };
  return null;
}

function lunesDeBusqueda(input) {
  const parsed = parseBusqueda(input);
  if (!parsed) return null;
  if (parsed.date) return lunesDe(isoDate(parsed.date));
  return lunesDeSemanaISO(parsed.year, parsed.week);
}

async function buscarBono() {
  const lunes = lunesDeBusqueda($("bono-buscar").value);
  if (!lunes) {
    $("bono-estado").textContent = "Formato no reconocido (semana 32, 2026-W32 o una fecha)";
    return;
  }
  $("bono-lunes").value = lunes;
  generarBonos();
  try {
    await guardarBono();
  } catch (err) {
    $("bono-estado").textContent = "Error al guardar: " + err.message;
    console.error(err);
  }
}

function celdasEditables() {
  const set = new Set();
  const cfg = state.bonosCfg;
  if (!cfg) return set;
  const sem = cfg.semana || {};
  ["semana", "periodoIni", "periodoFin", "fecha"].forEach((k) => {
    if (sem[k]) set.add(sem[k]);
  });
  for (const sec of cfg.secciones || []) {
    for (const fila of sec.filas || []) {
      for (const k of ["resultado", "nivel", "monto", "calificacion", "razon"]) {
        if (sec.cols && sec.cols[k]) set.add(sec.cols[k] + fila);
      }
    }
  }
  return set;
}

function crearOverlay(fila) {
  const cfg = state.bonosCfg;
  const overlay = {};
  const sem = cfg.semana || {};
  overlay[sem.semana] = String(fila.sem);
  overlay[sem.periodoIni] = fechaCorta(fila.ini);
  overlay[sem.periodoFin] = fechaCorta(fila.fin);
  overlay[sem.fecha] = fechaCorta(fila.fecha);
  for (const sec of cfg.secciones || []) {
    for (const f of sec.filas || []) {
      const c = sec.cols || {};
      const numero = String((state.bonos.template.cells || {})[c.empleado + f]?.v ?? "").trim();
      const t = numero && tecnicosIndex.get(numero);
      const res = c.resultado + f;
      if (t && t.indice != null) {
        const idx = t.indice;
        overlay[res] = Math.round(idx) + "%";
        let nivel = "", monto = "", cal = "";
        for (const m of cfg.montos || []) {
          if (idx >= m.min) { nivel = m.nivel; monto = String(m.monto); break; }
        }
        cal = idx >= 80 ? "OK" : "NG";
        if (idx < 80) { nivel = "/"; monto = "/"; }
        overlay[c.nivel + f] = nivel;
        overlay[c.monto + f] = monto;
        overlay[c.calificacion + f] = cal;
      } else {
        overlay[res] = "";
        overlay[c.nivel + f] = "";
        overlay[c.monto + f] = "";
        overlay[c.calificacion + f] = "";
      }
    }
  }
  return overlay;
}

let tecnicosIndex = new Map();

function renderBonosView() {
  const cfg = state.bonosCfg;
  if (!cfg) {
    $("bono-mensaje").hidden = false;
    $("bono-mensaje").textContent = "La configuración de bonos no está definida en config.json.";
    $("print-bonos").innerHTML = "";
    return;
  }
  if (!state.bonos.template) {
    $("bono-mensaje").hidden = false;
    $("bono-mensaje").textContent = "Sube la plantilla Excel del formato de bonos para comenzar.";
    $("print-bonos").innerHTML = "";
    return;
  }
  $("bono-mensaje").hidden = true;
  if (!bonoActual) {
    $("bono-lunes").value = lunesInicial();
    generarBonos();
  } else {
    renderBonoTabla();
  }
  populateBonoSemanas();
}

function generarBonos() {
  const cfg = state.bonosCfg;
  const lunes = $("bono-lunes").value || lunesInicial();
  $("bono-lunes").value = lunes;
  const fila = semanaInfo(lunes);
  const rows = state.records.filter((r) => {
    const d = String(r.record_date || "").slice(0, 10);
    return d >= fila.ini && d <= fila.fin;
  });
  const perf = computeTecnicos(rows, false);
  tecnicosIndex = new Map();
  for (const t of perf.list) tecnicosIndex.set(t.numero, t);
  bonoActual = { ...fila, overlay: crearOverlay(fila) };
  $("bono-semana-tag").textContent = `Semana ${fila.sem} · ${fechaCorta(fila.ini)} – ${fechaCorta(fila.fin)}`;
  renderBonoTabla();
}

function renderBonoTabla() {
  const tpl = state.bonos.template;
  if (!tpl) return;
  const overlay = bonoActual ? bonoActual.overlay : {};
  const editable = celdasEditables();
  const cells = tpl.cells || {};
  const merges = tpl.merges || [];
  const maxRow = tpl.maxRow != null ? tpl.maxRow : 52;
  const maxCol = tpl.maxCol != null ? tpl.maxCol : 18;

  const mergedHere = new Map();
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        mergedHere.set(r + ":" + c, m);
      }
    }
  }

  let html = '<table>';
  for (let r = 0; r <= maxRow; r++) {
    let row = '<tr>';
    for (let c = 0; c <= maxCol; c++) {
      const m = mergedHere.get(r + ":" + c);
      if (m && (r !== m.s.r || c !== m.s.c)) continue;
      const addr = String.fromCharCode(65 + c) + (r + 1);
      const cell = cells[addr];
      let texto = overlay[addr] !== undefined ? overlay[addr] : (cell ? cell.w : "");
      const isEditable = editable.has(addr);
      const isNum = cell && cell.t === "n" && overlay[addr] === undefined;
      if (!isEditable && texto == null) texto = "";
      let rowspan = 1, colspan = 1;
      if (m) {
        rowspan = m.e.r - m.s.r + 1;
        colspan = m.e.c - m.s.c + 1;
      }
      const hasFill = Boolean(cell && cell.fill);
      const showBorder = isEditable || hasFill || (texto !== "");
      const cls = [];
      if (showBorder) cls.push("bx");
      if (isEditable) cls.push("bono-edit");
      if (isNum) cls.push("num");
      const parts = [];
      if (rowspan > 1) parts.push(`rowspan="${rowspan}"`);
      if (colspan > 1) parts.push(`colspan="${colspan}"`);
      if (isEditable) parts.push('contenteditable="true"');
      if (cls.length) parts.push(`class="${cls.join(" ")}"`);
      if (hasFill) parts.push(`style="background:#${cell.fill}"`);
      const data = isEditable ? ` data-addr="${addr}"` : "";
      const inner = texto !== "" ? escapeHtml(texto) : "&nbsp;";
      row += `<td${parts.length ? " " + parts.join(" ") : ""}${data}>${inner}</td>`;
    }
    row += '</tr>';
    html += row;
  }
  html += '</table>';
  $("print-bonos").innerHTML = html;
}

function populateBonoSemanas() {
  const sel = $("bono-semanas");
  sel.innerHTML = "";
  const keys = Object.keys(state.bonos.weeks || {}).sort().reverse();
  if (!keys.length) {
    sel.innerHTML = '<option value="">Sin semanas guardadas</option>';
    return;
  }
  for (const k of keys) {
    const w = state.bonos.weeks[k];
    sel.appendChild(new Option(`Semana ${w.semana} · ${fechaCorta(w.periodoIni)} – ${fechaCorta(w.periodoFin)}`, k));
  }
  sel.value = bonoActual ? bonoActual.key : keys[0];
}

function cargarBonoSemana(key) {
  const w = (state.bonos.weeks || {})[key];
  if (!w) return;
  bonoActual = { key: w.key, sem: w.semana, ini: w.periodoIni, fin: w.periodoFin, fecha: w.fecha, overlay: w.cells || {} };
  $("bono-lunes").value = w.periodoIni;
  $("bono-semana-tag").textContent = `Semana ${w.semana} · ${fechaCorta(w.periodoIni)} – ${fechaCorta(w.periodoFin)}`;
  renderBonoTabla();
}

async function subirPlantilla(file) {
  $("bono-estado").textContent = "Subiendo…";
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const res = await fetch("/api/bonos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, base64: btoa(bin) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al subir la plantilla");
  state.bonos.template = data.template;
  $("bono-estado").textContent = `Plantilla "${file.name}" cargada`;
  bonoActual = null;
  renderBonosView();
}

async function guardarBono() {
  if (!bonoActual) return;
  const overlay = { ...bonoActual.overlay };
  document.querySelectorAll("#print-bonos [contenteditable]").forEach((td) => {
    overlay[td.dataset.addr] = td.innerText.trim();
  });
  bonoActual.overlay = overlay;
  const res = await fetch("/api/bonos/week", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: bonoActual.key, semana: bonoActual.sem, periodoIni: bonoActual.ini, periodoFin: bonoActual.fin, fecha: bonoActual.fecha, cells: overlay }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al guardar");
  state.bonos.weeks[bonoActual.key] = {
    key: bonoActual.key, semana: bonoActual.sem, periodoIni: bonoActual.ini,
    periodoFin: bonoActual.fin, fecha: bonoActual.fecha, cells: overlay,
  };
  populateBonoSemanas();
  $("bono-estado").textContent = `Semana ${bonoActual.sem} guardada`;
}

function imprimirBono() {
  const node = $("print-bonos");
  if (!node || !node.innerHTML.trim()) {
    alert("No hay documento que imprimir");
    return;
  }
  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "@page{size:landscape;margin:10mm}",
    "body{font-family:Arial,sans-serif;font-size:11px;color:#000}",
    "table{border-collapse:collapse;width:100%}",
    "td{padding:3px 6px;vertical-align:middle}",
    "td.bx{border:1px solid #000}",
    "td.num{text-align:right}",
    "td.bono-edit{background:#fff;outline:none}",
    "[contenteditable]:focus{outline:2px solid #1565c0}",
  ].join("\n");
  const w = window.open("", "_blank", "width=1100,height=900");
  if (!w) return;
  w.document.write(
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    `<title>Bono semanal</title><style>${css}</style></head><body>` +
    node.outerHTML + "</body></html>"
  );
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

async function loadBonos() {
  try {
    const res = await fetch("/api/bonos");
    if (!res.ok) return;
    const data = await res.json();
    state.bonos.template = data.template;
    state.bonos.weeks = data.weeks || {};
  } catch (err) {
    console.error("Error al cargar bonos:", err);
  }
}

/* ---------------- Bonos: eventos ---------------- */

$("bono-archivo").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  subirPlantilla(file).catch((err) => {
    $("bono-estado").textContent = "Error: " + err.message;
    console.error(err);
  });
});

$("bono-generar").addEventListener("click", generarBonos);

$("bono-guardar").addEventListener("click", () => {
  guardarBono().catch((err) => {
    $("bono-estado").textContent = "Error: " + err.message;
    console.error(err);
  });
});

$("bono-imprimir").addEventListener("click", imprimirBono);

$("bono-semanas").addEventListener("change", (e) => {
  if (e.target.value) cargarBonoSemana(e.target.value);
});

$("bono-anterior").addEventListener("click", () => {
  const actual = $("bono-lunes").value || lunesActual();
  $("bono-lunes").value = sumarDias(actual, -7);
  generarBonos();
});

$("bono-buscar-btn").addEventListener("click", buscarBono);

$("bono-buscar").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    buscarBono();
  }
});

/* ---------------- Calendarios: eventos ---------------- */

$("cal-archivo").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  subirCalendario(file).catch((err) => {
    $("cal-estado").textContent = "Error: " + err.message;
    console.error(err);
  });
});

$("cal-select").addEventListener("change", (e) => {
  if (e.target.value) {
    state.calendarios.activeId = e.target.value;
    renderCalView();
  }
});

$("cal-semana").addEventListener("change", () => renderCalAgenda());

$("cal-anterior").addEventListener("click", () => {
  const actual = $("cal-semana").value || lunesActual();
  $("cal-semana").value = sumarDias(actual, -7);
  renderCalAgenda();
});

$("cal-buscar-btn").addEventListener("click", () => {
  const lunes = lunesDeBusqueda($("cal-buscar").value);
  if (!lunes) {
    $("cal-estado").textContent = "Formato no reconocido (semana 32, 2026-W32 o una fecha)";
    return;
  }
  $("cal-semana").value = lunes;
  renderCalAgenda();
});

$("cal-buscar").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("cal-buscar-btn").click();
  }
});

$("cal-eliminar").addEventListener("click", () => {
  eliminarCalendario().catch((err) => {
    $("cal-estado").textContent = "Error: " + err.message;
    console.error(err);
  });
});

$("cal-grid").addEventListener("click", (e) => {
  const td = e.target.closest("td[data-cal]");
  if (!td) return;
  const cal = calActivo();
  if (!cal) return;
  const key = td.dataset.cal;
  const actual = (cal.status && cal.status[key] && cal.status[key].estado) || "";
  setCalStatus(key, calEstadoSiguiente(actual));
});

document.addEventListener("change", (e) => {
  if (e.target && e.target.classList && e.target.classList.contains("cal-status-sel")) {
    setCalStatus(e.target.dataset.cal, e.target.value);
  }
});

/* ---------------- Calendarios de mantenimiento ---------------- */

function addrRC(addr) {
  const m = String(addr).match(/^([A-Z]+)(\d+)$/);
  if (!m) return { r: -1, c: -1 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { r: +m[2] - 1, c: col - 1 };
}

function excelSerialToISO(serial) {
  const d = new Date(Date.UTC(1899, 11, 30));
  d.setUTCDate(d.getUTCDate() + Math.floor(serial));
  return d.toISOString().slice(0, 10);
}

function cellVDate(cell) {
  if (!cell || cell.t !== "n" || typeof cell.v !== "number") return null;
  if (cell.v >= 20000 && cell.v <= 80000) return excelSerialToISO(cell.v);
  return null;
}

function calActivo() {
  return state.calendarios.list.find((c) => c.id === state.calendarios.activeId) || null;
}

function calColors() {
  return (state.calCfg && state.calCfg.colores) || { Realizado: "#16a34a", Reprogramado: "#f59e0b", Pendiente: "#94a3b8" };
}

function calKey(sheetIdx, addr) {
  return `${sheetIdx}:${addr}`;
}

function calEstadoSiguiente(actual) {
  const order = ["Realizado", "Reprogramado", "Pendiente"];
  const i = order.indexOf(actual);
  return i === -1 ? "Realizado" : order[i + 1] || "";
}

function setCalStatus(key, estado) {
  const cal = calActivo();
  if (!cal) return;
  if (!cal.status) cal.status = {};
  if (estado) {
    const colors = calColors();
    cal.status[key] = { estado, color: colors[estado] || "#94a3b8" };
  } else {
    delete cal.status[key];
  }
  renderCalGrid();
  renderCalAgenda();
  saveCalStatuses(cal);
}

function saveCalStatuses(cal) {
  fetch(`/api/calendarios/${encodeURIComponent(cal.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: cal.status || {} }),
  }).catch((err) => console.error("Error al guardar estados:", err));
}

function renderCalSheet(sheetIdx, sh) {
  const cells = sh.cells || {};
  const merges = sh.merges || [];
  const cal = calActivo();
  const status = (cal && cal.status) || {};
  const maxRow = sh.maxRow != null ? sh.maxRow : 60;
  const maxCol = sh.maxCol != null ? sh.maxCol : 30;
  const mergedHere = new Map();
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) mergedHere.set(r + ":" + c, m);
    }
  }
  let html = "<table>";
  for (let r = 0; r <= maxRow; r++) {
    html += "<tr>";
    for (let c = 0; c <= maxCol; c++) {
      const m = mergedHere.get(r + ":" + c);
      if (m && (r !== m.s.r || c !== m.s.c)) continue;
      const addr = String.fromCharCode(65 + c) + (r + 1);
      const cell = cells[addr];
      const texto = cell ? cell.w : "";
      let rowspan = 1, colspan = 1;
      if (m) {
        rowspan = m.e.r - m.s.r + 1;
        colspan = m.e.c - m.s.c + 1;
      }
      const hasFill = Boolean(cell && cell.fill);
      const showBorder = hasFill || (texto !== "");
      const key = calKey(sheetIdx, addr);
      const st = status[key];
      const parts = [];
      if (rowspan > 1) parts.push(`rowspan="${rowspan}"`);
      if (colspan > 1) parts.push(`colspan="${colspan}"`);
      parts.push(`data-cal="${key}"`);
      const cls = ["cal-cell"];
      if (showBorder) cls.push("bx");
      parts.push(`class="${cls.join(" ")}"`);
      if (st && st.color) parts.push(`style="background:${st.color}"`);
      else if (hasFill) parts.push(`style="background:#${cell.fill}"`);
      const inner = texto !== "" ? escapeHtml(texto) : "&nbsp;";
      html += `<td ${parts.join(" ")}>${inner}</td>`;
    }
    html += "</tr>";
  }
  html += "</table>";
  return html;
}

function renderCalGrid() {
  const cal = calActivo();
  const el = $("cal-grid");
  if (!cal) {
    el.innerHTML = "";
    return;
  }
  let html = "";
  cal.sheets.forEach((sh, si) => {
    html += `<h4 class="cal-sheet-title">${escapeHtml(sh.sheet)}</h4>`;
    html += renderCalSheet(si, sh);
  });
  el.innerHTML = html;
}

function rowLabel(cells, r, c) {
  for (let cc = c - 1; cc >= 0; cc--) {
    const addr = String.fromCharCode(65 + cc) + (r + 1);
    const cell = cells[addr];
    if (cell && cell.w && !cellVDate(cell)) return String(cell.w).trim();
  }
  return "";
}

function agendaSemanal(cal, fila) {
  const items = [];
  const seen = new Set();
  cal.sheets.forEach((sh, si) => {
    const cells = sh.cells || {};
    const maxRow = sh.maxRow != null ? sh.maxRow : 60;
    for (const addr of Object.keys(cells)) {
      const cell = cells[addr];
      const d = cellVDate(cell);
      if (!d || d < fila.ini || d > fila.fin) continue;
      const { r, c } = addrRC(addr);
      if (r <= 3) {
        for (let rr = r + 1; rr <= maxRow; rr++) {
          const addr2 = String.fromCharCode(65 + c) + (rr + 1);
          const cell2 = cells[addr2];
          if (!cell2 || !cell2.w) continue;
          const key2 = calKey(si, addr2);
          if (seen.has(key2)) continue;
          seen.add(key2);
          items.push({ key: key2, equipo: rowLabel(cells, rr, c), actividad: String(cell2.w).trim(), fecha: fechaCorta(d), date: d });
        }
        continue;
      }
      const key = calKey(si, addr);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, equipo: rowLabel(cells, r, c), actividad: String(cell.w).trim(), fecha: fechaCorta(d), date: d });
    }
  });
  items.sort((a, b) => (a.date < b.date ? -1 : 1));
  return items;
}

function renderCalAgenda() {
  const cal = calActivo();
  const tbody = document.querySelector("#tabla-cal-agenda tbody");
  if (!cal) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">Sube un calendario primero.</td></tr>';
    return;
  }
  const lunes = $("cal-semana").value || lunesActual();
  $("cal-semana").value = lunes;
  const fila = semanaInfo(lunes);
  $("cal-semana-tag").textContent = `Semana ${fila.sem} · ${fechaCorta(fila.ini)} – ${fechaCorta(fila.fin)}`;
  const items = agendaSemanal(cal, fila);
  $("cal-mensaje").hidden = items.length > 0;
  if (items.length === 0) {
    $("cal-mensaje").textContent = "Sin actividades calendarizadas en esta semana.";
  }
  const opts = ["Realizado", "Reprogramado", "Pendiente"];
  tbody.innerHTML = items
    .map(
      (it, i) => `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(it.equipo || "—")}</td>
        <td>${escapeHtml(it.actividad || "—")}</td>
        <td>${it.fecha}</td>
        <td><select class="cal-status-sel" data-cal="${it.key}">
          <option value="">—</option>
          ${opts.map((o) => `<option value="${o}">${o}</option>`).join("")}
        </select></td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("select[data-cal]").forEach((sel) => {
    const st = (cal.status || {})[sel.dataset.cal];
    if (st) sel.value = st.estado;
  });
}

function populateCalSelect() {
  const sel = $("cal-select");
  sel.innerHTML = "";
  if (!state.calendarios.list.length) {
    sel.innerHTML = '<option value="">Sin calendarios cargados</option>';
    return;
  }
  for (const c of state.calendarios.list) {
    sel.appendChild(new Option(`${c.name} (${new Date(c.uploadedAt).toLocaleDateString("es-MX")})`, c.id));
  }
  sel.value = state.calendarios.activeId || "";
}

function renderCalView() {
  if (!state.calendarios.list.length) {
    $("cal-select").innerHTML = '<option value="">Sin calendarios cargados</option>';
    $("cal-grid").innerHTML = "";
    $("cal-estado").textContent = "Sin calendarios";
    const tbody = document.querySelector("#tabla-cal-agenda tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="5">—</td></tr>';
    $("cal-mensaje").hidden = false;
    $("cal-mensaje").textContent = "Sube un archivo Excel del calendario de mantenimiento.";
    return;
  }
  if (!state.calendarios.activeId) {
    state.calendarios.activeId = state.calendarios.list[state.calendarios.list.length - 1].id;
  }
  populateCalSelect();
  if (!$("cal-semana").value) $("cal-semana").value = lunesActual();
  const cal = calActivo();
  $("cal-estado").textContent = `${cal.name} · ${cal.sheets.length} hoja(s)`;
  renderCalGrid();
  renderCalAgenda();
}

async function subirCalendario(file) {
  $("cal-estado").textContent = "Subiendo…";
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const res = await fetch("/api/calendarios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, base64: btoa(bin) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al subir el calendario");
  state.calendarios.list.push(data);
  state.calendarios.activeId = data.id;
  $("cal-estado").textContent = `"${file.name}" cargado`;
  renderCalView();
}

async function eliminarCalendario() {
  const cal = calActivo();
  if (!cal) return;
  if (!confirm(`¿Eliminar "${cal.name}"?`)) return;
  const res = await fetch(`/api/calendarios/${encodeURIComponent(cal.id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Error al eliminar");
  state.calendarios.list = state.calendarios.list.filter((c) => c.id !== cal.id);
  state.calendarios.activeId = state.calendarios.list.length ? state.calendarios.list[state.calendarios.list.length - 1].id : null;
  renderCalView();
}

async function loadCalendarios() {
  try {
    const res = await fetch("/api/calendarios");
    if (!res.ok) return;
    state.calendarios.list = await res.json();
  } catch (err) {
    console.error("Error al cargar calendarios:", err);
  }
}

/* ---------------- Documentos ---------------- */

function docDescarga(cat, name) {
  return `/api/documentos/${encodeURIComponent(cat)}/${encodeURIComponent(name)}`;
}

function docSize(bytes) {
  if (bytes == null) return "";
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocView() {
  const grid = $("docs-grid");
  const estado = $("doc-estado");
  if (!state.documentos.list.length) {
    grid.innerHTML = '<p class="panel-hint">Cargando…</p>';
    return;
  }
  estado.textContent = `${state.documentos.list.length} categorías`;
  const colores = ["#0891b2", "#16a34a", "#f59e0b", "#6366f1", "#dc2626", "#0e7490"];
  grid.innerHTML = state.documentos.list
    .map((g, i) => {
      const color = colores[i % colores.length];
      const archivos = (g.archivos || [])
        .map(
          (f) => `
          <li>
            <a class="doc-name" href="${docDescarga(g.categoria, f.name)}" download title="Descargar ${escapeHtml(f.name)}">${escapeHtml(f.name)}</a>
            <span class="doc-size">${docSize(f.size)}</span>
            <button type="button" class="btn btn-danger btn-sm doc-del" data-cat="${escapeHtml(g.categoria)}" data-name="${escapeHtml(f.name)}">×</button>
          </li>`
        )
        .join("");
      return `
      <div class="doc-globo" style="border-top-color:${color}">
        <div class="doc-globo-head">
          <h3>${escapeHtml(g.categoria)}</h3>
          <span class="doc-count">${archivos.length}</span>
        </div>
        <label class="doc-upload">
          Subir archivo
          <input type="file" data-cat="${escapeHtml(g.categoria)}" hidden>
        </label>
        <ul class="doc-list">${archivos || '<li class="doc-empty">Sin archivos</li>'}</ul>
      </div>`;
    })
    .join("");
}

function subirDocumento(cat, file) {
  const estado = $("doc-estado");
  const label = estado.textContent || "";
  estado.textContent = `Subiendo "${file.name}"…`;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(",")[1] || "";
    fetch(`/api/documentos/${encodeURIComponent(cat)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, base64 }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al subir");
        const g = state.documentos.list.find((x) => x.categoria === cat);
        if (g) g.archivos = data.archivos || [];
        estado.textContent = label || "—";
        renderDocView();
      })
      .catch((err) => {
        estado.textContent = "Error: " + err.message;
        console.error(err);
      });
  };
  reader.readAsDataURL(file);
}

function borrarDocumento(cat, name) {
  if (!confirm(`¿Eliminar "${name}"?`)) return;
  fetch(`/api/documentos/${encodeURIComponent(cat)}/${encodeURIComponent(name)}`, { method: "DELETE" })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al eliminar");
      const g = state.documentos.list.find((x) => x.categoria === cat);
      if (g) g.archivos = data.archivos || [];
      renderDocView();
    })
    .catch((err) => {
      $("doc-estado").textContent = "Error: " + err.message;
      console.error(err);
    });
}

async function loadDocumentos() {
  try {
    const res = await fetch("/api/documentos");
    if (!res.ok) return;
    state.documentos.list = await res.json();
  } catch (err) {
    console.error("Error al cargar documentos:", err);
  }
}

async function loadGastos() {
  try {
    const res = await fetch("/api/gastos");
    if (!res.ok) return;
    state.gastos = await res.json();
  } catch (err) {
    console.error("Error al cargar gastos:", err);
  }
}

async function loadEntregas() {
  try {
    const res = await fetch("/api/entregas");
    if (!res.ok) return;
    const data = await res.json();
    state.entregas = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Error al cargar entregas:", err);
    state.entregas = [];
  }
}

function entregasMesRows(mesIdx) {
  /* Partidas de TIEMPO DE ENTREGA.xlsx (depto MTTO) de POs confirmadas en requisiciones.
     Cada partida es un renglon con su propio estatus; una PO puede tener varias partidas. */
  var gastos = state.gastos || [];
  var entregas = state.entregas || [];
  if (!gastos.length) return [];

  var poInfo = {};
  gastos.forEach(function(g) {
    if (!g.tiene_po) return;
    var k = String(g.po || "").trim();
    if (!k) return;
    if (!poInfo[k]) {
      poInfo[k] = {
        mes: g.mes_entrega,
        proveedor: (g.proveedor || "").trim(),
        producto: (g.producto || "").trim()
      };
    }
  });

  var hoyStr = new Date().toISOString().slice(0, 10);
  var rows = [];
  entregas.forEach(function(t) {
    var k = String(t.po || "").trim();
    var info = poInfo[k];
    if (!info) return; // PO sin confirmar en requisiciones -> otro departamento
    if (mesIdx !== -1 && info.mes !== mesIdx) return;
    var r = {
      po: k,
      proveedor: t.proveedor || info.proveedor,
      material: t.material || info.producto,
      cantidad: t.cantidad,
      estatus: t.estatus || "",
      fecha_envio: t.fecha_envio || "",
      fecha_estimada: t.fecha_estimada || "",
      dias: t.dias || "",
      observaciones: t.observaciones || "",
      depto: t.depto || "",
      mes: info.mes
    };
    if (r.estatus === "ENTREGADO") r.statusKey = "entregado";
    else if (r.estatus === "PARCIAL") r.statusKey = "parcial";
    else if (r.estatus === "PENDIENTE") {
      r.statusKey = (r.fecha_estimada && String(r.fecha_estimada).slice(0, 10) < hoyStr) ? "retrasado" : "pendiente";
    } else {
      r.statusKey = "pendiente";
    }
    rows.push(r);
  });

  rows.sort(function(a, b) { return String(a.po).localeCompare(String(b.po), undefined, { numeric: true }); });
  return rows;
}

function estatusEntregasSpan(r) {
  switch (r.statusKey) {
    case "entregado": return '<span style="color:#16a34a;font-weight:600">ENTREGADO</span>';
    case "parcial": return '<span style="color:#f97316;font-weight:600">PARCIAL</span>';
    case "retrasado": return '<span style="color:#dc2626;font-weight:600">RETRASADO</span>';
    default: return '<span style="color:#ca8a04;font-weight:600">PENDIENTE</span>';
  }
}

function renderEntregas() {
  var estado = $("entregas-estado");
  if (!estado) return;
  if (!state.gastos) {
    estado.textContent = "Cargando\u2026";
  } else {
    var all = entregasMesRows(-1);
    if (!all.length) {
      estado.textContent = "Sin datos. Prueba Actualizar datos del Excel.";
    } else {
      var ent = all.filter(function(r) { return r.statusKey === "entregado"; }).length;
      var pend = all.filter(function(r) { return r.statusKey !== "entregado"; }).length;
      var ret = all.filter(function(r) { return r.statusKey === "retrasado"; }).length;
      estado.textContent = all.length + " partidas de mantenimiento (MTTO) | " + ent + " entregadas | " + pend + " sin entregar | " + ret + " retrasadas";
    }
  }

  var tabsEl = $("entregas-month-tabs");
  tabsEl.innerHTML = "";
  var pendTotal = 0, entTotal = 0;
  for (var i = 0; i < 12; i++) {
    var rows = entregasMesRows(i);
    var pend = rows.filter(function(r) { return r.statusKey !== "entregado"; }).length;
    var ent = rows.length - pend;
    pendTotal += pend;
    entTotal += ent;
    var btn = document.createElement("button");
    btn.className = "month-tab" + (i === state.entregasTab ? " active" : "") + (rows.length === 0 ? " month-tab-empty" : "");
    btn.dataset.idx = i;
    var badgeTxt = rows.length > 0 ? rows.length + " part." : "—";
    btn.innerHTML = GASTOS_CORTO[i] +
      '<span class="month-tab-badge">' + badgeTxt + '</span>' +
      (rows.length > 0
        ? '<span class="month-tab-detail"><span style="color:#f59e0b">P:' + pend + '</span> <span style="color:#16a34a">E:' + ent + '</span></span>'
        : '<span class="month-tab-detail" style="color:#94a3b8">sin datos</span>');
    btn.onclick = (function(idx, el) {
      return function() {
        state.entregasTab = idx;
        tabsEl.querySelectorAll(".month-tab").forEach(function(b) { b.classList.remove("active"); });
        el.classList.add("active");
        renderEntregasMes();
      };
    })(i, btn);
    tabsEl.appendChild(btn);
  }

  var totalBtn = document.createElement("button");
  totalBtn.className = "month-tab total-tab" + (state.entregasTab === -1 ? " active" : "");
  totalBtn.innerHTML = '<strong>TOTAL</strong>' +
    '<span class="month-tab-badge">' + (pendTotal + entTotal) + ' part.</span>' +
    '<span class="month-tab-detail"><span style="color:#f59e0b">P:' + pendTotal + '</span> <span style="color:#16a34a">E:' + entTotal + '</span></span>';
  totalBtn.onclick = function() {
    state.entregasTab = -1;
    tabsEl.querySelectorAll(".month-tab").forEach(function(b) { b.classList.remove("active"); });
    totalBtn.classList.add("active");
    renderEntregasMes();
  };
  tabsEl.appendChild(totalBtn);

  renderEntregasMes();
}

function renderEntregasMes() {
  var term = "";
  var buscar = $("entregas-buscar");
  if (buscar) term = buscar.value.trim().toLowerCase();

  var pool, label;
  if (term) {
    // Busqueda general: revisa TODOS los meses, sin importar la pestana activa
    pool = entregasMesRows(-1);
    label = "Resultados para \u201c" + buscar.value.trim() + "\u201d (todos los meses)";
  } else {
    pool = entregasMesRows(state.entregasTab);
    label = state.entregasTab === -1 ? "Todos los meses" : GASTOS_CORTO[state.entregasTab] + " 2026";
  }

  var pendRows = pool.filter(function(r) { return r.statusKey !== "entregado"; });
  var entRows = pool.filter(function(r) { return r.statusKey === "entregado"; });

  if (term) {
    var matcher = function(r) {
      return (r.po + " " + r.proveedor + " " + r.material + " " + r.observaciones + " " + r.depto).toLowerCase().indexOf(term) !== -1;
    };
    pendRows = pendRows.filter(matcher);
    entRows = entRows.filter(matcher);
  }

  $("entregas-pend-titulo").textContent = "Pendientes de entrega (" + pendRows.length + ") \u2014 " + label;
  $("entregas-ent-titulo").textContent = "Entregados (" + entRows.length + ") \u2014 " + label;

  $("entregas-pendientes").querySelector("tbody").innerHTML = entregasRowsHtml(pendRows);
  $("entregas-entregados").querySelector("tbody").innerHTML = entregasRowsHtml(entRows);
}

function entregasRowsHtml(rows) {
  if (!rows.length) {
    return '<tr><td colspan="9" style="text-align:center;color:#94a3b8">Sin movimientos</td></tr>';
  }
  return rows.map(function(r) {
    var fE = r.fecha_envio || "\u2014";
    var fEst = r.fecha_estimada || "\u2014";
    var hoyStr = new Date().toISOString().slice(0, 10);
    var vencida = r.statusKey === "retrasado";
    if (vencida) fEst += ' <span style="color:#dc2626;font-weight:600">(vencida)</span>';
    return '<tr class="st-' + r.statusKey + '">' +
      '<td><strong>' + escapeHtml(r.po || "\u2014") + '</strong></td>' +
      '<td>' + escapeHtml(r.proveedor || "\u2014") + '</td>' +
      '<td>' + escapeHtml(r.material || "\u2014") +
      (r.depto ? ' <small style="color:#64748b">' + escapeHtml(r.depto) + '</small>' : '') + '</td>' +
      '<td class="num">' + escapeHtml(r.cantidad != null && r.cantidad !== "" ? r.cantidad : "\u2014") + '</td>' +
      '<td>' + fE + '</td>' +
      '<td>' + fEst + '</td>' +
      '<td class="num">' + escapeHtml(r.dias != null && r.dias !== "" ? r.dias : "\u2014") + '</td>' +
      '<td>' + estatusEntregasSpan(r) + '</td>' +
      '<td>' + escapeHtml(r.observaciones || "") + '</td>' +
      '</tr>';
  }).join("");
}

var GASTOS_CORTO = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
var GASTOS_PPTO = 510000;

function fmtMoney(v) {
  if (v == null) return "\u2014";
  return "$" + Number(v).toLocaleString("es-MX", {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtDolar(v) {
  if (v == null) return "\u2014";
  return "US$" + Number(v).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
}

function gastosMesRows(mesIdx) {
  var items = state.gastos;
  if (!items || !items.length) return [];
  if (mesIdx === -1) return items;
  return items.filter(function(r) { return r.mes_entrega === mesIdx; });
}

function toMXN(item) {
  var amt = (item.importe != null) ? item.importe : 0;
  if (item.moneda === "USD") return amt * state.dolarRate;
  return amt;
}

function gastosSum(rows) {
  var sub = 0, iva = 0, tot = 0, prog = 0, pend = 0, ext = 0;
  var progCount = 0, pendCount = 0, extCount = 0;
  var totUSD = 0, totMXN = 0;
  var cotProg = {}, cotPend = {}, cotExt = {};
  rows.forEach(function(r) {
    if (r.importe != null) sub += r.importe;
    if (r.iva != null) iva += r.iva;
    var amtMXN = toMXN(r);
    tot += amtMXN;
    if (r.moneda === "USD") totUSD += (r.importe || 0); else totMXN += (r.importe || 0);
    var cotKey = (r.sheet || "") + "_" + r.cotizacion;
    if (r.comentario) {
      ext += amtMXN;
      extCount++;
      cotExt[cotKey] = true;
    } else if (r.tiene_po) {
      prog += amtMXN;
      progCount++;
      cotProg[cotKey] = true;
    } else {
      pend += amtMXN;
      pendCount++;
      cotPend[cotKey] = true;
    }
  });
  return {
    sub: sub, iva: iva, tot: tot,
    prog: prog, pend: pend, ext: ext,
    progCount: progCount, pendCount: pendCount, extCount: extCount,
    cotProgCount: Object.keys(cotProg).length,
    cotPendCount: Object.keys(cotPend).length,
    cotExtCount: Object.keys(cotExt).length,
    totUSD: totUSD, totMXN: totMXN
  };
}

function renderGastos() {
  var items = state.gastos;
  var estado = $("gastos-estado");
  if (!items) { estado.textContent = "Cargando\u2026"; return; }
  if (!items.length) { estado.textContent = "Sin datos"; return; }

  var progCount = 0, pendCount = 0, extCount = 0;
  var cotProgMap = {}, cotPendMap = {}, cotExtMap = {};
  items.forEach(function(r) {
    var cotKey = (r.sheet || "") + "_" + r.cotizacion;
    if (r.comentario) { extCount++; cotExtMap[cotKey] = true; }
    else if (r.tiene_po) { progCount++; cotProgMap[cotKey] = true; }
    else { pendCount++; cotPendMap[cotKey] = true; }
  });
  estado.textContent = Object.keys(cotProgMap).length + Object.keys(cotPendMap).length + Object.keys(cotExtMap).length + " cotizaciones (" +
    Object.keys(cotProgMap).length + " con PO, " + Object.keys(cotPendMap).length + " sin PO, " + Object.keys(cotExtMap).length + " externas) \u2014 " +
    items.length + " filas";

  var tabsEl = $("gastos-month-tabs");
  tabsEl.innerHTML = "";
  var totalEnt = 0, totalProg = 0;
  for (var i = 0; i < 12; i++) {
    var rows = gastosMesRows(i);
    var s = gastosSum(rows);
    totalEnt += s.tot;
    totalProg += s.prog + s.ext;
    var totalMes = s.prog + s.ext;
    var pct = GASTOS_PPTO > 0 ? totalMes / GASTOS_PPTO : 0;
    var over = pct > 1.0;
    var btn = document.createElement("button");
    btn.className = "month-tab" + (i === state.gastosTab ? " active" : "") + (over ? " over-budget" : " under-budget");
    btn.dataset.idx = i;
    var badgeTxt = fmtMoney(totalMes);
    if (s.totUSD > 0) badgeTxt += ' <span class="month-tab-usd">(' + fmtDolar(s.totUSD) + ')</span>';
    btn.innerHTML = GASTOS_CORTO[i] +
      '<span class="month-tab-badge">' + badgeTxt + '</span>' +
      '<span class="month-tab-ppt">' + (pct * 100).toFixed(0) + '% ppto</span>' +
      '<span class="month-tab-detail"><span style="color:#16a34a">C:' + fmtMoney(s.prog) + '</span> <span style="color:#f59e0b">S:' + fmtMoney(s.pend) + '</span>' +
      (s.ext > 0 ? ' <span style="color:#dc2626">E:' + fmtMoney(s.ext) + '</span>' : '') + '</span>';
    btn.onclick = (function(idx, el) { return function() {
      state.gastosTab = idx;
      tabsEl.querySelectorAll(".month-tab").forEach(function(b) { b.classList.remove("active"); });
      el.classList.add("active");
      renderGastosMonth();
    }; })(i, btn);
    tabsEl.appendChild(btn);
  }
  var totalBtn = document.createElement("button");
  totalBtn.className = "month-tab total-tab";
  var pptoAnual = GASTOS_PPTO * 12;
  var pctAll = pptoAnual > 0 ? totalProg / pptoAnual : 0;
  totalBtn.innerHTML = '<strong>TOTAL</strong>' +
    '<span class="month-tab-badge">' + fmtMoney(totalProg) + '</span>' +
    '<span class="month-tab-ppt">' + (pctAll * 100).toFixed(0) + '% ppto anual</span>';
  totalBtn.onclick = function() {
    state.gastosTab = -1;
    tabsEl.querySelectorAll(".month-tab").forEach(function(b) { b.classList.remove("active"); });
    totalBtn.classList.add("active");
    renderGastosMonth();
  };
  tabsEl.appendChild(totalBtn);

  var genBtn = document.createElement("button");
  genBtn.className = "month-tab total-tab" + (state.gastosTab === -2 ? " active" : "");
  var genProg = 0;
  items.forEach(function(r) { if (r.tiene_po) genProg += toMXN(r); });
  genBtn.innerHTML = '<strong>GENERAL</strong>' +
    '<span class="month-tab-badge">' + fmtMoney(genProg) + '</span>' +
    '<span class="month-tab-detail" style="color:#7c3aed">Por proveedor y por mes</span>';
  genBtn.onclick = function() {
    state.gastosTab = -2;
    tabsEl.querySelectorAll(".month-tab").forEach(function(b) { b.classList.remove("active"); });
    genBtn.classList.add("active");
    renderGastosGeneral();
  };
  tabsEl.appendChild(genBtn);

  if (state.gastosTab === -2) renderGastosGeneral();
  else renderGastosMonth();
}

function renderGastosMonth() {
  var items = state.gastos;
  if (!items) return;
  var tabIdx = state.gastosTab;
  $("gastos-general-panel").hidden = true;
  $("gastos-resumen-panel").hidden = false;
  $("gastos-prov-titulo").closest("section").hidden = false;
  $("gastos-partidas-titulo").closest("section").hidden = false;
  var isTotal = tabIdx === -1;
  var rows = gastosMesRows(tabIdx);
  var label = isTotal ? "Todos los meses (Ene\u2013Dic 2026)" : GASTOS_CORTO[tabIdx] + " 2026";
  var s = gastosSum(rows);
  var coments = {};
  rows.forEach(function(r) { if (r.comentario) coments[r.comentario] = true; });
  var comentsArr = Object.keys(coments);
  var ppto = isTotal ? GASTOS_PPTO * 12 : GASTOS_PPTO;
  var gastado = s.prog + s.ext;
  var diff = gastado - ppto;
  var over = diff > 0;
  var pct = ppto > 0 ? gastado / ppto : 0;

  $("gastos-mes-titulo").textContent = label;
  var barHtml = '<div class="budget-bar">' +
    '<div class="budget-bar-fill' + (over ? ' over' : '') + '" style="width:' + Math.min(pct * 100, 100).toFixed(1) + '%"></div>' +
    '</div>' +
    '<div class="budget-bar-label">' +
    '<span>Presupuesto: ' + fmtMoney(ppto) + ' <small>(' + fmtDolar(ppto / state.dolarRate) + ')</small></span>' +
    '<span>Gasto confirmado (con PO): <strong>' + fmtMoney(gastado) + '</strong> (' + (pct * 100).toFixed(1) + '%) <small>(' + fmtDolar(gastado / state.dolarRate) + ')</small>' +
    (over
      ? '<span class="budget-status over">&nbsp;\u2014 Salimos de presupuesto: excedido por ' + fmtMoney(Math.abs(diff)) + ' <small>(' + fmtDolar(Math.abs(diff) / state.dolarRate) + ')</small></span>'
      : '<span class="budget-status under">&nbsp;\u2014 Disponible: ' + fmtMoney(ppto - gastado) + ' <small>(' + fmtDolar((ppto - gastado) / state.dolarRate) + ')</small></span>') +
    '</span>' +
    '</div>';
  $("gastos-budget-bar").innerHTML = barHtml;

  var pptoUSD = ppto / state.dolarRate;
  $("gastos-resumen-table").querySelector("thead").innerHTML =
    '<tr><th>Gasto confirmado (con PO)</th><th>Gasto externo (con comentario)</th><th>Gasto programado sin PO</th><th>Presupuesto</th><th>Disponible / Excedente</th></tr>';
  $("gastos-resumen-table").querySelector("tbody").innerHTML =
    '<tr><td class="num"><span style="color:#16a34a;font-weight:700">' + fmtMoney(s.prog) + '</span><br><small>' + fmtDolar(s.prog / state.dolarRate) + ' | ' + s.progCount + ' filas, ' + s.cotProgCount + ' cotizaciones</small>' +
    '</td><td class="num"><span style="color:#dc2626;font-weight:700">' + fmtMoney(s.ext) + '</span><br><small>' + fmtDolar(s.ext / state.dolarRate) + ' | ' + s.extCount + ' filas, ' + s.cotExtCount + ' cotizaciones</small>' +
    (comentsArr.length > 0 ? '<br><small style="color:#dc2626"><strong>Comentario:</strong> ' + comentsArr.map(escapeHtml).join(" | ") + '</small>' : '') +
    '</td><td class="num"><span style="color:#f59e0b">' + fmtMoney(s.pend) + '</span><br><small>' + fmtDolar(s.pend / state.dolarRate) + ' | ' + s.pendCount + ' filas, ' + s.cotPendCount + ' cotizaciones</small>' +
    '</td><td class="num">' + fmtMoney(ppto) + '<br><small>' + fmtDolar(pptoUSD) + '</small></td>' +
    '<td class="num"><strong>' + (over ? 'Excedido: ' + fmtMoney(diff) : fmtMoney(ppto - gastado)) + '</strong><br><small>' + (over ? fmtDolar(Math.abs(diff) / state.dolarRate) : fmtDolar((ppto - gastado) / state.dolarRate)) + '</small></td></tr>';

  $("gastos-prov-titulo").textContent = "Gastos por proveedor \u2014 " + label;
  var proveMap = {};
  rows.forEach(function(r) {
    var prov = r.proveedor || "Sin proveedor";
    if (!proveMap[prov]) proveMap[prov] = {cotMap: {}, total: 0, conPO: 0, sinPO: 0, ext: 0};
    proveMap[prov].cotMap[(r.sheet || "") + "_" + r.cotizacion] = true;
    var tpMXN = toMXN(r);
    proveMap[prov].total += tpMXN;
    if (r.comentario) proveMap[prov].ext += tpMXN;
    else if (r.tiene_po) proveMap[prov].conPO += tpMXN; else proveMap[prov].sinPO += tpMXN;
  });
  var provArr = Object.entries(proveMap)
    .map(function(e) { return {name: e[0], count: Object.keys(e[1].cotMap).length, total: e[1].total, conPO: e[1].conPO || 0, sinPO: e[1].sinPO || 0, ext: e[1].ext || 0}; })
    .sort(function(a, b) { return b.total - a.total; });
  $("gastos-proveedores").querySelector("tbody").innerHTML = provArr.map(function(p) {
    var det = '<small>';
    if (p.conPO > 0) det += '<span style="color:#0369a1">PO:' + fmtMoney(p.conPO) + '</span> ';
    if (p.sinPO > 0) det += '<span style="color:#f59e0b">Sin PO:' + fmtMoney(p.sinPO) + '</span> ';
    if (p.ext > 0) det += '<span style="color:#dc2626">Ext:' + fmtMoney(p.ext) + '</span>';
    if (det === '<small>') det = '<small style="color:#64748b">Sin movimientos</small>';
    det += '</small>';
    return '<tr><td>' + escapeHtml(p.name) + '</td><td class="num">' + p.count + ' cot.' +
      '</td><td class="num"><strong>' + fmtMoney(p.total) + '</strong><br><small>' + fmtDolar(p.total / state.dolarRate) + '</small>' + det + '</td></tr>';
  }).join("");

  $("gastos-partidas-titulo").textContent = "Detalle de material \u2014 " + label;
  rows.sort(function(a, b) {
    var da = a.fecha_entrega || "9999";
    var db = b.fecha_entrega || "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });
  $("gastos-partidas").querySelector("tbody").innerHTML = rows.map(function(r, i) {
    var estatus;
    if (r.comentario) estatus = '<span style="color:#dc2626;font-weight:600">Gasto externo</span>';
    else if (r.tiene_po) estatus = '<span style="color:#0369a1;font-weight:600">Con PO</span>';
    else estatus = '<span style="color:#f59e0b;font-weight:600">Sin PO</span>';
    var moneda = r.moneda === "USD" ? ' <span style="color:#0369a1;font-size:0.75rem">USD</span>' : '';
    var totalMXN = toMXN(r);
    var totalCell = '<strong>' + fmtMoney(totalMXN) + '</strong>';
    if (r.moneda === "USD") totalCell += '<br><small style="color:#0369a1">' + fmtMoney(r.importe || 0) + ' USD x' + state.dolarRate + '</small>';
    var fElab = r.fecha_elaboracion || "\u2014";
    var fRecep = r.fecha_entrega || "\u2014";
    var desc = escapeHtml(r.producto || '');
    if (r.observaciones) desc += ' <small style="color:#64748b">' + escapeHtml(r.observaciones) + '</small>';
    if (r.comentario) desc += ' <small style="color:#dc2626;font-weight:600">(' + escapeHtml(r.comentario) + ')</small>';
    return '<tr><td>' + (i + 1) + '</td><td>' + fElab +
      '</td><td>' + fRecep +
      '</td><td>' + desc + moneda +
      '</td><td>' + r.cotizacion +
      '</td><td>' + (r.po || "\u2014") +
      '</td><td>' + escapeHtml(r.proveedor) +
      '</td><td class="num">' + totalCell +
      '</td><td>' + estatus + '</td></tr>';
  }).join("");
}

function renderGastosGeneral() {
  var items = state.gastos;
  if (!items) return;
  $("gastos-general-panel").hidden = false;
  $("gastos-resumen-panel").hidden = true;
  $("gastos-prov-titulo").closest("section").hidden = true;
  $("gastos-partidas-titulo").closest("section").hidden = true;

  var proveMap = {};
  items.forEach(function(r) {
    var prov = r.proveedor || "Sin proveedor";
    if (!proveMap[prov]) proveMap[prov] = {cotMap: {}, conPO: 0, sinPO: 0, ext: 0};
    proveMap[prov].cotMap[(r.sheet || "") + "_" + r.cotizacion] = true;
    var amtMXN = toMXN(r);
    if (r.comentario) proveMap[prov].ext += amtMXN;
    else if (r.tiene_po) proveMap[prov].conPO += amtMXN; else proveMap[prov].sinPO += amtMXN;
  });

  var provArr = Object.entries(proveMap)
    .map(function(e) { return {
      name: e[0],
      count: Object.keys(e[1].cotMap).length,
      conPO: e[1].conPO || 0,
      sinPO: e[1].sinPO || 0,
      ext: e[1].ext || 0,
      total: (e[1].conPO || 0) + (e[1].sinPO || 0) + (e[1].ext || 0)
    }; })
    .sort(function(a, b) { return b.total - a.total; });

  var grandTotal = provArr.reduce(function(s, p) { return s + p.total; }, 0);

  $("gastos-general-proveedores").querySelector("tbody").innerHTML = provArr.map(function(p, i) {
    var pct = grandTotal > 0 ? (p.total / grandTotal) * 100 : 0;
    var pctBar = '<div style="background:#e2e8f0;border-radius:6px;height:8px;width:100%"><div style="background:#7c3aed;height:8px;border-radius:6px;width:' + pct.toFixed(1) + '%"></div></div>';
    return '<tr>' +
      '<td>' + escapeHtml(p.name) + '</td>' +
      '<td class="num">' + p.count + '</td>' +
      '<td class="num" style="color:#0369a1">' + fmtMoney(p.conPO) + '</td>' +
      '<td class="num" style="color:#f59e0b">' + fmtMoney(p.sinPO) + '</td>' +
      '<td class="num" style="color:#dc2626">' + fmtMoney(p.ext) + '</td>' +
      '<td class="num"><strong>' + fmtMoney(p.total) + '</strong><br><small>' + fmtDolar(p.total / state.dolarRate) + '</small></td>' +
      '<td class="num" style="min-width:140px">' + pct.toFixed(1) + '% ' + pctBar + '</td>' +
      '</tr>';
  }).join("");

  renderGastosChartsProveedores(provArr.slice(0, 10));
  renderGastosChartsMeses();
}

var gastosChartProv = null, gastosChartMeses = null;
function renderGastosChartsProveedores(topProv) {
  var ctx = $("gastos-chart-proveedores").getContext("2d");
  if (gastosChartProv) gastosChartProv.destroy();
  gastosChartProv = new Chart(ctx, {
    type: "bar",
    data: {
      labels: topProv.map(function(p) { return p.name.length > 28 ? p.name.slice(0, 27) + "\u2026" : p.name; }),
      datasets: [{ label: "Total MXN", data: topProv.map(function(p) { return Math.round(p.total); }), backgroundColor: "#7c3aed" }]
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(c) { return "$" + Number(c.raw).toLocaleString(); } } } },
      scales: { x: { ticks: { callback: function(v) { return "$" + Number(v).toLocaleString(); } } } }
    }
  });
}
function renderGastosChartsMeses() {
  var ctx = $("gastos-chart-meses").getContext("2d");
  if (gastosChartMeses) gastosChartMeses.destroy();
  var labels = [], conPO = [], sinPO = [], ext = [];
  for (var i = 0; i < 12; i++) {
    var rows = gastosMesRows(i);
    var s = gastosSum(rows);
    labels.push(GASTOS_CORTO[i]);
    conPO.push(Math.round(s.prog));
    sinPO.push(Math.round(s.pend));
    ext.push(Math.round(s.ext));
  }
  gastosChartMeses = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: "Con PO", data: conPO, backgroundColor: "#0369a1" },
        { label: "Sin PO", data: sinPO, backgroundColor: "#f59e0b" },
        { label: "Externo", data: ext, backgroundColor: "#dc2626" },
        { label: "Presupuesto ($" + Number(GASTOS_PPTO).toLocaleString() + ")", type: "line", data: labels.map(function() { return GASTOS_PPTO; }), borderColor: "#ef4444", borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 }
      ]
    },
    options: {
      responsive: true,
      plugins: { tooltip: { callbacks: { label: function(c) { if (c.dataset.type === "line") return c.dataset.label + ": $" + Number(c.raw).toLocaleString(); return c.dataset.label + ": $" + Number(c.raw).toLocaleString(); } } } },
      scales: { y: { ticks: { callback: function(v) { return "$" + Number(v).toLocaleString(); } } }, x: { stacked: false } }
    }
  });
}

document.addEventListener("change", (e) => {
  if (e.target && e.target.matches && e.target.matches("input[type=file][data-cat]")) {
    const file = e.target.files && e.target.files[0];
    if (file) subirDocumento(e.target.dataset.cat, file);
    e.target.value = "";
  }
});

var dolarInput = $("gastos-dolar-rate");
if (dolarInput) {
  dolarInput.addEventListener("input", function() {
    var val = parseFloat(this.value);
    if (val > 0 && val < 100) {
      state.dolarRate = val;
      if (state.gastos) renderGastos();
    }
  });
}

var btnGastosRefresh = $("btn-gastos-refresh");
if (btnGastosRefresh) {
  btnGastosRefresh.addEventListener("click", async function() {
    var btn = this;
    var spinner = btn.querySelector(".btn-spinner");
    var label = btn.querySelector(".btn-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "btn-label";
      label.textContent = "Actualizar datos del Excel";
      btn.textContent = "";
      btn.appendChild(label);
      btn.appendChild(spinner);
    }
    btn.disabled = true;
    spinner.hidden = false;
    label.textContent = "Extrayendo datos del Excel...";
    try {
      var res = await fetch("/api/gastos/refresh", { method: "POST" });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      await loadGastos();
      renderGastos();
      label.textContent = "Datos actualizados";
      setTimeout(function() { label.textContent = "Actualizar datos del Excel"; btn.disabled = false; }, 3000);
    } catch (err) {
      alert("Error al actualizar: " + err.message);
      label.textContent = "Actualizar datos del Excel";
      btn.disabled = false;
    } finally {
      spinner.hidden = true;
    }
  });
}

var btnEntregasRefresh = $("btn-entregas-refresh");
if (btnEntregasRefresh) {
  btnEntregasRefresh.addEventListener("click", async function() {
    var btn = this;
    var spinner = btn.querySelector(".btn-spinner");
    var label = btn.querySelector(".btn-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "btn-label";
      label.textContent = "Actualizar datos del Excel";
      btn.textContent = "";
      btn.appendChild(label);
      btn.appendChild(spinner);
    }
    btn.disabled = true;
    spinner.hidden = false;
    label.textContent = "Extrayendo datos del Excel...";
    try {
      var res = await fetch("/api/entregas/refresh", { method: "POST" });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      await loadGastos();
      await loadEntregas();
      renderEntregas();
      label.textContent = "Datos actualizados";
      setTimeout(function() { label.textContent = "Actualizar datos del Excel"; btn.disabled = false; }, 3000);
    } catch (err) {
      alert("Error al actualizar: " + err.message);
      label.textContent = "Actualizar datos del Excel";
      btn.disabled = false;
    } finally {
      spinner.hidden = true;
    }
  });
}

var buscarEntregas = $("entregas-buscar");
if (buscarEntregas) {
  buscarEntregas.addEventListener("input", function() {
    renderEntregasMes();
  });
}

var btnEntregasLimpiar = $("btn-entregas-limpiar");
if (btnEntregasLimpiar) {
  btnEntregasLimpiar.addEventListener("click", function() {
    if (buscarEntregas) {
      buscarEntregas.value = "";
      renderEntregasMes();
      buscarEntregas.focus();
    }
  });
}

if (state.gastosTab === undefined) state.gastosTab = 0;
if (state.entregasTab === undefined) state.entregasTab = -1;
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".doc-del");
  if (!btn) return;
  borrarDocumento(btn.dataset.cat, btn.dataset.name);
});

/* ---------------- Inicio ---------------- */

defaultRange();
loadData();
setInterval(liveTick, LIVE_MS);
loadContramedidas();
loadBonos();
loadCalendarios();
loadDocumentos();
loadGastos();
loadEntregas();
setInterval(() => loadData(true), 5 * 60 * 1000);
setInterval(() => {
  autoRefreshTodo();
}, 2 * 60 * 60 * 1000);


/* ---------------- Operadores de mantenimiento (cuenta <-> empleado del MES) ---------------- */

async function adminApi(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function opMsg(texto, esError) {
  const el = $("opa-msg");
  el.textContent = texto || "";
  el.classList.toggle("error", Boolean(esError));
}

const ROL_CUENTA_TXT = { mantenimiento_op: "Operador", mantenimiento_admin: "Administrador", tecnico_consulta: "Consulta · solo lectura" };
const VINCULO_TXT = {
  ACTIVO: ["ok", "Activo en MES"],
  INACTIVO: ["open", "Inactivo en MES · no atiende"],
  NO_EXISTE: ["open", "No existe en MES · no atiende"],
  SIN_NUMERO: ["warn", "Sin empleado asociado"],
  DESCONOCIDO: ["info", "MES sin respuesta"],
};

// Estado de la vista: cuentas, catalogo del MES y cuenta en edicion (null = alta).
const opa = { cuentas: [], personal: [], editando: null };

function etiquetaEmpleado(p) {
  return `${p.numeroEmpleado} — ${p.nombre || "(sin nombre en el MES)"}`;
}

// Opciones del selector: solo se pueden ELEGIR empleados activos y libres (o el
// que ya tiene la cuenta en edicion); los demas se muestran deshabilitados con
// el motivo, para que se entienda por que no estan disponibles.
function llenarEmpleados() {
  const sel = $("opa-empleado");
  const q = $("opa-buscar").value.trim().toLowerCase();
  const propio = opa.editando ? opa.editando.numeroEmpleado : null;
  const actual = sel.value;
  const esAdmin = (opa.editando ? opa.editando.rol : $("opa-rol").value) === "mantenimiento_admin";
  const lista = opa.personal
    .filter((p) => !q || String(p.numeroEmpleado).toLowerCase().includes(q) || String(p.nombre || "").toLowerCase().includes(q))
    .sort((a, b) => Number(Boolean(a.asignadoA && a.numeroEmpleado !== propio)) - Number(Boolean(b.asignadoA && b.numeroEmpleado !== propio)) || String(a.nombre || "~").localeCompare(String(b.nombre || "~")) || String(a.numeroEmpleado).localeCompare(String(b.numeroEmpleado)));
  const opciones = [`<option value="">${esAdmin ? "— Sin empleado (no atiende paros) —" : "— Elige un empleado —"}</option>`];
  for (const p of lista) {
    const ocupado = p.asignadoA && p.numeroEmpleado !== propio;
    const motivo = !p.activo ? " · INACTIVO en MES" : ocupado ? ` · ya es de ${p.asignadoA}` : p.numeroEmpleado === propio ? " · actual" : "";
    opciones.push(`<option value="${escapeHtml(p.numeroEmpleado)}"${!p.activo || ocupado ? " disabled" : ""}>${escapeHtml(etiquetaEmpleado(p) + motivo)}</option>`);
  }
  if (propio && !opa.personal.some((p) => p.numeroEmpleado === propio)) {
    opciones.push(`<option value="${escapeHtml(propio)}" disabled>${escapeHtml(`${propio} — NO EXISTE en el MES (elige otro)`)}</option>`);
  }
  sel.innerHTML = opciones.join("");
  if ([...sel.options].some((o) => o.value === actual && !o.disabled)) sel.value = actual;
}

async function cargarPersonalMes() {
  try {
    const r = await adminApi("GET", "/api/admin/personal-mes");
    opa.personal = r.personal || [];
  } catch (err) {
    opa.personal = [];
    $("opa-mes-aviso").textContent = `No se pudo leer el catálogo de personal de KOIDE MES (${err.message}). Sin él no se puede asociar un empleado.`;
    $("opa-mes-aviso").hidden = false;
  }
  llenarEmpleados();
}

async function renderOperadores() {
  try {
    const r = await adminApi("GET", "/api/admin/operadores");
    opa.cuentas = r.operadores || [];
    const aviso = $("opa-mes-aviso");
    aviso.hidden = r.mes.disponible;
    if (!r.mes.disponible) aviso.textContent = `KOIDE MES no responde: no se puede verificar el empleado de cada cuenta ni dar de alta (${r.mes.error || "sin detalle"}).`;
    const cs = opa.cuentas;
    $("op-admin-cuenta").textContent = `${cs.filter((o) => o.rol === "mantenimiento_op").length} operadores · ${cs.filter((o) => o.rol === "mantenimiento_admin").length} administradores · ${cs.filter((o) => o.rol === "tecnico_consulta").length} de consulta · ${cs.filter((o) => o.atiendeParos).length} pueden atender paros`;
    const tbody = $("tabla-operadores").querySelector("tbody");
    tbody.innerHTML = cs.length ? cs.map((o) => {
      const [cls, txt] = VINCULO_TXT[o.empleado.estado] || ["", ""];
      const empleado = o.rol === "tecnico_consulta" ? "—"
        : `${o.numeroEmpleado ? `<span class="mono">${escapeHtml(o.numeroEmpleado)}</span>${o.empleado.nombre ? ` · ${escapeHtml(o.empleado.nombre)}` : ""}<br>` : ""}<span class="badge-status ${cls}">${escapeHtml(txt)}</span>`;
      const acceso = o.rol !== "mantenimiento_op" ? "Contraseña" : o.bloqueoDefinitivo ? '<span class="badge-status open">Bloqueado: restablecer PIN</span>' : o.bloqueado ? '<span class="badge-status warn">Bloqueado 15 min</span>' : o.intentosFallidos ? `${o.intentosFallidos} intento(s) fallido(s)` : "PIN OK";
      return `
      <tr data-usuario="${escapeHtml(o.username)}">
        <td>${escapeHtml(o.nombre)}</td>
        <td class="mono">${escapeHtml(o.username)}</td>
        <td>${empleado}</td>
        <td>${escapeHtml(ROL_CUENTA_TXT[o.rol] || o.rol)}${o.atiendeParos ? " · atiende paros" : ""}</td>
        <td><span class="badge-status ${o.activo ? "ok" : "open"}">${o.activo ? "Activo" : "Inactivo"}</span></td>
        <td>${acceso}</td>
        <td>${o.creado ? fmtDateTime(o.creado) : "—"}</td>
        <td><div class="op-acciones">
          <button class="btn btn-small" data-accion="editar" type="button">Editar</button>
          <button class="btn btn-small" data-accion="secreto" type="button">${o.rol === "mantenimiento_op" ? "Restablecer PIN" : "Cambiar contraseña"}</button>
          <button class="btn btn-small" data-accion="activo" type="button">${o.activo ? "Desactivar" : "Activar"}</button>
        </div></td>
      </tr>`;
    }).join("") : '<tr><td colspan="8" class="panel-hint">Sin cuentas. Pulsa "Nuevo operador".</td></tr>';
  } catch (err) {
    opMsg(err.message, true);
  }
}

// Campos segun el rol (alta) o la cuenta (edicion).
function opaAplicarRol() {
  const rol = opa.editando ? opa.editando.rol : $("opa-rol").value;
  const consulta = rol === "tecnico_consulta";
  const op = rol === "mantenimiento_op";
  $("opa-empleado-grupo").hidden = consulta;
  $("opa-empleado").required = op;
  $("opa-pin-grupo").hidden = !op;
  $("opa-password-grupo").hidden = op;
  $("opa-pin").required = op && !opa.editando;
  $("opa-password").required = !op && !opa.editando;
  const opcional = opa.editando ? " — vacío = sin cambio" : "";
  $("opa-pin-label").textContent = `PIN (4 dígitos)${opcional}`;
  $("opa-password-label").textContent = `Contraseña (mín. 8)${opcional}`;
  llenarEmpleados();
}

function abrirFormulario(cuenta) {
  opa.editando = cuenta || null;
  const f = $("form-operador");
  f.reset();
  $("opa-buscar").value = "";
  $("opa-titulo").textContent = cuenta ? `Editar ${cuenta.username}` : "Nueva cuenta";
  $("opa-guardar").textContent = cuenta ? "Guardar cambios" : "Dar de alta";
  $("opa-rol").disabled = Boolean(cuenta);
  $("opa-usuario").disabled = Boolean(cuenta);
  if (cuenta) {
    $("opa-rol").value = cuenta.rol;
    $("opa-usuario").value = cuenta.username;
    $("opa-nombre").value = cuenta.nombre;
  }
  opaAplicarRol();
  if (cuenta && cuenta.numeroEmpleado) $("opa-empleado").value = cuenta.numeroEmpleado;
  $("opa-historia").hidden = !(cuenta && cuenta.numeroEmpleado);
  f.hidden = false;
  opMsg("");
  (cuenta ? $("opa-nombre") : $("opa-rol")).focus();
  cargarPersonalMes().then(() => { if (cuenta && cuenta.numeroEmpleado) $("opa-empleado").value = cuenta.numeroEmpleado; });
}

function cerrarFormulario() {
  $("form-operador").hidden = true;
  opa.editando = null;
}

$("opa-nuevo").addEventListener("click", () => abrirFormulario(null));
$("opa-cancelar").addEventListener("click", cerrarFormulario);
$("opa-rol").addEventListener("change", opaAplicarRol);
$("opa-buscar").addEventListener("input", llenarEmpleados);
$("opa-empleado").addEventListener("change", () => {
  const p = opa.personal.find((x) => x.numeroEmpleado === $("opa-empleado").value);
  if (p && p.nombre && (!$("opa-nombre").value.trim() || !opa.editando)) $("opa-nombre").value = p.nombre;
});

$("form-operador").addEventListener("submit", async (e) => {
  e.preventDefault();
  opMsg("");
  $("opa-guardar").disabled = true;
  try {
    const cuenta = opa.editando;
    const rol = cuenta ? cuenta.rol : $("opa-rol").value;
    const secreto = rol === "mantenimiento_op" ? { pin: $("opa-pin").value } : { password: $("opa-password").value };
    if (!cuenta) {
      const body = { rol, nombre: $("opa-nombre").value.trim(), username: $("opa-usuario").value.trim(), ...secreto };
      if (rol !== "tecnico_consulta") body.numeroEmpleado = $("opa-empleado").value;
      const o = await adminApi("POST", "/api/admin/operadores", body);
      cerrarFormulario();
      opMsg(`Cuenta ${o.username} (${ROL_CUENTA_TXT[o.rol]}${o.numeroEmpleado ? ` · empleado #${o.numeroEmpleado}` : ""}) dada de alta.`);
    } else {
      const body = { nombre: $("opa-nombre").value.trim() };
      if (rol !== "tecnico_consulta" && $("opa-empleado").value !== (cuenta.numeroEmpleado || "")) body.numeroEmpleado = $("opa-empleado").value;
      if (Object.values(secreto)[0]) Object.assign(body, secreto);
      const o = await adminApi("PATCH", `/api/admin/operadores/${encodeURIComponent(cuenta.username)}`, body);
      cerrarFormulario();
      opMsg(`Cuenta ${o.username} actualizada${"numeroEmpleado" in body ? ` (empleado ${o.numeroEmpleado ? `#${o.numeroEmpleado}` : "quitado"})` : ""}.`);
    }
    await renderOperadores();
  } catch (err) {
    opMsg(err.message, true);
  } finally {
    $("opa-guardar").disabled = false;
  }
});

$("tabla-operadores").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const cuenta = opa.cuentas.find((o) => o.username === btn.closest("tr").dataset.usuario);
  if (!cuenta) return;
  const accion = btn.dataset.accion;
  if (accion === "editar") return abrirFormulario(cuenta);
  let body;
  if (accion === "secreto") {
    const esOp = cuenta.rol === "mantenimiento_op";
    const v = prompt(esOp ? `Nuevo PIN de 4 dígitos para ${cuenta.username}:` : `Nueva contraseña (mín. 8) para ${cuenta.username}:`);
    if (v == null || v === "") return;
    body = esOp ? { pin: v } : { password: v };
  } else {
    if (cuenta.activo && !confirm(`¿Desactivar la cuenta ${cuenta.username}? Sus sesiones abiertas se cierran.`)) return;
    body = { activo: !cuenta.activo };
  }
  opMsg("");
  try {
    await adminApi("PATCH", `/api/admin/operadores/${encodeURIComponent(cuenta.username)}`, body);
    opMsg(accion === "secreto" ? `${cuenta.rol === "mantenimiento_op" ? "PIN" : "Contraseña"} de ${cuenta.username} actualizado; bloqueos liberados y sesiones cerradas.` : `Cuenta ${cuenta.username} ${body.activo ? "activada" : "desactivada"}.`);
    await renderOperadores();
  } catch (err) {
    opMsg(err.message, true);
  }
});


/* ================================================================
 * ROL Y CAPACIDADES (el servidor decide; aqui solo se oculta lo que rechazaria)
 *   mantenimiento_admin  todo
 *   tecnico_consulta     Tiempo muerto · MTTR/MTBF · Desempeño · Histórico
 * ================================================================ */

const VISTAS_POR_CAPACIDAD = {
  tiempo: "dashboard", mttr: "dashboard", tecnicos: "dashboard", historico: "historico",
  contramedidas: "escribir", bonos: "escribir", calendarios: "escribir", documentos: "escribir",
  gastos: "escribir", entregas: "escribir", operadores: "admin", configuracion: "admin",
};

function aplicarCapacidades(caps, user) {
  state.capacidades = caps;
  const puede = (c) => caps.includes(c);
  document.querySelectorAll(".menu-item").forEach((b) => {
    const req = VISTAS_POR_CAPACIDAD[b.dataset.view] || "escribir";
    b.hidden = !puede(req);
  });
  $("btn-atender").hidden = !puede("operador") || !(user && user.numeroEmpleado);
  document.body.classList.toggle("rol-consulta", !puede("escribir"));
  if (!puede("escribir")) {
    const sub = document.querySelector(".brand p");
    if (sub) sub.textContent = "Consulta · Tiempo muerto · MTTR / MTBF · Desempeño · Histórico";
  }
}

fetch("/api/auth/me", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d && d.capacidades) aplicarCapacidades(d.capacidades, d.user); })
  .catch(() => {});

/* ================================================================
 * CONTRAMEDIDAS POR ACUMULACION DE FALLAS (KOIDE MES)
 * Debajo de "Agendar contramedida": equipo + categoria con >= umbral de horas.
 * ================================================================ */

async function loadRecomendaciones() {
  const tbody = $("tabla-recomendaciones").querySelector("tbody");
  try {
    const res = await fetch("/api/contramedidas/recomendaciones");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const d = await res.json();
    state.recomendaciones = d.recomendaciones || [];
    $("cm-reco-umbral").textContent = fmtNum(d.umbralHoras);
    const pend = state.recomendaciones.filter((r) => r.programacion && r.programacion.estado === "SIN_FECHA").length;
    $("cm-reco-cuenta").textContent = `${state.recomendaciones.length} recomendación(es) · umbral ${fmtNum(d.umbralHoras)} h${pend ? ` · ${pend} sin fecha automática` : ""}`;
    renderRecomendaciones();
  } catch (err) {
    $("cm-reco-cuenta").textContent = "no disponible";
    tbody.innerHTML = `<tr><td colspan="8" class="panel-hint">No se pudieron leer las recomendaciones: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderRecomendaciones() {
  const tbody = $("tabla-recomendaciones").querySelector("tbody");
  if (!state.recomendaciones.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="panel-hint">Ningún equipo alcanza el umbral de horas acumuladas por categoría de falla.</td></tr>';
    return;
  }
  tbody.innerHTML = state.recomendaciones.map((r, i) => `
    <tr data-reco="${i}">
      <td><strong>${escapeHtml(r.equipo.codigo)}</strong>${r.equipo.nombre ? ` · ${escapeHtml(r.equipo.nombre)}` : ""}${r.equipo.idMaquina ? `<br><span class="muted">${escapeHtml(r.equipo.idMaquina)}</span>` : ""}</td>
      <td>${escapeHtml(r.equipo.proceso || "—")}${r.equipo.area ? ` · ${escapeHtml(r.equipo.area)}` : ""}</td>
      <td>${escapeHtml(r.categoria.nombre)}</td>
      <td class="num"><strong>${fmtNum(r.horasAcumuladas)} h</strong></td>
      <td class="num">${fmtNum(r.paros)}</td>
      <td>${r.desde ? fmtDate(r.desde) : "—"}</td>
      <td>${r.hasta ? fmtDate(r.hasta) : "—"}</td>
      <td class="reco-alerta">⚠️ Se recomienda programar una contramedida / mantenimiento profundo para esta sección.${r.contramedidaPrevia ? `<br><span class="muted">Contramedida previa #${r.contramedidaPrevia.id} (cubría hasta ${fmtDateTime(r.contramedidaPrevia.cubreHasta)})</span>` : ""}
        <div class="reco-prog">${programacionRecoHtml(r.programacion)}<button type="button" class="btn btn-sm solo-escritura" data-reco-programar="${i}">${r.programacion && ["SIN_FECHA", "PENDIENTE_APROBACION", "RECHAZADA"].includes(r.programacion.estado) ? "Programar manualmente" : "Programar contramedida"}</button></div></td>
    </tr>`).join("");
  tbody.querySelectorAll("button[data-reco-programar]").forEach((btn) => {
    btn.addEventListener("click", () => programarDesdeRecomendacion(state.recomendaciones[Number(btn.dataset.recoProgramar)]));
  });
}

function programarDesdeRecomendacion(r) {
  if (!r) return;
  resetForm();
  state.cmRecomendacion = { clave: r.clave, ciclo: r.ciclo, equipo: r.equipo.codigo, categoriaCodigo: r.categoria.codigo, recomendacion: r.recomendacion };
  populateMaquinaSelect();
  const selMaq = $("cm-maquina");
  if (![...selMaq.options].some((o) => o.value === r.equipo.codigo)) selMaq.appendChild(new Option(`${r.equipo.codigo}${r.equipo.nombre ? ` · ${r.equipo.nombre}` : ""}`, r.equipo.codigo));
  selMaq.value = r.equipo.codigo;
  onMaquinaChange();
  const selTipo = $("cm-tipo");
  if (![...selTipo.options].some((o) => o.value === r.categoria.nombre)) selTipo.appendChild(new Option(r.categoria.nombre, r.categoria.nombre));
  selTipo.value = r.categoria.nombre;
  $("form-titulo").textContent = `Programar contramedida · ${r.equipo.codigo} · ${r.categoria.nombre}`;
  const hint = document.createElement("p");
  hint.className = "panel-hint";
  hint.id = "cm-reco-en-captura";
  hint.textContent = `Recomendación por acumulación: ${fmtNum(r.horasAcumuladas)} h en ${fmtNum(r.paros)} paro(s). Al guardar se registra también en KOIDE MES y la recomendación se da por atendida.`;
  $("form-contramedida").prepend(hint);
  $("cm-cancel").hidden = false;
  $("view-contramedidas").scrollIntoView({ behavior: "smooth", block: "start" });
  $("cm-responsable").focus();
}

/* ================================================================
 * PROGRAMACION AUTOMATICA DE CONTRAMEDIDAS
 * Deteccion (KOIDE MES) -> busqueda de fecha -> PENDIENTE DE APROBACION ->
 * un administrador aprueba / reprograma / rechaza. Nada se confirma solo.
 * ================================================================ */

const CM_PROG_ESTADO = {
  PENDIENTE_APROBACION: ["Pendiente de aprobación", "warn"],
  EN_APROBACION: ["Aprobando…", "info"],
  CONFIRMADA: ["Confirmada", "ok"],
  RECHAZADA: ["Rechazada", "open"],
};
const CM_ORIGEN = { AUTOMATICA: "Automática", MANUAL: "Manual" };

async function cmApi(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  // 404 de una ruta de este modulo = el servidor en ejecucion es anterior a
  // estos archivos (se sirven del disco, la API vive en memoria).
  if (res.status === 404 && d.error === "No encontrado") {
    throw new Error("El servidor en ejecución no tiene este módulo (arrancó con una versión anterior del código). Reinícialo: npm run stop y después npm start.");
  }
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

function programacionRecoHtml(p) {
  if (!p) return "";
  if (p.estado === "SIN_FECHA") return '<span class="reco-prog-aviso">⚠ No se encontró una fecha disponible para programación automática.</span>';
  if (p.estado === "AUTOMATICA_INACTIVA") return '<span class="muted">Programación automática desactivada.</span>';
  if (p.estado === "SIN_PROPUESTA") return `<span class="muted">Fecha disponible: ${fmtDate(p.fechaDisponible)} (se propondrá en la siguiente revisión).</span>`;
  const [txt, cls] = CM_PROG_ESTADO[p.estado] || [p.estado, "info"];
  const fecha = p.estado === "CONFIRMADA" ? p.fechaConfirmada : p.estado === "PENDIENTE_APROBACION" ? p.fechaPropuesta : null;
  return `<span class="badge-status ${cls}">${escapeHtml(txt)}</span>${fecha ? ` <span class="muted">${fmtDate(fecha)}</span>` : ""}${p.estado === "RECHAZADA" && p.motivo ? `<br><span class="muted">Motivo: ${escapeHtml(p.motivo)}</span>` : ""}`;
}

// ejecutar: correr antes la busqueda automatica (idempotente) para que las
// recomendaciones nuevas lleguen ya con su propuesta.
async function refrescarProgramacionCm({ ejecutar = false } = {}) {
  if (ejecutar) {
    try {
      await cmApi("POST", "/api/contramedidas/programacion-automatica", {});
    } catch (err) {
      console.warn("Programación automática no disponible:", err.message);
    }
  }
  await Promise.all([loadRecomendaciones(), loadPendientesCm(), loadConfirmadasCm()]);
}

async function loadPendientesCm() {
  const cont = $("cm-pend-lista");
  try {
    state.cmPendientes = await cmApi("GET", "/api/contramedidas/propuestas?estado=PENDIENTE_APROBACION");
    renderPendientesCm();
  } catch (err) {
    $("cm-pend-cuenta").textContent = "no disponible";
    cont.innerHTML = `<p class="panel-hint">No se pudieron leer las propuestas: ${escapeHtml(err.message)}</p>`;
  }
}

function renderPendientesCm() {
  const cont = $("cm-pend-lista");
  const lista = state.cmPendientes;
  $("cm-pend-cuenta").textContent = `${lista.length} pendiente(s)`;
  if (!lista.length) {
    cont.innerHTML = '<p class="panel-hint">No hay contramedidas esperando aprobación.</p>';
    return;
  }
  cont.innerHTML = lista.map((p) => {
    const [txt, cls] = CM_PROG_ESTADO[p.estado] || [p.estado, "info"];
    const ocupada = p.estado !== "PENDIENTE_APROBACION";
    return `
    <article class="cm-pend-card" data-prop="${p.id}">
      <header class="cm-pend-head">
        <div>
          <strong class="cm-pend-equipo">${escapeHtml(p.equipo.codigo)}</strong>${p.equipo.nombre ? ` <span class="muted">· ${escapeHtml(p.equipo.nombre)}</span>` : ""}
        </div>
        <span class="badge-status ${cls}">${escapeHtml(txt)}</span>
      </header>
      <dl class="cm-pend-datos">
        <div><dt>Falla</dt><dd>${escapeHtml(p.categoria.nombre || p.categoria.codigo || "—")}</dd></div>
        <div><dt>Acumulado</dt><dd>${p.horasAcumuladas != null ? `${fmtNum(p.horasAcumuladas)} h` : "—"}</dd></div>
        <div><dt>Fecha propuesta</dt><dd class="cm-pend-fecha">${fmtDate(p.fechaPropuesta)}</dd></div>
        <div><dt>Origen</dt><dd>Programación automática</dd></div>
        <div><dt>Recomendación</dt><dd>${fmtDateTime(p.detectadaEn)}</dd></div>
        ${p.reprogramaciones ? `<div><dt>Reprogramada</dt><dd>${p.reprogramaciones} vez/veces${p.motivo ? ` · ${escapeHtml(p.motivo)}` : ""}</dd></div>` : ""}
      </dl>
      ${p.vigente === false ? '<p class="cm-pend-aviso">⚠ Esta recomendación ya fue atendida por otra contramedida. Recházala para cerrar la propuesta.</p>' : ""}
      <div class="form-actions">
        <button type="button" class="btn btn-sm btn-ok" data-prop-accion="aprobar" ${ocupada || p.vigente === false ? "disabled" : ""}>Aprobar</button>
        <button type="button" class="btn btn-sm btn-ghost" data-prop-accion="reprogramar" ${ocupada ? "disabled" : ""}>Reprogramar</button>
        <button type="button" class="btn btn-sm btn-danger btn-ghost" data-prop-accion="rechazar" ${ocupada ? "disabled" : ""}>Rechazar</button>
      </div>
    </article>`;
  }).join("");
}

$("cm-pend-lista").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-prop-accion]");
  if (!btn) return;
  const id = Number(btn.closest("[data-prop]").dataset.prop);
  const p = state.cmPendientes.find((x) => x.id === id);
  if (!p) return;
  const accion = btn.dataset.propAccion;
  if (accion === "reprogramar") return abrirReprogramarCm(p);
  if (accion === "rechazar") return abrirRechazarCm(p);
  if (!confirm(`¿Aprobar la contramedida de ${p.equipo.codigo} (${p.categoria.nombre || p.categoria.codigo}) para el ${fmtDate(p.fechaPropuesta)}?\n\nSe registrará en KOIDE MES y quedará en el calendario de seguimiento.`)) return;
  btn.disabled = true;
  try {
    await cmApi("POST", `/api/contramedidas/propuestas/${id}/aprobar`, {});
    await Promise.all([loadContramedidas(), refrescarProgramacionCm()]);
  } catch (err) {
    alert("No se pudo aprobar: " + err.message);
    await loadPendientesCm();
  }
});

function cerrarModalCm(id) {
  $(id).classList.add("hidden-modal");
  state.cmPropActual = null;
}

document.querySelectorAll("[data-cerrar-modal]").forEach((b) => b.addEventListener("click", () => cerrarModalCm(b.dataset.cerrarModal)));
["modal-cm-reprogramar", "modal-cm-rechazar"].forEach((id) => {
  $(id).addEventListener("click", (e) => { if (e.target.id === id) cerrarModalCm(id); });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["modal-cm-reprogramar", "modal-cm-rechazar"].forEach((id) => { if (!$(id).classList.contains("hidden-modal")) cerrarModalCm(id); });
});

async function abrirReprogramarCm(p) {
  state.cmPropActual = p;
  $("cm-rep-ref").textContent = `${p.equipo.codigo} · ${p.categoria.nombre || p.categoria.codigo} · fecha propuesta: ${fmtDate(p.fechaPropuesta)}`;
  $("cm-rep-motivo").value = "";
  const sel = $("cm-rep-fecha");
  sel.innerHTML = '<option value="">Buscando fechas disponibles…</option>';
  sel.disabled = true;
  $("cm-rep-guardar").disabled = true;
  $("modal-cm-reprogramar").classList.remove("hidden-modal");
  try {
    const d = await cmApi("GET", `/api/contramedidas/propuestas/${p.id}/fechas-disponibles`);
    const otras = d.fechas.filter((f) => f !== p.fechaPropuesta);
    sel.innerHTML = otras.length
      ? otras.map((f) => `<option value="${f}">${fmtDate(f)} · ${DIAS_SEMANA_CFG[diaSemanaCfg(f) - 1]}</option>`).join("")
      : '<option value="">No hay otra fecha disponible en el horizonte de programación</option>';
    sel.disabled = !otras.length;
    $("cm-rep-guardar").disabled = !otras.length;
  } catch (err) {
    sel.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
  }
}

$("cm-rep-guardar").addEventListener("click", async () => {
  const p = state.cmPropActual;
  if (!p) return;
  const fecha = $("cm-rep-fecha").value;
  const motivo = $("cm-rep-motivo").value.trim();
  if (!fecha) return alert("Selecciona una fecha disponible.");
  if (motivo.length < 3) return alert("Indica el motivo de la reprogramación.");
  $("cm-rep-guardar").disabled = true;
  try {
    await cmApi("POST", `/api/contramedidas/propuestas/${p.id}/reprogramar`, { fecha, motivo });
    cerrarModalCm("modal-cm-reprogramar");
    await refrescarProgramacionCm();
  } catch (err) {
    alert("No se pudo reprogramar: " + err.message);
  } finally {
    $("cm-rep-guardar").disabled = false;
  }
});

function abrirRechazarCm(p) {
  state.cmPropActual = p;
  $("cm-rech-ref").textContent = `${p.equipo.codigo} · ${p.categoria.nombre || p.categoria.codigo} · ${fmtNum(p.horasAcumuladas || 0)} h · propuesta para el ${fmtDate(p.fechaPropuesta)}`;
  $("cm-rech-motivo").value = "";
  $("modal-cm-rechazar").classList.remove("hidden-modal");
  $("cm-rech-motivo").focus();
}

$("cm-rech-guardar").addEventListener("click", async () => {
  const p = state.cmPropActual;
  if (!p) return;
  const motivo = $("cm-rech-motivo").value.trim();
  if (motivo.length < 3) return alert("Indica el motivo del rechazo.");
  $("cm-rech-guardar").disabled = true;
  try {
    await cmApi("POST", `/api/contramedidas/propuestas/${p.id}/rechazar`, { motivo });
    cerrarModalCm("modal-cm-rechazar");
    await refrescarProgramacionCm();
  } catch (err) {
    alert("No se pudo rechazar: " + err.message);
  } finally {
    $("cm-rech-guardar").disabled = false;
  }
});

async function loadConfirmadasCm() {
  const tbody = $("tabla-cm-confirmadas").querySelector("tbody");
  const estado = $("cm-conf-estado").value;
  try {
    const lista = await cmApi("GET", `/api/contramedidas/propuestas?estado=${encodeURIComponent(estado)}`);
    lista.sort((a, b) => String(b.resueltaEn || "").localeCompare(String(a.resueltaEn || "")));
    $("cm-conf-cuenta").textContent = `${lista.length} registro(s)`;
    if (!lista.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="panel-hint">${estado === "RECHAZADA" ? "No hay propuestas rechazadas." : "Aún no hay contramedidas confirmadas."}</td></tr>`;
      return;
    }
    tbody.innerHTML = lista.map((p) => {
      const [txt, cls] = CM_PROG_ESTADO[p.estado] || [p.estado, "info"];
      return `<tr>
        <td><strong>${escapeHtml(p.equipo.codigo)}</strong>${p.equipo.nombre ? `<br><span class="muted">${escapeHtml(p.equipo.nombre)}</span>` : ""}</td>
        <td>${escapeHtml(p.categoria.nombre || p.categoria.codigo || "—")}</td>
        <td class="num">${p.horasAcumuladas != null ? `${fmtNum(p.horasAcumuladas)} h` : "—"}</td>
        <td>${fmtDateTime(p.detectadaEn)}</td>
        <td>${p.fechaPropuesta ? fmtDate(p.fechaPropuesta) : "—"}</td>
        <td>${p.fechaConfirmada ? fmtDate(p.fechaConfirmada) : "—"}</td>
        <td><span class="badge-origen ${p.origen === "AUTOMATICA" ? "auto" : "manual"}">${escapeHtml(CM_ORIGEN[p.origen] || p.origen)}</span></td>
        <td>${escapeHtml(p.resueltaPor || "—")}<br><span class="muted">${fmtDateTime(p.resueltaEn)}</span></td>
        <td><span class="badge-status ${cls}">${escapeHtml(txt)}</span>${p.estado === "RECHAZADA" && p.motivo ? `<br><span class="muted">${escapeHtml(p.motivo)}</span>` : ""}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    $("cm-conf-cuenta").textContent = "no disponible";
    tbody.innerHTML = `<tr><td colspan="9" class="panel-hint">No se pudieron leer las contramedidas confirmadas: ${escapeHtml(err.message)}</td></tr>`;
  }
}

$("cm-conf-estado").addEventListener("change", loadConfirmadasCm);

/* ================================================================
 * CONFIGURACION DEL SISTEMA (solo administradores)
 * Los parametros y sus limites vienen del servidor (lib/configuracion.js).
 * ================================================================ */

const DIAS_SEMANA_CFG = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function diaSemanaCfg(fecha) {
  const w = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

function cfgValorTexto(p, texto) {
  if (texto === null || texto === undefined) return "—";
  if (p && p.tipo === "booleano") return texto === "1" ? "Activada" : "Desactivada";
  if (p && p.tipo === "dias_semana") return String(texto).split(",").map((n) => DIAS_SEMANA_CFG[Number(n) - 1] || n).join(", ");
  return `${texto}${p && p.unidad ? ` ${p.unidad}` : ""}`;
}

function cfgCampoHtml(p) {
  const id = `cfg-${p.clave}`;
  const off = p.disponible === false ? "disabled" : "";
  let control;
  if (p.tipo === "booleano") {
    control = `<label class="cfg-switch"><input type="checkbox" id="${id}" data-cfg="${p.clave}" ${p.valor ? "checked" : ""} ${off} /><span>${p.valor ? "Activada" : "Desactivada"}</span></label>`;
  } else if (p.tipo === "dias_semana") {
    control = `<div class="cfg-dias" role="group" aria-labelledby="${id}-lbl">${DIAS_SEMANA_CFG.map((d, i) => `
      <label class="cfg-dia"><input type="checkbox" data-cfg-dia="${p.clave}" value="${i + 1}" ${(p.valor || []).includes(i + 1) ? "checked" : ""} ${off} /><span>${d}</span></label>`).join("")}</div>`;
  } else {
    const step = p.tipo === "entero" ? "1" : "0.01";
    const v = p.valor === null || p.valor === undefined ? "" : p.tipo === "entero" ? String(p.valor) : Number(p.valor).toFixed(2);
    control = `<div class="cfg-numero"><input type="number" id="${id}" data-cfg="${p.clave}" value="${v}" min="${p.min}" max="${p.max}" step="${step}" inputmode="decimal" ${off} />${p.unidad ? `<span class="cfg-unidad">${escapeHtml(p.unidad)}</span>` : ""}</div>`;
  }
  const meta = p.disponible === false
    ? `<span class="cfg-aviso">⚠ ${escapeHtml(p.error || "No disponible")}</span>`
    : `<span class="cfg-meta">${p.fuente === "mes" ? "Se guarda en KOIDE MES" : p.actualizadoPor ? `Última modificación: ${escapeHtml(p.actualizadoPor)} · ${fmtDateTime(p.actualizado)}` : `Valor inicial: ${escapeHtml(cfgValorTexto(p, Array.isArray(p.porDefecto) ? p.porDefecto.join(",") : p.tipo === "booleano" ? (p.porDefecto ? "1" : "0") : String(p.porDefecto)))}`}</span>`;
  return `
    <div class="cfg-campo">
      <div class="cfg-campo-texto">
        <label ${p.tipo === "dias_semana" ? `id="${id}-lbl"` : `for="${id}"`} class="cfg-etiqueta">${escapeHtml(p.etiqueta)}</label>
        <p class="cfg-desc">${escapeHtml(p.descripcion)}</p>
        ${meta}
      </div>
      <div class="cfg-control">${control}</div>
    </div>`;
}

function cfgLeerFormulario() {
  const valores = {};
  for (const p of state.cfg.parametros) {
    if (p.disponible === false) continue;
    let v;
    if (p.tipo === "booleano") v = $(`cfg-${p.clave}`).checked;
    else if (p.tipo === "dias_semana") v = [...document.querySelectorAll(`input[data-cfg-dia="${p.clave}"]:checked`)].map((x) => Number(x.value));
    else v = $(`cfg-${p.clave}`).value.trim();
    const actual = p.tipo === "dias_semana" ? (p.valor || []).join(",") : String(p.valor);
    const nuevo = p.tipo === "dias_semana" ? v.join(",") : p.tipo === "booleano" ? String(v) : String(Number(v));
    if (nuevo !== actual) valores[p.clave] = v;
  }
  return valores;
}

async function renderConfiguracion() {
  const cont = $("cfg-grupos");
  $("cfg-msg").textContent = "";
  try {
    const d = await cmApi("GET", "/api/configuracion");
    state.cfg.parametros = d.parametros;
    const grupos = [...new Set(d.parametros.map((p) => p.grupo))];
    cont.innerHTML = grupos.map((g) => `
      <fieldset class="cfg-grupo">
        <legend>${escapeHtml(g)}</legend>
        ${d.parametros.filter((p) => p.grupo === g).map(cfgCampoHtml).join("")}
      </fieldset>`).join("");
    $("cfg-estado").textContent = `${d.parametros.length} parámetros`;
  } catch (err) {
    cont.innerHTML = `<p class="panel-hint">No se pudo leer la configuración: ${escapeHtml(err.message)}</p>`;
  }
  renderCfgAuditoria();
}

async function renderCfgAuditoria() {
  const tbody = $("tabla-cfg-auditoria").querySelector("tbody");
  try {
    const filas = await cmApi("GET", "/api/auditoria?entidad=configuracion&limite=50");
    const porClave = new Map(state.cfg.parametros.map((p) => [p.clave, p]));
    tbody.innerHTML = filas.length ? filas.map((a) => {
      const p = porClave.get(a.entidadId);
      return `<tr>
        <td>${fmtDateTime(a.en)}</td>
        <td>${escapeHtml(a.usuario)}</td>
        <td>${escapeHtml(p ? p.etiqueta : a.entidadId)}</td>
        <td>${escapeHtml(cfgValorTexto(p, a.anterior))}</td>
        <td><strong>${escapeHtml(cfgValorTexto(p, a.nuevo))}</strong></td>
      </tr>`;
    }).join("") : '<tr><td colspan="5" class="panel-hint">Sin cambios registrados.</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="panel-hint">No se pudo leer el historial: ${escapeHtml(err.message)}</td></tr>`;
  }
}

$("cfg-grupos").addEventListener("change", (e) => {
  const sw = e.target.closest(".cfg-switch input");
  if (sw) sw.nextElementSibling.textContent = sw.checked ? "Activada" : "Desactivada";
});

$("form-configuracion").addEventListener("submit", async (e) => {
  e.preventDefault();
  const valores = cfgLeerFormulario();
  const msg = $("cfg-msg");
  msg.className = "cfg-msg";
  if (!Object.keys(valores).length) {
    msg.textContent = "No hay cambios que guardar.";
    return;
  }
  const umbral = valores.contramedida_umbral_horas;
  if (umbral !== undefined && !confirm(`¿Cambiar el umbral para recomendar contramedidas a ${umbral} h?\n\nAfecta las recomendaciones de todos los equipos.`)) return;
  $("cfg-guardar").disabled = true;
  try {
    const d = await cmApi("PUT", "/api/configuracion", { valores });
    msg.textContent = d.cambios.length ? `Configuración guardada (${d.cambios.length} cambio(s)).` : "Sin cambios.";
    msg.classList.add("ok");
    await renderConfiguracion();
    msg.textContent = d.cambios.length ? `Configuración guardada (${d.cambios.length} cambio(s)).` : "Sin cambios.";
    msg.classList.add("ok");
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add("error");
  } finally {
    $("cfg-guardar").disabled = false;
  }
});

/* ================================================================
 * HISTORICO DE PAROS (KOIDE MES, cualquier proceso; solo lectura)
 * ================================================================ */

const HIST_ESTADO = { CERRADO: ["Cerrado", "ok"], ANULADO: ["Anulado", "open"], DECLARADO: ["Esperando mantenimiento", "open"], EN_ATENCION: ["En reparación", "warn"], EN_ESPERA_EXTERNA: ["En espera externa", "warn"], PENDIENTE_CIERRE: ["Atención terminada (histórico)", "info"] };
const HIST_ROL = { inicio: "inició", continuidad: "continuidad", finalizo: "finalizó" };
const HIST_EVENTO = { DECLARADO: "Paro declarado", ACEPTADO: "Atención iniciada", CONTINUIDAD: "Toma de continuidad", ESPERA_EXTERNA_INICIO: "Inicio de espera externa", ESPERA_EXTERNA_FIN: "Fin de espera externa", EVIDENCIA_AGREGADA: "Evidencia agregada", FINALIZADO: "Atención finalizada · paro cerrado", CIERRE_VALIDADO: "Código de cierre validado (histórico)", CIERRE_INTENTO_FALLIDO: "Intento de cierre fallido (histórico)", CIERRE_BLOQUEADO: "Cierre bloqueado (histórico)", CIERRE_MIGRADO_090: "Cerrado por migración (fin del doble código)", ANULADO: "Anulado por supervisión", IMPORTADO_LEGACY: "Importado del sistema anterior" };

function histTecnicosHtml(t) {
  if (!t || !t.length) return "—";
  return `<ul class="part-list">${t.map((x) => `<li><strong>${escapeHtml(x.nombre || x.numeroEmpleado)}</strong> <span class="muted">${escapeHtml(x.numeroEmpleado)}</span>${x.rolSnapshot ? ` · <span class="rol-tag rol-${x.rolSnapshot === "mantenimiento_admin" ? "admin" : "op"}">${rolTxt(x.rolSnapshot)}</span>` : ""} · ${escapeHtml((x.roles || []).map((r) => HIST_ROL[r] || r).join(", "))}${x.minutosAsignados != null ? ` <span class="part-min">${fmtHM(x.minutosAsignados)}</span>` : ""}</li>`).join("")}</ul>`;
}

async function loadHistCatalogos() {
  if (state.hist.catalogos) return state.hist.catalogos;
  try {
    const res = await fetch("/api/historico/catalogos");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.hist.catalogos = await res.json();
  } catch {
    state.hist.catalogos = { categorias: [], procesos: [], personal: [] };
  }
  const c = state.hist.catalogos;
  const selP = $("hist-proceso");
  selP.innerHTML = '<option value="">Todos</option>' + (c.procesos || []).map((p) => `<option value="${escapeHtml(p.codigo)}">${escapeHtml(p.nombre || p.codigo)}</option>`).join("");
  const selC = $("hist-categoria");
  selC.innerHTML = '<option value="">Todas</option>' + (c.categorias || []).map((x) => `<option value="${escapeHtml(x.codigo)}">${escapeHtml(x.nombre)}</option>`).join("");
  $("hist-tecnicos").innerHTML = (c.personal || []).map((p) => `<option value="${escapeHtml(p.numeroEmpleado)}">${escapeHtml(p.nombre || "")}</option>`).join("");
  $("hist-equipos").innerHTML = (state.machines || []).map((m) => `<option value="${escapeHtml(m.code)}">${escapeHtml(m.name || "")}</option>`).join("");
  return c;
}

function histFiltros() {
  return {
    desde: $("hist-desde").value, hasta: $("hist-hasta").value, proceso: $("hist-proceso").value, equipo: $("hist-equipo").value.trim(),
    categoria: $("hist-categoria").value, tecnico: $("hist-tecnico").value.trim(), estado: $("hist-estado").value, q: $("hist-q").value.trim(),
    limite: state.hist.limite, offset: state.hist.offset,
  };
}

async function loadHistorico() {
  const msg = $("hist-msg");
  msg.hidden = true;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(histFiltros())) if (v !== "" && v !== null && v !== undefined) q.set(k, v);
  try {
    const res = await fetch(`/api/historico/paros?${q}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    state.hist.filas = d.filas || [];
    state.hist.total = d.total || 0;
    renderHistorico();
  } catch (err) {
    msg.hidden = false;
    msg.textContent = `No se pudo consultar el histórico en KOIDE MES: ${err.message}`;
  }
}

function renderHistorico() {
  const tbody = $("tabla-historico").querySelector("tbody");
  const h = state.hist;
  $("hist-cuenta").textContent = `${fmtNum(h.total)} paros`;
  $("hist-pagina").textContent = h.total ? `${h.offset + 1}–${Math.min(h.offset + h.filas.length, h.total)} de ${fmtNum(h.total)}` : "—";
  $("hist-prev").disabled = h.offset <= 0;
  $("hist-next").disabled = h.offset + h.filas.length >= h.total;
  if (!h.filas.length) {
    tbody.innerHTML = '<tr><td colspan="17" class="panel-hint">Sin paros con esos filtros.</td></tr>';
    return;
  }
  tbody.innerHTML = h.filas.map((p, i) => {
    const [txt, cls] = HIST_ESTADO[p.estado] || [p.estado, "info"];
    return `<tr data-hist="${i}">
      <td>${fmtDate(p.fecha)}</td>
      <td>${escapeHtml(p.turno || "—")}</td>
      <td>${escapeHtml(p.proceso ? p.proceso.nombre || p.proceso.codigo : "—")}</td>
      <td>${escapeHtml(p.area || "—")}</td>
      <td><strong>${escapeHtml(p.equipo.codigo)}</strong>${p.equipo.nombre ? ` · ${escapeHtml(p.equipo.nombre)}` : ""}</td>
      <td>${escapeHtml(p.linea || "—")}</td>
      <td>${escapeHtml(p.categoria ? p.categoria.nombre : "—")}</td>
      <td>${escapeHtml(p.problemaDetectado || p.descripcionOperador || "—")}</td>
      <td>${histTecnicosHtml(p.tecnicos)}</td>
      <td>${fmtDateTime(p.inicio)}</td>
      <td>${p.inicioAtencion ? fmtDateTime(p.inicioAtencion) : "—"}</td>
      <td>${p.finalizadoEn ? fmtDateTime(p.finalizadoEn) : p.fin ? fmtDateTime(p.fin) : "—"}</td>
      <td class="num">${p.tiempoTotalMin != null ? fmtHours(p.tiempoTotalMin) : "—"}</td>
      <td class="num">${p.esperaExternaMin ? `${fmtNum(p.esperaExternaMin)} min` : "—"}</td>
      <td><span class="badge-status ${cls}">${escapeHtml(txt)}</span></td>
      <td class="num">${fmtNum((p.evidencias || []).length)}</td>
      <td><button type="button" class="btn btn-sm btn-ghost" data-hist-ver="${p.id}">Ver</button></td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("button[data-hist-ver]").forEach((btn) => btn.addEventListener("click", () => verHistorico(btn.dataset.histVer)));
}

async function verHistorico(id) {
  try {
    const res = await fetch(`/api/historico/paros/${encodeURIComponent(id)}`);
    const p = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(p.error || `HTTP ${res.status}`);
    const [txt] = HIST_ESTADO[p.estado] || [p.estado];
    $("hist-det-titulo").textContent = `Paro #${p.id} · ${p.equipo.codigo}${p.equipo.nombre ? ` · ${p.equipo.nombre}` : ""} · ${txt}`;
    const pares = [
      ["Proceso", p.proceso ? p.proceso.nombre || p.proceso.codigo : "—"], ["Área", p.area || "—"], ["Ubicación", p.ubicacion || "—"],
      ["Línea MES", p.linea || "sin línea MES"], ["Terminal de origen", p.terminal ? `${p.terminal.uid}${p.terminal.posicion ? ` · posición ${p.terminal.posicion}` : ""}${p.terminal.tipo ? ` · ${p.terminal.tipo}` : ""}` : "—"],
      ["Fecha / turno", `${fmtDate(p.fecha)}${p.turno ? ` · ${p.turno}` : ""}${p.grupo ? ` · grupo ${p.grupo}` : ""}`],
      ["Código de atención", p.codigoAtencion || "—"], ["Reportó", p.reportadoPor ? `${p.reportadoPor.nombre || ""} ${p.reportadoPor.numeroEmpleado ? `#${p.reportadoPor.numeroEmpleado}` : ""}`.trim() : "—"],
      ["Nota del operador", p.descripcionOperador || "—"], ["Categoría de falla", p.categoria ? p.categoria.nombre : "—"],
      ["Problema detectado", p.problemaDetectado || "—"], ["Trabajo realizado", p.accionRealizada || "—"], ["Comentarios", p.comentarios || "—"],
      ["Inicio del paro", fmtDateTime(p.inicio)], ["Inicio de atención", p.inicioAtencion ? fmtDateTime(p.inicioAtencion) : "—"],
      ["Finalización", p.finalizadoEn ? fmtDateTime(p.finalizadoEn) : "—"], ["Cierre", p.cierre ? `${fmtDateTime(p.cierre.en)} · ${p.cierre.modo === "finalizacion" ? "por mantenimiento al finalizar" : p.cierre.modo === "codigo" ? "con código (histórico)" : p.cierre.modo === "supervisor" ? "anulado por supervisión" : p.cierre.modo}` : "—"],
      ["Tiempo total", p.tiempoTotalMin != null ? fmtHours(p.tiempoTotalMin) : "—"], ["Respuesta", p.respuestaMin != null ? `${fmtNum(p.respuestaMin)} min` : "—"],
      ["Reparación (sin espera externa)", p.reparacionMin != null ? `${fmtNum(p.reparacionMin)} min` : "—"], ["Espera externa", p.esperaExternaMin ? `${fmtNum(p.esperaExternaMin)} min${p.esperaExterna && p.esperaExterna.nota ? ` · ${p.esperaExterna.nota}` : ""}` : "—"],
      ["Estado", txt], ["Motivo de anulación", p.cierre && p.cierre.anuladoMotivo ? p.cierre.anuladoMotivo : "—"],
    ];
    $("hist-det-datos").innerHTML = pares.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("");
    $("hist-det-tecnicos").innerHTML = (p.tecnicos || []).length ? histTecnicosHtml(p.tecnicos).replace(/^<ul class="part-list">|<\/ul>$/g, "") : "<li>—</li>";
    $("hist-det-evidencias").innerHTML = (p.evidencias || []).length ? p.evidencias.map((e) => `<figure><a href="${e.url}" target="_blank" rel="noopener"><img src="${e.url}" alt="${escapeHtml(e.tipo)}" loading="lazy" /></a><figcaption>${escapeHtml(e.tipo)}${e.etapa ? ` · ${escapeHtml(e.etapa)}` : ""}${e.descripcion ? ` · ${escapeHtml(e.descripcion)}` : ""}<br>${e.subidoPor ? `#${escapeHtml(e.subidoPor.numeroEmpleado || "?")}${e.subidoPor.usuario ? ` (${escapeHtml(e.subidoPor.usuario)})` : ""} · ` : ""}${e.creado ? fmtDateTime(e.creado) : ""}</figcaption></figure>`).join("") : '<span class="muted">Sin evidencias.</span>';
    $("hist-det-eventos").querySelector("tbody").innerHTML = (p.eventos || []).map((e) => `<tr><td>${fmtDateTime(e.creado)}</td><td>${escapeHtml(HIST_EVENTO[e.evento] || e.evento)}</td><td class="mono">${escapeHtml(e.actor || e.actorTipo || "—")}</td><td class="mono">${escapeHtml(e.detalle ? JSON.stringify(e.detalle) : "")}</td></tr>`).join("") || '<tr><td colspan="4">—</td></tr>';
    $("hist-detalle").hidden = false;
    $("hist-detalle").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    alert(`No se pudo abrir el paro: ${err.message}`);
  }
}

async function renderHistoricoView() {
  await loadHistCatalogos();
  if (!$("hist-desde").value && !$("hist-hasta").value && !state.hist.filas.length) {
    const hoy = today();
    $("hist-hasta").value = hoy;
    $("hist-desde").value = isoDate(new Date(Date.now() - 30 * 86400000));
  }
  await loadHistorico();
}

$("hist-buscar").addEventListener("click", () => { state.hist.offset = 0; loadHistorico(); });
$("hist-limpiar").addEventListener("click", () => {
  for (const id of ["hist-desde", "hist-hasta", "hist-equipo", "hist-tecnico", "hist-q"]) $(id).value = "";
  $("hist-proceso").value = ""; $("hist-categoria").value = ""; $("hist-estado").value = "terminados";
  state.hist.offset = 0;
  loadHistorico();
});
$("hist-prev").addEventListener("click", () => { state.hist.offset = Math.max(0, state.hist.offset - state.hist.limite); loadHistorico(); });
$("hist-next").addEventListener("click", () => { state.hist.offset += state.hist.limite; loadHistorico(); });
$("hist-det-cerrar").addEventListener("click", () => { $("hist-detalle").hidden = true; });
["hist-equipo", "hist-tecnico", "hist-q"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("hist-buscar").click(); } }));
