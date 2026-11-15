// Apartado 4 · Preparar misión: configuración → POST /api/recomendar → ranking, mapa y ficha.
// Método (AGENTS.md §5): restricciones → frente de Pareto → Chebyshev ponderado → robustez.
// Dueño: Samuel (app/).

import { $, $$, el, fmt, pct, coordenadas, nombre, TEXTURA, LIMITES_SIEMPRE, mapaAmerica, hudCoordenadas } from "./util.js";
import { investigarLugar } from "./lugar.js";
import { prepararRejilla, puntoRejilla, pedirNombre, alNombrar, nombres, MAPAS, colorCelda } from "./rejilla.js";

const E = {
  inicio: null,
  mision: null,       // configuración que se está editando
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

// Cada punto del ranking es un punto de la grilla de Daniel
function sitio(id) {
  if (E.G?.idx.has(id)) return puntoRejilla(id);
  return { id, nombre: id, lat: null, lon: null };
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
  E.nombres = nombres;
  alNombrar(() => { if (E.resultado) pintarResultado(false); });
  $("#sel-destino").append(...inicio.destinos.map((d) => el("option", { value: d.id }, `${d.nombre} (${{ luna: "Moon", marte: "Mars" }[d.cuerpo] || d.cuerpo})`)));
  $("#sel-destino").addEventListener("change", (e) => { E.mision.destino = e.target.value; cambio(true); });
  $("#btn-agregar-parametro").addEventListener("click", agregarParametro);
  $$(".pestana").forEach((b) => b.addEventListener("click", () => cambiarModo(b.dataset.modo)));
  iniciarAsistente(inicio);
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

  const pedidaM = params?.get("mision");
  if (pedidaM && E.inicio.misiones.some((m) => m.id === pedidaM)) { E.modo = "predefinida"; marcarPestana(); cargarMision(pedidaM); return; }
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
  if (!E.inicio.misiones.length) caja.append(el("p", { class: "nota" }, "No preset missions available."));
}

function marcarPestana() {
  $$(".pestana").forEach((b) => b.classList.toggle("activa", b.dataset.modo === E.modo));
  $$(".op-mision").forEach((b) => b.classList.toggle("activa", E.modo === "predefinida" && b.dataset.id === E.mision?.id));
}

// ---------------------------------------------------------------- misión
function cargarMision(id) {
  const m = E.inicio.misiones.find((x) => x.id === id);
  E.mision = structuredClone(m);
  marcarPestana();
  pintarConfig();
  calcular();
}

function cambiarModo(modo) {
  E.modo = modo;
  if (modo === "ia") {
    marcarPestana();
    if (E.mision) pintarConfig();
    $("#ia-texto").focus();
    return;
  }
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
  const pers = E.modo !== "predefinida";
  $("#lista-misiones").hidden = pers;
  $("#panel-ia").hidden = E.modo !== "ia";
  $("#sel-destino").disabled = !pers;
  $("#sel-destino").value = m.destino;
  const d = destino(m.destino);
  $("#nota-mision").textContent = `${pers ? m.nombre + ". " : ""}${d.por_que || ""}`;

  // parámetros
  const lp = $("#lista-parametros");
  lp.replaceChildren(...m.parametros.map((p, i) => filaParametro(p, i)));
  setTimeout(actualizarCuotas);
  if (!m.parametros.length) lp.append(el("p", { class: "nota" }, "Add at least one parameter."));

  // selects para agregar: parámetros = variables con distancia f; restricciones = valores del sitio
  const usadosP = new Set(m.parametros.map((p) => p.variable));
  const opcP = E.inicio.variables.filter((v) => !esValorDeSitio(v.variable) && !usadosP.has(v.variable))
    .map((v) => el("option", { value: v.variable, disabled: !disponible(v.variable) },
      `${nombre(v.variable)}${disponible(v.variable) ? "" : " (not applicable at this destination)"}`));
  $("#sel-nuevo-parametro").replaceChildren(...opcP);
  $("#btn-agregar-parametro").disabled = !opcP.some((o) => !o.disabled);
  const primeraLibre = opcP.find((o) => !o.disabled);
  if (primeraLibre) $("#sel-nuevo-parametro").value = primeraLibre.value;

  // límites
  $("#lista-limites").replaceChildren(
    ...m.limites_tierra.map((t) => el("li", {}, t)),
    ...LIMITES_SIEMPRE.map((t) => el("li", { class: "nota" }, t)));
}

// ---------------------------------------------------------------- objetivo y peso de cada parámetro
// Cada parámetro tiene un valor OBJETIVO (por defecto el del destino) y un PESO (1–100).
// El modelo de Daniel recibe los pesos normalizados (suman 1): puntuación = max_i peso_i · brecha_i,
// donde brecha_i = |valor − objetivo| / rango del parámetro en América (0 = idéntico, 1 = todo el rango).
const unidadCorta = (v) => (variable(v).unidad || "").replace(/\s*\(.*\)$/, "").replace(/^albedo$/, "");
const objetivoDestino = (v) => destino(E.mision.destino).objetivos?.[v] || null;

function cuotas() {
  const ps = paramsActivos();
  const suma = ps.reduce((a, p) => a + (p.peso || 0), 0) || 1;
  return Object.fromEntries(ps.map((p) => [p.variable, (p.peso || 0) / suma]));
}
function actualizarCuotas() {
  for (const [v, x] of Object.entries(cuotas())) {
    const n = document.getElementById(`cuota-${v}`);
    if (n) { n.textContent = `${Math.round(x * 100)} % of the total weight`; n.style.setProperty("--x", `${x * 100}%`); }
  }
}

function filaParametro(p, i) {
  const activo = disponible(p.variable);
  const v = p.variable, u = unidadCorta(v);
  const quitar = el("button", { class: "quitar", title: "Remove", "aria-label": `Remove ${nombre(v)}`, onclick: () => {
    E.mision.parametros.splice(i, 1); cambio(true); } }, "×");
  const cab = el("div", { class: "fila-cab" }, el("strong", {}, nombre(v)), el("span", { class: "unidad" }, u), quitar);
  if (!activo) {
    return el("div", { class: "fila inactiva" }, cab, el("div", { class: "texto" }, `${motivoNoDisponible(v)} Not used in the calculation.`));
  }
  const texto = p.texto ? el("div", { class: "texto" }, p.texto) : null;

  // ---- objetivo: el del destino por defecto; el usuario lo puede cambiar (se corta al rango de América)
  const od = objetivoDestino(v);
  const lo = E.G?.min[v], hi = E.G?.max[v];
  const regla = { min: "lowest in the Americas", max: "highest in the Americas", fijo: "destination value" };
  const nota = el("span", { class: "nota-objetivo" });
  const pintarNota = (recorte = "") => {
    nota.className = `nota-objetivo${recorte ? " recorte" : ""}`;
    nota.textContent = recorte || (p.objetivo == null
      ? `${destino(E.mision.destino).nombre || "Destination"}: ${regla[od?.regla] || "target"} · range ${lo != null ? `${+lo.toPrecision(3)} to ${+hi.toPrecision(3)}` : "—"}`
      : `Your target · destination: ${od ? +od.valor.toPrecision(3) : "—"} · range ${lo != null ? `${+lo.toPrecision(3)} to ${+hi.toPrecision(3)}` : "—"}`);
  };
  const obj = el("input", { type: "number", step: "any", value: +(p.objetivo ?? od?.valor ?? 0).toPrecision(4), "aria-label": `Target for ${nombre(v)}` });
  obj.addEventListener("change", () => {
    let x = parseFloat(obj.value);
    if (Number.isNaN(x)) { obj.value = +(p.objetivo ?? od?.valor ?? 0).toPrecision(4); return; }
    let recorte = "";
    if (hi != null && x > hi) { recorte = `Above the maximum in the Americas: set to ${+hi.toPrecision(4)} ${u}`; x = hi; }
    if (lo != null && x < lo) { recorte = `Below the minimum in the Americas: set to ${+lo.toPrecision(4)} ${u}`; x = lo; }
    obj.value = +x.toPrecision(4);
    p.objetivo = x;
    pintarNota(recorte);
    cambio();
  });
  const volver = el("button", { type: "button", class: "mini", title: "Back to the destination's target", onclick: () => {
    p.objetivo = null; obj.value = +(od?.valor ?? 0).toPrecision(4); pintarNota(); cambio(); } }, "↺");
  pintarNota();
  const filaObjetivo = el("div", { class: "control objetivo" }, el("span", { class: "etq-ctrl" }, "Target"), obj, volver, nota);

  // ---- peso: 1 a 100 (lo que cuenta es la proporción entre los parámetros)
  const pesoPct = Math.round((p.peso || 0) * 100) || 1;
  const num = el("input", { type: "number", min: "1", max: "100", step: "1", value: pesoPct, "aria-label": `Weight of ${nombre(v)}` });
  const rango = el("input", { type: "range", min: "1", max: "100", step: "1", value: pesoPct, "aria-label": `Weight of ${nombre(v)} (slider)` });
  const poner = (x) => { x = Math.min(100, Math.max(1, Math.round(x))); p.peso = x / 100; num.value = x; rango.value = x; cambio(); };
  rango.addEventListener("input", () => poner(+rango.value));
  num.addEventListener("change", () => { const x = parseFloat(num.value); if (x > 0) poner(x); });
  const control = el("div", { class: "control" }, el("span", { class: "etq-ctrl" }, "Weight"), rango, num);
  const cuota = el("div", { class: "cuota", id: `cuota-${v}` });
  return el("div", { class: "fila" }, cab, texto, filaObjetivo, control, cuota);
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
  E.mision.parametros.push({ variable: v, metodo: "ahp", valor: null, peso: 0.3, objetivo: null,
    unidad: "share of the weight", texto: "Added by hand: set its target and weight", fuente: "" });
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
  if (E.modo === "predefinida") { E.modo = "personalizada"; cambiarModo("personalizada"); }
}

// Cualquier cambio en la configuración recalcula (con una pequeña espera)
let espera;
function cambio(repintar = false) {
  if (repintar) pintarConfig();
  actualizarCuotas();
  clearTimeout(espera);
  espera = setTimeout(calcular, 250);
}

// ---------------------------------------------------------------- cálculo
let peticion;
async function calcular() {
  if (!E.mision) return;
  const err = $("#error");
  // Solo se mandan los parámetros que el destino tiene (los "no aplica" quedan fuera)
  // Al modelo van los pesos normalizados (suman 1), todos como peso directo ("ahp" en el modelo de Daniel)
  const c = cuotas();
  const parametros = paramsActivos().map((p) => ({ ...p, metodo: "ahp", valor: null, peso: Math.max(c[p.variable], 1e-6) }));
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
      body: JSON.stringify({ ...E.mision, parametros, restricciones: [] }), signal: peticion.signal,
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
    datos.ranking.slice(0, 5).forEach((x) => pedirNombre(x.sitio_id));
  } catch (e) {
    if (e.name === "AbortError") return;
    err.hidden = false;
    err.textContent = `Could not calculate: ${e.message}`;
  }
}

