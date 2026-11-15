// Apartado 4 · Preparar misión: configuración → POST /api/recomendar → ranking, mapa y ficha.
// Método (AGENTS.md §5): restricciones → frente de Pareto → Chebyshev ponderado → robustez.
// Dueño: Samuel (app/).

import { $, $$, el, fmt, pct, coordenadas, nombre, TEXTURA, LIMITES_SIEMPRE, mapaAmerica, hudCoordenadas } from "./util.js";
import { investigarLugar } from "./lugar.js";

const E = {
  inicio: null,
  mision: null,       // configuración que se está editando
  base: {},           // tolerancias originales (centro de cada slider)
  modo: "predefinida",
  resultado: null,
  sel: null,          // sitio seleccionado
  mapa: null,
  capa: null,
  listo: false,
  G: null,            // grilla de Daniel (puntos de 1° x 1° con los 5 parámetros medidos)
  nombres: {},        // id del punto → nombre del lugar (OpenStreetMap)
  parametrosCalculo: [],
};

const ESTADO = { borrador: "draft", verificado: "verified" };

// Sitio del catálogo; si el modelo devolvió un punto que no está en sitios.csv (p. ej. una celda de grilla),
// se arma con la lat/lon/nombre que trae el propio ranking.
function sitio(id) {
  if (E.G?.idx.has(id)) return puntoRejilla(id);
  const s = E.inicio.sitios.find((x) => x.id === id);
  if (s) return s;
  const r = E.resultado?.ranking.find((x) => x.sitio_id === id) || {};
  return { id, nombre: r.nombre || (r.lat != null ? `Punto ${coordenadas(r.lat, r.lon)}` : id), lat: r.lat, lon: r.lon };
}
const variable = (v) => E.inicio.variables.find((x) => x.variable === v) || {};
const destino = (id) => E.inicio.destinos.find((d) => d.id === id) || {};
const esValorDeSitio = (v) => /^(valor del sitio|restricción|site value)/i.test(variable(v).metrica || "");

// ¿El destino tiene datos de este parámetro? (p. ej. la Luna no tiene humedad ni viento: no hay atmósfera)
function disponible(v, idDestino = E.mision?.destino) {
  const d = destino(idDestino);
  return !d.variables_disponibles || d.variables_disponibles.includes(v);
}
function motivoNoDisponible(v) {
  const d = destino(E.mision.destino);
  const enLuna = (variable(v).luna || "").toLowerCase();
  if (d.cuerpo === "luna" && /^(no aplica|not applicable)/.test(enLuna)) return "Not applicable on the Moon: it has no atmosphere.";
  return `No data for this parameter at ${d.nombre || "this destination"}.`;
}

// ---------------------------------------------------------------- inicio
export function iniciarMision(inicio) {
  E.inicio = inicio;
  E.G = prepararRejilla(inicio.rejilla);
  $("#sel-destino").append(...inicio.destinos.map((d) => el("option", { value: d.id }, `${d.nombre} (${{ luna: "Moon", marte: "Mars" }[d.cuerpo] || d.cuerpo})`)));
  $("#sel-destino").addEventListener("change", (e) => { E.mision.destino = e.target.value; cambio(true); });
  $("#btn-agregar-parametro").addEventListener("click", agregarParametro);
  $("#btn-agregar-restriccion").addEventListener("click", agregarRestriccion);
  $$(".pestana").forEach((b) => b.addEventListener("click", () => cambiarModo(b.dataset.modo)));
  pintarMisiones();
}

// Se llama cada vez que se abre el apartado. ?destino=luna|marte|<id> escoge una misión de ese destino.
export function mostrarMision(params) {
  if (!E.mapa) {
    E.mapa = mapaAmerica("mapa");
    E.capa = L.layerGroup().addTo(E.mapa);
    hudCoordenadas(E.mapa, $("#coords-mision"));
  }
  setTimeout(() => { E.mapa.invalidateSize(); if (E.resultado) pintarOptimo(); }, 50);

  const pedido = params?.get("destino");
  if (pedido) {
    const d = E.inicio.destinos.find((x) => x.id === pedido) || E.inicio.destinos.find((x) => x.cuerpo === pedido);
    const m = d && E.inicio.misiones.find((x) => x.destino === d.id);
    if (m) { E.modo = "predefinida"; marcarPestana(); cargarMision(m.id); return; }
    if (d) { cambiarModo("personalizada"); E.mision.destino = d.id; cambio(true); return; }
  }
  if (!E.listo) {
    E.listo = true;
    if (E.inicio.misiones.length) cargarMision(E.inicio.misiones[0].id);
    else cambiarModo("personalizada");
  } else if (E.resultado) {
    pintarMapa();
  }
}

