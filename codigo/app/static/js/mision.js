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
};

const ESTADO = { borrador: "draft", verificado: "verified" };

// Sitio del catálogo; si el modelo devolvió un punto que no está en sitios.csv (p. ej. una celda de grilla),
// se arma con la lat/lon/nombre que trae el propio ranking.
function sitio(id) {
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
  const parametros = E.mision.parametros.filter((p) => disponible(p.variable));
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
    if (!E.sel || !estadoDe(E.sel)) E.sel = datos.ranking[0]?.sitio_id ?? null;
    pintarResultado();
  } catch (e) {
    if (e.name === "AbortError") return;
    err.hidden = false;
    err.textContent = `Could not calculate: ${e.message}`;
  }
}

function estadoDe(id) {
  const R = E.resultado;
  const i = R.ranking.findIndex((x) => x.sitio_id === id);
  if (i >= 0) return { tipo: "frente", puesto: i + 1, dato: R.ranking[i] };
  const d = R.dominados.find((x) => x.sitio_id === id);
  if (d) return { tipo: "dominado", dato: d };
  const x = R.descartados.find((x) => x.sitio_id === id);
  if (x) return { tipo: "descartado", dato: x };
  return null;
}

function seleccionar(id) {
  E.sel = id;
  pintarResultado();
  volarA(sitio(id), 5);
}

function pintarResultado() {
  const R = E.resultado;
  $("#ranking").replaceChildren(...R.ranking.map((x, i) => {
    const s = sitio(x.sitio_id);
    const etq = x.dentro_tolerancia === null ? null :
      el("span", { class: `etq ${x.dentro_tolerancia ? "bien" : "mal"}` },
        x.dentro_tolerancia ? "within tolerance" : "outside tolerance");
    return el("li", { class: x.sitio_id === E.sel ? "sel" : "", tabindex: "0", onclick: () => seleccionar(x.sitio_id),
      onkeydown: (e) => { if (e.key === "Enter") seleccionar(x.sitio_id); } },
      el("span", { class: "puesto" }, String(i + 1).padStart(2, "0")),
      el("div", {}, el("div", { class: "nombre" }, s.nombre),
        el("div", { class: "meta" }, `${s.pais || ""} · decided by: ${nombre(x.parametro_decisivo)} · robustness ${pct(x.robustez)} `), etq),
      el("div", { class: "punt" }, el("b", {}, fmt(x.puntuacion)), el("span", { class: "meta" }, "score")));
  }));
  if (!R.ranking.length) {
    $("#ranking").append(el("p", { class: "nota" }, "No site meets the constraints."));
  }
  $("#n-dom").textContent = R.dominados.length;
  $("#dominados").replaceChildren(...R.dominados.map((d) =>
    el("li", { onclick: () => seleccionar(d.sitio_id) }, `${sitio(d.sitio_id).nombre} — beaten by ${sitio(d.dominado_por).nombre}`)));
  $("#n-desc").textContent = R.descartados.length;
  $("#descartados").replaceChildren(...R.descartados.map((d) =>
    el("li", { onclick: () => seleccionar(d.sitio_id) }, `${sitio(d.sitio_id).nombre} — ${d.motivo}`)));

  pintarMapa();
  pintarOptimo();
  pintarFicha();
}

// Lugar óptimo (salida del modelo de Daniel): recuadro sobre el mapa y vuelo hasta él cuando cambia
function pintarOptimo() {
  if (!E.mapa) return;
  const o = E.resultado.optimo;
  const caja = $("#optimo");
  caja.hidden = !o || o.lat == null;
  if (caja.hidden) return;
  caja.replaceChildren(
    el("span", { class: "optimo-etq" }, "Optimal site"),
    el("b", {}, o.nombre || o.sitio_id),
    el("span", { class: "optimo-coords" }, coordenadas(o.lat, o.lon)),
    el("button", { class: "btn chico", type: "button", onclick: () => { seleccionar(o.sitio_id); volarA(o, 7); } }, "Center ", el("i", { class: "flecha" })));
  const clave = `${o.lat},${o.lon}`;
  if (clave !== E._ultimoOptimo && E.mapa.getSize().x > 0) {
    E._ultimoOptimo = clave;
    volarA(o, 4);
  }
}

function volarA(p, zoom) {
  if (p?.lat == null) return;
  E.mapa.flyTo([p.lat, p.lon], Math.max(E.mapa.getZoom(), zoom), { duration: 1.6 });
}

function pintarMapa() {
  if (!E.mapa) return;
  E.capa.clearLayers();
  const puntos = [];
  const ids = new Set(E.inicio.sitios.map((s) => s.id));
  const extra = E.resultado.ranking.filter((x) => !ids.has(x.sitio_id)).map((x) => sitio(x.sitio_id));
  for (const s of [...E.inicio.sitios, ...extra]) {
    if (s.lat == null || s.lon == null) continue;
    const st = estadoDe(s.id);
    if (!st) continue;
    let clase = st.tipo, texto = "", tam = 16;
    if (st.tipo === "frente") { texto = st.puesto; tam = 26; if (st.puesto === 1) { clase += " primero"; tam = 30; } }
    if (s.id === E.sel) tam += 6;
    const icono = L.divIcon({ className: "", iconSize: [tam, tam],
      html: `<div class="marcador ${clase}" style="width:${tam}px;height:${tam}px">${texto}</div>` });
    L.marker([s.lat, s.lon], { icon: icono, title: s.nombre, zIndexOffset: st.tipo === "frente" ? 1000 - (st.puesto || 0) : 0 })
      .on("click", () => seleccionar(s.id)).addTo(E.capa);
    puntos.push([s.lat, s.lon]);
  }
}

