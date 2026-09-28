"use strict";

// Pantalla del operador de mantenimiento:
//   /operador-mantenimiento                 codigo de reporte
//   /operador-mantenimiento/atender/<id>    captura del trabajo + evidencia
//   /operador-mantenimiento/cierre/<id>     codigo de cierre
(function () {
  const $ = (id) => document.getElementById(id);
  const BASE = "/operador-mantenimiento";
  const MAX_FOTO = 5 * 1024 * 1024;
  let consulta = null; // ultima consulta de reporte
  let atencion = null; // atencion en pantalla

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.replace("/login");
      throw new Error("Sesión expirada");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
    return data;
  }

  function error(msg) {
    $("op-error").textContent = msg || "";
    $("op-error").hidden = !msg;
  }

  function fecha(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function dl(el, pares) {
    el.innerHTML = "";
    for (const [k, v] of pares) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v == null || v === "" ? "—" : String(v);
      el.append(dt, dd);
    }
  }

  function datosReporte(r) {
    return [
      ["Código", r.codigo],
      ["Máquina", [r.maquina, r.maquinaNombre].filter(Boolean).join(" · ")],
      ["Proceso", r.proceso],
      ["Fecha / turno", [r.fecha, r.turno, r.grupo && `Grupo ${r.grupo}`].filter(Boolean).join(" · ")],
      ["Inicio del paro", fecha(r.inicio)],
      ["Categoría", r.categoria],
      ["Problema", r.descripcion],
      ["Reportó", r.reportadoPor],
    ];
  }

  function mostrar(paso) {
    for (const p of ["paso-codigo", "paso-confirmar", "paso-atender", "paso-cierre"]) $(p).hidden = p !== paso;
    window.scrollTo({ top: 0 });
  }

  function ir(ruta, reemplazar) {
    if (location.pathname !== ruta) history[reemplazar ? "replaceState" : "pushState"]({}, "", ruta);
    enrutar();
  }

  /* ---------- 1. Codigo ---------- */

  async function pantallaCodigo() {
    error("");
    mostrar("paso-codigo");
    $("op-codigo").value = "";
    $("op-codigo").focus();
    try {
      const d = await api("GET", "/api/operador/atenciones");
      pintarLista("op-abiertas", d.abiertas, (a) => ({ texto: `Reporte ${a.codigoReporte} · ${a.reporte.maquina || ""}`, boton: "Continuar", ir: `${BASE}/atender/${a.id}` }));
      pintarLista("op-recientes", d.recientes, (a) => ({ texto: `Reporte ${a.codigoReporte} · ${a.reporte.maquina || ""}`, mono: a.codigoCierre, estado: a.estado, boton: "Ver", ir: `${BASE}/cierre/${a.id}` }));
    } catch (err) {
      error(err.message);
    }
  }

  function pintarLista(id, items, fn) {
    const ul = $(id);
    ul.innerHTML = "";
    $(id + "-card").hidden = !items.length;
    for (const it of items) {
      const v = fn(it);
      const li = document.createElement("li");
      const txt = document.createElement("span");
      txt.textContent = v.texto + " ";
      if (v.mono) {
        const m = document.createElement("span");
        m.className = "mono";
        m.textContent = v.mono;
        txt.append(m, " ");
      }
      if (v.estado) {
        const b = document.createElement("span");
        b.className = `acc-badge ${v.estado}`;
        b.textContent = v.estado === "CERRADA" ? "Cerrado en terminal" : "Pendiente de terminal";
        txt.append(b);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "acc-btn ghost small";
      btn.textContent = v.boton;
      btn.addEventListener("click", () => ir(v.ir));
      li.append(txt, btn);
      ul.appendChild(li);
    }
  }

  $("form-codigo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = $("op-codigo").value.trim();
    if (!codigo) return error("Ingresa el código del reporte.");
    $("op-buscar").disabled = true;
    error("");
    try {
      consulta = await api("GET", `/api/operador/reportes/${encodeURIComponent(codigo)}`);
      pantallaConfirmar();
    } catch (err) {
      error(err.message);
      $("op-codigo").select();
    } finally {
      $("op-buscar").disabled = false;
    }
  });

  /* ---------- 2. Confirmar ---------- */

  function pantallaConfirmar() {
    mostrar("paso-confirmar");
    dl($("conf-datos"), datosReporte(consulta.reporte));
    $("conf-aviso").textContent = consulta.aviso || "";
    $("conf-aviso").hidden = !consulta.aviso;
    $("conf-motivo").textContent = consulta.motivo || "";
    $("conf-motivo").hidden = !consulta.motivo;
    $("conf-aceptar").hidden = !consulta.puedeAceptar;
    // Si el reporte ya lo tiene este usuario, ofrecer continuar.
    if (consulta.atencion && consulta.atencion.estado === "EN_ATENCION") {
      $("conf-aceptar").hidden = false;
      $("conf-aceptar").textContent = "CONTINUAR ATENCIÓN";
    } else if (consulta.atencion) {
      $("conf-aceptar").hidden = false;
      $("conf-aceptar").textContent = "VER CÓDIGO DE CIERRE";
    } else {
      $("conf-aceptar").textContent = "ACEPTAR PARO";
    }
  }

  $("conf-cancelar").addEventListener("click", () => ir(BASE));

  $("conf-aceptar").addEventListener("click", async () => {
    if (consulta.atencion) {
      return ir(consulta.atencion.estado === "EN_ATENCION" ? `${BASE}/atender/${consulta.atencion.id}` : `${BASE}/cierre/${consulta.atencion.id}`);
    }
    $("conf-aceptar").disabled = true;
    error("");
    try {
      atencion = await api("POST", `/api/operador/reportes/${encodeURIComponent(consulta.codigo)}/aceptar`);
      ir(`${BASE}/atender/${atencion.id}`);
    } catch (err) {
      error(err.message);
    } finally {
      $("conf-aceptar").disabled = false;
    }
  });

  /* ---------- 3. Atender ---------- */

  function pantallaAtender() {
    if (atencion.estado !== "EN_ATENCION") return ir(`${BASE}/cierre/${atencion.id}`, true);
    mostrar("paso-atender");
    $("at-sub").textContent = `Aceptado por ${atencion.aceptadoPor} · ${fecha(atencion.aceptadoEn)}`;
    dl($("at-datos"), datosReporte(atencion.reporte));
  }

  function preview(inputId, imgId) {
    $(inputId).addEventListener("change", () => {
      const f = $(inputId).files[0];
      const img = $(imgId);
      if (!f) {
        img.hidden = true;
        return;
      }
      if (!/^image\/(jpeg|png)$/.test(f.type)) {
        error("Solo se aceptan fotos JPG o PNG.");
        $(inputId).value = "";
        img.hidden = true;
        return;
      }
      if (f.size > MAX_FOTO) {
        error(`La foto "${f.name}" excede 5 MB.`);
        $(inputId).value = "";
        img.hidden = true;
        return;
      }
      error("");
      img.src = URL.createObjectURL(f);
      img.hidden = false;
    });
  }
  preview("at-foto-antes", "at-prev-antes");
  preview("at-foto-despues", "at-prev-despues");

  function toB64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("No se pudo leer la foto"));
      reader.readAsDataURL(file);
    });
  }

  $("at-volver").addEventListener("click", () => ir(BASE));

  $("form-finalizar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trabajo = $("at-trabajo").value.trim();
    if (!trabajo) return error("Escribe la descripción del trabajo realizado.");
    if (!confirm("¿Completar el reporte? Después no se podrá modificar.")) return;
    $("at-finalizar").disabled = true;
    error("");
    try {
      const fotos = [];
      for (const [tipo, id] of [["antes", "at-foto-antes"], ["despues", "at-foto-despues"]]) {
        const f = $(id).files[0];
        if (f) fotos.push({ tipo, name: f.name, base64: await toB64(f) });
      }
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/finalizar`, {
        actionTaken: trabajo,
        comments: $("at-comentarios").value.trim(),
        fotos,
      });
      $("form-finalizar").reset();
      $("at-prev-antes").hidden = $("at-prev-despues").hidden = true;
      ir(`${BASE}/cierre/${atencion.id}`, true);
    } catch (err) {
      error(err.message);
    } finally {
      $("at-finalizar").disabled = false;
    }
  });

  /* ---------- 4. Cierre ---------- */

  function pantallaCierre() {
    if (atencion.estado === "EN_ATENCION") return ir(`${BASE}/atender/${atencion.id}`, true);
    mostrar("paso-cierre");
    $("cierre-codigo").textContent = atencion.codigoCierre || "—";
    dl($("cierre-datos"), [
      ["Reporte", atencion.codigoReporte],
      ["Máquina", [atencion.reporte.maquina, atencion.reporte.maquinaNombre].filter(Boolean).join(" · ")],
      ["Atendió", atencion.tecnicoNombre],
      ["Aceptado", fecha(atencion.aceptadoEn)],
      ["Finalizado", fecha(atencion.finalizadoEn)],
      ["Tiempo de respuesta", atencion.responseTimeMinutes != null ? `${atencion.responseTimeMinutes} min` : null],
      ["Tiempo de reparación", atencion.repairTimeMinutes != null ? `${atencion.repairTimeMinutes} min` : null],
      ["Evidencia", atencion.fotos.length ? `${atencion.fotos.length} foto(s)` : "Sin fotos"],
      ["Estado", atencion.estado === "CERRADA" ? `Cerrado en terminal (${fecha(atencion.cierreConfirmadoEn)})` : "Pendiente de capturar en la terminal"],
    ]);
  }

  $("cierre-otro").addEventListener("click", () => ir(BASE));

  /* ---------- Rutas ---------- */

  async function enrutar() {
    error("");
    const m = location.pathname.match(/^\/operador-mantenimiento\/(atender|cierre)\/(\d+)$/);
    if (!m) {
      if (location.pathname !== BASE) history.replaceState({}, "", BASE);
      return pantallaCodigo();
    }
    try {
      if (!atencion || String(atencion.id) !== m[2]) atencion = await api("GET", `/api/operador/atenciones/${m[2]}`);
      if (m[1] === "atender") pantallaAtender();
      else pantallaCierre();
    } catch (err) {
      history.replaceState({}, "", BASE);
      await pantallaCodigo();
      error(err.message);
    }
  }

  window.addEventListener("popstate", () => {
    atencion = null;
    enrutar();
  });

  $("op-logout").addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {}
    location.replace("/login");
  });
  $("op-dashboard").addEventListener("click", () => location.assign("/"));

  api("GET", "/api/auth/me")
    .then((d) => {
      $("op-usuario").textContent = d.user.nombre;
      $("op-dashboard").hidden = d.user.rol !== "mantenimiento_admin";
    })
    .catch(() => {});

  enrutar();
})();