// ---------------------------------------------------------------- misiones predefinidas
function pintarMisiones() {
  const caja = $("#lista-misiones");
  caja.replaceChildren(...E.inicio.misiones.map((m) => {
    const d = destino(m.destino);
    return el("button", { class: "op-mision", type: "button", "data-id": m.id, onclick: () => { E.modo = "predefinida"; marcarPestana(); cargarMision(m.id); } },
      el("span", { class: "astro", style: `--tex:url(${TEXTURA[d.cuerpo] || TEXTURA.tierra})` }),
      el("span", {}, el("b", {}, m.nombre), el("small", {}, `${d.nombre || m.destino} · ${m.parametros.length} parameters`)));
  }));
  if (!E.inicio.misiones.length) caja.append(el("p", { class: "nota" }, "No missions in misiones.csv."));
}

function marcarPestana() {
  $$(".pestana").forEach((b) => b.classList.toggle("activa", b.dataset.modo === E.modo));
  $$(".op-mision").forEach((b) => b.classList.toggle("activa", E.modo === "predefinida" && b.dataset.id === E.mision?.id));
}

// ---------------------------------------------------------------- misión
function cargarMision(id) {
  const m = E.inicio.misiones.find((x) => x.id === id);
  E.mision = structuredClone(m);
  E.base = {};
  E.mision.parametros.forEach((p) => { if (p.metodo === "tolerancia") E.base[p.variable] = p.valor; });
  marcarPestana();
  pintarConfig();
  calcular();
}

function cambiarModo(modo) {
  E.modo = modo;
  if (modo === "personalizada") {
    if (!E.mision) {
      const d = E.inicio.destinos[0];
      E.mision = { id: "personalizada", nombre: "Custom mission", destino: d ? d.id : "",
                   restricciones: [], parametros: [], limites_tierra: [] };
    } else if (E.mision.id !== "personalizada") {
      E.mision = { ...structuredClone(E.mision), id: "personalizada", nombre: `Custom (based on: ${E.mision.nombre})` };
    }
    marcarPestana();
    pintarConfig();
    calcular();
  } else if (E.inicio.misiones.length) {
    const actual = E.inicio.misiones.find((m) => m.id === E.mision?.id);
    cargarMision(actual ? actual.id : E.inicio.misiones[0].id);
  }
}

function pintarConfig() {
  const m = E.mision;
  const pers = E.modo === "personalizada";
  $("#lista-misiones").hidden = pers;
  $("#sel-destino").disabled = !pers;
  $("#sel-destino").value = m.destino;
  const d = destino(m.destino);
  $("#nota-mision").textContent = `${pers ? m.nombre + ". " : ""}${d.por_que || ""}` + (m.estado ? ` · status: ${ESTADO[m.estado] || m.estado}` : "");

  // parámetros
  const lp = $("#lista-parametros");
  lp.replaceChildren(...m.parametros.map((p, i) => filaParametro(p, i)));
  if (!m.parametros.length) lp.append(el("p", { class: "nota" }, "Add at least one parameter."));

  // restricciones
  const lr = $("#lista-restricciones");
  lr.replaceChildren(...m.restricciones.map((r, i) => filaRestriccion(r, i)));
  if (!m.restricciones.length) lr.append(el("p", { class: "nota" }, "No constraints."));

  // selects para agregar: parámetros = variables con distancia f; restricciones = valores del sitio
  const usadosP = new Set(m.parametros.map((p) => p.variable));
  const usadosR = new Set(m.restricciones.map((r) => r.variable));
  const opcP = E.inicio.variables.filter((v) => !esValorDeSitio(v.variable) && !usadosP.has(v.variable))
    .map((v) => el("option", { value: v.variable, disabled: !disponible(v.variable) },
      `${nombre(v.variable)}${disponible(v.variable) ? "" : " (not applicable at this destination)"}`));
  const opcR = (E.inicio.restricciones_disponibles || []).filter((v) => !usadosR.has(v))
    .map((v) => el("option", { value: v }, `${nombre(v)} (${variable(v).unidad || "—"})`));
  $("#sel-nuevo-parametro").replaceChildren(...opcP);
  $("#sel-nueva-restriccion").replaceChildren(...opcR);
  $("#btn-agregar-parametro").disabled = !opcP.some((o) => !o.disabled);
  $("#btn-agregar-restriccion").disabled = !opcR.length;
  const primeraLibre = opcP.find((o) => !o.disabled);
  if (primeraLibre) $("#sel-nuevo-parametro").value = primeraLibre.value;

  // límites
  $("#lista-limites").replaceChildren(
    ...m.limites_tierra.map((t) => el("li", {}, t)),
    ...LIMITES_SIEMPRE.map((t) => el("li", { class: "nota" }, t)));
}