// "Sobre este lugar": se investiga una vez por sitio y misión; al mover los pesos se reutiliza (no se vuelve a consultar)
function sobreElLugar(s) {
  const k = `${s.id}|${E.mision.id}|${E.mision.destino}`;
  if (E._lugarClave !== k) {
    E._lugarClave = k;
    E._lugarNodo = el("div");
    if (s.lat != null) {
      const atr = E.inicio.atributos.find((a) => a.sitio_id === s.id) || {};
      const d = destino(E.mision.destino);
      investigarLugar(E._lugarNodo, { lat: s.lat, lon: s.lon,
        sitio: E.inicio.sitios.some((x) => x.id === s.id) ? { ...s, ...atr } : null,
        destino: d.nombre ? { nombre: d.nombre, cuerpo: d.cuerpo } : null, mision: E.mision.nombre });
    } else {
      E._lugarNodo.append(el("p", { class: "nota" }, "This point has no coordinates."));
    }
  }
  return [el("h3", {}, "About this place"), E._lugarNodo];
}

function pintarFicha() {
  const caja = $("#ficha");
  const f = { replaceChildren: (...xs) => caja.replaceChildren(...xs.flat().filter((x) => x !== null && x !== undefined)) };
  const titulo = el("div", { class: "paso" }, el("span", {}, "5"), el("h2", {}, "Site profile"));
  if (!E.sel) { f.replaceChildren(titulo, el("p", { class: "nota" }, "Pick a site.")); return; }
  const s = sitio(E.sel);
  const st = estadoDe(E.sel);
  const cab = el("div", { class: "ficha-cab" }, el("h2", {}, s.nombre),
    el("span", { class: "pais" }, `${s.pais || ""} · ${coordenadas(s.lat, s.lon)}`));
  const hipotesis = s.por_que ? el("p", { class: "nota" }, `Hypothesis: ${s.por_que}`) : null;
  const fuente = el("p", { class: "nota" }, `Source: ${s.fuente || "—"} · status: ${ESTADO[s.estado] || s.estado || "—"}`);
  const limites = [el("h3", {}, "What Earth cannot reproduce"),
    el("ul", {}, ...E.mision.limites_tierra.map((t) => el("li", {}, t)), ...LIMITES_SIEMPRE.map((t) => el("li", {}, t)))];

  if (!st) { f.replaceChildren(titulo, cab, el("p", { class: "nota" }, "No result for this site."), hipotesis, fuente); return; }
  if (st.tipo === "descartado") {
    f.replaceChildren(titulo, cab, el("p", { class: "error" }, `Ruled out: ${st.dato.motivo}`), hipotesis, sobreElLugar(s), fuente);
    return;
  }
  if (st.tipo === "dominado") {
    f.replaceChildren(titulo, cab, el("p", {}, `Dominated by ${sitio(st.dato.dominado_por).nombre}: that site is equal or better in every mission parameter and better in at least one. That is why it is not recommended.`), hipotesis, sobreElLugar(s), fuente);
    return;
  }

  const x = st.dato;
  const cifras = el("div", { class: "cifras" },
    el("div", { class: "cifra" }, el("b", {}, `#${st.puesto}`), el("span", {}, "rank")),
    el("div", { class: "cifra" }, el("b", {}, fmt(x.puntuacion)), el("span", {}, "score (≤ 1 = within)")),
    el("div", { class: "cifra" }, el("b", {}, pct(x.robustez)), el("span", {}, "robustness (times 1st)")));

  const escala = Math.max(2, ...x.detalle.map((d) => d.w_f));
  const barras = x.detalle.map((d) => {
    const p = E.mision.parametros.find((q) => q.variable === d.variable) || {};
    const color = d.dentro_tolerancia === false ? "var(--mal)" : d.dentro_tolerancia ? "var(--bien)" : "var(--cian)";
    return el("div", { class: "barra-param" },
      el("div", { class: "rotulo" }, el("span", {}, nombre(d.variable)),
        el("span", { class: "meta" }, `f = ${fmt(d.f)} ${p.unidad || ""} · w·f = ${fmt(d.w_f)}`)),
      el("div", { class: "pista" },
        el("i", { style: `width:${(d.w_f / escala) * 100}%;background:${color}` }),
        el("span", { class: "marca-1", style: `left:${(1 / escala) * 100}%` })));
  });

  const si = x.detalle.filter((d) => d.dentro_tolerancia === true);
  const no = x.detalle.filter((d) => d.dentro_tolerancia === false);
  const tol = (v) => (E.mision.parametros.find((q) => q.variable === v) || {}).valor;
  const fuera = E.mision.parametros.filter((p) => !disponible(p.variable));
  f.replaceChildren(titulo, cab, hipotesis, cifras, sobreElLugar(s),
    el("h3", {}, "Weighted difference per parameter"),
    el("p", { class: "ayuda" }, "The white line marks 1: to its left, within tolerance."),
    ...barras,
    el("h3", {}, "Where it matches"),
    si.length ? el("ul", {}, ...si.map((d) => el("li", {}, `${nombre(d.variable)}: difference ${fmt(d.f)}, tolerance ${fmt(tol(d.variable))}`)))
      : el("p", { class: "nota" }, "It is not within tolerance in any parameter."),
    el("h3", {}, "Where it falls short"),
    no.length ? el("ul", {}, ...no.map((d) => el("li", {}, `${nombre(d.variable)}: difference ${fmt(d.f)}, ${fmt(d.w_f, 1)} times the tolerance`)))
      : el("p", { class: "nota" }, "It is within tolerance in every parameter."),
    fuera.length ? el("p", { class: "nota" }, `Not compared at this destination: ${fuera.map((p) => nombre(p.variable)).join(", ")}.`) : null,
    ...limites, fuente);
}