const paramsActivos = () => (E.mision?.parametros || []).filter((p) => disponible(p.variable));

// ---------------------------------------------------------------- grilla de Daniel (puntos de 1° x 1°)
// Evaluación de un punto con la configuración actual (la misma cuenta del modelo: Chebyshev ponderado)
function evaluar(k) {
  const obj = E.resultado.objetivos;
  const detalle = E.parametrosCalculo.map((p) => {
    const v = p.variable, x = E.G.val[v][k], o = obj[v].valor;
    const dif = Math.abs(x - o), f = dif / E.G.rango[v];
    return { variable: v, f, w_f: f * p.peso, dentro_tolerancia: null, valor_sitio: x, objetivo: o, diferencia: dif, peso: p.peso };
  });
  const wf = detalle.map((d) => d.w_f);
  const m = Math.max(...wf);
  return { sitio_id: E.G.ids[k], puntuacion: m, parametro_decisivo: detalle[wf.indexOf(m)].variable,
    dentro_tolerancia: null, robustez: null, detalle };
}

// Brecha = |valor − objetivo| / rango en América. Cercano ≤ 10 %, parcial ≤ 25 %, lejos > 25 %
const peorBrecha = (detalle) => Math.max(...detalle.map((d) => d.f));
const nivel = (f) => (f <= 0.1 ? "bien" : f <= 0.25 ? "medio" : "mal");
const NIVEL = { bien: "close match", medio: "partial match", mal: "far from target" };
const pctR = (f) => `${Math.round(f * 100)} %`;

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
  if (E.G?.idx.has(id)) {
    const k = E.G.idx.get(id);
    const est = R.puntos[k][1];
    if (est === 2) return { tipo: "descartado", dato: { sitio_id: id, motivo: motivoDescarte(k) } };
    const ev = evaluar(k);
    if (est === 0) return { tipo: "frente", puesto: puestoFrente(k), dato: ev, eval: ev };
    return { tipo: "dominado", dato: { sitio_id: id, dominado_por: dominador(k) }, eval: ev };
  }
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
    const b = peorBrecha(x.detalle);
    const etq = el("span", { class: `etq ${nivel(b)}`, title: "Largest gap to a target, as % of that parameter's range in the Americas" },
      `${{ bien: "close", medio: "partial", mal: "far" }[nivel(b)]} · gap ${pctR(b)}`);
    return el("li", { class: x.sitio_id === E.sel ? "sel" : "", tabindex: "0", onclick: () => seleccionar(x.sitio_id),
      onkeydown: (e) => { if (e.key === "Enter") seleccionar(x.sitio_id); } },
      el("span", { class: "puesto" }, String(i + 1).padStart(2, "0")),
      el("div", {}, el("div", { class: "nombre" }, s.nombre),
        el("div", { class: "meta" }, `${s.pais ? s.pais + " · " : ""}decided by: ${nombre(x.parametro_decisivo)} · robustness ${pct(x.robustez)} `), etq),
      el("div", { class: "punt" }, el("b", {}, fmt(x.puntuacion, 3)), el("span", { class: "meta" }, "score")));
  }));
  if (!R.ranking.length) {
    $("#ranking").append(el("p", { class: "nota" }, "No site meets the constraints."));
  }
  const nota = $("#filtro-nota");
  const partes = [];
  if (tot) partes.push(`${tot.puntos.toLocaleString("en")} grid points · ${tot.frente.toLocaleString("en")} on the Pareto front${tot.frente > R.ranking.length ? ` (top ${R.ranking.length} shown; click the map for any other)` : ""}.`);
  nota.hidden = !partes.length;
  nota.textContent = partes.join(" ");

  $("#n-dom").textContent = (tot?.dominados ?? R.dominados.length).toLocaleString("en");
  $("#dominados").replaceChildren(...R.dominados.map((d) =>
    el("li", { onclick: () => seleccionar(d.sitio_id) }, `${sitio(d.sitio_id).nombre} — beaten by ${sitio(d.dominado_por).nombre}`)));
  if ($("#n-desc")) $("#n-desc").textContent = (tot?.descartados ?? R.descartados.length).toLocaleString("en");

  pintarAvisoCalidad();
  pintarControl();
  if (conMapa) pintarMapa();
  pintarOptimo();
  pintarFicha();
}

