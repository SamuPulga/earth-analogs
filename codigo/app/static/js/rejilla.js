// La grilla de Daniel en la página: puntos de 1° x 1° de América con los 5 parámetros medidos.
// La comparten los apartados Analogs y Plan a mission.
// Dueño: Samuel (app/).

import { coordenadas } from "./util.js";

export let G = null;          // { ids, idx, lat, lon, val: {variable: [...]}, rango, variables }
export const nombres = {};    // id del punto → { nombre, region } (OpenStreetMap)

export function prepararRejilla(r) {
  if (G || !r) return G;
  G = { ids: [], idx: new Map(), lat: [], lon: [], val: {}, rango: {}, min: {}, max: {}, variables: r.variables };
  r.variables.forEach((v) => (G.val[v] = []));
  r.puntos.forEach((p, i) => {
    G.ids.push(p[0]); G.idx.set(p[0], i); G.lat.push(p[1]); G.lon.push(p[2]);
    r.variables.forEach((v, j) => G.val[v].push(p[3 + j]));
  });
  for (const v of r.variables) {
    const xs = G.val[v].filter((x) => x != null);
    G.min[v] = Math.min(...xs); G.max[v] = Math.max(...xs);
    G.rango[v] = G.max[v] - G.min[v];
  }
  return G;
}

// El punto como "sitio": nombre del lugar si ya se conoce; si no, sus coordenadas
export function puntoRejilla(id) {
  const k = G.idx.get(id);
  const n = nombres[id];
  return { id, k, lat: G.lat[k], lon: G.lon[k], rejilla: true,
    nombre: n?.nombre || coordenadas(G.lat[k], G.lon[k]), pais: n ? n.region : "1° grid cell" };
}

// Nombres (vía /api/lugar). Se piden en fila: el servidor consulta OpenStreetMap máximo 1 vez por segundo.
const cola = [];
const oyentes = [];
let ocupada = false;
export const alNombrar = (fn) => oyentes.push(fn);
export function pedirNombre(id) {
  if (!G?.idx.has(id) || nombres[id] || cola.includes(id)) return;
  cola.push(id);
  procesar();
}
async function procesar() {
  if (ocupada) return;
  ocupada = true;
  while (cola.length) {
    const id = cola.shift();
    const k = G.idx.get(id);
    try {
      const h = await (await fetch(`/api/lugar?lat=${G.lat[k]}&lon=${G.lon[k]}`)).json();
      const l = h.lugar;
      if (l) {
        nombres[id] = { nombre: l.nombre || l.region || "", region: [l.nombre ? l.region : "", l.pais].filter(Boolean).join(", ") };
        oyentes.forEach((fn) => fn(id));
      }
    } catch { /* sin nombre: se queda con las coordenadas */ }
  }
  ocupada = false;
}

// Mapas medidos por el equipo (carpeta IMAGENES-DATOS), uno por parámetro
export const MAPAS = {
  temperatura: "Surface temperature (°C)",
  humedad: "Surface relative humidity (%)",
  viento: "Wind speed (m/s)",
  variacion_temperatura: "Day–night surface temperature range (°C)",
  reflectancia: "Surface albedo (%)",
};

// Color de una celda: t = 0 (mejor / valor bajo) → 1 (peor / valor alto)
export const colorCelda = (t) => `hsl(${195 + 35 * t}, ${90 - 50 * t}%, ${68 - 40 * t}%)`;