function filaParametro(p, i) {
  const activo = disponible(p.variable);
  const quitar = el("button", { class: "quitar", title: "Remove", "aria-label": `Remove ${nombre(p.variable)}`, onclick: () => {
    E.mision.parametros.splice(i, 1); cambio(true); } }, "×");
  const cab = el("div", { class: "fila-cab" },
    el("strong", {}, nombre(p.variable)),
    el("span", { class: "unidad" }, p.metodo === "tolerancia" ? `tolerance · ${p.unidad || ""}` : "AHP weight"),
    quitar);
  if (!activo) {
    return el("div", { class: "fila inactiva" }, cab, el("div", { class: "texto" }, `${motivoNoDisponible(p.variable)} Not used in the calculation.`));
  }
  const texto = p.texto ? el("div", { class: "texto" }, p.texto) : null;

  let control;
  if (p.metodo === "tolerancia") {
    // slider en escala logarítmica alrededor de la tolerancia original: de base/10 a base·10
    const base = E.base[p.variable] ?? p.valor;
    const num = el("input", { type: "number", min: "0", step: "any", value: +p.valor.toPrecision(3), "aria-label": `Tolerance for ${nombre(p.variable)}` });
    const rango = el("input", { type: "range", min: "-1", max: "1", step: "0.02",
      value: Math.log10(p.valor / base).toFixed(2), "aria-label": `Tolerance for ${nombre(p.variable)} (slider)` });
    rango.addEventListener("input", () => {
      p.valor = +(base * 10 ** +rango.value).toPrecision(3);
      num.value = p.valor; cambio();
    });
    num.addEventListener("change", () => {
      const v = parseFloat(num.value);
      if (v > 0) { p.valor = v; rango.value = Math.log10(v / base).toFixed(2); cambio(); }
    });
    control = el("div", { class: "control" }, rango, num);
  } else {
    const num = el("input", { type: "number", min: "0", step: "0.01", value: p.peso });
    num.addEventListener("change", () => { const v = parseFloat(num.value); if (v > 0) { p.peso = v; cambio(); } });
    control = el("div", { class: "control" }, el("span", { class: "nota" }, "weight w ="), num);
  }
  return el("div", { class: "fila" }, cab, texto, control);
}

function filaRestriccion(r, i) {
  const quitar = el("button", { class: "quitar", title: "Remove", "aria-label": `Remove ${nombre(r.variable)}`, onclick: () => {
    E.mision.restricciones.splice(i, 1); cambio(true); } }, "×");
  const op = el("select", { "aria-label": "Operator" }, el("option", { value: "<=" }, "≤"), el("option", { value: ">=" }, "≥"));
  op.value = r.operador;
  op.addEventListener("change", () => { r.operador = op.value; cambio(); });
  const num = el("input", { type: "number", step: "any", value: r.valor, "aria-label": `Threshold for ${nombre(r.variable)}` });
  num.addEventListener("change", () => { const v = parseFloat(num.value); if (!isNaN(v)) { r.valor = v; cambio(); } });
  return el("div", { class: "fila" },
    el("div", { class: "fila-cab" }, el("strong", {}, nombre(r.variable)), el("span", { class: "unidad" }, r.unidad || ""), quitar),
    r.texto ? el("div", { class: "texto" }, r.texto) : null,
    el("div", { class: "control tres" }, op, num));
}

function agregarParametro() {
  const v = $("#sel-nuevo-parametro").value;
  if (!v || !disponible(v)) return;
  pasarAPersonalizada();
  E.mision.parametros.push({ variable: v, metodo: "tolerancia", valor: 1, peso: null,
    unidad: variable(v).unidad || "", texto: "Added by hand: adjust the tolerance", fuente: "" });
  E.base[v] = 1;
  cambio(true);
}

function agregarRestriccion() {
  const v = $("#sel-nueva-restriccion").value;
  if (!v) return;
  pasarAPersonalizada();
  E.mision.restricciones.push({ variable: v, operador: "<=", valor: 0, unidad: variable(v).unidad || "",
    texto: "Added by hand: enter the threshold", fuente: "" });
  cambio(true);
}

// Agregar o quitar reglas a una predefinida la vuelve personalizada (la predefinida queda intacta)
function pasarAPersonalizada() {
  if (E.modo !== "personalizada") { E.modo = "personalizada"; cambiarModo("personalizada"); }
}

// Cualquier cambio en la configuración recalcula (con una pequeña espera)
let espera;
function cambio(repintar = false) {
  if (repintar) pintarConfig();
  clearTimeout(espera);
  espera = setTimeout(calcular, 250);
}

// ---------------------------------------------------------------- cálculo
let peticion;
async function calcular() {
  if (!E.mision) return;
  const err = $("#error");
  // Solo se mandan los parámetros que el destino tiene (los "no aplica" quedan fuera)
  const parametros = paramsActivos();
  if (!parametros.length) {
    err.hidden = false;
    err.textContent = "Add at least one parameter that exists for this destination.";
    return;
  }
  peticion?.abort();
  peticion = new AbortController();
  try {
    const r = await fetch("/api/recomendar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...E.mision, parametros }), signal: peticion.signal,
    });
    const datos = await r.json();
    if (!r.ok) {
      const det = Array.isArray(datos.detail) ? datos.detail.map((d) => d.msg).join("; ") : datos.detail;
      throw new Error(det);
    }
    err.hidden = true;
    E.resultado = datos;
    E.parametrosCalculo = structuredClone(parametros);
    const cambioOptimo = datos.optimo?.sitio_id !== E._optimoId;
    E._optimoId = datos.optimo?.sitio_id;
    // Al cambiar el óptimo se selecciona; si el usuario escogió otro punto que sigue existiendo, se respeta
    if (!E.sel || !estadoDe(E.sel) || (cambioOptimo && E.selEsOptimo)) { E.sel = datos.optimo?.sitio_id ?? datos.ranking[0]?.sitio_id ?? null; E.selEsOptimo = true; }
    pintarResultado();
    if (datos.rejilla) datos.ranking.slice(0, 5).forEach((x) => pedirNombre(x.sitio_id));
  } catch (e) {
    if (e.name === "AbortError") return;
    err.hidden = false;
    err.textContent = `Could not calculate: ${e.message}`;
  }
}

