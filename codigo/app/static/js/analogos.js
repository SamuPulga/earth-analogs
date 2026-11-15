// Apartado 1 · Análogos: la grilla de Daniel (puntos de 1° x 1° de América) en un mapa.
// El mapa se colorea por un parámetro medido o por qué tan bien sirve cada punto para una misión
// predefinida. Al tocar un punto: sus 5 valores medidos, su puesto en cada misión y la ficha de la IA.
// Dueño: Samuel (app/).

import { $, el, fmt, coordenadas, nombre, mapaAmerica, hudCoordenadas, TEXTURA } from "./util.js";
import { investigarLugar } from "./lugar.js";
import { prepararRejilla, puntoRejilla, pedirNombre, alNombrar, MAPAS, colorCelda } from "./rejilla.js";

const A = { inicio: null, G: null, mapa: null, celdas: null, marca: null, sel: null, capa: "temperatura", misiones: {} };

const CORTO = { temperatura: "Temperature", humedad: "Humidity", viento: "Wind", variacion_temperatura: "Day–night range", reflectancia: "Albedo" };
const unidad = (v) => ((A.inicio.variables.find((x) => x.variable === v) || {}).unidad || "").replace(/\s*\(.*\)$/, "").replace(/^albedo$/, "");
const destino = (id) => A.inicio.destinos.find((d) => d.id === id) || {};

export function iniciarAnalogos(inicio) {
  A.inicio = inicio;
  A.G = prepararRejilla(inicio.rejilla);
  $("#cifras-analogos").replaceChildren(
    ...[[A.G.ids.length.toLocaleString("en"), "grid points"], [A.G.variables.length, "measured parameters"],
      [inicio.misiones.length, "preset missions"], ["1°", "grid resolution"]]
      .map(([v, t]) => el("div", {}, el("dt", {}, String(v)), el("dd", {}, t))));

  // Botones para colorear el mapa: parámetros medidos y misiones predefinidas
  $("#capa-medida").replaceChildren(...A.G.variables.map((v) =>
    el("button", { type: "button", "data-capa": v, onclick: () => cambiarCapa(v) }, CORTO[v] || nombre(v))));
  $("#capa-mision").replaceChildren(...inicio.misiones.map((m) =>
    el("button", { type: "button", "data-capa": `m:${m.id}`, onclick: () => cambiarCapa(`m:${m.id}`) },
      el("span", { class: "astro", style: `--tex:url(${TEXTURA[destino(m.destino).cuerpo] || TEXTURA.tierra})` }), m.nombre)));
  marcarCapa();
  alNombrar(() => { pintarListas(); if (A.sel) pintarMedidas(); });
  calcularMisiones();
}

// Corre cada misión predefinida (con el modelo de Daniel) y guarda la puntuación de cada punto
async function calcularMisiones() {
  for (const m of A.inicio.misiones) {
    const d = destino(m.destino);
    const parametros = m.parametros.filter((p) => !d.variables_disponibles || d.variables_disponibles.includes(p.variable));
    try {
      const r = await fetch("/api/recomendar", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...m, parametros }) });
      if (!r.ok) continue;
      const res = await r.json();
      // puesto dentro del frente de Pareto (por puntuación), para cada punto
      const frente = res.puntos.map((p, i) => [p[0], i, p[1]]).filter((x) => x[2] === 0).sort((a, b) => a[0] - b[0]);
      const puesto = new Array(res.puntos.length).fill(null);
      frente.forEach(([, i], n) => (puesto[i] = n + 1));
      A.misiones[m.id] = { mision: m, res, puesto, nFrente: frente.length };
      res.ranking.slice(0, 5).forEach((x) => pedirNombre(x.sitio_id));
    } catch { /* sin servidor: la misión queda sin resultado */ }
    pintarListas();
    if (A.mapa && A.capa === `m:${m.id}`) pintarCeldas();
    if (A.sel) pintarMedidas();
  }
}

