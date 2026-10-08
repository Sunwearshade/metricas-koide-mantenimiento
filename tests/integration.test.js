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
const PERSONAL_MES = ["1382", "2000", "3000", "7777", "7778", "4001", "4002", "4003"].map((n) => ({ numeroEmpleado: n, nombre: `TECNICO ${n}` }));
// Catalogo completo del MES (/personal): activos + inactivos. mesPersonalBaja
// simula que el MES da de baja a un empleado despues de asociarlo.
const PERSONAL_MES_INACTIVO = [{ numeroEmpleado: "8888", nombre: "TECNICO BAJA" }];
const mesPersonalBaja = new Set();
const mesFotos = new Map();
// Contramedidas por acumulacion (MES mig 090): recomendaciones y registro.
let mesRecomendaciones = [{ clave: "M1|falla_hidraulica", equipo: { id: 1, codigo: "M1", nombre: "MAQ-1", proceso: "CORTE", idMaquina: null, area: null, ubicacion: null },
  categoria: { codigo: "falla_hidraulica", nombre: "Falla hidráulica" }, horasAcumuladas: 23.6, minutosAcumulados: 1416, paros: 4, parosIds: [1, 2, 3, 4],
  desde: "2026-09-01T10:00:00.000Z", hasta: "2026-09-20T10:00:00.000Z", umbralHoras: 20, alcanzaUmbral: true, contramedidaPrevia: null,
  recomendacion: "M1 — Falla hidráulica — 23.6 h acumuladas. Se recomienda programar una contramedida / mantenimiento profundo para esta seccion." }];