const paramsActivos = () => (E.mision?.parametros || []).filter((p) => disponible(p.variable));

// ---------------------------------------------------------------- grilla de Daniel (puntos de 1° x 1°)
function prepararRejilla(r) {
  if (!r) return null;
  const G = { ids: [], idx: new Map(), lat: [], lon: [], val: {}, rango: {}, variables: r.variables };
  r.variables.forEach((v) => (G.val[v] = []));
  r.puntos.forEach((p, i) => {
    G.ids.push(p[0]); G.idx.set(p[0], i); G.lat.push(p[1]); G.lon.push(p[2]);
    r.variables.forEach((v, j) => G.val[v].push(p[3 + j]));
  });
  for (const v of r.variables) {
    const xs = G.val[v].filter((x) => x != null);
    G.rango[v] = Math.max(...xs) - Math.min(...xs);
  }
  return G;
}

// Nombre del lugar (OpenStreetMap, vía /api/lugar). Se piden en fila: el servidor hace máximo 1 por segundo.
const cola = [];
let colaOcupada = false;
function pedirNombre(id) {
  if (!E.G?.idx.has(id) || E.nombres[id] || cola.includes(id)) return;
  cola.push(id);
  procesarCola();
}
async function procesarCola() {
  if (colaOcupada) return;
  colaOcupada = true;
  while (cola.length) {
    const id = cola.shift();
    const k = E.G.idx.get(id);
    try {
      const h = await (await fetch(`/api/lugar?lat=${E.G.lat[k]}&lon=${E.G.lon[k]}`)).json();
      const l = h.lugar || {};
      if (h.lugar) E.nombres[id] = { nombre: l.nombre || l.region || "", region: [l.nombre ? l.region : "", l.pais].filter(Boolean).join(", ") };
      if (E.resultado) pintarResultado(false);
    } catch { /* sin nombre: se queda con las coordenadas */ }
  }
  colaOcupada = false;
}

function puntoRejilla(id) {
  const k = E.G.idx.get(id);
  const n = E.nombres[id];
  const coords = coordenadas(E.G.lat[k], E.G.lon[k]);
  return { id, k, lat: E.G.lat[k], lon: E.G.lon[k], rejilla: true,
    nombre: n?.nombre || coords, pais: n ? n.region : "1° grid cell" };
}

// Evaluación de un punto con la configuración actual (la misma cuenta del modelo: Chebyshev ponderado)
function evaluar(k) {
  const obj = E.resultado.objetivos;
  const detalle = E.parametrosCalculo.map((p) => {
    const v = p.variable, x = E.G.val[v][k], o = obj[v].valor;
    const dif = Math.abs(x - o), f = dif / E.G.rango[v];
    const w_f = p.metodo === "tolerancia" ? dif / p.valor : f * p.peso;
    return { variable: v, f, w_f, dentro_tolerancia: p.metodo === "tolerancia" ? w_f <= 1 : null,
      valor_sitio: x, objetivo: o, diferencia: dif, tolerancia: p.metodo === "tolerancia" ? p.valor : null };
  });
  const wf = detalle.map((d) => d.w_f);
  const m = Math.max(...wf);
  const conTol = detalle.filter((d) => d.dentro_tolerancia !== null);
  return { sitio_id: E.G.ids[k], puntuacion: m, parametro_decisivo: detalle[wf.indexOf(m)].variable,
    dentro_tolerancia: conTol.length ? conTol.every((d) => d.dentro_tolerancia) : null, robustez: null, detalle };
}

function puestoFrente(k) {
  const P = E.resultado.puntos, s = P[k][0];
  let n = 1;
  for (const [x, est] of P) if (est === 0 && x < s) n++;
  return n;
}

// Quién domina a un punto: entre los del frente que son iguales o mejores en todo, el de menor puntuación
function dominador(k) {
  const obj = E.resultado.objetivos, vs = E.parametrosCalculo.map((p) => p.variable);
  const f = (i) => vs.map((v) => Math.abs(E.G.val[v][i] - obj[v].valor) / E.G.rango[v]);
  const fk = f(k);
  let mejor = null;
  E.resultado.puntos.forEach(([s, est], j) => {
    if (est !== 0) return;
    const fj = f(j);
    if (fj.every((x, i) => x <= fk[i]) && fj.some((x, i) => x < fk[i]) && (mejor === null || s < E.resultado.puntos[mejor][0])) mejor = j;
  });
  return mejor === null ? null : E.G.ids[mejor];
}