// ---------------------------------------------------------------- ¿el resultado es bueno o solo el menos malo?
// ¿El óptimo se parece de verdad a los objetivos? Si en algún parámetro queda a más del 25 % del rango de
// América de su objetivo, ningún lugar se acerca a todo: el primero es solo el mejor compromiso.
function pintarAvisoCalidad() {
  const R = E.resultado, caja = $("#aviso-calidad");
  const top = R.ranking[0];
  if (!top) { caja.hidden = true; return; }
  const partes = [];
  const lejos = top.detalle.filter((d) => d.f > 0.25).sort((a, b) => b.f - a.f);
  if (lejos.length) {
    const u = (v) => unidadCorta(v);
    partes.push(el("span", {}, el("b", {}, "No place in the Americas gets close to every target. "),
      "The optimal site is only the ", el("b", {}, "best compromise"), ": it is still far in ",
      lejos.map((d) => `${nombre(d.variable)} (${+d.valor_sitio.toPrecision(3)} vs target ${+d.objetivo.toPrecision(3)} ${u(d.variable)}, a gap of ${pctR(d.f)} of the range)`).join(" and "),
      ". Lower the weight of what matters less, change the target, or accept that Earth cannot reproduce it."));
  }
  if (top.robustez < 0.3) {
    partes.push(el("span", {}, el("b", {}, "Fragile first place: "),
      `it stays first in only ${pct(top.robustez)} of runs with slightly different weights. Look at the next places too.`));
  }
  caja.hidden = !partes.length;
  caja.className = "aviso-calidad";
  caja.replaceChildren(...partes.flatMap((x, i) => (i ? [el("br"), el("br"), x] : [x])));
}

