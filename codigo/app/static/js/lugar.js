// "Sobre este lugar": investiga un punto por su latitud y longitud y lo muestra en dos tiempos.
//   1. GET  /api/lugar          → nombre, región, país, elevación y Wikipedia (rápido, sin IA)
//   2. POST /api/lugar/resumen  → ficha breve escrita por la IA, que va apareciendo mientras se escribe
// Lo que el equipo ya sabe del sitio (sitios.csv) se muestra de inmediato, antes de las dos consultas.

import { el, coordenadas } from "./util.js";

let IA = { activa: false };
export function configurarIA(estado) { IA = estado || IA; }

// Markdown mínimo y seguro: primero se escapa todo, luego **negrita**, _cursiva_ y párrafos
function markdown(texto) {
  const seguro = texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return seguro
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:])/g, "$1<em>$2</em>")
    .split(/\n{2,}/).map(bloque).join("");
}

// Un bloque de texto: párrafo, o lista si sus líneas empiezan con "- " / "* " / "1. "
function bloque(p) {
  const lineas = p.split("\n");
  const lista = (re, tag) => {
    const items = [];
    let antes = "";
    for (const l of lineas) {
      if (re.test(l.trim())) items.push(l.trim().replace(re, ""));
      else if (items.length) items[items.length - 1] += " " + l.trim();
      else antes += (antes ? "<br>" : "") + l;
    }
    return items.length ? `${antes ? `<p>${antes}</p>` : ""}<${tag}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>` : null;
  };
  return lista(/^[-*•]\s+/, "ul") || lista(/^\d+[.)]\s+/, "ol") || `<p>${p.replace(/\n/g, "<br>")}</p>`;
}

const cargando = (texto) => el("div", { class: "cargando" }, el("i"), el("i"), el("i"), el("span", {}, texto));

/**
 * Pinta la información del punto en `caja` (un elemento vacío).
 * @param {{lat:number, lon:number, sitio?:object, destino?:object, mision?:string, evaluacion?:object}} punto
 * `evaluacion`: cómo quedó el punto con los pesos de la misión; la IA la usa para explicar por qué es análogo.
 * Devuelve una función para cancelar las consultas si el usuario cambia de sitio.
 */
export function investigarLugar(caja, { lat, lon, sitio = null, destino = null, mision = null, evaluacion = null, medidas = null }) {
  caja.__cancelar?.();
  const ctrl = new AbortController();
  caja.__cancelar = () => ctrl.abort();
  caja.classList.add("lugar");

  const cab = el("div", { class: "lugar-cab" },
    el("span", { class: "lugar-coords" }, coordenadas(lat, lon)),
    el("span", { class: `lugar-ia ${IA.activa ? "on" : ""}` }, IA.activa ? `AI · ${IA.modelo}` : "No AI · automatic summary"));
  const zonaLugar = el("div", { class: "lugar-donde" }, cargando("Looking up the place…"));
  const zonaWiki = el("div", { class: "lugar-wiki" });
  const zonaIA = el("div", { class: "lugar-resumen" });
  const pie = el("p", { class: "lugar-fuentes" });
  caja.replaceChildren(cab, zonaLugar, zonaIA, zonaWiki, pie);

  (async () => {
    // ---- paso 1: hechos
    let h;
    try {
      const r = await fetch(`/api/lugar?lat=${lat}&lon=${lon}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      h = await r.json();
    } catch (e) {
      if (e.name === "AbortError") return;
      zonaLugar.replaceChildren(el("p", { class: "nota" }, `Could not look up the place (${e.message}). Is there an internet connection?`));
      return;
    }
    const l = h.lugar || {};
    const c = h.clima;
    const dato = (t, v) => (v == null || v === "" ? null : el("div", {}, el("dt", {}, t), el("dd", {}, v)));
    zonaLugar.replaceChildren(
      el("b", { class: "lugar-nombre" }, l.nombre || "Unnamed point"),
      el("span", { class: "lugar-region" }, [l.condado !== l.nombre ? l.condado : "", l.region, l.pais].filter(Boolean).join(" · ")),
      el("dl", { class: "lugar-datos" }, ...[
        dato("Elevation", h.elevacion_m != null ? `${Math.round(h.elevacion_m).toLocaleString("en")} m` : null),
        dato("Coordinates", coordenadas(lat, lon)),
        c ? dato(`Mean temp. ${c.anio}`, `${c.temp_media_c} °C`) : null,
        c ? dato("Daily range", `${c.oscilacion_diaria_media_c} °C`) : null,
        c ? dato("Min / max", `${c.temp_min_c} / ${c.temp_max_c} °C`) : null,
        c ? dato("Rain per year", c.lluvia_anual_mm != null ? `${c.lluvia_anual_mm.toLocaleString("en")} mm` : null) : null,
        c ? dato("Dry days", c.dias_secos_pct != null ? `${c.dias_secos_pct} %` : null) : null,
      ].filter(Boolean)));
    const tarjeta = (w, etiqueta) => el("a", { class: "wiki", href: w.url || "#", target: "_blank", rel: "noopener" },
      w.imagen ? el("img", { src: w.imagen, alt: "", loading: "lazy" }) : null,
      el("span", {}, el("small", {}, etiqueta), el("b", {}, w.titulo),
        w.extracto ? el("em", {}, w.extracto.length > 180 ? w.extracto.slice(0, 180) + "…" : w.extracto) : null));
    zonaWiki.replaceChildren(...[
      h.wikipedia_area?.titulo ? tarjeta(h.wikipedia_area, "Wikipedia · the area") : null,
      h.wikipedia?.titulo ? tarjeta(h.wikipedia, `Wikipedia · nearby${h.wikipedia.distancia_km != null ? `, ${h.wikipedia.distancia_km} km away` : ""}`) : null,
    ].filter(Boolean));
    pie.textContent = `${h.cache ? "Cached" : `Looked up in ${h.segundos} s`}. Sources: ${h.fuentes.join(" · ")}${IA.activa ? ` · Summary: ${IA.modelo} (${IA.proveedor})` : ""}.`;

    // ---- paso 2: resumen (streaming)
    zonaIA.replaceChildren(cargando(IA.activa ? "The AI is writing…" : "Building the summary…"));
    try {
      const r = await fetch("/api/lugar/resumen", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ lat, lon, sitio, destino, mision, evaluacion, medidas }),
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const lector = r.body.getReader();
      const dec = new TextDecoder();
      let texto = "";
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        texto += dec.decode(value, { stream: true });
        zonaIA.innerHTML = markdown(texto);
      }
      if (!texto.trim()) zonaIA.replaceChildren(el("p", { class: "nota" }, "No summary for this point."));
    } catch (e) {
      if (e.name === "AbortError") return;
      zonaIA.replaceChildren(el("p", { class: "nota" }, `Could not generate the summary (${e.message}).`));
    }
  })();

  return caja.__cancelar;
}