function motivoDescarte(k) {
  for (const r of E.mision.restricciones) {
    const x = E.G.val[r.variable]?.[k];
    if (x == null) continue;
    if (r.operador === "<=" ? x > r.valor : x < r.valor) return `${nombre(r.variable)} = ${fmt(x)} (must be ${r.operador} ${r.valor} ${r.unidad || ""})`;
  }
  return "Does not meet a constraint";
}

function estadoDe(id) {
  const R = E.resultado;
  const i = R.ranking.findIndex((x) => x.sitio_id === id);
  if (i >= 0) return { tipo: "frente", puesto: i + 1, dato: R.ranking[i], eval: R.ranking[i] };
  if (R.rejilla && E.G?.idx.has(id)) {
    const k = E.G.idx.get(id);
    const est = R.puntos[k][1];
    if (est === 2) return { tipo: "descartado", dato: { sitio_id: id, motivo: motivoDescarte(k) } };
    const ev = evaluar(k);
    if (est === 0) return { tipo: "frente", puesto: puestoFrente(k), dato: ev, eval: ev };
    return { tipo: "dominado", dato: { sitio_id: id, dominado_por: dominador(k) }, eval: ev };
  }
  const d = R.dominados.find((x) => x.sitio_id === id);
  if (d) return { tipo: "dominado", dato: d };
  const x = R.descartados.find((x) => x.sitio_id === id);
  if (x) return { tipo: "descartado", dato: x };
  return null;
}

function seleccionar(id, zoom = 6) {
  E.sel = id;
  E.selEsOptimo = id === E.resultado?.optimo?.sitio_id;
  pintarResultado();
  volarA(sitio(id), zoom);
  pedirNombre(id);
}

function pintarResultado(conMapa = true) {
  const R = E.resultado;
  const tot = R.totales;
  $("#ranking").replaceChildren(...R.ranking.map((x, i) => {
    const s = sitio(x.sitio_id);
    const etq = x.dentro_tolerancia === null ? null :
      el("span", { class: `etq ${x.dentro_tolerancia ? "bien" : "mal"}` },
        x.dentro_tolerancia ? "within tolerance" : "outside tolerance");
    return el("li", { class: x.sitio_id === E.sel ? "sel" : "", tabindex: "0", onclick: () => seleccionar(x.sitio_id),
      onkeydown: (e) => { if (e.key === "Enter") seleccionar(x.sitio_id); } },
      el("span", { class: "puesto" }, String(i + 1).padStart(2, "0")),
      el("div", {}, el("div", { class: "nombre" }, s.nombre),
        el("div", { class: "meta" }, `${s.pais ? s.pais + " · " : ""}decided by: ${nombre(x.parametro_decisivo)} · robustness ${pct(x.robustez)} `), etq),
      el("div", { class: "punt" }, el("b", {}, fmt(x.puntuacion)), el("span", { class: "meta" }, "score")));
  }));
  if (!R.ranking.length) {
    $("#ranking").append(el("p", { class: "nota" }, "No site meets the constraints."));
  }
  const nota = $("#filtro-nota");
  const partes = [];
  if (tot) partes.push(`${tot.puntos.toLocaleString("en")} points of Daniel's grid · ${tot.frente.toLocaleString("en")} on the Pareto front${tot.frente > R.ranking.length ? ` (top ${R.ranking.length} shown; click the map for any other)` : ""}.`);
  if (R.restricciones_omitidas?.length) partes.push(`Not applied, no data in the grid yet: ${R.restricciones_omitidas.map(nombre).join(", ")}.`);
  nota.hidden = !partes.length;
  nota.textContent = partes.join(" ");

  $("#n-dom").textContent = (tot?.dominados ?? R.dominados.length).toLocaleString("en");
  $("#dominados").replaceChildren(...R.dominados.map((d) =>
    el("li", { onclick: () => seleccionar(d.sitio_id) }, `${sitio(d.sitio_id).nombre} — beaten by ${sitio(d.dominado_por).nombre}`)));
  $("#n-desc").textContent = (tot?.descartados ?? R.descartados.length).toLocaleString("en");
  $("#descartados").replaceChildren(...R.descartados.map((d) =>
    el("li", { onclick: () => seleccionar(d.sitio_id) }, `${sitio(d.sitio_id).nombre} — ${d.motivo}`)));

  if (conMapa) pintarMapa();
  pintarOptimo();
  pintarFicha();
}

// Lugar óptimo (salida del modelo de Daniel): recuadro sobre el mapa, y el mapa vuela y hace zoom cuando cambia
function pintarOptimo() {
  if (!E.mapa) return;
  const o = E.resultado.optimo;
  const caja = $("#optimo");
  caja.hidden = !o || o.lat == null;
  if (caja.hidden) return;
  const s = sitio(o.sitio_id);
  caja.replaceChildren(
    el("span", { class: "optimo-etq" }, "Optimal site"),
    el("b", {}, s.nombre || o.sitio_id),
    el("span", { class: "optimo-coords" }, `${s.pais && s.rejilla ? s.pais + " · " : ""}${coordenadas(o.lat, o.lon)}`),
    el("button", { class: "btn chico", type: "button", onclick: () => seleccionar(o.sitio_id, 7) }, "Center ", el("i", { class: "flecha" })));
  const clave = `${o.lat},${o.lon}`;
  if (clave !== E._ultimoOptimo && E.mapa.getSize().x > 0) {
    E._ultimoOptimo = clave;
    volarA(o, 6);
  }
}