// Control positivo (AGENTS.md §4): ¿dónde quedan los análogos que ya se usan, con esta configuración?
function conocidosDelDestino() {
  const cuerpo = destino(E.mision.destino).cuerpo;
  return (E.inicio.analogos_conocidos || []).filter((a) => a.destino_sugerido === cuerpo || a.destino_sugerido === "ambos");
}

function puestoGlobal(k) {
  const P = E.resultado.puntos, s = P[k][0];
  if (s == null) return null;
  let n = 1, total = 0;
  for (const [x] of P) { if (x == null) continue; total++; if (x < s) n++; }
  return { n, total, frac: n / total };
}

function pintarControl() {
  const lista = conocidosDelDestino();
  const veredicto = $("#control-veredicto");
  const filas = lista.map((a) => {
    const k = a.celda != null ? E.G.idx.get(a.celda) : undefined;
    if (k === undefined) {
      return { a, html: el("li", {}, el("span", {}, el("b", {}, a.nombre)), el("span", { class: "pos nd" }, "no data"),
        el("small", {}, "Its 1° square has no measurements for every parameter yet, so it cannot be ranked.")) };
    }
    const g = puestoGlobal(k);
    const [s, est] = E.resultado.puntos[k];
    const clase = g.frac <= 0.1 ? "bien" : g.frac <= 0.33 ? "medio" : "mal";
    const estado = est === 0 ? `Pareto front #${puestoFrente(k)}` : est === 2 ? "ruled out by a constraint" : "dominated";
    return { a, g, html: el("li", { class: "clic", tabindex: "0", onclick: () => seleccionar(a.celda), onkeydown: (e) => { if (e.key === "Enter") seleccionar(a.celda); } },
      el("span", {}, el("b", {}, a.nombre)), el("span", { class: `pos ${clase}` }, `#${g.n.toLocaleString("en")}`),
      el("small", {}, `Top ${Math.max(1, Math.round(g.frac * 100))} % of ${g.total.toLocaleString("en")} · score ${fmt(s, 3)} · ${estado}`),
      a.por_que ? el("small", { class: "uso" }, `Used for: ${a.por_que}`) : null) };
  });
  $("#control-positivo").replaceChildren(...filas.map((f) => f.html));
  const evaluables = filas.filter((f) => f.g);
  veredicto.className = "control-veredicto";
  if (!lista.length) veredicto.textContent = "No known analogs listed for this destination.";
  else if (!evaluables.length) { veredicto.classList.add("mal"); veredicto.textContent = `Cannot check: none of the ${lista.length} known analogs for this destination is in the grid yet.`; }
  else {
    const mejor = Math.min(...evaluables.map((f) => f.g.frac));
    if (mejor <= 0.1) { veredicto.classList.add("bien"); veredicto.textContent = `Consistent: at least one known analog is in the top ${Math.max(1, Math.round(mejor * 100))} % with these settings.`; }
    else { veredicto.classList.add("mal"); veredicto.textContent = `Warning: the known analogs rank low with these settings (best: top ${Math.round(mejor * 100)} %). This matters if they were chosen for what this mission tests (see "Used for"): then the settings may not describe the mission well, or the data misses what makes them good analogs.`; }
    if (evaluables.length < lista.length) veredicto.textContent += ` ${lista.length - evaluables.length} of ${lista.length} have no data in the grid.`;
  }
}

