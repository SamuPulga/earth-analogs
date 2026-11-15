"""Servidor de la app (FastAPI). Sirve la página y la API.

Correr (con el venv activado), desde la carpeta codigo/app:
    uvicorn main:app --reload
y abrir http://127.0.0.1:8000

Dueño: Samuel (app/).
"""
from __future__ import annotations

import importlib

import httpx
import sys
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi import Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

AQUI = Path(__file__).resolve().parent
CODIGO = AQUI.parent
sys.path.insert(0, str(AQUI))
sys.path.insert(1, str(CODIGO))  # para poder importar el paquete modelo/ de Daniel

import datos  # noqa: E402
import lugar  # noqa: E402
import rejilla  # noqa: E402
import asistente  # noqa: E402

# --- Modelo de Daniel (codigo/modelo/recomendar.py) y su grilla (codigo/modelo/datos_sitios.csv) ----
# Se importa como paquete (modelo.recomendar), así Daniel puede repartir su código en varios archivos.
recomendar = importlib.import_module("modelo.recomendar").recomendar
MODELO = "oficial (codigo/modelo/recomendar.py, Daniel)"
if not rejilla.disponible():
    raise SystemExit("Falta la grilla de Daniel: codigo/modelo/datos_sitios.csv")


# --- Formato de una misión (el mismo que produce el lector de misiones.csv) -----------
class Restriccion(BaseModel):
    variable: str
    operador: Literal["<=", ">="]
    valor: float
    unidad: str = ""
    texto: str = ""
    fuente: str = ""


class Parametro(BaseModel):
    variable: str
    metodo: Literal["tolerancia", "ahp"]
    valor: float | None = None
    peso: float | None = None
    objetivo: float | None = None   # valor objetivo puesto por el usuario (None = el del destino)
    unidad: str = ""
    texto: str = ""
    fuente: str = ""

    @model_validator(mode="after")
    def _revisar(self):
        if self.metodo == "tolerancia" and not (self.valor and self.valor > 0):
            raise ValueError(f"{self.variable}: tolerance must be > 0")
        if self.metodo == "ahp" and not (self.peso and self.peso > 0):
            raise ValueError(f"{self.variable}: AHP weight must be > 0")
        return self


class Mision(BaseModel):
    id: str = "personalizada"
    nombre: str = "Misión personalizada"
    destino: str
    restricciones: list[Restriccion] = []
    parametros: list[Parametro] = Field(min_length=1)
    limites_tierra: list[str] = []


from contextlib import asynccontextmanager  # noqa: E402
import asyncio  # noqa: E402


@asynccontextmanager
async def _ciclo(app):
    # Al arrancar: investigar en segundo plano los lugares óptimos de las misiones predefinidas
    # (caché de "About this place"), que es lo primero que se abre
    puntos = _optimos_predefinidos()
    tarea = asyncio.create_task(lugar.precalentar(puntos))
    yield
    tarea.cancel()


app = FastAPI(title="S.E.I.A.T — Sistema Eafitense de Identificación Análoga Terrestre", lifespan=_ciclo)
app.add_middleware(GZipMiddleware, minimum_size=1000)  # la grilla pesa ~200 KB sin comprimir


def _registros(df):
    """Tabla → lista de diccionarios para JSON (los vacíos quedan como null)."""
    if not len(df):
        return []
    t = df.reset_index()
    return t.astype(object).where(t.notna(), None).to_dict("records")


@app.get("/api/inicio")
def inicio():
    """Todo lo que la página necesita al abrir: destinos, variables, misiones y la grilla de Daniel."""
    destinos, f_destinos = datos.cargar_destinos()
    variables, f_variables = datos.cargar_variables()
    misiones, errores, f_misiones = datos.cargar_misiones(variables, destinos)
    sitios, f_sitios = datos.cargar_sitios()

    # Análogos conocidos (sitios.csv, clasico = sí): el control positivo (AGENTS.md §4 y §5.5).
    # A cada uno se le asigna el cuadro de la grilla que lo contiene (None si ese cuadro no tiene datos).
    conocidos = []
    for sid, f in (sitios.iterrows() if len(sitios) else []):
        if str(f.get("clasico", "")).strip().lower() not in ("sí", "si", "yes") or f["lat"] != f["lat"]:
            continue
        conocidos.append({"id": sid, "nombre": f["nombre"], "pais": f.get("pais", ""), "lat": float(f["lat"]),
                          "lon": float(f["lon"]), "destino_sugerido": f.get("destino_sugerido", ""),
                          "por_que": f.get("por_que", ""), "fuente": f.get("fuente", ""), "estado": f.get("estado", ""),
                          "celda": rejilla.celda_de(float(f["lat"]), float(f["lon"]))})

    # Para cada destino: qué parámetros tienen valor objetivo. Los que no (p. ej. humedad y viento en
    # la Luna, que no tiene atmósfera) se desactivan en la app.
    lista_destinos = _registros(destinos)
    for d in lista_destinos:
        d["variables_disponibles"] = [c.removeprefix("f_") for c in rejilla.F(d["id"]).columns]
        d["objetivos"] = rejilla.objetivos(d["id"])
    return {
        "modelo": MODELO,
        "ia": lugar.estado_ia(),
        "fuentes": {"destinos": f_destinos, "variables": f_variables, "misiones": f_misiones, "sitios": f_sitios},
        "analogos_conocidos": conocidos,
        "destinos": lista_destinos,
        "restricciones_disponibles": rejilla.VARIABLES,
        # Grilla de Daniel: [id, lat, lon, temperatura, humedad, viento, variacion_temperatura, reflectancia]
        "rejilla": {"variables": rejilla.VARIABLES, "puntos": rejilla.puntos_json()},
        "variables": _registros(variables),
        "misiones": misiones,
        "errores_misiones": errores,
    }