function volarA(p, zoom) {
  if (p?.lat == null || !E.mapa) return;
  E.mapa.flyTo([p.lat, p.lon], Math.max(E.mapa.getZoom(), zoom), { duration: 1.6 });
}

function pintarMapa() {
  if (!E.mapa) return;
  E.capa.clearLayers();
  if (E.resultado.rejilla) { pintarRejilla(); return; }
  for (const s of E.inicio.sitios) {
    if (s.lat == null || s.lon == null) continue;
    const st = estadoDe(s.id);
    if (!st) continue;
    marcador(s, st);
  }
}

function marcador(s, st) {
  let clase = st.tipo, texto = "", tam = 16;
  if (st.tipo === "frente") { texto = st.puesto; tam = 26; if (st.puesto === 1) { clase += " primero"; tam = 30; } }
  if (s.id === E.sel) tam += 6;
  const icono = L.divIcon({ className: "", iconSize: [tam, tam],
    html: `<div class="marcador ${clase}" style="width:${tam}px;height:${tam}px">${texto}</div>` });
  L.marker([s.lat, s.lon], { icon: icono, title: s.nombre, zIndexOffset: st.tipo === "frente" ? 1000 - (st.puesto || 0) : 0 })
    .on("click", () => seleccionar(s.id)).addTo(E.capa);
}

// Cada punto de la grilla es un cuadro de 1°, coloreado según qué tan bien imita al destino con los pesos actuales
function pintarRejilla() {
  const G = E.G, R = E.resultado;
  if (!E.celdas) {
    const lienzo = L.canvas({ padding: 0.3 });
    E.capaCeldas = L.layerGroup().addTo(E.mapa);
    E.celdas = G.ids.map((id, i) => L.rectangle([[G.lat[i] - 0.5, G.lon[i] - 0.5], [G.lat[i] + 0.5, G.lon[i] + 0.5]],
      { renderer: lienzo, weight: 0, fillOpacity: 0, interactive: true })
      .on("click", () => seleccionar(id)).addTo(E.capaCeldas));
  }
  // color por percentil de la puntuación: así siempre se ve el contraste, sea cual sea la escala
  const orden = R.puntos.map((p, i) => [p[0], i]).filter((x) => x[0] != null).sort((a, b) => a[0] - b[0]);
  const perc = new Float32Array(G.ids.length).fill(1);
  orden.forEach(([, i], n) => (perc[i] = n / Math.max(1, orden.length - 1)));
  E.celdas.forEach((c, i) => {
    const est = R.puntos[i][1], t = perc[i];
    const sel = G.ids[i] === E.sel;
    if (est === 2) c.setStyle({ fillColor: "#ff5d6c", fillOpacity: 0.16, weight: sel ? 2 : 0, color: "#fff" });
    else c.setStyle({ fillColor: `hsl(${195 + 35 * t}, ${90 - 50 * t}%, ${68 - 40 * t}%)`,
      fillOpacity: est === 0 ? 0.85 - 0.45 * t : 0.6 - 0.5 * t, weight: sel ? 2 : 0, color: "#fff" });
  });
  R.ranking.slice(0, 10).forEach((x, i) => marcador(sitio(x.sitio_id), { tipo: "frente", puesto: i + 1 }));
  if (E.sel && !R.ranking.slice(0, 10).some((x) => x.sitio_id === E.sel) && G.idx.has(E.sel)) {
    const s = sitio(E.sel);
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", iconSize: [18, 18], html: '<div class="marcador-punto"></div>' }) }).addTo(E.capa);
  }
}

// "Sobre este lugar": la IA lo investiga y explica por qué es análogo CON LA CONFIGURACIÓN ACTUAL.
// Al mover los pesos se espera a que el usuario suelte el control antes de volver a preguntarle a la IA.
function sobreElLugar(s, st) {
  const ev = st?.eval ? paraIA(st) : null;
  const k = `${s.id}|${E.mision.id}|${E.mision.destino}|${JSON.stringify(ev)}`;
  if (E._lugarClave !== k) {
    const mismoSitio = E._lugarSitio === s.id && E._lugarNodo;
    E._lugarClave = k;
    E._lugarSitio = s.id;
    if (!mismoSitio) E._lugarNodo = el("div", { class: "lugar" }, el("p", { class: "nota" }, "Looking up the place…"));
    const nodo = E._lugarNodo;
    clearTimeout(E._lugarEspera);
    if (s.lat == null) { nodo.replaceChildren(el("p", { class: "nota" }, "This point has no coordinates.")); }
    else {
      const atr = E.inicio.atributos.find((a) => a.sitio_id === s.id) || {};
      const d = destino(E.mision.destino);
      E._lugarEspera = setTimeout(() => investigarLugar(nodo, { lat: s.lat, lon: s.lon,
        sitio: E.inicio.sitios.some((x) => x.id === s.id) ? { ...s, ...atr } : null,
        destino: d.nombre ? { nombre: d.nombre, cuerpo: d.cuerpo } : null, mision: E.mision.nombre, evaluacion: ev }),
      mismoSitio ? 900 : 100);
    }
  }
  return [el("h3", {}, "About this place"), E._lugarNodo];
}