// Lugar óptimo (salida del modelo de Daniel): recuadro sobre el mapa, y el mapa vuela y hace zoom cuando cambia
function pintarOptimo() {
  if (!E.mapa) return;
  const o = E.resultado.optimo;
  const caja = $("#optimo");
  caja.hidden = !o || o.lat == null;
  if (caja.hidden) return;
  const s = sitio(o.sitio_id);
  caja.replaceChildren(...[
    el("span", { class: "optimo-etq" }, "Optimal site"),
    (E.resultado.ranking[0] && peorBrecha(E.resultado.ranking[0].detalle) > 0.25) ? el("span", { class: "etq-menos-malo", title: "No place gets close to every target" }, "best compromise") : null,
    el("b", {}, s.nombre || o.sitio_id),
    el("span", { class: "optimo-coords" }, `${s.pais && s.rejilla ? s.pais + " · " : ""}${coordenadas(o.lat, o.lon)}`),
    el("button", { class: "btn chico", type: "button", onclick: () => seleccionar(o.sitio_id, 7) }, "Center ", el("i", { class: "flecha" })),
  ].filter(Boolean));
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
  pintarRejilla();
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
    else c.setStyle({ fillColor: colorCelda(t),
      fillOpacity: est === 0 ? 0.85 - 0.45 * t : 0.6 - 0.5 * t, weight: sel ? 2 : 0, color: "#fff" });
  });
  R.ranking.slice(0, 10).forEach((x, i) => marcador(sitio(x.sitio_id), { tipo: "frente", puesto: i + 1 }));
  for (const a of conocidosDelDestino()) {
    L.marker([a.lat, a.lon], { icon: L.divIcon({ className: "", iconSize: [12, 12], html: '<div class="marcador-conocido"></div>' }),
      title: `${a.nombre} (known analog)`, zIndexOffset: 500 })
      .on("click", () => (a.celda ? seleccionar(a.celda) : null)).addTo(E.capa);
  }
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
      const d = destino(E.mision.destino);
      E._lugarEspera = setTimeout(() => investigarLugar(nodo, { lat: s.lat, lon: s.lon,
        destino: d.nombre ? { nombre: d.nombre, cuerpo: d.cuerpo } : null, mision: E.mision.nombre, evaluacion: ev }),
      mismoSitio ? 900 : 100);
    }
  }
  return [el("h3", {}, "About this place"), E._lugarNodo];
}