def _ubicar(resultado: dict) -> None:
    """Campo "optimo" (el lugar óptimo): si el modelo no lo trae, es el primero del ranking."""
    if not resultado.get("optimo") and resultado.get("ranking"):
        p = resultado["ranking"][0]
        resultado["optimo"] = {k: p.get(k) for k in ("sitio_id", "nombre", "lat", "lon", "puntuacion")}
    resultado.setdefault("optimo", None)


@app.post("/api/recomendar")
def api_recomendar(mision: Mision):
    destinos, _ = datos.cargar_destinos()
    if mision.destino not in destinos.index:
        raise HTTPException(400, f"Unknown destination: {mision.destino}")
    return _recomendar_rejilla(mision.model_dump())


# --- Recomendar sobre la grilla de Daniel ------------------------------------------------
N_LISTA = 10          # puestos del ranking que se mandan con todo su detalle
_resultados: dict[str, dict] = {}   # caché: misma configuración -> mismo resultado (el modelo es determinista)

_MOTIVOS = [  # los motivos de descarte del modelo vienen en español: la app va en inglés
    (r"^Sin dato de (.+) para este sitio$", r"No \1 data for this point"),
    (r"^Sin datos de distancia para este destino$", "No distance data for this destination"),
    (r"\(debe ser ", "(must be "),
]


def _en_ingles(texto: str) -> str:
    import re
    for a, b in _MOTIVOS:
        texto = re.sub(a, b, texto)
    return texto


def _recomendar_rejilla(mision: dict) -> dict:
    destino = mision["destino"]
    if not rejilla.objetivos(destino):
        raise HTTPException(400, f"No target values for {destino} yet")
    # Objetivos que fijó el usuario: se cortan al mínimo/máximo que existe en América
    pedidos = tuple(sorted((p["variable"], float(p["objetivo"])) for p in mision["parametros"]
                           if p.get("objetivo") is not None and p["variable"] in rejilla.VARIABLES))
    Fd = rejilla.F_con(destino, pedidos) if pedidos else rejilla.F(destino)
    obj = rejilla.objetivos_con(destino, dict(pedidos)) if pedidos else rejilla.objetivos(destino)
    no_aplica = [p["variable"] for p in mision["parametros"] if p["variable"] not in obj]
    if no_aplica:
        raise HTTPException(400, f"Not applicable at this destination: {', '.join(no_aplica)}")

    # Sin restricciones (decisión del 15/11/2026): la misión se define solo con objetivos y pesos
    aplicables, omitidas = [], []
    m = rejilla.a_unidades_del_modelo({**mision, "restricciones": aplicables})

    clave = rejilla.firma({"d": destino, "p": m["parametros"], "r": aplicables, "o": pedidos})
    if clave not in _resultados:
        try:
            r = recomendar(m, Fd, rejilla.atributos(), rejilla.ids())
        except ValueError as e:
            raise HTTPException(400, _en_ingles(str(e)))
        if len(_resultados) > 64:
            _resultados.clear()
        _resultados[clave] = {"r": r, "puntos": rejilla.puntuaciones(m, Fd, r)}
    r, puntos = _resultados[clave]["r"], _resultados[clave]["puntos"]

    b = rejilla.base()
    tol = {p["variable"]: p["valor"] for p in mision["parametros"] if p["metodo"] == "tolerancia"}
    ranking = []
    for x in r["ranking"][:N_LISTA]:
        fila = b.loc[x["sitio_id"]]
        detalle = []
        for d in x["detalle"]:
            v = d["variable"]
            detalle.append({**d, "valor_sitio": float(fila[v]), "objetivo": obj[v]["valor"],
                            "diferencia": abs(float(fila[v]) - obj[v]["valor"]), "tolerancia": tol.get(v)})
        ranking.append({**x, "detalle": detalle, "lat": float(fila["latitud"]), "lon": float(fila["longitud"]),
                        "nombre": rejilla.nombre_punto(fila["latitud"], fila["longitud"])})
    resultado = {
        "ranking": ranking,
        "dominados": r["dominados"][:N_LISTA],
        "descartados": [{**d, "motivo": _en_ingles(d["motivo"])} for d in r["descartados"][:N_LISTA]],
        "totales": {"frente": len(r["ranking"]), "dominados": len(r["dominados"]),
                    "descartados": len(r["descartados"]), "puntos": len(puntos)},
        "puntos": puntos,                  # alineado con inicio.rejilla.puntos: [puntuación, estado]
        "objetivos": obj,
        "restricciones_omitidas": omitidas,
        "rejilla": True,
        "modelo": MODELO,
        "fuentes": {"grilla": "real"},
    }
    _ubicar(resultado)
    return resultado