const REGLA = { min: "lowest_on_earth", max: "highest_on_earth", fijo: "fixed_value" };
const redondo = (x) => (x == null ? null : +(+x).toPrecision(3));

// Lo que la IA necesita para explicar el ranking: valores del punto, objetivo del destino, tolerancias y pesos
function paraIA(st) {
  const ev = st.eval, R = E.resultado, obj = R.objetivos || {};
  const pesos = E.parametrosCalculo.map((p) => (p.metodo === "tolerancia" ? (E.G?.rango[p.variable] || 1) / p.valor : p.peso));
  const suma = pesos.reduce((a, b) => a + b, 0) || 1;
  return {
    status: { frente: "on the Pareto front", dominado: "dominated: another point is equal or better in every parameter" }[st.tipo],
    rank: st.puesto ? `${st.puesto} of ${R.totales?.frente ?? R.ranking.length} on the Pareto front` : null,
    is_optimal_site: ev.sitio_id === R.optimo?.sitio_id,
    score: redondo(ev.puntuacion),
    score_meaning: "largest difference/tolerance among the parameters; 1 or less means within tolerance in all of them",
    decisive_parameter: nombre(ev.parametro_decisivo),
    robustness: ev.robustez == null ? null : `ranked first in ${Math.round(ev.robustez * 100)}% of runs with slightly changed weights`,
    parameters: ev.detalle.map((d, i) => ({
      name: nombre(d.variable), unit: (variable(d.variable).unidad || "").replace(/\s*\(.*\)$/, ""),
      value_here: redondo(d.valor_sitio), destination_target: redondo(d.objetivo),
      target_rule: REGLA[obj[d.variable]?.regla] || null, difference: redondo(d.diferencia),
      tolerance: redondo(d.tolerancia), within_tolerance: d.dentro_tolerancia,
      weight_share_percent: Math.round((pesos[i] / suma) * 100),
    })),
  };
}

// Mapas medidos por el equipo (IMAGENES-DATOS): se muestran los de los parámetros de la misión
const MAPAS = { temperatura: "Surface temperature (°C)", humedad: "Surface relative humidity (%)", viento: "Wind speed (m/s)",
  variacion_temperatura: "Day–night surface temperature range (°C)", reflectancia: "Surface albedo (%)" };
function mapasMedidos(s) {
  const vs = E.parametrosCalculo.map((p) => p.variable).filter((v) => MAPAS[v]);
  if (!vs.length) return null;
  return [el("h3", {}, "Measured data behind this site"),
    el("p", { class: "ayuda" }, `Maps of the Americas measured by the team, one per mission parameter. This point: ${coordenadas(s.lat, s.lon)}.`),
    el("div", { class: "mapas-medidos" }, ...vs.map((v) => {
      const k = E.G?.idx.get(s.id);
      const aqui = k != null ? E.G.val[v][k] : null;
      return el("a", { class: "mapa-medido", href: `/static/img/mapas/${v}.png`, target: "_blank", rel: "noopener" },
        el("img", { src: `/static/img/mapas/${v}.png`, alt: `${MAPAS[v]} across the Americas`, loading: "lazy" }),
        el("span", {}, el("b", {}, nombre(v)), aqui != null ? ` · here: ${+aqui.toPrecision(3)} ${(variable(v).unidad || "").replace(/\s*\(.*\)$/, "")}` : ""));
    }))];
}