const REGLA = { min: "lowest_on_earth", max: "highest_on_earth", fijo: "fixed_value", usuario: "set_by_user" };
const redondo = (x) => (x == null ? null : +(+x).toPrecision(3));

// Lo que la IA necesita para explicar el ranking: valores del punto, objetivos, brechas y pesos
function paraIA(st) {
  const ev = st.eval, R = E.resultado, obj = R.objetivos || {};
  const c = cuotas();
  const top = R.ranking[0];
  return {
    status: { frente: "on the Pareto front", dominado: "dominated: another point is equal or better in every parameter" }[st.tipo],
    rank: st.puesto ? `${st.puesto} of ${R.totales?.frente ?? R.ranking.length} on the Pareto front` : null,
    is_optimal_site: ev.sitio_id === R.optimo?.sitio_id,
    best_place_far_from_some_target: top ? peorBrecha(top.detalle) > 0.25 : false,
    score: redondo(ev.puntuacion),
    score_meaning: "largest weighted gap among the parameters (lower = better)",
    decisive_parameter: nombre(ev.parametro_decisivo),
    robustness: ev.robustez == null ? null : `ranked first in ${Math.round(ev.robustez * 100)}% of runs with slightly changed weights`,
    parameters: ev.detalle.map((d) => ({
      name: nombre(d.variable), unit: unidadCorta(d.variable),
      value_here: redondo(d.valor_sitio), target: redondo(d.objetivo),
      target_rule: REGLA[obj[d.variable]?.regla] || null, difference: redondo(d.diferencia),
      gap_percent_of_range: Math.round(d.f * 100), match: NIVEL[nivel(d.f)],
      weight_share_percent: Math.round((c[d.variable] ?? 0) * 100),
    })),
  };
}

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
  const regla = { min: "lowest on Earth", max: "highest on Earth", usuario: "set by you" };
  const n = (x) => (x == null ? "—" : String(+(+x).toPrecision(3)));
  const c = cuotas();
  return el("div", { class: "tabla-scroll" }, el("table", { class: "tabla-analogo" },
    el("thead", {}, el("tr", {}, ...["Parameter", "Here", "Target", "Gap", "Weight"].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...ev.detalle.map((d) => el("tr", {},
      el("td", {}, nombre(d.variable), el("small", {}, unidadCorta(d.variable))),
      el("td", { class: "num-t" }, n(d.valor_sitio)),
      el("td", { class: "num-t", title: obj[d.variable]?.por_que || "" }, n(d.objetivo), regla[obj[d.variable]?.regla] ? el("small", {}, regla[obj[d.variable].regla] + (obj[d.variable].recortado ? " (clipped)" : "")) : null),
      el("td", { class: "num-t", title: `Difference ${n(d.diferencia)} ${unidadCorta(d.variable)} = ${pctR(d.f)} of the range in the Americas` },
        el("span", { class: `etq ${nivel(d.f)}` }, pctR(d.f)), el("small", {}, `±${n(d.diferencia)}`)),
      el("td", { class: "num-t" }, `${Math.round((c[d.variable] ?? 0) * 100)} %`))))));
}

