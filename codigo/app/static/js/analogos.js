// Apartado 1 · Análogos: todos los sitios candidatos en un mapa, con sus datos generales
// y el puesto que sacan en cada misión predefinida.
// Cuando lleguen los datos reales de sitios.csv y atributos_sitios.csv, esto se llena solo.

import { $, $$, el, fmt, coordenadas, nombre, mapaAmerica, hudCoordenadas } from "./util.js";
import { investigarLugar } from "./lugar.js";

const A = { inicio: null, mapa: null, capa: null, marcadores: {}, sel: null, filtro: { destino: "todos", texto: "" }, puestos: {} };

// Valores del sitio que se muestran en cada tarjeta (columnas de atributos_sitios.csv)
const VALORES = [
  ["temperatura_media_c", "Mean temp.", (v) => `${fmt(v, 0)} °C`],
  ["amplitud_termica_c", "Daily range", (v) => `${fmt(v, 0)} °C`],
  ["humedad_media_pct", "Humidity", (v) => `${fmt(v, 0)} %`],
  ["viento_medio_ms", "Wind", (v) => `${fmt(v, 1)} m/s`],
  ["albedo", "Albedo", (v) => fmt(v, 2)],
  ["elevacion_m", "Elevation", (v) => `${Math.round(v).toLocaleString("en")} m`],
];

const claseDestino = (s) => (["luna", "marte", "ambos"].includes(s.destino_sugerido) ? s.destino_sugerido : "ambos");
const textoDestino = { luna: "Lunar analog", marte: "Martian analog", ambos: "Moon and Mars" };

export function iniciarAnalogos(inicio) {
  A.inicio = inicio;
  const paises = new Set(inicio.sitios.map((s) => s.pais).filter(Boolean));
  const clasicos = inicio.sitios.filter((s) => (s.clasico || "").toLowerCase().startsWith("s")).length;
  $("#cifras-analogos").replaceChildren(
    ...[[inicio.sitios.length, "sites"], [paises.size, "countries"], [clasicos, "classic analogs"], [inicio.sitios.length - clasicos, "new analogs"]]
      .map(([v, t]) => el("div", {}, el("dt", {}, String(v)), el("dd", {}, t))));

  $$("#filtro-destino button").forEach((b) => b.addEventListener("click", () => {
    $$("#filtro-destino button").forEach((x) => x.classList.toggle("activo", x === b));
    A.filtro.destino = b.dataset.d; pintar(true);
  }));
  $("#filtro-texto").addEventListener("input", (e) => { A.filtro.texto = e.target.value.trim().toLowerCase(); pintar(true); });

  calcularPuestos();
}

// Corre cada misión predefinida y guarda el puesto de cada sitio
async function calcularPuestos() {
  for (const m of A.inicio.misiones) {
    try {
      const r = await fetch("/api/recomendar", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(m) });
      if (!r.ok) continue;
      const res = await r.json();
      res.ranking.forEach((x, i) => { (A.puestos[x.sitio_id] ??= []).push({ mision: m.nombre, puesto: i + 1 }); });
    } catch { /* sin servidor: la tarjeta queda sin puestos */ }
  }
  if (A.mapa) pintar(false);
}

export function mostrarAnalogos() {
  if (!A.mapa) {
    A.mapa = mapaAmerica("mapa-analogos");
    A.capa = L.layerGroup().addTo(A.mapa);
    hudCoordenadas(A.mapa, $("#coords-analogos"));
    // Clic en cualquier punto del mapa (fuera de los sitios): investigar esa latitud y longitud
    A.mapa.on("click", (e) => {
      const { lat, lng } = e.latlng;
      A.punto?.remove();
      A.punto = L.marker([lat, lng], { icon: L.divIcon({ className: "", iconSize: [18, 18], html: '<div class="marcador-punto"></div>' }) }).addTo(A.mapa);
      seleccionar(null, false);
      $("#panel-lugar .kicker").textContent = "Selected point";
      investigarLugar($("#info-lugar"), { lat, lon: lng });
    });
    pintar(true);
  }
  setTimeout(() => A.mapa.invalidateSize(), 50);
}

function filtrados() {
  const f = A.filtro;
  return A.inicio.sitios.filter((s) =>
    (f.destino === "todos" || claseDestino(s) === f.destino) &&
    (!f.texto || `${s.nombre} ${s.pais}`.toLowerCase().includes(f.texto)));
}

function atributo(id) { return A.inicio.atributos.find((a) => a.sitio_id === id) || {}; }

