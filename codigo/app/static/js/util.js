// Funciones pequeñas que usan todos los apartados.

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];

export function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) n.append(h);
  return n;
}

export const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(+x) ? "—" : Number(x).toFixed(d));
export const pct = (x) => `${Math.round(x * 100)} %`;

// 24.08° S · 69.93° O
export function coordenadas(lat, lon) {
  if (lat == null || lon == null) return "no coordinates";
  const la = `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}`;
  const lo = `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
  return `${la} · ${lo}`;
}

// Nombres legibles de las variables (el código usa el id de variables.csv)
export const NOMBRES = {
  temperatura: "Temperature",
  humedad: "Humidity",
  viento: "Wind speed",
  variacion_temperatura: "Temperature variation",
  reflectancia: "Reflectance",
  pendiente_p95: "Slope (95th percentile)",
  precipitacion_anual_mm: "Annual precipitation",
  temperatura_media_c: "Mean temperature",
  humedad_media_pct: "Mean humidity",
  viento_medio_ms: "Mean wind",
  amplitud_termica_c: "Daily temperature range",
  albedo: "Albedo",
  elevacion_m: "Elevation",
};
export const nombre = (v) => NOMBRES[v] || v;

// Textura de cada cuerpo, para los círculos pequeños de la interfaz
export const TEXTURA = { luna: "/static/texturas/luna.jpg", marte: "/static/texturas/marte.jpg", tierra: "/static/texturas/tierra.jpg" };

export const LIMITES_SIEMPRE = [
  "Gravity: Earth has 6 times the Moon's and 2.6 times Mars's.",
  "Vacuum and atmosphere: no site reproduces the lunar vacuum or the thin Martian atmosphere.",
  "Radiation: Earth's atmosphere and magnetic field block it.",
];

// Mapas base sin clave de API: satélite (por defecto) y gris oscuro, de Esri
export function capasBase(mapa) {
  const esri = (servicio, max) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${servicio}/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: max, attribution: "Tiles © Esri · Esri, Maxar, Earthstar Geographics and the GIS User Community" });
  const satelite = esri("World_Imagery", 18);
  const oscuro = esri("Canvas/World_Dark_Gray_Base", 16);
  satelite.addTo(mapa);
  L.control.layers({ "Satellite": satelite, "Dark": oscuro }, null, { position: "topleft" }).addTo(mapa);
}

// Alcance del proyecto: solo el continente americano (AGENTS.md §12)
export const AMERICA = { centro: [8, -82], zoom: 3, limites: [[-58, -170], [84, -28]] };

export function mapaAmerica(id) {
  const mapa = L.map(id, { minZoom: 2, zoomSnap: 0.5, maxBounds: AMERICA.limites, maxBoundsViscosity: 0.8, worldCopyJump: false })
    .setView(AMERICA.centro, AMERICA.zoom);
  capasBase(mapa);
  // Oscurece lo que queda fuera de la zona de estudio para que América resalte
  const [[s0, o0], [n0, e0]] = AMERICA.limites;
  L.polygon([
    [[-89, -360], [89, -360], [89, 360], [-89, 360]],
    [[s0, o0], [n0, o0], [n0, e0], [s0, e0]],
  ], { stroke: false, fillColor: "#03050a", fillOpacity: 0.6, interactive: false }).addTo(mapa);
  return mapa;
}

// Muestra en un recuadro la latitud y longitud del centro de la vista (y del cursor, si está encima)
export function hudCoordenadas(mapa, caja) {
  const f = (ll) => `${Math.abs(ll.lat).toFixed(3)}° ${ll.lat >= 0 ? "N" : "S"}  ${Math.abs(ll.lng).toFixed(3)}° ${ll.lng >= 0 ? "E" : "W"}`;
  let cursor = null;
  const pintar = () => {
    const filas = [el("div", {}, el("span", {}, "CENTER "), f(mapa.getCenter()), el("span", {}, ` · Z${mapa.getZoom()}`))];
    if (cursor) filas.push(el("div", {}, el("span", {}, "CURSOR "), f(cursor)));
    caja.replaceChildren(...filas);
  };
  mapa.on("move zoom", pintar);
  mapa.on("mousemove", (e) => { cursor = e.latlng; pintar(); });
  mapa.on("mouseout", () => { cursor = null; pintar(); });
  pintar();
}