function pintarFicha() {
  const caja = $("#ficha");
  const f = { replaceChildren: (...xs) => caja.replaceChildren(...xs.flat(Infinity).filter((x) => x !== null && x !== undefined)) };
  const titulo = el("div", { class: "paso" }, el("span", {}, "4"), el("h2", {}, "Site profile"));
  if (!E.sel) { f.replaceChildren(titulo, el("p", { class: "nota" }, "Pick a site.")); return; }
  const s = sitio(E.sel);
  const st = estadoDe(E.sel);
  const cab = el("div", { class: "ficha-cab" }, el("h2", {}, s.nombre),
    el("span", { class: "pais" }, `${s.pais ? s.pais + " · " : ""}${coordenadas(s.lat, s.lon)}`));
  const hipotesis = s.por_que ? el("p", { class: "nota" }, `Hypothesis: ${s.por_que}`) : null;
  const fuente = s.rejilla
    ? el("p", { class: "nota" }, "Source: measured grid of the Americas (1° × 1°, 5 surface parameters). Destination targets: see More data.")
    : el("p", { class: "nota" }, `Source: ${s.fuente || "—"}`);
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
      hipotesis, st.eval ? [el("h3", {}, "Compared with the targets"), tablaAnalogo(st.eval)] : null,
      sobreElLugar(s, st), mapasMedidos(s), fuente);
    return;
  }

  const x = st.dato;
  const cifras = el("div", { class: "cifras" },
    el("div", { class: "cifra" }, el("b", {}, `#${st.puesto}`), el("span", {}, "rank")),
    el("div", { class: "cifra" }, el("b", {}, fmt(x.puntuacion, 3)), el("span", {}, "score (lower = better)")),
    el("div", { class: "cifra" }, el("b", {}, x.robustez == null ? "—" : pct(x.robustez)), el("span", {}, "robustness (times 1st)")));

  const escala = Math.max(...x.detalle.map((d) => d.w_f)) || 1;
  const barras = x.detalle.map((d) => {
    const color = { bien: "var(--bien)", medio: "#f5c451", mal: "var(--mal)" }[nivel(d.f)];
    return el("div", { class: "barra-param" },
      el("div", { class: "rotulo" }, el("span", {}, nombre(d.variable)),
        el("span", { class: "meta" }, `gap ${pctR(d.f)} × weight ${Math.round((cuotas()[d.variable] ?? 0) * 100)} % = ${fmt(d.w_f, 3)}`)),
      el("div", { class: "pista" },
        el("i", { style: `width:${(d.w_f / escala) * 100}%;background:${color}` })));
  });

  const fuera = E.mision.parametros.filter((p) => !disponible(p.variable));
  const comparacion = x.detalle[0]?.valor_sitio !== undefined
    ? [el("h3", {}, "Compared with the targets"), el("p", { class: "ayuda" }, "Gap = how far this place is from the target, as % of that parameter's range in the Americas (green ≤ 10 %, yellow ≤ 25 %, red > 25 %). When the Moon or Mars is beyond anything on Earth, the destination's target is the most extreme value on the continent."), tablaAnalogo(x)]
    : null;
  f.replaceChildren(titulo, cab, hipotesis, cifras, comparacion, sobreElLugar(s, st),
    el("h3", {}, "Weighted gap per parameter"),
    el("p", { class: "ayuda" }, "Gap × weight. The longest bar sets the score: it is what keeps this place from being a better match."),
    ...barras,
    mapasMedidos(s),
    fuera.length ? el("p", { class: "nota" }, `Not compared at this destination: ${fuera.map((p) => nombre(p.variable)).join(", ")}.`) : null,
    ...limites, fuente);
}

