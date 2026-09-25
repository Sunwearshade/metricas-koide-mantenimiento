"use strict";

// Sesion en el navegador: muestra el usuario, cierra sesion y, si cualquier
// llamada a /api responde 401 (sesion expirada), vuelve a la pantalla de login.
(function () {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (res.status === 401 && url.indexOf("/api/auth/") === -1) location.replace("/login");
    return res;
  };

  document.addEventListener("DOMContentLoaded", function () {
    nativeFetch("/api/auth/me")
      .then(function (r) {
        if (r.status === 401) location.replace("/login");
        return r.ok ? r.json() : null;
      })
      .then(function (u) {
        const el = document.getElementById("session-user");
        if (u && el) el.textContent = u.nombre || u.usuario;
      })
      .catch(function () {});

    const btn = document.getElementById("btn-logout");
    if (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        nativeFetch("/api/auth/logout", { method: "POST" })
          .catch(function () {})
          .then(function () {
            location.replace("/login");
          });
      });
    }
  });
})();