function popup(s) {
  // Se arma con nodos (no con HTML en texto) para que nada de la hoja de cálculo se interprete como código
  return el("div", {}, el("b", {}, s.nombre), el("br"),
    el("span", { style: "color:var(--suave);font-size:12px" }, `${s.pais || ""} · ${coordenadas(s.lat, s.lon)}`),
    s.por_que ? el("p", { style: "margin:8px 0 0;font-size:13px" }, s.por_que) : null);
}

function seleccionar(id, volar = true) {
  A.sel = id;
  if (id) {
    A.punto?.remove(); A.punto = null;
    const s0 = A.inicio.sitios.find((x) => x.id === id);
    if (s0) {
      $("#panel-lugar .kicker").textContent = s0.nombre;
      investigarLugar($("#info-lugar"), { lat: s0.lat, lon: s0.lon, sitio: { ...s0, ...atributo(id) } });
    }
  }
  $$(".sitio").forEach((t) => t.classList.toggle("sel", t.dataset.id === id));
  Object.entries(A.marcadores).forEach(([k, m]) => m.getElement()?.firstElementChild?.classList.toggle("sel", k === id));
  const s = A.inicio.sitios.find((x) => x.id === id);
  const m = A.marcadores[id];
  if (volar && s && m) {
    A.mapa.flyTo([s.lat, s.lon], Math.max(A.mapa.getZoom(), 6), { duration: 1.4 });
    m.openPopup();
    $("#mapa-analogos").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function pintar(encuadrar) {
  const lista = filtrados();
  // mapa
  A.capa.clearLayers();
  A.marcadores = {};
  const puntos = [];
  for (const s of lista) {
    if (s.lat == null || s.lon == null) continue;
    const icono = L.divIcon({ className: "", iconSize: [14, 14], html: `<div class="marcador-sitio ${claseDestino(s)}${s.id === A.sel ? " sel" : ""}"></div>` });
    A.marcadores[s.id] = L.marker([s.lat, s.lon], { icon: icono, title: s.nombre })
      .bindPopup(popup(s)).on("click", () => seleccionar(s.id, false)).addTo(A.capa);
    puntos.push([s.lat, s.lon]);
  }
  if (encuadrar && puntos.length) A.mapa.fitBounds(puntos, { padding: [50, 50], maxZoom: 5 });
  else if (encuadrar) A.mapa.setView([8, -82], 3);

  // tarjetas
  const caja = $("#lista-analogos");
  if (!lista.length) { caja.replaceChildren(el("p", { class: "vacio" }, "No site matches the filter.")); return; }
  caja.replaceChildren(...lista.map((s) => {
    const a = atributo(s.id);
    const valores = VALORES.filter(([k]) => a[k] != null);
    const puestos = (A.puestos[s.id] || []).sort((x, y) => x.puesto - y.puesto);
    const clasico = (s.clasico || "").toLowerCase().startsWith("s");
    return el("article", { class: `sitio ${claseDestino(s)}${s.id === A.sel ? " sel" : ""}`, "data-id": s.id, tabindex: "0",
      onclick: () => seleccionar(s.id), onkeydown: (e) => { if (e.key === "Enter") seleccionar(s.id); } },
      el("div", { class: "sitio-cab" }, el("div", {}, el("h3", {}, s.nombre), el("div", { class: "pais" }, s.pais || "—"))),
      el("div", { class: "coords" }, coordenadas(s.lat, s.lon)),
      el("div", { class: "etiquetas" },
        el("span", { class: "etq tono" }, textoDestino[claseDestino(s)]),
        s.ambiente ? el("span", { class: "etq" }, s.ambiente) : null,
        el("span", { class: "etq" }, clasico ? "classic" : "new"),
        s.estado ? el("span", { class: `etq ${s.estado === "verificado" ? "bien" : ""}` }, s.estado === "verificado" ? "verified" : s.estado === "borrador" ? "draft" : s.estado) : null),
      s.por_que ? el("p", {}, s.por_que) : null,
      valores.length ? el("dl", { class: "valores" }, ...valores.map(([k, t, f]) =>
        el("div", { title: nombre(k) }, el("dt", {}, t), el("dd", {}, f(a[k]))))) : null,
      puestos.length ? el("div", { class: "puestos" }, ...puestos.map((p) =>
        el("div", {}, el("b", {}, `#${p.puesto}`), p.mision))) : el("div", { class: "puestos" }, "Not on the Pareto front of any preset mission."),
    );
  }));
}
