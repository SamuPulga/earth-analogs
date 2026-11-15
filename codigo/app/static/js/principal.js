// Arranque de la página: navegación entre los 5 apartados, reloj, estrellas y carga de datos.
//   GET /api/inicio → destinos, sitios, variables, misiones, atributos
// Cada apartado tiene su archivo: analogos.js, mision.js, datos_extra.js. Luna y Marte son HTML + globo.js.
// Dueño: Samuel (app/).

import { $, $$, el, coordenadas } from "./util.js";
import { crearGlobo } from "./globo.js";
import { iniciarAnalogos, mostrarAnalogos } from "./analogos.js";
import { iniciarMision, mostrarMision } from "./mision.js";
import { iniciarDatosExtra } from "./datos_extra.js";
import { configurarIA } from "./lugar.js";

const VISTAS = ["inicio", "analogos", "luna", "marte", "mision", "datos"];
let INICIO = null;
const globos = {};

// ---------------------------------------------------------------- planetas (se crean la primera vez que se ven)
const CONFIG_GLOBOS = {
  tierra: { id: "globo-tierra", textura: "/static/texturas/tierra.jpg", atmosfera: "#5aa8ff", atmosferaIntensidad: 0.75, inclinacion: 23.4, velocidad: 0.045, distancia: 4.5, luz: [-4, 1.4, 1.6], ambiente: 0.06 },
  luna: { id: "globo-luna", textura: "/static/texturas/luna.jpg", relieve: "/static/texturas/luna_relieve.jpg", relieveEscala: 0.05, inclinacion: 6.7, velocidad: 0.04, distancia: 4.4, luz: [-4, 1.0, 1.4], ambiente: 0.03 },
  marte: { id: "globo-marte", textura: "/static/texturas/marte.jpg", atmosfera: "#ff9a70", atmosferaIntensidad: 0.4, inclinacion: 25.2, velocidad: 0.045, distancia: 4.4, luz: [-4, 1.2, 1.5], ambiente: 0.04 },
};
function asegurarGlobo(nombre) {
  if (globos[nombre]) return;
  const c = CONFIG_GLOBOS[nombre];
  globos[nombre] = crearGlobo(document.getElementById(c.id), c);
}

// ---------------------------------------------------------------- navegación (#/apartado?param=valor)
function leerRuta() {
  const [ruta, consulta] = location.hash.replace(/^#\/?/, "").split("?");
  return { vista: VISTAS.includes(ruta) ? ruta : "inicio", params: new URLSearchParams(consulta || "") };
}

function irA() {
  // Enlaces internos de una página (#explora) no cambian de apartado
  if (location.hash && !location.hash.startsWith("#/") && $(".vista.activa")) return;
  const { vista, params } = leerRuta();
  $$(".vista").forEach((v) => v.classList.toggle("activa", v.dataset.vista === vista));
  $$(".enlaces a").forEach((a) => a.classList.toggle("activo", a.dataset.vista === vista));
  $("#nav").classList.remove("abierta");
  $("#menu-btn").setAttribute("aria-expanded", "false");
  window.scrollTo({ top: 0, behavior: "instant" });
  document.title = { inicio: "Earth Analogs", analogos: "Analogs · Earth Analogs", luna: "The Moon · Earth Analogs",
    marte: "Mars · Earth Analogs", mision: "Plan a mission · Earth Analogs", datos: "More data · Earth Analogs" }[vista];

  if (vista === "inicio") asegurarGlobo("tierra");
  if (vista === "luna") asegurarGlobo("luna");
  if (vista === "marte") asegurarGlobo("marte");
  if (!INICIO) return;  // los apartados con datos se pintan cuando llegue /api/inicio
  if (vista === "analogos") mostrarAnalogos();
  if (vista === "mision") mostrarMision(params);
}

function navegacion() {
  window.addEventListener("hashchange", irA);
  $("#menu-btn").addEventListener("click", () => {
    const abierta = $("#nav").classList.toggle("abierta");
    $("#menu-btn").setAttribute("aria-expanded", String(abierta));
  });
  const nav = $("#nav");
  const alDesplazar = () => nav.classList.toggle("solida", window.scrollY > 40);
  window.addEventListener("scroll", alDesplazar, { passive: true });
  alDesplazar();
}

// ---------------------------------------------------------------- reloj UTC
function reloj() {
  const r = $("#reloj");
  const tic = () => { r.textContent = new Date().toISOString().slice(11, 19); };
  tic();
  setInterval(tic, 1000);
}

// ---------------------------------------------------------------- fondo de estrellas
function estrellas() {
  const c = $("#estrellas");
  const ctx = c.getContext("2d");
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lista = [];
  function crear() {
    const dpr = Math.min(devicePixelRatio, 2);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((innerWidth * innerHeight) / 5200);
    lista = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: Math.random() < 0.92 ? Math.random() * 0.8 + 0.2 : Math.random() * 1.2 + 0.8,
      a: Math.random() * 0.6 + 0.15, f: Math.random() * 2 * Math.PI, v: Math.random() * 0.8 + 0.2,
    }));
  }
  function pintar(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of lista) {
      const brillo = quieto ? s.a : s.a * (0.65 + 0.35 * Math.sin(t / 1000 * s.v + s.f));
      ctx.globalAlpha = brillo;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    }
    if (!quieto) requestAnimationFrame(pintar);
  }
  crear();
  addEventListener("resize", () => { crear(); if (quieto) pintar(0); });
  requestAnimationFrame(pintar);
}