const mesContramedidas = [];
let mesUmbral = 20; // mtto_parametros.contramedida_umbral_horas
function mesEvidencia(f, etapa, actor) {
  const id = mesFotos.size + 1;
  mesFotos.set(id, Buffer.from(f.base64, "base64"));
  return { id, tipo: f.tipo, etapa, nombre: f.nombre, descripcion: f.descripcion || null, mime: "image/png", bytes: mesFotos.get(id).length,
    subidoPor: { numeroEmpleado: actor, usuario: "op", rol: mesRolActual }, creado: new Date().toISOString() };
}

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
        if (r === "/personal") {
          return send(200, { personal: [...PERSONAL_MES.map((p) => ({ ...p, activo: !mesPersonalBaja.has(p.numeroEmpleado), origen: "mes" })), ...PERSONAL_MES_INACTIVO.map((p) => ({ ...p, activo: false, origen: "mes" }))] });
        }
        if (r === "/catalogos") return send(200, { categorias: [{ codigo: "sensor", nombre: "Sensor" }, { codigo: "falla_mecanica", nombre: "Falla mecánica" }], personal: PERSONAL_MES, procesos: [{ codigo: "CORTE", nombre: "Corte" }, { codigo: "CNC", nombre: "CNC" }] });
        // Historico general (mig 090): cualquier paro terminado; filtros basicos.
        if (r.startsWith("/historico")) {
          const sp = new URL(url, "http://x").searchParams;
          const filas = [mesParo].filter((p) => ["CERRADO", "ANULADO"].includes(p.estado) || sp.get("estado") === "todos")
            .filter((p) => !sp.get("equipo") || p.equipo.codigo === sp.get("equipo"))
            .map((p) => ({ ...p, tecnicos: p.participantes, eventosCount: 5, tiempoTotalMin: p.tiempos.paro_min, esperaExternaMin: p.tiempos.espera_externa_min, linea: p.equipo.idMaquina }));
          return send(200, { total: filas.length, limite: Number(sp.get("limite") || 200), offset: 0, filas });
        }
        // Misma regla que el MES (alcanzaUmbral): horas >= umbral de mtto_parametros.
        if (r === "/contramedidas/recomendaciones") {
          const recs = mesRecomendaciones.filter((x) => x.horasAcumuladas >= mesUmbral).map((x) => ({ ...x, umbralHoras: mesUmbral, alcanzaUmbral: true }));
          return send(200, { umbralHoras: mesUmbral, total: recs.length, recomendaciones: recs });
        }
        if (r === "/contramedidas" && req.method === "POST") {
          if (!["mantenimiento_op", "mantenimiento_admin"].includes(mesRolActual)) return send(403, { error: "rol", code: "ACTOR_ROL_INVALIDO" });
          if (b.equipo === "NOEXISTE") return send(400, { error: "Equipo de mantenimiento invalido o no indicado", code: "EQUIPO_INVALIDO" });
          const cm = { id: mesContramedidas.length + 1, estado: "PROGRAMADA", origen: b.origen || "acumulacion", equipo: { codigo: b.equipo }, categoria: b.categoria ? { codigo: b.categoria } : null,
            horasAcumuladas: 23.6, parosConsiderados: 4, umbralHoras: 20, referenciaExterna: b.referenciaExterna || null, descripcion: b.descripcion || null, responsable: b.responsable || null,
            fechaProgramada: b.fechaProgramada || null, creadoPor: { usuario: req.headers["x-actor-usuario"] || null, rol: mesRolActual } };
          mesContramedidas.push(cm);
          mesRecomendaciones = mesRecomendaciones.filter((x) => !(x.equipo.codigo === b.equipo && (!b.categoria || x.categoria.codigo === b.categoria)));
          return send(201, cm);
        }
        let mc = r.match(/^\/contramedidas\/(\d+)$/);
        if (mc && req.method === "PATCH") {
          const cm = mesContramedidas.find((x) => x.id === Number(mc[1]));
          if (!cm) return send(404, { error: "Contramedida no encontrada" });
          Object.assign(cm, b);
          return send(200, cm);
        }
        if (r === "/contramedidas") return send(200, { contramedidas: mesContramedidas });
        if (r === "/parametros") return send(200, { parametros: [{ clave: "contramedida_umbral_horas", valor: String(mesUmbral) }] });
        if (r === "/parametros/contramedida-umbral" && req.method === "PUT") {
          const n = Number(b.horas);
          if (!Number.isFinite(n) || n <= 0) return send(400, { error: "Umbral invalido (horas > 0)" });
          const anterior = mesUmbral;
          mesUmbral = n;
          return send(200, { clave: "contramedida_umbral_horas", valor: String(n), anterior: String(anterior) });
        }
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
        if (["/espera-externa", "/reanudar", "/finalizar", "/continuidad", "/evidencias"].includes(m[2]) && req.method === "POST") {
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
        // (mig 090) evidencia durante la atencion.
        if (m[2] === "/evidencias" && req.method === "POST") {
          if (!["EN_ATENCION", "EN_ESPERA_EXTERNA"].includes(mesParo.estado)) return send(409, { error: "La atencion ya fue finalizada", code: "YA_APLICADO" });
          if ((mesParo.evidencias.length + (b.fotos || []).length) > 6) return send(400, { error: "Maximo 6 evidencias por paro", code: "EVIDENCIA_INVALIDA" });
          for (const f of b.fotos || []) mesParo.evidencias.push(mesEvidencia(f, "atencion", actor));
          return send(201, mesParo);
        }
        // (mig 090) finalizar = CERRAR el paro (sin codigo de cierre).
        if (m[2] === "/finalizar") {
          if (mesParo.estado === "CERRADO") return send(409, { error: "El paro ya esta cerrado", code: "YA_APLICADO" });
          if (mesParo.estado !== "EN_ATENCION") return send(409, { error: "La atencion no esta en curso" });
          const yaHay = mesParo.evidencias.some((e) => e.tipo === "despues");
          if (!yaHay && !(b.fotos || []).some((f) => f.tipo === "despues")) return send(400, { error: "foto despues obligatoria", code: "EVIDENCIA_REQUERIDA" });
          for (const f of b.fotos || []) mesParo.evidencias.push(mesEvidencia(f, "finalizacion", actor));
          const ahora = new Date().toISOString();
          Object.assign(mesParo, {
            estado: "CERRADO", categoria: { codigo: b.categoria, nombre: "Sensor" }, problemaDetectado: b.problemaDetectado,
            accionRealizada: b.accionRealizada, comentarios: b.comentarios, finalizadoEn: ahora,
            finalizadoPor: { numeroEmpleado: actor }, codigoCierre: null,
            cierre: { en: ahora, modo: "finalizacion", recibidoPor: null, anuladoMotivo: null },
            participantes: mesParo.participantes, historialAtencion: mesParo.historialAtencion,
            tiempos: { respuesta_min: 12, reparacion_min: 40, paro_min: 60, entrega_min: null, espera_externa_min: 7 },
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
    // La suite general prueba la integracion con KOIDE MES; el modo local
    // (desarrollo) tiene su propia prueba que reinicia el servidor.
    CONTRAMEDIDAS_FUENTE: "mes",
    CONTRAMEDIDAS_AUTO_MS: "0",
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

  // Recomendaciones por ACUMULACION de fallas (KOIDE MES, cualquier proceso).
  r = await api("GET", "/api/contramedidas/recomendaciones");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.umbralHoras, 20);
  assert.equal(r.data.recomendaciones.length, 1);
  assert.equal(r.data.recomendaciones[0].equipo.codigo, "M1");
  assert.match(r.data.recomendaciones[0].recomendacion, /23\.6 h acumuladas/);
  // Programar la contramedida desde la recomendacion: PRIMERO se registra en el
  // MES (fija la cobertura), luego la copia local con el enlace.
  const antesMes = mesLlamadas.length;
  r = await api("POST", "/api/contramedidas", { tipo: "Falla hidráulica", maquina: "M1", maquinaNombre: "MAQ-1", responsable: "Ana", fechaLimite: "2026-10-05", estado: "Pendiente",
    recomendacionClave: "M1|falla_hidraulica", categoriaCodigo: "falla_hidraulica", descripcion: "Mantenimiento profundo hidraulico" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mesId, 1);
  assert.equal(r.data.recomendacionClave, "M1|falla_hidraulica");
  const reg = mesLlamadas.slice(antesMes).find((c) => c.method === "POST" && c.url.endsWith("/contramedidas"));
  assert.ok(reg, "se registro en el MES");
  assert.equal(reg.rol, "mantenimiento_admin");
  const cmMes = mesContramedidas[0];
  assert.equal(cmMes.equipo.codigo, "M1");
  assert.equal(cmMes.categoria.codigo, "falla_hidraulica");
  assert.equal(cmMes.referenciaExterna, r.data.id, "referencia cruzada al id de metricas");
  assert.equal(cmMes.fechaProgramada, "2026-10-05");
  const idReco = r.data.id;
  r = await api("GET", "/api/contramedidas/recomendaciones");
  assert.equal(r.data.recomendaciones.length, 0, "atendida: la recomendacion deja de aparecer");
  const guardada = (await api("GET", "/api/contramedidas")).data.find((c) => c.id === idReco);
  assert.equal(guardada.mesId, 1, "el enlace persiste en MySQL");
  // Completarla refleja el estado en el MES.
  r = await api("PUT", `/api/contramedidas/${idReco}`, { estado: "Completado", trabajoRealizado: "Bomba cambiada" });
  assert.equal(r.status, 200);
  assert.equal(r.data.mesSync, true);
  assert.equal(cmMes.estado, "COMPLETADA");
  assert.equal(cmMes.trabajoRealizado, "Bomba cambiada");
  // Si el MES rechaza, no se guarda nada local.
  const nLocal = (await api("GET", "/api/contramedidas")).data.length;
  r = await api("POST", "/api/contramedidas", { tipo: "Falla común", maquina: "NOEXISTE", recomendacionClave: "NOEXISTE|sensor", categoriaCodigo: "sensor" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /KOIDE MES/);
  assert.equal((await api("GET", "/api/contramedidas")).data.length, nLocal);
  await api("DELETE", `/api/contramedidas/${idReco}`);
});

// Recomendacion del MES para las pruebas de programacion (equipo + categoria).
function recoMes(codigo, catCodigo, catNombre, horas, previa = null) {
  return { clave: `${codigo}|${catCodigo}`, equipo: { id: 100 + mesRecomendaciones.length, codigo, nombre: `LINEA ${codigo}`, proceso: "CORTE", idMaquina: null, area: null, ubicacion: null },
    categoria: { codigo: catCodigo, nombre: catNombre }, horasAcumuladas: horas, minutosAcumulados: Math.round(horas * 60), paros: 3, parosIds: [],
    desde: "2026-09-01T10:00:00.000Z", hasta: "2026-09-20T10:00:00.000Z", umbralHoras: mesUmbral, alcanzaUmbral: true, contramedidaPrevia: previa,
    recomendacion: `${codigo} — ${catNombre} — ${horas} h acumuladas. Se recomienda programar una contramedida / mantenimiento profundo.` };
}

function fechaLocalTest(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("contramedidas: umbral configurable, programacion automatica y aprobacion", async () => {
  const reco = async () => (await api("GET", "/api/contramedidas/recomendaciones")).data;
  const codigos = async () => (await reco()).recomendaciones.map((x) => x.equipo.codigo).sort();
  const ejecutar = async () => {
    const r = await api("POST", "/api/contramedidas/programacion-automatica", {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const propuestaDe = async (codigo) => (await dbq("SELECT * FROM contramedidas_propuestas WHERE equipo_codigo = ?", [codigo]));
  const creadasLocal = [];

  // ---- Configuracion del sistema: el umbral se lee de KOIDE MES (unica fuente) ----
  let r = await api("GET", "/api/configuracion");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const par = (d, clave) => d.parametros.find((x) => x.clave === clave);
  assert.equal(par(r.data, "contramedida_umbral_horas").valor, 20, "valor inicial = comportamiento actual");
  assert.equal(par(r.data, "contramedida_umbral_horas").fuente, "mes");
  assert.deepEqual(par(r.data, "programacion_dias_permitidos").valor, [1, 2, 3, 4, 5, 6]);
  assert.equal(par(r.data, "programacion_horizonte_dias").valor, 14);
  assert.equal(par(r.data, "programacion_max_por_dia").valor, 1);
  assert.equal(par(r.data, "programacion_automatica_activa").valor, true);

  // Caso A / B: umbral 20
  mesRecomendaciones = [recoMes("LA", "electrica", "Eléctrica", 19.9), recoMes("LB", "electrica", "Eléctrica", 20)];
  assert.deepEqual(await codigos(), ["LB"], "A: 19.9 h no recomienda · B: 20 h recomienda");

  // Validacion y permisos del cambio
  assert.equal((await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 0 } })).status, 400);
  assert.equal((await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: "abc" } })).status, 400);
  assert.equal((await api("PUT", "/api/configuracion", { valores: { programacion_dias_permitidos: [] } })).status, 400);
  assert.equal((await api("PUT", "/api/configuracion", { valores: { no_existe: 1 } })).status, 400);
  assert.equal(mesUmbral, 20, "un cambio invalido no llega al MES");
  assert.equal((await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 30 } }, "op")).status, 403);

  // Caso C / D: umbral 30 (cambiado desde metricos -> se guarda en el MES)
  r = await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 30 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(mesUmbral, 30);
  assert.deepEqual(r.data.cambios, [{ clave: "contramedida_umbral_horas", anterior: 20, nuevo: 30 }]);
  let [aud] = await dbq("SELECT * FROM auditoria WHERE entidad = 'configuracion' AND entidad_id = 'contramedida_umbral_horas' ORDER BY id DESC LIMIT 1");
  assert.equal(aud.usuario, USUARIOS.admin.username);
  assert.equal(aud.valor_anterior, "20");
  assert.equal(aud.valor_nuevo, "30");
  mesRecomendaciones = [recoMes("LC", "mecanica", "Mecánica", 25), recoMes("LD", "mecanica", "Mecánica", 30)];
  assert.deepEqual(await codigos(), ["LD"], "C: 25 h con umbral 30 no recomienda · D: 30 h recomienda");
  assert.equal((await reco()).umbralHoras, 30);

  // De vuelta a 20 y parametros locales deterministas para la busqueda.
  r = await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 20, programacion_dias_permitidos: [1, 2, 3, 4, 5, 6, 7], programacion_horizonte_dias: 3, programacion_max_por_dia: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cambios.length, 3, "max_por_dia ya valia 1: sin cambio, sin auditoria");
  const [cfgRow] = await dbq("SELECT valor, actualizado_por FROM configuracion_sistema WHERE clave = 'programacion_horizonte_dias'");
  assert.equal(cfgRow.valor, "3");
  assert.equal(cfgRow.actualizado_por, USUARIOS.admin.username);
  r = await api("GET", "/api/auditoria?entidad=configuracion");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((x) => x.entidadId).sort(), ["contramedida_umbral_horas", "contramedida_umbral_horas", "programacion_dias_permitidos", "programacion_horizonte_dias"],
    "20->30, 30->20, dias y horizonte");

  // Dias del horizonte (manana .. manana+2) y los que ya ocupan contramedidas abiertas.
  const dias = [1, 2, 3].map(fechaLocalTest);
  const ocupados = new Set((await api("GET", "/api/contramedidas")).data.filter((c) => c.estado !== "Completado" && c.fechaLimite).map((c) => c.fechaLimite));
  const libres = dias.filter((d) => !ocupados.has(d));
  assert.ok(libres.length >= 2, "el escenario necesita al menos 2 dias libres");

  // ---- Caso E: existe fecha libre -> propuesta automatica pendiente de aprobacion ----
  mesRecomendaciones = [recoMes("L4", "electrica", "Eléctrica", 27.5)];
  let e = await ejecutar();
  assert.equal(e.creadas.length, 1);
  assert.equal(e.creadas[0].fechaPropuesta, libres[0], "primera fecha disponible del horizonte");
  let [p4] = await propuestaDe("L4");
  assert.equal(p4.estado, "PENDIENTE_APROBACION");
  assert.equal(p4.origen, "AUTOMATICA");
  assert.equal(p4.ciclo, "L4|electrica#0");
  assert.equal(Number(p4.horas_acumuladas), 27.5);
  assert.equal(mesContramedidas.filter((c) => c.equipo.codigo === "L4").length, 0, "NO se confirma ni se registra en el MES sin aprobacion");
  let rl = (await reco()).recomendaciones.find((x) => x.equipo.codigo === "L4");
  assert.equal(rl.programacion.estado, "PENDIENTE_APROBACION");
  assert.equal(rl.programacion.fechaPropuesta, libres[0]);
  r = await api("GET", "/api/contramedidas/propuestas?estado=PENDIENTE_APROBACION");
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].vigente, true);

  // ---- Caso G: ya hay propuesta pendiente para la misma condicion -> no duplica ----
  e = await ejecutar();
  assert.equal(e.creadas.length, 0);
  mesRecomendaciones[0].horasAcumuladas = 31; // siguen sumando horas: MISMA acumulacion (mismo ciclo)
  e = await ejecutar();
  assert.equal(e.creadas.length, 0);
  assert.equal(await count("contramedidas_propuestas", "WHERE equipo_codigo = 'L4'"), 1);

  // ---- Caso F: sin fecha libre -> no se programa; queda la programacion manual ----
  for (const d of libres.slice(1)) {
    r = await api("POST", "/api/contramedidas", { tipo: "Preventivo", maquina: "X9", responsable: "R", fechaLimite: d, estado: "Pendiente" });
    creadasLocal.push(r.data.id);
  }
  mesRecomendaciones.push(recoMes("L5", "neumatica", "Neumática", 24.8));
  e = await ejecutar();
  assert.equal(e.creadas.length, 0);
  assert.deepEqual(e.sinFecha.map((x) => x.equipo), ["L5"]);
  assert.equal(await count("contramedidas_propuestas", "WHERE equipo_codigo = 'L5'"), 0, "no inventa una fecha");
  rl = (await reco()).recomendaciones.find((x) => x.equipo.codigo === "L5");
  assert.equal(rl.programacion.estado, "SIN_FECHA");
  // Programar manualmente sigue funcionando igual y queda como confirmada / manual.
  r = await api("POST", "/api/contramedidas", { tipo: "Neumática", maquina: "L5", maquinaNombre: "LINEA L5", responsable: "Ana", fechaLimite: fechaLocalTest(10), estado: "Pendiente",
    recomendacionClave: "L5|neumatica", recomendacionCiclo: rl.ciclo, categoriaCodigo: "neumatica", descripcion: rl.recomendacion });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  creadasLocal.push(r.data.id);
  let [p5] = await propuestaDe("L5");
  assert.equal(p5.estado, "CONFIRMADA");
  assert.equal(p5.origen, "MANUAL");
  assert.equal(p5.fecha_confirmada, fechaLocalTest(10));
  assert.equal(p5.contramedida_id, r.data.id);
  assert.ok(!(await codigos()).includes("L5"), "atendida: deja de aparecer (cobertura del MES)");

  // ---- Reprogramar: solo a una fecha disponible y con motivo ----
  const id4 = Number(p4.id);
  r = await api("GET", `/api/contramedidas/propuestas/${id4}/fechas-disponibles`);
  assert.deepEqual(r.data.fechas, [libres[0]], "su propio dia sigue disponible para ella");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: libres[1], motivo: "Paro de linea programado" })).status, 409, "dia lleno");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: libres[0], motivo: "x" })).status, 400, "misma fecha");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: fechaLocalTest(0), motivo: "Hoy mismo" })).status, 409, "nunca hoy");
  await api("DELETE", `/api/contramedidas/${creadasLocal.shift()}`); // se libera libres[1]
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: libres[1] })).status, 400, "sin motivo");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: libres[1], motivo: "Esperar refacción" }, "op")).status, 403);
  r = await api("POST", `/api/contramedidas/propuestas/${id4}/reprogramar`, { fecha: libres[1], motivo: "Esperar refacción" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fechaPropuesta, libres[1]);
  assert.equal(r.data.reprogramaciones, 1);
  assert.equal(r.data.estado, "PENDIENTE_APROBACION", "reprogramar no confirma");
  [aud] = await dbq("SELECT * FROM auditoria WHERE accion = 'CONTRAMEDIDA_REPROGRAMADA' AND entidad_id = ?", [String(id4)]);
  assert.match(aud.valor_anterior, new RegExp(libres[0]));
  assert.match(aud.valor_nuevo, new RegExp(libres[1]));
  assert.match(aud.detalle, /Esperar refacción/);

  // ---- Caso H: el administrador aprueba -> confirmada ----
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/aprobar`, {}, "op")).status, 403);
  r = await api("POST", `/api/contramedidas/propuestas/${id4}/aprobar`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.propuesta.estado, "CONFIRMADA");
  assert.equal(r.data.propuesta.fechaConfirmada, libres[1]);
  assert.equal(r.data.propuesta.resueltaPor, USUARIOS.admin.username);
  assert.ok(r.data.propuesta.resueltaEn);
  const cm4 = r.data.contramedida;
  creadasLocal.push(cm4.id);
  assert.equal(cm4.fechaLimite, libres[1], "queda en el calendario de seguimiento");
  assert.equal(cm4.recomendacionClave, "L4|electrica");
  const mes4 = mesContramedidas.find((c) => c.equipo.codigo === "L4");
  assert.ok(mes4, "se registro en el MES por el mismo camino que la programacion manual");
  assert.equal(mes4.fechaProgramada, libres[1]);
  assert.equal(mes4.categoria.codigo, "electrica");
  assert.ok(!(await codigos()).includes("L4"), "la acumulacion queda cubierta (se reinicia como antes)");
  r = await api("GET", "/api/contramedidas/propuestas?estado=CONFIRMADA");
  const conf = r.data.find((x) => x.id === id4);
  assert.equal(conf.origen, "AUTOMATICA");
  assert.equal(conf.categoria.nombre, "Eléctrica");
  assert.ok(conf.detectadaEn);
  assert.ok(r.data.some((x) => x.equipo.codigo === "L5" && x.origen === "MANUAL"), "confirmadas manuales y automaticas juntas");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id4}/aprobar`, {})).status, 409, "no se aprueba dos veces");
  assert.equal(mesContramedidas.filter((c) => c.equipo.codigo === "L4").length, 1);
  // Nueva acumulacion posterior (nuevo ciclo: contramedida previa = la aprobada) -> nueva propuesta.
  mesRecomendaciones.push(recoMes("L4", "electrica", "Eléctrica", 21, { id: mes4.id, cubreHasta: new Date().toISOString() }));
  await api("PUT", "/api/configuracion", { valores: { programacion_horizonte_dias: 30 } });
  e = await ejecutar();
  assert.equal(e.creadas.length, 1);
  assert.equal(e.creadas[0].ciclo, `L4|electrica#${mes4.id}`);
  const idNuevoCiclo = e.creadas[0].id;

  // ---- Caso I: el administrador rechaza -> rechazada, sin crear otra de inmediato ----
  mesRecomendaciones.push(recoMes("L6", "hidraulica", "Hidráulica", 22));
  e = await ejecutar();
  assert.deepEqual(e.creadas.map((x) => x.equipo), ["L6"]);
  const id6 = e.creadas[0].id;
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id6}/rechazar`, {})).status, 400, "motivo obligatorio");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id6}/rechazar`, { motivo: "Se hará en el paro anual" }, "op")).status, 403);
  r = await api("POST", `/api/contramedidas/propuestas/${id6}/rechazar`, { motivo: "Se hará en el paro anual" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "RECHAZADA");
  assert.equal(r.data.motivo, "Se hará en el paro anual");
  e = await ejecutar();
  assert.equal(e.creadas.length, 0, "el mismo ciclo rechazado no se vuelve a proponer solo");
  assert.equal(await count("contramedidas_propuestas", "WHERE equipo_codigo = 'L6'"), 1);
  rl = (await reco()).recomendaciones.find((x) => x.equipo.codigo === "L6");
  assert.equal(rl.programacion.estado, "RECHAZADA", "sigue visible para programarla a mano");
  assert.equal(mesContramedidas.filter((c) => c.equipo.codigo === "L6").length, 0, "rechazar no toca el MES");
  assert.equal((await api("POST", `/api/contramedidas/propuestas/${id6}/aprobar`, {})).status, 409);

  // Propuesta cuya recomendacion ya se atendio directamente en el MES: no se aprueba.
  mesRecomendaciones = mesRecomendaciones.filter((x) => !(x.equipo.codigo === "L4"));
  r = await api("POST", `/api/contramedidas/propuestas/${idNuevoCiclo}/aprobar`, {});
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "RECOMENDACION_NO_VIGENTE");
  const [pv] = await dbq("SELECT estado FROM contramedidas_propuestas WHERE id = ?", [idNuevoCiclo]);
  assert.equal(pv.estado, "PENDIENTE_APROBACION", "vuelve a pendiente para rechazarla");
  r = await api("GET", "/api/contramedidas/propuestas?estado=PENDIENTE_APROBACION");
  assert.equal(r.data.find((x) => x.id === idNuevoCiclo).vigente, false);
  await api("POST", `/api/contramedidas/propuestas/${idNuevoCiclo}/rechazar`, { motivo: "Atendida en el MES" });

  // Programacion automatica apagada: no propone; la recomendacion queda para manual.
  await api("PUT", "/api/configuracion", { valores: { programacion_automatica_activa: false } });
  mesRecomendaciones.push(recoMes("L7", "sensor", "Sensor", 40));
  e = await ejecutar();
  assert.equal(e.activa, false);
  assert.equal(await count("contramedidas_propuestas", "WHERE equipo_codigo = 'L7'"), 0);
  assert.equal((await reco()).recomendaciones.find((x) => x.equipo.codigo === "L7").programacion.estado, "AUTOMATICA_INACTIVA");

  // Auditoria completa de la programacion y aprobacion.
  const acciones = (await dbq("SELECT DISTINCT accion FROM auditoria")).map((x) => x.accion).sort();
  for (const a of ["CONFIGURACION_MODIFICADA", "PROGRAMACION_AUTOMATICA_CREADA", "CONTRAMEDIDA_REPROGRAMADA", "CONTRAMEDIDA_APROBADA", "CONTRAMEDIDA_RECHAZADA", "CONTRAMEDIDA_PROGRAMADA_MANUAL"]) {
    assert.ok(acciones.includes(a), `auditoria: ${a}`);
  }
  const [auto] = await dbq("SELECT usuario FROM auditoria WHERE accion = 'PROGRAMACION_AUTOMATICA_CREADA' ORDER BY id LIMIT 1");
  assert.equal(auto.usuario, USUARIOS.admin.username, "quien disparo la ejecucion desde la pantalla");

  // Limpieza: el resto de las pruebas espera los datos originales.
  for (const id of creadasLocal) await api("DELETE", `/api/contramedidas/${id}`);
  await api("PUT", "/api/configuracion", { valores: { programacion_automatica_activa: true, programacion_dias_permitidos: [1, 2, 3, 4, 5, 6], programacion_horizonte_dias: 14 } });
  mesRecomendaciones = [];
});

