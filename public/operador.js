"use strict";

// Pantalla del operador de mantenimiento:
//   /operador-mantenimiento                 codigo de reporte
//   /operador-mantenimiento/atender/<id>    captura del trabajo + evidencia
//   /operador-mantenimiento/cierre/<id>     paro cerrado (sin codigo de cierre, MES mig 090)
(function () {
  const $ = (id) => document.getElementById(id);
  const BASE = "/operador-mantenimiento";
  const MAX_FOTO = 5 * 1024 * 1024;
  let consulta = null; // ultima consulta de reporte
  let atencion = null; // atencion en pantalla
  let categorias = null; // catalogo de categorias de falla (KOIDE MES)
  const EN_CURSO = ["EN_ATENCION", "EN_ESPERA_EXTERNA"];

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
      ["Código de atención", r.codigo],
      ["Máquina", [r.maquina, r.maquinaNombre].filter(Boolean).join(" · ")],
      ["Línea", r.linea],
      ["Proceso", r.proceso],
      ["Fecha / turno", [r.fecha, r.turno, r.grupo && `Grupo ${r.grupo}`].filter(Boolean).join(" · ")],
      ["Inicio del paro", fecha(r.inicio)],
      ["Nota del operador", r.descripcion],
      ["Reportó", r.reportadoPor],
    ];
  }

  // Participantes del paro: cada uno con el tiempo COMPLETO del paro.
  const ROLES = { inicio: "inició", continuidad: "tomó continuidad", finalizo: "finalizó" };
  function horas(min) {
    if (min == null) return "—";
    return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")} h`;
  }
  function pintarParticipantes(el, a) {
    el.innerHTML = "";
    const lista = a.participantes || [];
    if (!lista.length) return;
    const t = document.createElement("h3");
    t.className = "acc-h2";
    t.textContent = `Técnicos participantes · duración del paro ${horas(a.duracion && a.duracion.minutos)}${a.duracion && a.duracion.enCurso ? " (en curso)" : ""}`;
    const ul = document.createElement("ul");
    ul.className = "acc-list";
    for (const x of lista) {
      const li = document.createElement("li");
      li.dataset.numero = x.numeroEmpleado;
      const actual = a.responsableActual === x.numeroEmpleado && ["EN_ATENCION", "EN_ESPERA_EXTERNA"].includes(a.estado);
      const rs = x.rolSnapshot === "mantenimiento_admin" ? " · Administrador" : x.rolSnapshot === "mantenimiento_op" ? " · Operador" : "";
      li.dataset.rol = x.rolSnapshot || "";
      li.textContent = `${x.nombre || "—"} (#${x.numeroEmpleado})${rs} · ${x.roles.map((r) => ROLES[r] || r).join(", ")}${actual ? " · atiende ahora" : ""}`;
      const tm = document.createElement("span");
      tm.className = "mono";
      tm.textContent = horas(x.minutosAsignados);
      li.append(" ", tm);
      ul.appendChild(li);
    }
    el.append(t, ul);
  }
  function participantesTexto(a) {
    return (a.participantes || []).map((x) => `${x.nombre || x.numeroEmpleado} (${x.roles.map((r) => ROLES[r] || r).join(", ")})`).join(" · ") || null;
  }

  async function cargarCategorias() {
    if (categorias) return;
    const d = await api("GET", "/api/operador/catalogos");
    categorias = d.categorias || [];
    const sel = $("at-categoria");
    for (const c of categorias) {
      const o = document.createElement("option");
      o.value = c.codigo;
      o.textContent = c.nombre;
      sel.appendChild(o);
    }
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
      pintarLista("op-abiertas", d.abiertas, (a) => ({ texto: `Paro ${a.codigoReporte} · ${a.reporte.maquina || ""}${a.estado === "EN_ESPERA_EXTERNA" ? " · en espera externa" : ""}`, boton: a.esParticipante ? "Continuar" : "Ver", ir: `${BASE}/atender/${a.id}` }));
      pintarLista("op-encurso", d.enCurso || [], (a) => ({ texto: `Paro ${a.codigoReporte} · ${a.reporte.maquina || ""} · ${participantesTexto(a) || ""}`, boton: "Ver / tomar continuidad", ir: `${BASE}/atender/${a.id}` }));
      pintarLista("op-recientes", d.recientes, (a) => ({ texto: `Reporte ${a.codigoReporte} · ${a.reporte.maquina || ""}`, estado: a.estado, boton: "Ver", ir: `${BASE}/cierre/${a.id}` }));
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
        b.textContent = v.estado === "CERRADO" ? "Cerrado" : v.estado === "ANULADO" ? "Anulado" : "Atención terminada";
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
    if (!codigo) return error("Ingresa el código de atención.");
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
    // Atencion en curso: quien participa continua; otro tecnico puede tomar
    // continuidad; sin numero de empleado, solo consulta.
    const a = consulta.atencion;
    if (a && EN_CURSO.includes(a.estado)) {
      $("conf-motivo").hidden = true;
      $("conf-aceptar").hidden = false;
      $("conf-aceptar").textContent = a.esParticipante ? "CONTINUAR ATENCIÓN"
        : a.puedeTomarContinuidad ? "VER ATENCIÓN / TOMAR CONTINUIDAD" : "VER ATENCIÓN (SOLO LECTURA)";
    } else if (consulta.atencion) {
      $("conf-aceptar").hidden = false;
      $("conf-aceptar").textContent = "VER REPORTE";
    } else {
      $("conf-aceptar").textContent = "INICIAR ATENCIÓN";
    }
  }

  $("conf-cancelar").addEventListener("click", () => ir(BASE));

  $("conf-aceptar").addEventListener("click", async () => {
    if (consulta.atencion) {
      return ir(EN_CURSO.includes(consulta.atencion.estado) ? `${BASE}/atender/${consulta.atencion.id}` : `${BASE}/cierre/${consulta.atencion.id}`);
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
    if (!EN_CURSO.includes(atencion.estado)) return ir(`${BASE}/cierre/${atencion.id}`, true);
    mostrar("paso-atender");
    $("at-sub").textContent = `Aceptado por ${atencion.aceptadoPor}${atencion.tecnicoNumeroEmpleado ? ` (#${atencion.tecnicoNumeroEmpleado})` : ""} · ${fecha(atencion.aceptadoEn)}`;
    pintarParticipantes($("at-participantes"), atencion);
    // Permisos que calcula el servidor (el MES vuelve a validar cada accion):
    //   puedeOperar  -> participa: pausa / reanuda
    //   puedeTomarContinuidad -> otro tecnico puede sumarse
    //   puedeFinalizar -> cualquier tecnico con numero, atencion en curso
    const soloLectura = !atencion.puedeFinalizar && !atencion.puedeOperar && !atencion.puedeTomarContinuidad;
    $("at-solo-lectura").hidden = atencion.esParticipante;
    $("at-solo-lectura").textContent = soloLectura
      ? "Solo lectura: tu usuario no puede intervenir en esta atención."
      : atencion.esParticipante ? ""
        : "No participas todavía en esta atención. Toma continuidad para continuarla, o captura el reporte para finalizarla: quedarás registrado como participante.";
    $("at-continuidad").hidden = !(atencion.puedeTomarContinuidad && !atencion.esParticipante);
    $("at-espera-card").hidden = !atencion.puedeOperar;
    $("form-finalizar").hidden = !atencion.puedeFinalizar && !(atencion.puedeOperar && atencion.estado === "EN_ESPERA_EXTERNA");
    $("at-volver-lectura").hidden = !$("form-finalizar").hidden;
    dl($("at-datos"), datosReporte(atencion.reporte));
    const espera = atencion.estado === "EN_ESPERA_EXTERNA";
    const ee = atencion.esperaExterna || {};
    $("at-espera").hidden = espera;
    $("at-espera-nota-campo").hidden = espera;
    $("at-reanudar").hidden = !espera;
    $("at-espera-estado").textContent = espera
      ? `En espera externa desde ${fecha(ee.inicio)}${ee.nota ? ` · ${ee.nota}` : ""}. Reanuda para poder completar el reporte.`
      : ee.minutos
        ? `Espera externa acumulada: ${ee.minutos} min (no cuenta como reparación).`
        : "Si la reparación depende de algo externo (fabricar una pieza, proveedor), pausa la atención: ese tiempo no cuenta como reparación.";
    $("at-finalizar").disabled = espera;
    // Evidencia durante la atencion (MES mig 090) y estado de la foto "despues".
    $("at-evidencia-card").hidden = !atencion.puedeAgregarEvidencia;
    pintarEvidencias($("at-evidencias"), atencion);
    const hayDespues = (atencion.fotos || []).some((f) => f.tipo === "despues");
    $("at-foto-despues-label").textContent = hayDespues ? "Foto después (ya hay una registrada; opcional)" : "Foto después *";
    $("at-fotos-titulo").textContent = hayDespues
      ? "Evidencia adicional (JPG o PNG, máx. 5 MB) — ya existe una foto «después»"
      : "Evidencia (JPG o PNG, máx. 5 MB) — la foto «después» es obligatoria";
    cargarCategorias().catch((err) => error(err.message));
  }

  const TIPO_EV = { antes: "antes", durante: "durante", despues: "después" };
  function pintarEvidencias(el, a) {
    el.innerHTML = "";
    for (const f of a.fotos || []) {
      const li = document.createElement("li");
      li.dataset.tipo = f.tipo;
      const img = document.createElement("img");
      img.src = f.url;
      img.alt = f.tipo;
      img.className = "acc-thumb";
      const txt = document.createElement("span");
      const quien = f.subidoPor ? ` · #${f.subidoPor.numeroEmpleado || "?"}${f.subidoPor.usuario ? ` (${f.subidoPor.usuario})` : ""}` : "";
      txt.textContent = ` ${TIPO_EV[f.tipo] || f.tipo}${f.descripcion ? ` · ${f.descripcion}` : ""}${quien}${f.creado ? ` · ${fecha(f.creado)}` : ""}`;
      li.append(img, txt);
      el.appendChild(li);
    }
  }

  preview("at-ev-archivo", "at-ev-prev");
  $("at-ev-agregar").addEventListener("click", async () => {
    const f = $("at-ev-archivo").files[0];
    if (!f) return error("Selecciona una foto para agregar como evidencia.");
    $("at-ev-agregar").disabled = true;
    error("");
    try {
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/evidencias`, {
        fotos: [{ tipo: $("at-ev-tipo").value, name: f.name, base64: await toB64(f), descripcion: $("at-ev-desc").value.trim() }],
      });
      $("at-ev-archivo").value = "";
      $("at-ev-desc").value = "";
      $("at-ev-prev").hidden = true;
      pantallaAtender();
    } catch (err) {
      error(err.message);
    } finally {
      $("at-ev-agregar").disabled = false;
    }
  });

  $("at-espera").addEventListener("click", async () => {
    $("at-espera").disabled = true;
    error("");
    try {
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/espera-externa`, { nota: $("at-espera-nota").value.trim() });
      $("at-espera-nota").value = "";
      pantallaAtender();
    } catch (err) {
      error(err.message);
    } finally {
      $("at-espera").disabled = false;
    }
  });

  $("at-volver-lectura").addEventListener("click", () => ir(BASE));

  $("at-continuidad").addEventListener("click", async () => {
    $("at-continuidad").disabled = true;
    error("");
    try {
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/continuidad`);
      pantallaAtender();
    } catch (err) {
      error(err.message);
    } finally {
      $("at-continuidad").disabled = false;
    }
  });

  $("at-reanudar").addEventListener("click", async () => {
    $("at-reanudar").disabled = true;
    error("");
    try {
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/reanudar`);
      pantallaAtender();
    } catch (err) {
      error(err.message);
    } finally {
      $("at-reanudar").disabled = false;
    }
  });

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
    const categoria = $("at-categoria").value;
    const problema = $("at-problema").value.trim();
    if (!categoria) return error("Selecciona la categoría de falla.");
    if (!problema) return error("Describe el problema detectado.");
    if (!trabajo) return error("Escribe la descripción del trabajo realizado.");
    const hayDespues = (atencion.fotos || []).some((f) => f.tipo === "despues");
    if (!hayDespues && !$("at-foto-despues").files[0]) return error("La foto «después» es obligatoria: sin evidencia de la reparación terminada no se cierra el paro.");
    if (!confirm("¿Completar el reporte? El paro quedará CERRADO y no se podrá modificar.")) return;
    $("at-finalizar").disabled = true;
    error("");
    try {
      const fotos = [];
      for (const [tipo, id] of [["antes", "at-foto-antes"], ["despues", "at-foto-despues"]]) {
        const f = $(id).files[0];
        if (f) fotos.push({ tipo, name: f.name, base64: await toB64(f) });
      }
      atencion = await api("POST", `/api/operador/atenciones/${atencion.id}/finalizar`, {
        categoria,
        problemaDetectado: problema,
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
    if (EN_CURSO.includes(atencion.estado)) return ir(`${BASE}/atender/${atencion.id}`, true);
    mostrar("paso-cierre");
    const cerrado = atencion.estado === "CERRADO";
    $("cierre-titulo").textContent = cerrado ? "Paro cerrado" : atencion.estado === "ANULADO" ? "Paro anulado" : "Reporte completado";
    $("cierre-sub").textContent = cerrado
      ? `La atención quedó registrada y el paro está cerrado en KOIDE MES${atencion.cerradoEn ? ` (${fecha(atencion.cerradoEn)})` : ""}.`
      : atencion.estado === "ANULADO" ? "Un supervisor anuló este paro." : "Atención terminada (registro histórico anterior al cierre directo).";
    // Solo el historico cerrado con el doble codigo conserva un codigo.
    $("cierre-codigo").hidden = !atencion.codigoCierre;
    $("cierre-codigo").textContent = atencion.codigoCierre || "";
    pintarEvidencias($("cierre-evidencias"), atencion);
    dl($("cierre-datos"), [
      ["Código de atención", atencion.codigoReporte],
      ["Máquina", [atencion.reporte.maquina, atencion.reporte.maquinaNombre].filter(Boolean).join(" · ")],
      ["Categoría", atencion.categoria ? atencion.categoria.nombre : null],
      ["Problema detectado", atencion.problemaDetectado],
      ["Técnicos", participantesTexto(atencion) || atencion.tecnicoNombre || atencion.tecnicoNumeroEmpleado],
      ["Tiempo asignado a cada técnico", atencion.duracion && atencion.duracion.minutos != null ? `${horas(atencion.duracion.minutos)}${atencion.duracion.enCurso ? " (en curso)" : ""}` : null],
      ["Aceptado", fecha(atencion.aceptadoEn)],
      ["Finalizado", fecha(atencion.finalizadoEn)],
      ["Tiempo de respuesta", atencion.responseTimeMinutes != null ? `${atencion.responseTimeMinutes} min` : null],
      ["Tiempo de reparación", atencion.repairTimeMinutes != null ? `${atencion.repairTimeMinutes} min` : null],
      ["Espera externa", atencion.esperaExterna && atencion.esperaExterna.minutos ? `${atencion.esperaExterna.minutos} min` : null],
      ["Duración total del paro", atencion.downtimeMinutes != null ? `${atencion.downtimeMinutes} min` : null],
      ["Evidencia", atencion.fotos.length ? `${atencion.fotos.length} foto(s)` : "Sin fotos"],
      ["Estado", cerrado ? `Cerrado por mantenimiento${atencion.cerradoEn ? ` (${fecha(atencion.cerradoEn)})` : ""}` : atencion.estado === "ANULADO" ? "Anulado por supervisión" : "Atención terminada"],
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
      $("op-usuario").textContent = d.user.numeroEmpleado ? `${d.user.nombre} · #${d.user.numeroEmpleado}` : d.user.nombre;
      $("op-dashboard").hidden = d.user.rol !== "mantenimiento_admin";
      $("op-solo-lectura").hidden = Boolean(d.user.numeroEmpleado);
      $("op-flujo").hidden = !d.user.numeroEmpleado;
    })
    .catch(() => {});

  enrutar();
})();
