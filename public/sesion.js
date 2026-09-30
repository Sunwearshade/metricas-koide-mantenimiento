"use strict";

// Sesion en el dashboard: muestra el usuario, agrega "Cerrar sesion" y, si el
// servidor responde 401 (sesion expirada), regresa a /login. Se carga antes de
// app.js y no cambia la logica del dashboard.
(function () {
  const originalFetch = window.fetch.bind(window);
  let redirigiendo = false;

  window.fetch = async function (input, init) {
    const res = await originalFetch(input, init);
    const url = typeof input === "string" ? input : input && input.url;
    if (res.status === 401 && !redirigiendo && url && String(url).startsWith("/api/") && !String(url).startsWith("/api/auth/login")) {
      redirigiendo = true;
      location.replace("/login");
    }
    return res;
  };

  async function cerrarSesion() {
    try {
      await originalFetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {}
    location.replace("/login");
  }
  window.metricosCerrarSesion = cerrarSesion;

  function montar(user) {
    // La sesion va al pie del menu lateral (si existe); si no, a la barra superior.
    const bar = document.getElementById("menu-sesion") || document.querySelector(".topbar-right");
    if (!bar || document.getElementById("sesion-box")) return;
    const box = document.createElement("div");
    box.id = "sesion-box";
    box.className = "sesion-box";
    const nombre = document.createElement("span");
    nombre.className = "badge badge-muted";
    nombre.textContent = user.nombre;
    nombre.title = `${user.username} · ${user.rol}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.id = "btn-logout";
    btn.textContent = "Cerrar sesión";
    btn.addEventListener("click", cerrarSesion);
    box.append(nombre, btn);
    bar.appendChild(box);
  }

  originalFetch("/api/auth/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => montar(d.user));
      else montar(d.user);
    })
    .catch(() => {});
})();