def _optimos_predefinidos() -> list[tuple[float, float]]:
    """Lugar óptimo de cada misión predefinida (para investigarlo antes de que alguien lo abra)."""
    variables, _ = datos.cargar_variables()
    destinos, _ = datos.cargar_destinos()
    misiones, _, _ = datos.cargar_misiones(variables, destinos)
    puntos = []
    for mi in misiones:
        mi = {**mi, "parametros": [p for p in mi["parametros"] if p["variable"] in rejilla.objetivos(mi["destino"])]}
        try:
            o = _recomendar_rejilla(mi).get("optimo") if mi["parametros"] else None
        except HTTPException:
            o = None
        if o and o.get("lat") is not None:
            puntos.append((o["lat"], o["lon"]))
    return puntos


# --- Investigar un lugar por latitud y longitud (lugar.py) ---------------------------------
@app.get("/api/lugar")
async def api_lugar(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)):
    """Paso 1 (rápido, sin IA): nombre del lugar, Wikipedia y elevación."""
    return await lugar.hechos(lat, lon)


class ConsultaAsistente(BaseModel):
    texto: str = Field(min_length=10, max_length=1500)   # la misión, con las palabras del usuario
    destino: str | None = None                            # None = que la IA proponga el destino


@app.post("/api/ia/mision")
async def api_ia_mision(c: ConsultaAsistente):
    """Asistente: traduce la descripción a una configuración validada. NO escoge el sitio (AGENTS.md §7)."""
    destinos, _ = datos.cargar_destinos()
    variables, _ = datos.cargar_variables()
    misiones, _, _ = datos.cargar_misiones(variables, destinos)
    if c.destino and c.destino not in destinos.index:
        raise HTTPException(400, f"Unknown destination: {c.destino}")
    try:
        return await asistente.traducir(c.texto.strip(), c.destino, destinos, variables, misiones)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except httpx.HTTPError:
        raise HTTPException(503, "Could not reach the AI provider. Try again.")


@app.get("/api/ia/prueba")
async def api_ia_prueba():
    """Diagnóstico de la IA (sin mostrar la clave): ¿hay clave y qué responde el proveedor?"""
    return await lugar.probar_ia()


class ConsultaResumen(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    sitio: dict | None = None     # fila de sitios.csv, si el punto es un sitio con nombre del equipo
    destino: dict | None = None   # destino de la misión (nombre, cuerpo)
    mision: str | None = None     # nombre de la misión
    evaluacion: dict | None = None  # cómo quedó el punto con la configuración actual (puesto, parámetros, pesos)
    medidas: dict | None = None     # apartado Analogs: valores medidos del punto y su puesto en cada misión


@app.post("/api/lugar/resumen")
async def api_lugar_resumen(c: ConsultaResumen):
    """Paso 2 (IA, en streaming): ficha breve en español hecha solo con los hechos del paso 1."""
    h = await lugar.hechos(c.lat, c.lon)
    contexto = {"sitio": c.sitio, "destino": c.destino, "mision": c.mision, "evaluacion": c.evaluacion,
                "medidas": c.medidas}
    return StreamingResponse(lugar.resumen(h, contexto), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


app.mount("/static", StaticFiles(directory=AQUI / "static"), name="static")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    # Logo del equipo (static/img/). Sin caché larga para que el navegador no se quede con el icono viejo.
    return FileResponse(AQUI / "static" / "img" / "favicon_32.png", media_type="image/png",
                        headers={"Cache-Control": "no-cache"})


@app.get("/")
def pagina():
    return FileResponse(AQUI / "static" / "index.html")