// ---------------------------------------------------------------- avisos de datos de prueba
function avisos() {
  // Un solo aviso compacto; el detalle aparece al pasar el mouse o al tocarlo
  const av = $("#avisos");
  av.replaceChildren();
  const partes = [], detalle = [];
  const prueba = Object.entries(INICIO.fuentes).filter(([, f]) => f !== "real").map(([t]) => t);
  if (prueba.length) { partes.push("Test data"); detalle.push(`Test tables: ${prueba.join(", ")}. Results are not real.`); }
  if (INICIO.modelo.startsWith("provisional")) { partes.push("Provisional model"); detalle.push("The final model (codigo/modelo/recomendar.py) is not connected yet."); }
  if (INICIO.errores_misiones.length) { partes.push(`${INICIO.errores_misiones.length} errors in misiones.csv`); detalle.push(...INICIO.errores_misiones); }
  if (!partes.length) return;
  const caja = el("details", { class: "aviso" }, el("summary", {}, el("b", {}, partes.join(" · "))),
    el("ul", {}, ...detalle.map((t) => el("li", {}, t))));
  av.append(caja);
}

// ---------------------------------------------------------------- inicio y destinos de Luna/Marte
function cifra(valor, texto) { return el("div", {}, el("dt", {}, String(valor)), el("dd", {}, texto)); }

function pintarInicio() {
  const paises = new Set(INICIO.sitios.map((s) => s.pais).filter(Boolean));
  $("#cifras-hero").replaceChildren(
    cifra(INICIO.sitios.length, "candidate sites"),
    cifra(paises.size, "countries"),
    cifra(INICIO.misiones.length, "missions"),
    cifra(INICIO.destinos.length, "destinations"));

  for (const cuerpo of ["luna", "marte"]) {
    const caja = $(`#destinos-${cuerpo}`);
    const lista = INICIO.destinos.filter((d) => d.cuerpo === cuerpo);
    caja.replaceChildren(...(lista.length ? lista.map((d) => el("div", { class: "destino" },
      el("h3", {}, d.nombre),
      el("div", { class: "coords" }, coordenadas(d.lat, d.lon)),
      d.por_que ? el("p", {}, d.por_que) : null,
      el("a", { class: "btn chico", href: `#/mision?destino=${d.id}` }, "Find analogs ", el("i", { class: "flecha" })),
    )) : [el("p", { class: "nota" }, "No destinations in destinos.csv yet.")]));
  }
  $("#pie-modelo").textContent = `Model: ${INICIO.modelo.startsWith("oficial") ? "final" : "provisional"}`;
}

// ---------------------------------------------------------------- arranque
async function iniciar() {
  navegacion();
  reloj();
  estrellas();
  irA();
  try {
    const r = await fetch("/api/inicio");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    INICIO = await r.json();
  } catch (e) {
    $("#avisos").append(el("div", { class: "aviso" }, el("b", {}, "No connection to the server"), ` (${e.message}). Start uvicorn and reload.`));
    return;
  }
  configurarIA(INICIO.ia);
  avisos();
  pintarInicio();
  iniciarAnalogos(INICIO);
  iniciarMision(INICIO);
  iniciarDatosExtra(INICIO);
  irA();
}

iniciar();
