"use strict";

// Presentacion del dashboard: menu lateral derecho colapsable y altura de la
// barra superior. Solo cambia clases y atributos visuales; la navegacion entre
// modulos sigue a cargo de app.js (.menu-item -> switchView).
(function () {
  const body = document.body;
  const root = document.documentElement;
  const toggle = document.getElementById("nav-toggle");
  const menu = document.getElementById("menu-lateral");
  const cerrar = document.getElementById("menu-close");
  const fondo = document.getElementById("nav-backdrop");
  const topbar = document.querySelector(".topbar");
  if (!toggle || !menu) return;

  // Debe coincidir con el breakpoint de styles.css (menu como drawer).
  const modoDrawer = window.matchMedia("(max-width: 1099px)");
  const CLAVE = "metricos.menuColapsado";

  function leerColapsado() {
    try {
      return localStorage.getItem(CLAVE) === "1";
    } catch {
      return false;
    }
  }

  function guardarColapsado(valor) {
    try {
      localStorage.setItem(CLAVE, valor ? "1" : "0");
    } catch {}
  }

  function estaAbierto() {
    return modoDrawer.matches ? body.classList.contains("nav-open") : !body.classList.contains("nav-collapsed");
  }

  function sincronizar() {
    toggle.setAttribute("aria-expanded", String(estaAbierto()));
  }

  function fijar(abierto) {
    if (modoDrawer.matches) {
      body.classList.toggle("nav-open", abierto);
    } else {
      body.classList.toggle("nav-collapsed", !abierto);
      guardarColapsado(!abierto);
    }
    sincronizar();
  }

  function cerrarDrawer() {
    if (!modoDrawer.matches || !estaAbierto()) return;
    fijar(false);
    toggle.focus();
  }

  toggle.addEventListener("click", () => {
    fijar(!estaAbierto());
    if (modoDrawer.matches && estaAbierto()) {
      const activo = menu.querySelector(".menu-item.active") || menu.querySelector(".menu-item");
      if (activo) activo.focus();
    }
  });
  if (cerrar) cerrar.addEventListener("click", cerrarDrawer);
  if (fondo) fondo.addEventListener("click", cerrarDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cerrarDrawer();
  });
  // En tablet/movil, elegir un modulo cierra el drawer.
  menu.addEventListener("click", (e) => {
    if (modoDrawer.matches && e.target.closest(".menu-item")) fijar(false);
  });
  modoDrawer.addEventListener("change", () => {
    body.classList.remove("nav-open");
    sincronizar();
  });

  body.classList.toggle("nav-collapsed", leerColapsado());
  sincronizar();

  // Altura real de la barra superior (cambia al reacomodarse en varias filas):
  // el menu acoplado se fija justo debajo de ella.
  if (topbar && "ResizeObserver" in window) {
    new ResizeObserver(() => {
      root.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
    }).observe(topbar);
  }

  // Las transiciones se activan despues del primer pintado para evitar
  // que el menu "se anime" al cargar la pagina.
  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.add("nav-ready")));
})();
