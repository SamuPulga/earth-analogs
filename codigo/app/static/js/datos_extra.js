// Apartado 5 · Datos extra: tabla de parámetros, valores de los sitios, estado de los datos
// y el gráfico del ejemplo de Pareto (AGENTS.md §5.4).

import { $, el, fmt, nombre } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, texto) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto != null) n.textContent = texto;
  return n;
}

export function iniciarDatosExtra(inicio) {
  tablaVariables(inicio);
  tablaAtributos(inicio);
  estado(inicio);
  graficoPareto();
}

function tablaVariables(inicio) {
  const params = inicio.variables.filter((v) => !/^(valor del sitio|restricción|site value)/i.test(v.metrica || ""));
  const celda = (t) => el("td", { class: /^(no aplica|not applicable)/i.test(t || "") ? "no-aplica" : "" }, t || "—");
  $("#tabla-variables").replaceChildren(
    el("thead", {}, el("tr", {}, ...["Parameter", "Unit", "Earth", "Moon", "Mars", "How it is compared", "Status"].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...params.map((v) => el("tr", {},
      el("td", {}, nombre(v.variable)), el("td", {}, v.unidad || "—"), celda(v.tierra), celda(v.luna), celda(v.marte),
      el("td", {}, v.metrica || "—"), el("td", {}, { "en proceso": "in progress", disponible: "available", "no disponible": "not available" }[v.estado] || v.estado || "—")))));
}

function tablaAtributos(inicio) {
  const cols = inicio.restricciones_disponibles || [];
  const unidad = (c) => (inicio.variables.find((v) => v.variable === c) || {}).unidad || "";
  const nom = (id) => (inicio.sitios.find((s) => s.id === id) || {}).nombre || id;
  $("#tabla-atributos").replaceChildren(
    el("thead", {}, el("tr", {}, el("th", {}, "Sitio"), ...cols.map((c) => el("th", { class: "num-t" }, `${nombre(c)}${unidad(c) ? ` (${unidad(c)})` : ""}`)))),
    el("tbody", {}, ...inicio.atributos.map((a) => el("tr", {}, el("td", {}, nom(a.sitio_id)),
      ...cols.map((c) => el("td", { class: "num-t" }, a[c] == null ? "—" : String(+fmt(a[c], 2))))))));
}

function estado(inicio) {
  const nombres = { sitios: "Sites (sitios.csv)", destinos: "Destinations (destinos.csv)", variables: "Variables (variables.csv)",
    misiones: "Missions (misiones.csv)", atributos: "Site values (atributos_sitios.csv)" };
  const filas = Object.entries(inicio.fuentes).map(([k, f]) =>
    el("li", {}, el("span", {}, nombres[k] || k),
      el("span", { class: `etq ${f === "real" ? "bien" : "mal"}` }, f === "real" ? "real" : "test data")));
  filas.push(el("li", {}, el("span", {}, "Mathematical model"),
    el("span", { class: `etq ${inicio.modelo.startsWith("oficial") ? "bien" : "mal"}` }, inicio.modelo.startsWith("oficial") ? "final" : "provisional")));
  $("#estado-datos").replaceChildren(...filas);
}

// Ejemplo A–E: la suma ponderada nunca escoge C; Chebyshev con pesos iguales sí.
function graficoPareto() {
  const g = $("#grafico-pareto");
  const P = [["A", 1, 8], ["B", 2, 5], ["C", 4.2, 4.2], ["D", 5, 2], ["E", 8, 1]];
  const x0 = 46, y0 = 262, ancho = 290, alto = 236, max = 9;
  const X = (v) => x0 + (v / max) * ancho, Y = (v) => y0 - (v / max) * alto;
  const gris = "rgba(255,255,255,.14)";
  for (let i = 0; i <= max; i += 3) {
    g.append(svg("line", { x1: X(i), x2: X(i), y1: y0, y2: y0 - alto, stroke: gris, "stroke-width": 1 }));
    g.append(svg("line", { x1: x0, x2: x0 + ancho, y1: Y(i), y2: Y(i), stroke: gris, "stroke-width": 1 }));
    g.append(svg("text", { x: X(i), y: y0 + 16, fill: "#9ba3b4", "font-size": 11, "text-anchor": "middle" }, i));
    g.append(svg("text", { x: x0 - 10, y: Y(i) + 4, fill: "#9ba3b4", "font-size": 11, "text-anchor": "end" }, i));
  }
  g.append(svg("text", { x: x0 + ancho, y: y0 + 34, fill: "#9ba3b4", "font-size": 11, "text-anchor": "end" }, "f₁ (difference in parameter 1)"));
  g.append(svg("text", { x: 12, y: y0 - alto - 10, fill: "#9ba3b4", "font-size": 11 }, "f₂"));
  // cuadrado de Chebyshev con pesos iguales alrededor de C (todo lo que está dentro tiene max(f₁, f₂) ≤ 4,2)
  g.append(svg("rect", { x: X(0), y: Y(4.2), width: X(4.2) - X(0), height: Y(0) - Y(4.2), fill: "rgba(92,200,255,.06)", stroke: "#5cc8ff", "stroke-dasharray": "4 4", "stroke-width": 1 }));
  // frente
  g.append(svg("polyline", { points: P.map(([, a, b]) => `${X(a)},${Y(b)}`).join(" "), fill: "none", stroke: "rgba(47,123,255,.6)", "stroke-width": 1.5 }));
  for (const [n, a, b] of P) {
    const esC = n === "C";
    g.append(svg("circle", { cx: X(a), cy: Y(b), r: esC ? 7 : 5, fill: esC ? "#fff" : "#2f7bff", stroke: esC ? "#2f7bff" : "none", "stroke-width": 2 }));
    g.append(svg("text", { x: X(a) + 10, y: Y(b) - 8, fill: "#f3f4f6", "font-size": 13, "font-weight": 600 }, `${n} (${a}, ${b})`));
  }
  g.append(svg("text", { x: X(0.3), y: Y(0.4), fill: "#5cc8ff", "font-size": 11 }, "Chebyshev: max ≤ 4.2"));
}