// ---------------------------------------------------------------- asistente de IA (AGENTS.md §7)
// El usuario describe su misión; la IA la TRADUCE a parámetros (objetivo y peso) (cada uno con
// su razón), el servidor la valida y aquí se carga como configuración editable. El sitio lo escoge el modelo.
const EJEMPLOS = [
  ["Rover cameras at the lunar pole", "We want to test the navigation cameras and batteries of a lunar rover: bright ground like regolith and big day–night temperature swings, as near the lunar south pole."],
  ["Dust on Mars solar panels", "Our team built a small Mars rover and we need to see how dust covers its solar panels in very dry and windy places."],
  ["Cold-weather Mars habitat", "We will test the insulation and heaters of an inflatable Mars habitat module; the coldest, driest place with strong daily temperature cycles."],
];

function iniciarAsistente(inicio) {
  $("#ia-destino").append(...inicio.destinos.map((d) => el("option", { value: d.id }, `${d.nombre} (${{ luna: "Moon", marte: "Mars" }[d.cuerpo] || d.cuerpo})`)));
  $("#ia-ejemplos").replaceChildren(...EJEMPLOS.map(([t, texto]) =>
    el("button", { type: "button", onclick: () => { $("#ia-texto").value = texto; $("#ia-texto").focus(); } }, t)));
  $("#ia-traducir").addEventListener("click", traducirIA);
  $("#ia-texto").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) traducirIA(); });
  if (!inicio.ia?.activa) {
    $("#ia-traducir").disabled = true;
    $("#ia-resultado").replaceChildren(el("p", { class: "nota" }, "The AI is not configured on this server, so the assistant is off. Use Preset or Custom."));
  }
}

async function traducirIA() {
  const texto = $("#ia-texto").value.trim();
  const caja = $("#ia-resultado");
  if (texto.length < 10) { caja.replaceChildren(el("p", { class: "error" }, "Describe the mission in at least a sentence.")); return; }
  const btn = $("#ia-traducir");
  btn.disabled = true;
  caja.replaceChildren(el("div", { class: "cargando" }, el("i"), el("i"), el("i"), el("span", {}, "The AI is reading your mission…")));
  try {
    const r = await fetch("/api/ia/mision", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto, destino: $("#ia-destino").value || null }) });
    const datos = await r.json();
    if (!r.ok) throw new Error(Array.isArray(datos.detail) ? datos.detail.map((d) => d.msg).join("; ") : datos.detail);
    E.mision = datos.mision;
    E.sel = null;
    pintarConfig();
    calcular();
    const d = destino(datos.mision.destino);
    caja.replaceChildren(...[
      el("h4", {}, "How the AI read your mission"),
      el("p", {}, el("b", {}, datos.mision.nombre), ` → ${d.nombre || datos.mision.destino}. ${datos.resumen || ""}`),
      el("p", { class: "nota" }, `Settings loaded below: ${datos.mision.parametros.map((p) => `${nombre(p.variable)} (weight ${Math.round(p.peso * 100)}${p.objetivo != null ? `, target ${+p.objetivo.toPrecision(3)}` : ""})`).join(", ")}. Review and edit them: the ranking updates by itself.`),
      datos.no_disponible.length ? [el("h4", {}, "Needed but not in the app's data"),
        el("ul", {}, ...datos.no_disponible.map((x) => el("li", {}, el("b", {}, x.need), x.reason ? ` — ${x.reason}` : "")))] : null,
      datos.avisos.length ? el("ul", { class: "aviso-ia" }, ...datos.avisos.map((t) => el("li", {}, `Checked by the app: ${t}`))) : null,
      el("p", { class: "nota" }, "AI suggestion: the settings are a starting point, not a verified requirement."),
    ].flat().filter(Boolean));
  } catch (e) {
    caja.replaceChildren(el("p", { class: "error" }, `Could not translate the mission: ${e.message}`));
  } finally {
    btn.disabled = false;
  }
}
