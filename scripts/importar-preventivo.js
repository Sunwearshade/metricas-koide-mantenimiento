"use strict";

// Importa el programa preventivo mensual del sistema "metricos" (JSON) a MySQL
// (tablas de la mig 009).
//
//   node scripts/importar-preventivo.js <ruta>/data/calendarios.json [--evidencias <ruta>/data/calendarios-evidencias]
//
// Solo importa meses que en MySQL no existen o no tienen tareas: nunca toca un
// mes ya programado aqui. Conserva estado y reporte de cada maquina. Las
// evidencias del reporte se copian a DATA_DIR/preventivo-evidencias si se
// indica --evidencias; si no, se omiten (con aviso).

const fs = require("fs");
const path = require("path");
const { loadEnvFile, env, resolvePath } = require("../lib/env");

loadEnvFile();

const db = require("../lib/db");
const preventivo = require("../lib/preventivo");

const ESTADOS = new Set(["", ...preventivo.ESTADOS]);
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXT_RE = /\.(jpe?g|png|pdf)$/i;

function args() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--evidencias");
  const evidencias = i !== -1 ? a[i + 1] : null;
  const archivo = a.find((x, j) => !x.startsWith("--") && j !== i + 1);
  if (!archivo) {
    console.error("Uso: node scripts/importar-preventivo.js <calendarios.json> [--evidencias <carpeta>]");
    process.exit(1);
  }
  return { archivo, evidencias };
}

function copiarEvidencias(lista, origenDir, dataDir, avisos) {
  const out = [];
  for (const e of Array.isArray(lista) ? lista : []) {
    const nombre = path.basename(String((e && (e.name || e.url)) || ""));
    if (!EXT_RE.test(nombre)) continue;
    const src = origenDir ? path.join(origenDir, nombre) : null;
    if (!src || !fs.existsSync(src)) {
      avisos.push(`evidencia omitida: ${nombre}`);
      continue;
    }
    const ext = nombre.match(EXT_RE)[1].toLowerCase().replace("jpeg", "jpg");
    const nuevo = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.mkdirSync(path.join(dataDir, "preventivo-evidencias"), { recursive: true });
    fs.copyFileSync(src, path.join(dataDir, "preventivo-evidencias", nuevo));
    out.push({ name: nuevo });
  }
  return out.slice(0, 6);
}

async function main() {
  const { archivo, evidencias } = args();
  const dataDir = resolvePath(env("DATA_DIR", "data"));
  const cals = JSON.parse(fs.readFileSync(archivo, "utf8"));
  if (!Array.isArray(cals)) throw new Error("El archivo no es una lista de calendarios");
  const avisos = [];
  for (const cal of cals) {
    const mes = String((cal && cal.mes) || "");
    if (!MES_RE.test(mes) || !cal.dias || typeof cal.dias !== "object") {
      avisos.push(`omitido (no es un mes del programa preventivo): ${(cal && cal.name) || "?"}`);
      continue;
    }
    const n = await db.tx(async (conn) => {
      await preventivo.crearMes(mes, { conn });
      const [[r]] = await conn.query("SELECT COUNT(*) AS n FROM preventivo_tareas WHERE mes = ? FOR UPDATE", [mes]);
      if (Number(r.n)) {
        avisos.push(`${mes}: ya tiene programacion en MySQL, no se modifica`);
        return 0;
      }
      let total = 0;
      for (const fecha of Object.keys(cal.dias).sort()) {
        if (!FECHA_RE.test(fecha) || fecha.slice(0, 7) !== mes) continue;
        const tareas = Array.isArray(cal.dias[fecha]) ? cal.dias[fecha] : [];
        for (const [orden, t] of tareas.entries()) {
          const maquina = String((t && t.maquina) || "").trim();
          if (!maquina) continue;
          const estado = ESTADOS.has(t.estado) ? t.estado : "";
          const rep = t.reporte || null;
          const evid = rep ? copiarEvidencias(rep.evidencias, evidencias, dataDir, avisos) : [];
          await conn.query(
            `INSERT INTO preventivo_tareas (mes, fecha, orden, maquina_codigo, maquina_nombre, estado, estado_por, estado_en,
               reporte_responsable, reporte_puntos, reporte_observaciones, reporte_evidencias, reporte_por, reporte_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              mes, fecha, orden, maquina.slice(0, 50), String(t.maquinaNombre || "").slice(0, 255) || null,
              estado, estado ? "importacion" : null, estado ? new Date() : null,
              rep ? String(rep.responsable || "").slice(0, 255) : null,
              rep ? JSON.stringify((Array.isArray(rep.puntos) ? rep.puntos : []).map((p) => ({ punto: String(p.punto || "").slice(0, 255), ok: Boolean(p.ok) })).filter((p) => p.punto)) : null,
              rep ? String(rep.observaciones || "") : null,
              rep ? JSON.stringify(evid) : null,
              rep ? "importacion" : null,
              rep ? new Date() : null,
            ]
          );
          total++;
        }
      }
      return total;
    });
    if (n) console.log(`[importar] ${mes}: ${n} tareas importadas`);
  }
  for (const a of avisos) console.log(`[importar] ${a}`);
}

main()
  .catch((err) => {
    console.error("[importar] Error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.closePool());