export function mostrarAnalogos() {
  if (!A.mapa) {
    A.mapa = mapaAmerica("mapa-analogos");
    hudCoordenadas(A.mapa, $("#coords-analogos"));
    // Clic fuera de la grilla (mar, o zonas sin datos): investigar esa latitud y longitud
    A.mapa.on("click", (e) => {
      const { lat, lng } = e.latlng;
      seleccionar(null);
      ponerMarca(lat, lng);
      $("#panel-lugar .kicker").textContent = "Selected point (outside the grid)";
      const ia = el("div");
      $("#info-lugar").replaceChildren(el("p", { class: "nota" }, "No measurements here: the grid only has land points with data for all 5 parameters."), ia);
      investigarLugar(ia, { lat, lon: lng });
    });
    pintarCeldas();
  }
  setTimeout(() => A.mapa.invalidateSize(), 50);
}

function cambiarCapa(capa) {
  A.capa = capa;
  marcarCapa();
  pintarCeldas();
}

function marcarCapa() {
  document.querySelectorAll("#capa-medida button, #capa-mision button")
    .forEach((b) => b.classList.toggle("activo", b.dataset.capa === A.capa));
}

function ponerMarca(lat, lon) {
  A.marca?.remove();
  A.marca = L.marker([lat, lon], { icon: L.divIcon({ className: "", iconSize: [18, 18], html: '<div class="marcador-punto"></div>' }) }).addTo(A.mapa);
}

// Cada punto es un cuadro de 1°, coloreado por el parámetro o la misión elegida
function pintarCeldas() {
  if (!A.mapa) return;
  const G = A.G;
  if (!A.celdas) {
    const lienzo = L.canvas({ padding: 0.3 });
    A.celdas = G.ids.map((id, i) => L.rectangle([[G.lat[i] - 0.5, G.lon[i] - 0.5], [G.lat[i] + 0.5, G.lon[i] + 0.5]],
      { renderer: lienzo, weight: 0, fillOpacity: 0 })
      .on("click", (e) => { L.DomEvent.stop(e); seleccionar(id, false); })
      .addTo(A.mapa));
  }
  const leyenda = $("#leyenda-analogos");
  if (A.capa.startsWith("m:")) {
    const M = A.misiones[A.capa.slice(2)];
    if (!M) { leyenda.replaceChildren(el("span", {}, "Calculating…")); return; }
    const P = M.res.puntos;
    const orden = P.map((p, i) => [p[0], i]).filter((x) => x[0] != null).sort((a, b) => a[0] - b[0]);
    const perc = new Float32Array(P.length).fill(1);
    orden.forEach(([, i], n) => (perc[i] = n / Math.max(1, orden.length - 1)));
    A.celdas.forEach((c, i) => c.setStyle(P[i][1] === 2
      ? { fillColor: "#ff5d6c", fillOpacity: 0.16, weight: 0 }
      : { fillColor: colorCelda(perc[i]), fillOpacity: P[i][1] === 0 ? 0.85 - 0.45 * perc[i] : 0.6 - 0.5 * perc[i], weight: 0 }));
    leyenda.replaceChildren(el("span", { class: "degradado" }, el("i"), `Best for: ${M.mision.nombre} → worse`));
  } else {
    const v = A.capa, x = G.val[v];
    const color = (t) => `hsl(${230 - 225 * t}, 75%, ${45 + 10 * Math.sin(Math.PI * t)}%)`;
    A.celdas.forEach((c, i) => c.setStyle(x[i] == null ? { fillOpacity: 0, weight: 0 }
      : { fillColor: color((x[i] - G.min[v]) / (G.rango[v] || 1)), fillOpacity: 0.75, weight: 0 }));
    leyenda.replaceChildren(el("span", { class: "degradado medida" }, el("i"),
      `${CORTO[v] || nombre(v)}: ${+G.min[v].toPrecision(3)} → ${+G.max[v].toPrecision(3)} ${unidad(v)}`));
  }
}