function tablaAnalogo(ev) {
  const obj = E.resultado.objetivos || {};
  const regla = { min: "lowest on Earth", max: "highest on Earth" };
  const u = (v) => (variable(v).unidad || "").replace(/\s*\(.*\)$/, "");
  const n = (x) => (x == null ? "—" : String(+(+x).toPrecision(3)));
  return el("div", { class: "tabla-scroll" }, el("table", { class: "tabla-analogo" },
    el("thead", {}, el("tr", {}, ...["Parameter", "Here", "Target", "Diff.", "Tol.", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...ev.detalle.map((d) => el("tr", {},
      el("td", {}, nombre(d.variable), el("small", {}, u(d.variable))),
      el("td", { class: "num-t" }, n(d.valor_sitio)),
      el("td", { class: "num-t", title: obj[d.variable]?.por_que || "" }, n(d.objetivo), regla[obj[d.variable]?.regla] ? el("small", {}, regla[obj[d.variable].regla]) : null),
      el("td", { class: "num-t" }, n(d.diferencia)),
      el("td", { class: "num-t" }, d.tolerancia == null ? "AHP" : n(d.tolerancia)),
      el("td", {}, d.dentro_tolerancia == null ? "" : el("span", { class: `etq ${d.dentro_tolerancia ? "bien" : "mal"}` }, d.dentro_tolerancia ? "✓" : "✗")))))));
}

function pintarFicha() {
  const caja = $("#ficha");
  const f = { replaceChildren: (...xs) => caja.replaceChildren(...xs.flat(Infinity).filter((x) => x !== null && x !== undefined)) };
  const titulo = el("div", { class: "paso" }, el("span", {}, "5"), el("h2", {}, "Site profile"));
  if (!E.sel) { f.replaceChildren(titulo, el("p", { class: "nota" }, "Pick a site.")); return; }
  const s = sitio(E.sel);
  const st = estadoDe(E.sel);
  const cab = el("div", { class: "ficha-cab" }, el("h2", {}, s.nombre),
    el("span", { class: "pais" }, `${s.pais ? s.pais + " · " : ""}${coordenadas(s.lat, s.lon)}`));
  const hipotesis = s.por_que ? el("p", { class: "nota" }, `Hypothesis: ${s.por_que}`) : null;
  const fuente = s.rejilla
    ? el("p", { class: "nota" }, "Source: Daniel's grid (1° × 1°, 5 measured parameters) · targets: research team (TO BE VERIFIED)")
    : el("p", { class: "nota" }, `Source: ${s.fuente || "—"} · status: ${ESTADO[s.estado] || s.estado || "—"}`);
  const limites = [el("h3", {}, "What Earth cannot reproduce"),
    el("ul", {}, ...E.mision.limites_tierra.map((t) => el("li", {}, t)), ...LIMITES_SIEMPRE.map((t) => el("li", {}, t)))];

  if (!st) { f.replaceChildren(titulo, cab, el("p", { class: "nota" }, "No result for this site."), hipotesis, fuente); return; }
  if (st.tipo === "descartado") {
    f.replaceChildren(titulo, cab, el("p", { class: "error" }, `Ruled out: ${st.dato.motivo}`), hipotesis, sobreElLugar(s, null), fuente);
    return;
  }
  if (st.tipo === "dominado") {
    const quien = st.dato.dominado_por ? sitio(st.dato.dominado_por).nombre : "another point";
    f.replaceChildren(titulo, cab,
      el("p", {}, `Dominated by ${quien}: that point is equal or better in every mission parameter and better in at least one. That is why it is not recommended.`),
      hipotesis, st.eval ? [el("h3", {}, "Compared with the destination"), tablaAnalogo(st.eval)] : null,
      sobreElLugar(s, st), s.rejilla ? mapasMedidos(s) : null, fuente);
    return;
  }

  const x = st.dato;
  const cifras = el("div", { class: "cifras" },
    el("div", { class: "cifra" }, el("b", {}, `#${st.puesto}`), el("span", {}, "rank")),
    el("div", { class: "cifra" }, el("b", {}, fmt(x.puntuacion)), el("span", {}, "score (≤ 1 = within)")),
    el("div", { class: "cifra" }, el("b", {}, x.robustez == null ? "—" : pct(x.robustez)), el("span", {}, "robustness (times 1st)")));

  const escala = Math.max(2, ...x.detalle.map((d) => d.w_f));
  const barras = x.detalle.map((d) => {
    const color = d.dentro_tolerancia === false ? "var(--mal)" : d.dentro_tolerancia ? "var(--bien)" : "var(--cian)";
    return el("div", { class: "barra-param" },
      el("div", { class: "rotulo" }, el("span", {}, nombre(d.variable)),
        el("span", { class: "meta" }, `w·f = ${fmt(d.w_f)}`)),
      el("div", { class: "pista" },
        el("i", { style: `width:${(d.w_f / escala) * 100}%;background:${color}` }),
        el("span", { class: "marca-1", style: `left:${(1 / escala) * 100}%` })));
  });

  const fuera = E.mision.parametros.filter((p) => !disponible(p.variable));
  const comparacion = x.detalle[0]?.valor_sitio !== undefined
    ? [el("h3", {}, "Compared with the destination"), el("p", { class: "ayuda" }, "Target = the destination's value. When the Moon or Mars is beyond anything on Earth, the target is the most extreme value on the continent."), tablaAnalogo(x)]
    : null;
  f.replaceChildren(titulo, cab, hipotesis, cifras, comparacion, sobreElLugar(s, st),
    el("h3", {}, "Weighted difference per parameter"),
    el("p", { class: "ayuda" }, "Difference ÷ tolerance. The white line marks 1: to its left, within tolerance. The longest bar sets the score."),
    ...barras,
    s.rejilla ? mapasMedidos(s) : null,
    fuera.length ? el("p", { class: "nota" }, `Not compared at this destination: ${fuera.map((p) => nombre(p.variable)).join(", ")}.`) : null,
    ...limites, fuente);
}