test("contramedidas en modo LOCAL (desarrollo, sin KOIDE MES): flujo completo", async () => {
  // 1) Paros locales (tiempo_muerto) sincronizados una vez; despues el MES se apaga.
  const base = makeRecords(1, 50000)[0];
  let n = 0;
  const paro = (maquina, categoria, inicio, minutos) => ({ ...base, id: 50000 + n++, machine_id: Number(maquina.slice(1)), machine_code: maquina, downtime_category: categoria,
    downtime_start: inicio, downtime_end: new Date(Date.parse(inicio) + minutos * 60000).toISOString(), downtime_minutes: minutos, status: "Finalizado" });
  const recordsOriginales = mesRecords;
  const koideOriginales = koideRecords;
  mesRecords = [
    paro("M1", "Falla eléctrica", "2026-09-02T10:00:00.000Z", 600), paro("M1", "Falla eléctrica", "2026-09-05T10:00:00.000Z", 594), // 19.9 h
    paro("M2", "Falla eléctrica", "2026-09-03T10:00:00.000Z", 1200),                                                                // 20 h
    paro("M3", "Sensor", "2026-09-04T10:00:00.000Z", 1500),                                                                          // 25 h
    paro("M3", "Falla hidráulica", "2026-09-06T10:00:00.000Z", 1000), paro("M3", "Falla hidráulica", "2026-09-07T10:00:00.000Z", 800), // 30 h
    { ...paro("M1", "", "2026-09-08T10:00:00.000Z", 5000), downtime_category: null },                                                  // sin categoria: no acumula
    { ...paro("M2", "Sensor", "2026-09-09T10:00:00.000Z", 3000), downtime_end: null, status: "En reparación" },                        // abierto: no acumula
  ];
  koideRecords = [];
  let r = await api("GET", "/api/refresh");
  assert.equal(r.status, 200);
  assert.equal(await count("tiempo_muerto"), mesRecords.length);
  const envMes = appEnv;
  await stopApp();
  appEnv = { ...appEnv, CONTRAMEDIDAS_FUENTE: "local", KOIDE_GENERAL_URL: "http://127.0.0.1:1", KOIDE_BASE_URL: "http://127.0.0.1:1" };
  await startApp();
  const llamadasMes = mesLlamadas.length;
  const creadas = [];
  try {
    const reco = async () => (await api("GET", "/api/contramedidas/recomendaciones")).data;
    const claves = async () => (await reco()).recomendaciones.map((x) => x.clave).sort();
    const ejecutar = async () => {
      const x = await api("POST", "/api/contramedidas/programacion-automatica", {});
      assert.equal(x.status, 200, JSON.stringify(x.data));
      return x.data;
    };

    // 2) Configuracion local: umbral 20 sembrado por la migracion.
    r = await api("GET", "/api/configuracion");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let umbral = r.data.parametros.find((x) => x.clave === "contramedida_umbral_horas");
    assert.equal(umbral.fuente, "local");
    assert.equal(umbral.valor, 20);
    assert.equal(umbral.disponible, true);

    // Casos A/B: 19.9 h no, 20 h si (y los de 25 y 30 h tambien).
    r = await reco();
    assert.equal(r.fuente, "local");
    assert.equal(r.umbralHoras, 20);
    assert.deepEqual(await claves(), ["M2|falla_electrica", "M3|falla_hidraulica", "M3|sensor"]);
    const m2 = r.recomendaciones.find((x) => x.clave === "M2|falla_electrica");
    assert.equal(m2.horasAcumuladas, 20);
    assert.equal(m2.paros, 1);
    assert.equal(m2.equipo.nombre, "MAQ-2", "nombre del equipo desde el catalogo local");

    // Casos C/D: umbral 30 -> 25 h no, 30 h si. Se guarda y se vuelve a consultar.
    r = await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 30 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.cambios, [{ clave: "contramedida_umbral_horas", anterior: 20, nuevo: 30 }]);
    umbral = (await api("GET", "/api/configuracion")).data.parametros.find((x) => x.clave === "contramedida_umbral_horas");
    assert.equal(umbral.valor, 30);
    assert.equal(umbral.actualizadoPor, USUARIOS.admin.username);
    const [fila] = await dbq("SELECT valor, actualizado_por FROM configuracion_sistema WHERE clave = 'contramedida_umbral_horas'");
    assert.equal(fila.valor, "30");
    assert.deepEqual(await claves(), ["M3|falla_hidraulica"]);
    const [aud] = await dbq("SELECT * FROM auditoria WHERE entidad_id = 'contramedida_umbral_horas' ORDER BY id DESC LIMIT 1");
    assert.equal(aud.valor_anterior, "20");
    assert.equal(aud.valor_nuevo, "30");
    assert.equal(aud.usuario, USUARIOS.admin.username);
    await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 20, programacion_dias_permitidos: [1, 2, 3, 4, 5, 6, 7], programacion_horizonte_dias: 2, programacion_max_por_dia: 1 } });
    assert.equal((await reco()).umbralHoras, 20);

    // 3) Casos E/F: horizonte de 2 dias y 1 por dia -> las 2 de mas horas reciben fecha; M2 no.
    const [d1, d2, d3] = [1, 2, 3].map(fechaLocalTest);
    let e = await ejecutar();
    assert.deepEqual(e.creadas.map((x) => [x.equipo, x.categoria, x.fechaPropuesta]), [["M3", "Falla hidráulica", d1], ["M3", "Sensor", d2]]);
    assert.deepEqual(e.sinFecha.map((x) => x.ciclo), ["M2|falla_electrica#0"]);
    r = await reco();
    assert.equal(r.recomendaciones.find((x) => x.clave === "M2|falla_electrica").programacion.estado, "SIN_FECHA");
    assert.equal(r.recomendaciones.find((x) => x.clave === "M3|falla_hidraulica").programacion.estado, "PENDIENTE_APROBACION");
    const idHid = e.creadas[0].id;
    const idSen = e.creadas[1].id;

    // 4) Caso G: sin duplicados aunque se repita y sigan sumando horas (mismo ciclo).
    await dbq(`INSERT INTO tiempo_muerto (id, orden, machine_code, downtime_category, downtime_start, downtime_end, payload)
               VALUES (59001, 59001, 'M3', 'Falla hidráulica', '2026-09-10 10:00:00', '2026-09-10 12:00:00', '{}')`);
    e = await ejecutar();
    assert.equal(e.creadas.length, 0);
    assert.equal((await reco()).recomendaciones.find((x) => x.clave === "M3|falla_hidraulica").horasAcumuladas, 32);
    assert.equal(await count("contramedidas_propuestas", "WHERE equipo_codigo IN ('M2', 'M3')"), 2);

    // 5) Reprogramar a una fecha disponible (con motivo).
    await api("PUT", "/api/configuracion", { valores: { programacion_horizonte_dias: 3 } });
    r = await api("GET", `/api/contramedidas/propuestas/${idHid}/fechas-disponibles`);
    assert.deepEqual(r.data.fechas, [d1, d3], "d2 lo ocupa la otra propuesta");
    assert.equal((await api("POST", `/api/contramedidas/propuestas/${idHid}/reprogramar`, { fecha: d2, motivo: "Probar día lleno" })).status, 409);
    r = await api("POST", `/api/contramedidas/propuestas/${idHid}/reprogramar`, { fecha: d3, motivo: "Producción programada" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.fechaPropuesta, d3);
    assert.equal(r.data.estado, "PENDIENTE_APROBACION");

    // 6) Caso H: aprobar -> confirmada; la contramedida local cubre la acumulacion.
    r = await api("POST", `/api/contramedidas/propuestas/${idHid}/aprobar`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.propuesta.estado, "CONFIRMADA");
    assert.equal(r.data.propuesta.fechaConfirmada, d3);
    assert.equal(r.data.propuesta.origen, "AUTOMATICA");
    const cmHid = r.data.contramedida;
    creadas.push(cmHid.id);
    assert.equal(cmHid.recomendacionClave, "M3|falla_hidraulica");
    assert.equal(cmHid.fechaLimite, d3);
    assert.equal(cmHid.mesId, undefined, "sin KOIDE MES");
    assert.ok(!(await claves()).includes("M3|falla_hidraulica"), "cubierta: la recomendacion deja de aparecer");
    assert.equal((await api("POST", `/api/contramedidas/propuestas/${idHid}/aprobar`, {})).status, 409);
    // Nueva acumulacion POSTERIOR -> nuevo ciclo -> nueva propuesta.
    const futuro = new Date(Date.now() + 60000);
    await dbq(`INSERT INTO tiempo_muerto (id, orden, machine_code, downtime_category, downtime_start, downtime_end, payload) VALUES (59002, 59002, 'M3', 'Falla hidráulica', ?, ?, '{}')`,
      [futuro, new Date(futuro.getTime() + 21 * 3600000)]);
    r = await reco();
    const nueva = r.recomendaciones.find((x) => x.clave === "M3|falla_hidraulica");
    assert.equal(nueva.horasAcumuladas, 21, "solo cuentan las horas posteriores a la contramedida");
    assert.equal(nueva.ciclo, `M3|falla_hidraulica#${cmHid.id}`);
    await api("PUT", "/api/configuracion", { valores: { programacion_horizonte_dias: 10 } });
    e = await ejecutar();
    assert.ok(e.creadas.some((x) => x.ciclo === `M3|falla_hidraulica#${cmHid.id}`));

    // 7) Caso I: rechazar -> no se vuelve a proponer sola; queda para manual.
    r = await api("POST", `/api/contramedidas/propuestas/${idSen}/rechazar`, { motivo: "Se hará en el paro anual" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.estado, "RECHAZADA");
    e = await ejecutar();
    assert.ok(!e.creadas.some((x) => x.equipo === "M3" && x.categoria === "Sensor"));
    assert.equal((await reco()).recomendaciones.find((x) => x.clave === "M3|sensor").programacion.estado, "RECHAZADA");

    // 8) Programacion manual desde la recomendacion (M2) -> confirmada / manual.
    const recoM2 = (await reco()).recomendaciones.find((x) => x.clave === "M2|falla_electrica");
    r = await api("POST", "/api/contramedidas", { tipo: "Falla eléctrica", maquina: "M2", maquinaNombre: "MAQ-2", responsable: "Ana", fechaLimite: fechaLocalTest(20), estado: "Pendiente",
      recomendacionClave: recoM2.clave, recomendacionCiclo: recoM2.ciclo, categoriaCodigo: "falla_electrica", descripcion: recoM2.recomendacion });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    creadas.push(r.data.id);
    assert.equal(r.data.recomendacionClave, "M2|falla_electrica");
    const [pm] = await dbq("SELECT * FROM contramedidas_propuestas WHERE recomendacion_clave = 'M2|falla_electrica'");
    assert.equal(pm.estado, "CONFIRMADA");
    assert.equal(pm.origen, "MANUAL");
    assert.ok(!(await claves()).includes("M2|falla_electrica"));
    r = await api("GET", "/api/contramedidas/propuestas?estado=CONFIRMADA");
    assert.deepEqual(r.data.filter((x) => ["M2", "M3"].includes(x.equipo.codigo)).map((x) => [x.equipo.codigo, x.origen]).sort(), [["M2", "MANUAL"], ["M3", "AUTOMATICA"]]);

    // Una sola propuesta por ciclo y ninguna llamada a KOIDE MES en todo el flujo.
    const [dup] = await dbq("SELECT COUNT(*) AS n, COUNT(DISTINCT ciclo) AS c FROM contramedidas_propuestas");
    assert.equal(Number(dup.n), Number(dup.c));
    assert.equal(mesLlamadas.length, llamadasMes, "el modulo no llamo a KOIDE MES");
  } finally {
    for (const id of creadas) await api("DELETE", `/api/contramedidas/${id}`);
    await dbq("DELETE FROM tiempo_muerto WHERE id IN (59001, 59002)");
    await dbq("DELETE FROM contramedidas_propuestas");
    await api("PUT", "/api/configuracion", { valores: { contramedida_umbral_horas: 20, programacion_dias_permitidos: [1, 2, 3, 4, 5, 6], programacion_horizonte_dias: 14 } });
    await stopApp();
    appEnv = envMes;
    await startApp();
    mesRecords = recordsOriginales;
    koideRecords = koideOriginales;
    await api("GET", "/api/refresh");
  }
});