function seleccionar(id, volar = true) {
  A.sel = id;
  if (!id) return;
  const s = puntoRejilla(id);
  ponerMarca(s.lat, s.lon);
  pedirNombre(id);
  if (volar) {
    A.mapa?.flyTo([s.lat, s.lon], Math.max(A.mapa.getZoom(), 6), { duration: 1.4 });
    $("#mapa-analogos").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  pintarMedidas(true);
}

// Panel del punto: valores medidos, puesto en cada misión y ficha de la IA
function pintarMedidas(nuevo = false) {
  const id = A.sel;
  if (!id) return;
  const s = puntoRejilla(id);
  const k = s.k;
  $("#panel-lugar .kicker").textContent = s.nombre;
  const medidas = el("div", { class: "medidas" },
    el("p", { class: "lugar-coords" }, `${s.pais} · ${coordenadas(s.lat, s.lon)}`),
    el("dl", { class: "valores" }, ...A.G.variables.map((v) => el("div", { title: MAPAS[v] || nombre(v) },
      el("dt", {}, CORTO[v] || nombre(v)), el("dd", {}, `${fmt(A.G.val[v][k], v === "reflectancia" ? 2 : 1)} ${unidad(v)}`)))),
    el("div", { class: "puestos" }, ...A.inicio.misiones.map((m) => {
      const M = A.misiones[m.id];
      const p = M?.puesto[k];
      const est = M?.res.puntos[k][1];
      return el("a", { href: `#/mision?mision=${m.id}`, title: "Open this mission" },
        el("b", {}, !M ? "…" : p ? `#${p}` : est === 2 ? "out" : "—"), m.nombre,
        M && !p ? el("small", {}, est === 2 ? " (ruled out)" : " (dominated)") : null);
    })));
  // La ficha de la IA se mantiene si solo cambió un nombre o un puesto
  if (nuevo || !A.nodoIA || A.nodoIAid !== id) {
    A.nodoIA = el("div");
    A.nodoIAid = id;
    clearTimeout(A._esperaIA);
    const listo = () => A.inicio.misiones.every((m) => A.misiones[m.id]);
    const lanzar = () => investigarLugar(A.nodoIA, { lat: s.lat, lon: s.lon, medidas: paraIA(k) });
    // Espera los puestos de las misiones (tardan poco) para que la IA los pueda citar
    if (listo()) lanzar();
    else { A.nodoIA.append(el("p", { class: "nota" }, "Ranking this point in each mission…")); A._esperaIA = setTimeout(function rev() { listo() ? lanzar() : (A._esperaIA = setTimeout(rev, 300)); }, 300); }
  }
  $("#info-lugar").replaceChildren(medidas, A.nodoIA);
}

function paraIA(k) {
  return {
    grid_cell: "1° × 1°",
    values: A.G.variables.map((v) => ({ name: nombre(v), value: +(+A.G.val[v][k]).toPrecision(3), unit: unidad(v),
      continent_range: `${+A.G.min[v].toPrecision(3)} to ${+A.G.max[v].toPrecision(3)}` })),
    preset_missions: A.inicio.misiones.map((m) => {
      const M = A.misiones[m.id];
      return { mission: m.nombre, destination: destino(m.destino).nombre,
        rank: M?.puesto[k] ? `${M.puesto[k]} of ${M.nFrente} on the Pareto front` : null };
    }),
  };
}

// Tarjetas: los 5 mejores puntos de cada misión predefinida
function pintarListas() {
  const caja = $("#lista-analogos");
  caja.replaceChildren(...A.inicio.misiones.map((m) => {
    const M = A.misiones[m.id];
    const d = destino(m.destino);
    return el("article", { class: `sitio ${d.cuerpo === "luna" ? "luna" : "marte"}` },
      el("div", { class: "sitio-cab" }, el("div", {}, el("h3", {}, m.nombre), el("div", { class: "pais" }, `Best places for ${d.nombre || m.destino}`))),
      !M ? el("p", { class: "nota" }, "Calculating…") :
        el("ol", { class: "top-mision" }, ...M.res.ranking.slice(0, 5).map((x, i) => {
          const s = puntoRejilla(x.sitio_id);
          return el("li", { tabindex: "0", onclick: () => seleccionar(x.sitio_id), onkeydown: (e) => { if (e.key === "Enter") seleccionar(x.sitio_id); } },
            el("span", { class: "puesto" }, String(i + 1)),
            el("span", {}, el("b", {}, s.nombre), el("small", {}, `${s.pais} · ${coordenadas(s.lat, s.lon)}`)),
            (() => { const b = Math.max(...x.detalle.map((d) => d.f)); const c = b <= 0.1 ? "bien" : b <= 0.25 ? "medio" : "mal";
              return el("span", { class: `etq ${c}`, title: "Largest gap to a target, as % of the range in the Americas" }, `gap ${Math.round(b * 100)} %`); })());
        })),
      el("a", { class: "btn chico", href: `#/mision?mision=${m.id}` }, "Plan this mission ", el("i", { class: "flecha" })));
  }));
}
