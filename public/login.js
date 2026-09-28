"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  // Con sesion activa, ir directo a la pantalla del rol.
  fetch("/api/auth/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.home) location.replace(d.home);
    })
    .catch(() => {});

  function showError(msg) {
    $("login-error").textContent = msg;
    $("login-error").hidden = false;
  }

  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("login-usuario").value.trim();
    const password = $("login-password").value;
    if (!username || !password) {
      showError("Escribe usuario y contraseña.");
      return;
    }
    $("login-btn").disabled = true;
    $("login-error").hidden = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      location.replace(data.redirect || "/");
    } catch (err) {
      $("login-password").value = "";
      showError(err.message === "Failed to fetch" ? "No hay conexión con el servidor." : err.message);
      $("login-password").focus();
    } finally {
      $("login-btn").disabled = false;
    }
  });

  $("login-usuario").focus();
})();