test("planificacion de contramedidas: reglas de fechas (funciones puras)", () => {
  const plan = require("../lib/contramedidasPlanificacion");
  const hoy = "2026-09-30"; // miercoles
  const op = { hoy, diasPermitidos: [1, 2, 3, 4, 5, 6], horizonteDias: 7, maxPorDia: 1 };
  const equipo = { codigo: "M1", nombre: "Prensa 1" };
  const vacio = { programadas: [], calendario: [] };
  assert.equal(plan.diaSemana("2026-10-04"), 7, "domingo");
  assert.deepEqual(plan.fechasDisponibles(op, vacio, equipo), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07"], "sin hoy ni domingo");
  assert.match(plan.motivoNoDisponible("2026-09-30", op, vacio, equipo), /posterior a hoy/);
  assert.match(plan.motivoNoDisponible("2026-10-08", op, vacio, equipo), /horizonte/);
  // Capacidad por dia y mismo equipo.
  let ocup = { programadas: [{ fecha: "2026-10-01", equipo: "OTRA" }], calendario: [] };
  assert.equal(plan.buscarFecha(op, ocup, equipo), "2026-10-02");
  assert.equal(plan.buscarFecha({ ...op, maxPorDia: 2 }, ocup, equipo), "2026-10-01");
  ocup = { programadas: [{ fecha: "2026-10-01", equipo: "m1" }], calendario: [] };
  assert.match(plan.motivoNoDisponible("2026-10-01", { ...op, maxPorDia: 5 }, ocup, equipo), /mismo|equipo ya tiene/);
  // Calendario de mantenimiento (Excel): fecha en encabezado, equipo a la izquierda.
  const serial = (f) => (Date.parse(`${f}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
  const cal = [{ name: "cal.xlsx", sheets: [{ maxRow: 4, cells: {
    B1: { t: "n", v: serial("2026-10-01"), w: "01/10" }, C1: { t: "n", v: serial("2026-10-02"), w: "02/10" },
    A3: { t: "s", v: "PRENSA 1", w: "PRENSA 1" }, B3: { t: "s", v: "P", w: "Preventivo" },
    A4: { t: "s", v: "M10", w: "M10" }, C4: { t: "s", v: "L", w: "Lubricación" },
  } }] }];
  const acts = plan.actividadesCalendario(cal);
  assert.deepEqual(acts.map((a) => [a.fecha, a.equipo, a.actividad]), [["2026-10-01", "PRENSA 1", "Preventivo"], ["2026-10-02", "M10", "Lubricación"]]);
  ocup = { programadas: [], calendario: acts };
  assert.match(plan.motivoNoDisponible("2026-10-01", op, ocup, equipo), /calendario de mantenimiento/, "coincide por nombre (Prensa 1)");
  assert.equal(plan.motivoNoDisponible("2026-10-02", op, ocup, equipo), null, "M10 no es M1");
  assert.equal(plan.buscarFecha(op, ocup, equipo), "2026-10-02");
  // Sin ningun dia posible -> null (nunca inventa).
  assert.equal(plan.buscarFecha({ ...op, diasPermitidos: [7], horizonteDias: 3 }, vacio, equipo), null);
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

test("programa preventivo: programacion por tiempo muerto del mes anterior (funciones puras)", () => {
  const pv = require("../lib/preventivo");
  assert.equal(pv.mesAnterior("2026-01"), "2025-12");
  assert.equal(pv.nombreMes("2026-10"), "Octubre 2026");
  const habiles = pv.diasHabiles("2026-10");
  assert.equal(habiles.length, 27, "octubre 2026: lunes a sabado");
  assert.ok(!habiles.includes("2026-10-04"), "sin domingos");
  const rec = (code, min, fecha = "2026-09-10") => ({ record_date: fecha, machine_code: code, downtime_minutes: min });
  const records = [rec("A", 10), rec("B", 50), rec("B", 5), rec("C", null), rec("Z", 999, "2026-08-01")];
  const machines = ["A", "B", "C", "D"].map((code) => ({ code, name: `Maq ${code}` }));
  const t = pv.programarMes("2026-10", records, machines);
  assert.deepEqual(t.map((x) => x.maquina), ["B", "A", "C", "D"], "mas tiempo muerto primero; sin minutos al final");
  assert.deepEqual(t.map((x) => x.fecha), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"]);
  assert.equal(t[0].maquinaNombre, "Maq B");
  assert.deepEqual(pv.programarMes("2026-12", records, machines), [], "sin paros el mes anterior: sin programacion");
  // Mas maquinas que dias habiles: se reparten y se numeran dentro del dia.
  const muchas = Array.from({ length: 30 }, (_, i) => ({ code: `M${i}` }));
  const t2 = pv.programarMes("2026-10", [rec("M0", 1)], muchas);
  assert.equal(t2[27].fecha, "2026-10-01");
  assert.equal(t2[27].orden, 1);
});

test("programa preventivo: meses, agenda, estado, reporte con evidencias y protecciones", async () => {
  let r = await api("GET", "/api/preventivo");
  assert.equal(r.status, 200);
  await api("POST", "/api/preventivo", { mes: "2026-10" });
  assert.equal((await api("POST", "/api/preventivo", { mes: "2026-10" })).status, 400, "mes duplicado");
  assert.equal((await api("POST", "/api/preventivo", { mes: "2026-13" })).status, 400, "mes invalido");
  r = await api("GET", "/api/preventivo");
  let oct = r.data.find((c) => c.mes === "2026-10");
  if (!Object.keys(oct.dias).length) {
    assert.equal((await api("POST", "/api/preventivo/2026-10/programar")).status, 200);
    oct = (await api("GET", "/api/preventivo")).data.find((c) => c.mes === "2026-10");
  }
  assert.equal(oct.name, "Octubre 2026");
  const tareas = Object.values(oct.dias).flat();
  assert.deepEqual(tareas.map((t) => t.maquina).sort(), ["M1", "M2", "M3"], "una tarea por maquina");
  assert.ok(Object.keys(oct.dias).every((f) => new Date(f + "T12:00:00Z").getUTCDay() !== 0), "nunca en domingo");
  const t = tareas[0];

  // Sin paros en el mes anterior: no se programa.
  await api("POST", "/api/preventivo", { mes: "2030-02" });
  assert.equal((await api("POST", "/api/preventivo/2030-02/programar")).status, 409);

  // Estado
  assert.equal((await api("PUT", `/api/preventivo/tareas/${t.id}/estado`, { estado: "Hecho" })).status, 400);
  assert.equal((await api("PUT", `/api/preventivo/tareas/${t.id}/estado`, { estado: "Realizado" })).status, 200);
  assert.equal((await api("PUT", "/api/preventivo/tareas/999999/estado", { estado: "Realizado" })).status, 404);
  // Con avance ya no se puede regenerar ni limpiar.
  assert.equal((await api("POST", "/api/preventivo/2026-10/programar")).status, 409);
  assert.equal((await api("POST", "/api/preventivo/2026-10/limpiar")).status, 409);

  // Evidencias: se valida el contenido real, no la extension.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  assert.equal((await api("POST", "/api/preventivo/evidencia", { name: "x.png", base64: Buffer.alloc(200, 65).toString("base64") })).status, 400);
  const ev1 = (await api("POST", "/api/preventivo/evidencia", { name: "a.png", base64: png.toString("base64") })).data;
  const ev2 = (await api("POST", "/api/preventivo/evidencia", { name: "b.png", base64: png.toString("base64") })).data;
  assert.match(ev1.name, /^ev_.+\.png$/);
  r = await api("GET", ev1.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal((await api("GET", "/api/preventivo/evidencia/..%2F..%2Fconfig.json")).status, 404);

  // Reporte
  const puntos = [{ punto: "Lubricar puntos de engrase", ok: true }, { punto: "Revisar sensores", ok: false }];
  r = await api("PUT", `/api/preventivo/tareas/${t.id}/reporte`, {
    responsable: "PEDRO ENRIQUE ORTIZ", puntos, observaciones: "Sin novedad ñ", evidencias: [{ name: ev1.name }, { name: ev2.name }],
  });
  assert.equal(r.status, 200);
  assert.equal((await api("PUT", `/api/preventivo/tareas/${t.id}/reporte`, { evidencias: [{ name: "../../config.json" }] })).status, 400);
  assert.equal((await api("PUT", `/api/preventivo/tareas/${t.id}/reporte`, { evidencias: [{ name: "ev_no_existe.png" }] })).status, 400);
  oct = (await api("GET", "/api/preventivo")).data.find((c) => c.mes === "2026-10");
  const t1 = Object.values(oct.dias).flat().find((x) => x.id === t.id);
  assert.equal(t1.estado, "Realizado");
  assert.equal(t1.color, "#16a34a");
  assert.equal(t1.reporte.responsable, "PEDRO ENRIQUE ORTIZ");
  assert.deepEqual(t1.reporte.puntos, puntos);
  assert.equal(t1.reporte.observaciones, "Sin novedad ñ");
  assert.equal(t1.reporte.evidencias.length, 2);
  assert.equal(t1.reporte.por, USUARIOS.admin.username);
  const dir = path.join(DATA_DIR, "preventivo-evidencias");
  // Quitar una evidencia del reporte borra el archivo.
  r = await api("PUT", `/api/preventivo/tareas/${t.id}/reporte`, { responsable: "X", puntos, evidencias: [{ name: ev2.name }] });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, ev1.name)));
  assert.ok(fs.existsSync(path.join(dir, ev2.name)));
  assert.ok((await count("auditoria", "WHERE entidad = 'preventivo'")) >= 3);

  // Solo administradores.
  assert.equal((await api("GET", "/api/preventivo", null, "op")).status, 403);
  assert.equal((await api("GET", "/api/preventivo", null, null)).status, 401);

  // Eliminar el mes borra tareas y evidencias.
  assert.equal((await api("DELETE", "/api/preventivo/2026-10")).status, 200);
  assert.equal(await count("preventivo_tareas", "WHERE mes = '2026-10'"), 0);
  assert.ok(!fs.existsSync(path.join(dir, ev2.name)));
  assert.equal((await api("DELETE", "/api/preventivo/2026-10")).status, 404);
  await api("DELETE", "/api/preventivo/2030-02");
});

test("programa preventivo: importacion del JSON del sistema metricos", async () => {
  const src = path.join(TMP, "pv-import");
  fs.mkdirSync(path.join(src, "ev"), { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200)]);
  fs.writeFileSync(path.join(src, "ev", "ev_abc_1234.png"), png);
  const cals = [
    { id: "cal-2031-03", name: "Marzo 2031", mes: "2031-03", dias: {
      "2031-03-03": [
        { maquina: "CNC1", maquinaNombre: "Muratec", estado: "Realizado", color: "#16a34a",
          reporte: { responsable: "R", puntos: [{ punto: "P1", ok: true }], observaciones: "O", evidencias: [{ name: "ev_abc_1234.png", url: "/api/calendarios/evidencia/ev_abc_1234.png" }] } },
        { maquina: "B8", maquinaNombre: "NPK-250", estado: "", color: "" },
      ],
      "2031-04-01": [{ maquina: "FUERA", estado: "" }],
    } },
    { id: "excel", name: "viejo.xlsx", sheets: [] },
  ];
  fs.writeFileSync(path.join(src, "calendarios.json"), JSON.stringify(cals));
  const run = () => execFileSync(process.execPath, [path.join(ROOT, "scripts", "importar-preventivo.js"), path.join(src, "calendarios.json"), "--evidencias", path.join(src, "ev")], { env: directEnv(), cwd: TMP }).toString();
  assert.match(run(), /2031-03: 2 tareas importadas/);
  assert.match(run(), /ya tiene programacion/, "repetir no duplica");
  const mar = (await api("GET", "/api/preventivo")).data.find((c) => c.mes === "2031-03");
  const [cnc, b8] = mar.dias["2031-03-03"];
  assert.equal(cnc.estado, "Realizado");
  assert.equal(cnc.reporte.responsable, "R");
  assert.equal(cnc.reporte.evidencias.length, 1);
  assert.equal((await api("GET", cnc.reporte.evidencias[0].url)).status, 200);
  assert.equal(b8.reporte, undefined);
  assert.equal(Object.keys(mar.dias).length, 1, "las fechas fuera del mes se ignoran");
  await api("DELETE", "/api/preventivo/2031-03");
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
  assert.equal((await alta({ numeroEmpleado: "1382" })).status, 409, "numero ya usado por otro operador");
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

test("operadores: cuenta <-> empleado del MES: alta, rechazos, listado persistente, login y atencion", async () => {
  // Selector: catalogo COMPLETO del MES (activo/inactivo) + cuenta que ya tiene cada numero.
  let r = await api("GET", "/api/admin/personal-mes");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.completo, true);
  const cat = new Map(r.data.personal.map((p) => [p.numeroEmpleado, p]));
  assert.equal(cat.get("8888").activo, false, "el inactivo se ve (deshabilitado en el formulario)");
  assert.equal(cat.get("1382").asignadoA, "op_prueba");
  assert.equal(cat.get("4001").asignadoA, null);
  assert.equal((await api("GET", "/api/admin/personal-mes", null, "op")).status, 403);

  const alta = (b) => api("POST", "/api/admin/operadores", { rol: "mantenimiento_op", nombre: "", username: "juan.perez", pin: "5937", numeroEmpleado: "4001", ...b });
  // Asociaciones invalidas: no se crea nada.
  r = await alta({ numeroEmpleado: "9999" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no existe en el catalogo/);
  r = await alta({ numeroEmpleado: "8888" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /INACTIVO/);
  r = await alta({ numeroEmpleado: "1382" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /op_prueba/);
  assert.equal((await alta({ numeroEmpleado: "" })).status, 400, "operador sin empleado");
  for (const rol of ["operador_produccion", "supervisor", "admin", "capturista"]) {
    r = await alta({ rol });
    assert.equal(r.status, 400, `rol ${rol}`);
    assert.match(r.data.error, /Rol no valido/);
  }
  assert.equal((await alta({ username: "op_prueba" })).status, 409, "usuario duplicado");
  assert.equal((await alta({ pin: "1234" })).status, 400, "PIN trivial");
  assert.equal(Number((await dbq("SELECT COUNT(*) n FROM usuarios WHERE username = 'juan.perez'"))[0].n), 0, "ningun rechazo deja una cuenta a medias");

  // Alta valida: sin nombre escrito, toma el del MES.
  r = await alta({});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.rol, r.data.numeroEmpleado, r.data.nombre, r.data.activo], ["mantenimiento_op", "4001", "TECNICO 4001", true]);
  assert.ok(r.data.creado && !Number.isNaN(Date.parse(r.data.creado)), "fecha de creacion");
  assert.equal((await api("GET", "/api/admin/personal-mes")).data.personal.find((p) => p.numeroEmpleado === "4001").asignadoA, "juan.perez");

  // Listado: persistente y con el estado del vinculo en el MES.
  const cuenta = async (u) => (await api("GET", "/api/admin/operadores")).data.operadores.find((o) => o.username === u);
  let l = await api("GET", "/api/admin/operadores");
  assert.equal(l.data.mes.disponible, true);
  let j = await cuenta("juan.perez");
  assert.deepEqual([j.empleado.estado, j.empleado.nombre, j.atiendeParos], ["ACTIVO", "TECNICO 4001", true]);
  await stopApp();
  await startApp();
  j = await cuenta("juan.perez");
  assert.ok(j && j.numeroEmpleado === "4001", "sigue en el listado tras reiniciar el servidor");

  // Login con usuario + PIN y atencion completa (el MES recibe su numero y rol).
  assert.equal((await login("juan.perez", "6048")).status, 401, "PIN incorrecto");
  const lj = await login("juan.perez", "5937");
  assert.equal(lj.status, 200, JSON.stringify(lj.data));
  assert.equal(lj.data.redirect, "/operador-mantenimiento");
  assert.equal(lj.data.user.numeroEmpleado, "4001");
  const juan = { headers: { Cookie: lj.cookie } };
  const paroPrevio = mesParo;
  try {
    mesParo = MES_PARO();
    r = await api("GET", "/api/operador/reportes/482913", null, juan);
    assert.equal(r.data.puedeAceptar, true, JSON.stringify(r.data));
    r = await api("POST", "/api/operador/reportes/482913/aceptar", null, juan);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const acc = mesLlamadas.filter((c) => c.url.endsWith("/aceptar")).pop();
    assert.deepEqual([acc.actor, acc.rol], ["4001", "mantenimiento_op"]);
    const id = r.data.id;
    r = await api("POST", `/api/operador/atenciones/${id}/continuidad`, null, "op");
    assert.equal(r.status, 200, "otro tecnico toma continuidad");
    r = await api("POST", `/api/operador/atenciones/${id}/finalizar`, { categoria: "sensor", problemaDetectado: "p", actionTaken: "t", fotos: [{ tipo: "despues", name: "d.png", base64: PNG.toString("base64") }] }, juan);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.estado, "CERRADO");
    assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/finalizar")).pop().actor, "4001");
    assert.deepEqual(r.data.participantes.map((x) => `${x.numeroEmpleado}:${x.tipoActor}:${x.minutosAsignados}`), ["4001:operador:60", "1382:operador:60"]);
  } finally {
    mesParo = paroPrevio;
  }
  assert.ok((await api("GET", "/api/data")).data.technicians.some((t) => String(t.employee_number) === "4001"), "roster / estadisticas");

  // Administrador desde el mismo formulario: contrasena, con o sin empleado.
  r = await api("POST", "/api/admin/operadores", { rol: "mantenimiento_admin", nombre: "Ana", username: "ana.admin", password: "ana-admin-2026", numeroEmpleado: "4002" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.rol, r.data.numeroEmpleado], ["mantenimiento_admin", "4002"]);
  assert.equal((await login("ana.admin", "ana-admin-2026")).data.user.numeroEmpleado, "4002");
  r = await api("POST", "/api/admin/operadores", { rol: "mantenimiento_admin", nombre: "Sin numero", username: "admin.sinnum", password: "admin-sin-2026" });
  assert.equal(r.status, 201);
  assert.equal(r.data.numeroEmpleado, null);
  assert.equal((await api("POST", "/api/admin/operadores", { rol: "mantenimiento_admin", nombre: "x", username: "admin.corta", password: "corta" })).status, 400, "contrasena < 8");
  assert.equal((await api("PATCH", "/api/admin/operadores/ana.admin", { pin: "5937" })).status, 400, "al admin no se le pone PIN");
  assert.equal((await api("PATCH", "/api/admin/operadores/juan.perez", { password: "larga-2026" })).status, 400, "al operador no se le pone contrasena");
  r = await api("PATCH", "/api/admin/operadores/ana.admin", { activo: false });
  assert.equal(r.status, 200, "otro admin puede desactivarla");
  assert.equal((await login("ana.admin", "ana-admin-2026")).status, 401);
  assert.equal((await api("PATCH", `/api/admin/operadores/${USUARIOS.admin.username}`, { activo: false })).status, 400, "no se desactiva a si mismo");
  await api("PATCH", "/api/admin/operadores/ana.admin", { activo: true });

  // Desactivar / reactivar el operador.
  r = await api("PATCH", "/api/admin/operadores/juan.perez", { activo: false });
  assert.equal(r.data.activo, false);
  assert.equal((await api("GET", "/api/auth/me", null, juan)).status, 401, "sus sesiones se cierran");
  assert.equal((await login("juan.perez", "5937")).status, 401, "desactivado no entra");
  assert.equal((await cuenta("juan.perez")).atiendeParos, false);
  assert.equal((await api("PATCH", "/api/admin/operadores/juan.perez", { activo: true })).data.activo, true);

  // Cambiar el empleado asociado: validado; la historia del MES no se toca.
  assert.equal((await api("PATCH", "/api/admin/operadores/juan.perez", { numeroEmpleado: "8888" })).status, 400, "inactivo");
  assert.equal((await api("PATCH", "/api/admin/operadores/juan.perez", { numeroEmpleado: "4002" })).status, 409, "de otra cuenta");
  assert.equal((await api("PATCH", "/api/admin/operadores/juan.perez", { numeroEmpleado: "" })).status, 400, "operador sin empleado");
  r = await api("PATCH", "/api/admin/operadores/juan.perez", { numeroEmpleado: "4003", nombre: "Juan Pérez" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.numeroEmpleado, r.data.nombre], ["4003", "Juan Pérez"]);
  const cat2 = new Map((await api("GET", "/api/admin/personal-mes")).data.personal.map((p) => [p.numeroEmpleado, p]));
  assert.deepEqual([cat2.get("4001").asignadoA, cat2.get("4003").asignadoA], [null, "juan.perez"], "el numero anterior queda libre");
  const aud = await dbq("SELECT accion, valor_anterior, valor_nuevo FROM auditoria WHERE entidad = 'usuario' AND entidad_id = 'juan.perez' ORDER BY id");
  assert.equal(aud[0].accion, "alta_cuenta");
  const cambio = aud.find((a) => /"4003"/.test(a.valor_nuevo || ""));
  assert.ok(cambio && /"4001"/.test(cambio.valor_anterior), "auditoria con numero anterior y nuevo");
  assert.ok(aud.every((a) => !/5937/.test(`${a.valor_anterior}${a.valor_nuevo}`)), "sin PIN en la auditoria");

  // El MES da de baja al empleado despues: el listado lo avisa antes de que el tecnico lo sufra.
  mesPersonalBaja.add("4003");
  try {
    j = await cuenta("juan.perez");
    assert.deepEqual([j.empleado.estado, j.atiendeParos], ["INACTIVO", false]);
  } finally {
    mesPersonalBaja.delete("4003");
  }

  // Unicidad garantizada por la base (mig 008), no solo por la aplicacion.
  await assert.rejects(dbq("UPDATE usuarios SET numero_empleado = '4002' WHERE username = 'juan.perez'"), /Duplicate/);

  // Operador sin empleado (estado invalido heredado, solo editando la base): no entra y el listado lo marca.
  await dbq("UPDATE usuarios SET numero_empleado = NULL WHERE username = 'juan.perez'");
  r = await login("juan.perez", "5937");
  assert.equal(r.status, 403);
  assert.match(r.data.error, /no esta asociada a un empleado/);
  assert.equal((await login("juan.perez", "0000")).status, 401, "con PIN incorrecto no se revela nada");
  j = await cuenta("juan.perez");
  assert.deepEqual([j.empleado.estado, j.atiendeParos], ["SIN_NUMERO", false]);
  await dbq("UPDATE usuarios SET numero_empleado = '4003', intentos_fallidos = 0, bloqueado_hasta = NULL WHERE username = 'juan.perez'");
});

test("autorizacion: el backend valida el rol (401/403)", async () => {
  let r0;
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
    ["GET", "/api/configuracion"],
    ["PUT", "/api/configuracion"],
    ["POST", "/api/contramedidas/propuestas/1/aprobar"],
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

  // tecnico_consulta (mig 006): SOLO LECTURA de desempeno / tiempo muerto / MTTR-MTBF / historico.
  r0 = await api("POST", "/api/admin/operadores", { rol: "tecnico_consulta", nombre: "Consulta Prueba", username: "consulta_prueba", password: "consulta-123" });
  assert.equal(r0.status, 201, JSON.stringify(r0.data));
  assert.equal(r0.data.rol, "tecnico_consulta");
  assert.equal(r0.data.numeroEmpleado, null);
  assert.equal((await api("PATCH", "/api/admin/operadores/consulta_prueba", { numeroEmpleado: "7778" })).status, 400, "un usuario de consulta no lleva numero (no atiende paros)");
  const lc = await login("consulta_prueba", "consulta-123");
  assert.equal(lc.status, 200);
  assert.equal(lc.data.redirect, "/", "entra al dashboard");
  const con = { headers: { Cookie: lc.cookie } };
  const me = await api("GET", "/api/auth/me", null, con);
  assert.deepEqual(me.data.capacidades.sort(), ["dashboard", "historico"]);
  assert.equal((await api("GET", "/api/data", null, con)).status, 200, "tiempo muerto / MTTR / MTBF / desempeno (lectura)");
  assert.equal((await api("GET", "/api/refresh", null, con)).status, 200);
  const hist = await api("GET", "/api/historico/paros?estado=todos", null, con);
  assert.equal(hist.status, 200, JSON.stringify(hist.data));
  assert.ok(Array.isArray(hist.data.filas));
  assert.equal((await api("GET", "/api/historico/catalogos", null, con)).status, 200);
  // Directamente contra la API, todo lo demas se rechaza en el backend (403).
  const prohibido = [
    ["GET", "/api/operador/atenciones"], ["POST", "/api/operador/reportes/482913/aceptar"], ["POST", "/api/operador/atenciones/1000001/continuidad"],
    ["POST", "/api/operador/atenciones/1000001/finalizar"], ["POST", "/api/operador/atenciones/1000001/evidencias"],
    ["GET", "/api/admin/operadores"], ["POST", "/api/admin/operadores"], ["PATCH", "/api/admin/operadores/roberto"],
    ["GET", "/api/contramedidas"], ["POST", "/api/contramedidas"], ["PUT", "/api/contramedidas/x"], ["DELETE", "/api/contramedidas/x"], ["GET", "/api/contramedidas/recomendaciones"],
    ["GET", "/api/configuracion"], ["PUT", "/api/configuracion"], ["GET", "/api/auditoria"], ["POST", "/api/contramedidas/programacion-automatica"],
    ["GET", "/api/contramedidas/propuestas"], ["POST", "/api/contramedidas/propuestas/1/aprobar"], ["POST", "/api/contramedidas/propuestas/1/rechazar"],
    ["POST", "/api/contramedidas/propuestas/1/reprogramar"],
    ["GET", "/api/bonos"], ["POST", "/api/bonos/week"], ["GET", "/api/calendarios"], ["POST", "/api/calendarios"], ["GET", "/api/documentos"], ["POST", "/api/documentos/Dibujos"],
    ["GET", "/api/gastos"], ["POST", "/api/gastos/refresh"], ["GET", "/api/entregas"],
  ];
  for (const [m, u] of prohibido) {
    const rr = await api(m, u, m === "GET" ? null : {}, con);
    assert.equal(rr.status, 403, `${m} ${u} como tecnico_consulta debe ser 403 (fue ${rr.status})`);
  }
  assert.equal((await api("GET", "/", null, con)).status, 200, "ve el dashboard");
  assert.equal((await api("GET", "/app.js", null, con)).status, 200);
  assert.equal((await api("GET", "/operador-mantenimiento", null, con)).status, 302, "no tiene pantalla de operador");
  const opAsConsulta = await api("GET", "/operador.js", null, con);
  assert.equal(opAsConsulta.status, 302);
  // El operador tampoco ve el historico ni el dashboard.
  assert.equal((await api("GET", "/api/historico/paros", null, "op")).status, 403);
  assert.equal((await api("POST", "/api/admin/operadores", { rol: "tecnico_consulta", nombre: "x", username: "consulta_op", password: "consulta-123" }, "op")).status, 403);

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

  // Evidencia DURANTE la atencion (MES mig 090): persistente, con quien la subio.
  const foto = (tipo, name = `${tipo}.png`, buf = PNG) => ({ tipo, name, base64: buf.toString("base64") });
  r = await api("POST", `/api/operador/atenciones/${atencionId}/evidencias`, { fotos: [{ ...foto("durante"), descripcion: "sensor sucio" }] }, "op");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.fotos.length, 1);
  assert.equal(r.data.fotos[0].tipo, "durante");
  assert.equal(r.data.fotos[0].etapa, "atencion");
  assert.equal(r.data.fotos[0].descripcion, "sensor sucio");
  assert.equal(r.data.fotos[0].subidoPor.numeroEmpleado, "1382");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/evidencias`, { fotos: [{ ...foto("x") }] }, "op")).status, 400, "tipo invalido");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/evidencias`, { fotos: [] }, "op")).status, 400, "sin fotos");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/evidencias`, { fotos: [foto("durante")] }, "admin")).data.code, "TECNICO_SIN_NUMERO");

  // Validaciones tempranas (el MES vuelve a validar).
  const base = { categoria: "sensor", problemaDetectado: "Sensor sucio", actionTaken: "Se limpio", fotos: [foto("antes"), foto("despues")] };
  const fin = (extra) => api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, { ...base, ...extra }, "op");
  assert.equal((await fin({ categoria: "" })).status, 400, "categoria obligatoria");
  assert.equal((await fin({ problemaDetectado: " " })).status, 400, "problema obligatorio");
  assert.equal((await fin({ actionTaken: "" })).status, 400, "trabajo obligatorio");
  assert.equal((await fin({ fotos: [foto("antes")] })).status, 400, "foto despues obligatoria");
  assert.equal((await fin({ fotos: [foto("antes", "a.gif"), foto("despues")] })).status, 400, "solo jpg/png");
  assert.equal((await fin({ fotos: Array(7).fill(0).map(() => foto("durante")) })).status, 400, "max 6 fotos");

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

  // Lo FINALIZA el segundo tecnico (distinto de quien inicio): el paro queda CERRADO.
  r = await api("POST", `/api/operador/atenciones/${atencionId}/finalizar`, base, otroH);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, "CERRADO", "finalizar cierra el paro (sin codigo de cierre)");
  assert.equal(r.data.codigoCierre, null);
  assert.equal(r.data.cierreModo, "finalizacion");
  assert.ok(r.data.cerradoEn);
  assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/finalizar")).pop().actor, "2000", "finaliza con SU numero de empleado");
  assert.deepEqual(r.data.participantes.map((x) => `${x.numeroEmpleado}:${x.roles.join("+")}`), ["1382:inicio", "2000:continuidad+finalizo"]);
  assert.ok(r.data.participantes.every((x) => x.minutosAsignados === 60), "cada participante con el tiempo completo");
  assert.equal(r.data.categoria.codigo, "sensor");
  assert.equal(r.data.problemaDetectado, "Sensor sucio");
  assert.equal(r.data.actionTaken, "Se limpio");
  assert.equal(r.data.fotos.length, 3, "durante + antes + despues: la evidencia no se borra al cerrar");
  cierreGenerado = "C-ABCD-EF23"; // ya no existe: solo para el endpoint retirado (410)
  // Doble finalizacion: el MES la rechaza (409) y el reporte no cambia.
  const doble = await fin({ problemaDetectado: "otra cosa" });
  assert.equal(doble.status, 409, JSON.stringify(doble.data));
  assert.equal((await api("GET", `/api/operador/atenciones/${atencionId}`, null, "op")).data.problemaDetectado, "Sensor sucio");
  assert.equal((await api("POST", `/api/operador/atenciones/${atencionId}/evidencias`, { fotos: [foto("durante")] }, "op")).status, 409, "sin evidencia nueva tras cerrar");
  for (const f of r.data.fotos) {
    const g = await api("GET", f.url, null, "op");
    assert.equal(g.status, 200);
    assert.deepEqual(g.data, PNG);
    assert.equal((await api("GET", f.url, null, { headers: { Cookie: otro } })).status, 200, "la evidencia la ve todo mantenimiento");
  }
  // Nada se escribe en las tablas locales de atenciones: el MES es la fuente.
  assert.equal(await count("paro_atenciones"), 0);
  r = await api("GET", "/api/operador/atenciones", null, "op");
  assert.equal(r.data.recientes[0].estado, "CERRADO");
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
  assert.equal(r.status, 409, "numero ya usado por otro usuario");
  r = await api("PATCH", "/api/admin/operadores/admin_jona", { numeroEmpleado: "3000" });
  assert.equal(r.status, 409, "3000 lo tiene admin_tec");
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
  assert.equal(r.data.estado, "CERRADO", "el admin finaliza y el paro queda cerrado");
  assert.equal(mesLlamadas.filter((c) => c.url.endsWith("/finalizar")).pop().rol, "mantenimiento_admin");
  assert.ok(r.data.participantes.every((x) => x.minutosAsignados === 60), "tiempo completo para cada participante");
  const id = r.data.id;
  // No existe ninguna accion de "cerrar" aparte: ni en Metricas ni para la terminal.
  assert.equal((await api("POST", `/api/operador/atenciones/${id}/cerrar`, {}, jona)).status, 404);
  assert.equal((await api("POST", "/api/terminal/cierres/validar", { codigoCierre: "x" }, jona)).status, 410);

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
    // Operadores: el listado sale de ESTA base (vinculo DESCONOCIDO); el alta no se hace sin validar.
    const l = await api("GET", "/api/admin/operadores");
    assert.equal(l.status, 200);
    assert.equal(l.data.mes.disponible, false);
    assert.ok(l.data.operadores.find((o) => o.username === USUARIOS.op.username).empleado.estado === "DESCONOCIDO");
    const a = await api("POST", "/api/admin/operadores", { rol: "mantenimiento_op", nombre: "x", username: "sin.mes", pin: "5937", numeroEmpleado: "4001" });
    assert.equal(a.status, 503);
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
  assert.equal(r.data.estado, "CERRADO");
  assert.equal(r.data.codigoCierre, null);
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
