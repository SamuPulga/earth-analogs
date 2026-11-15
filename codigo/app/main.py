"""Servidor de la app (FastAPI). Sirve la página y la API.

Correr (con el venv activado), desde la carpeta codigo/app:
    uvicorn main:app --reload
y abrir http://127.0.0.1:8000

Dueño: Samuel (app/).
"""
from __future__ import annotations

import importlib
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

# --- Modelo: el oficial de Daniel si existe; si no, el provisional --------------------
# Se importa como paquete (modelo.recomendar), así Daniel puede repartir su código en
# varios archivos de modelo/ e importarlos con "from modelo.pareto import ..." o "from .pareto import ...".
if (CODIGO / "modelo" / "recomendar.py").exists():
    recomendar = importlib.import_module("modelo.recomendar").recomendar
    MODELO = "oficial (codigo/modelo/recomendar.py, Daniel)"
else:
    from modelo_provisional import recomendar  # noqa: E402
    MODELO = "provisional (codigo/app/modelo_provisional.py)"


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


class Consulta(Mision):
    """Lo que manda la página: la misión + filtros de búsqueda que no son de la misión."""
    # None = todos los continentes. Si hay lista, solo se comparan sitios de esos continentes
    # (se aplica ANTES del frente de Pareto, como una restricción más).
    continentes: list[str] | None = None


from contextlib import asynccontextmanager  # noqa: E402
import asyncio  # noqa: E402


@asynccontextmanager
async def _ciclo(app):
    # Al arrancar: investigar en segundo plano los sitios del catálogo (caché de "Sobre este lugar")
    sitios, _ = datos.cargar_sitios()
    puntos = [(float(r.lat), float(r.lon)) for r in sitios.itertuples() if r.lat == r.lat and r.lon == r.lon] if len(sitios) else []
    if rejilla.disponible():
        # Primero el lugar óptimo de cada misión predefinida: es lo primero que se abre
        puntos = _optimos_predefinidos() + puntos
    tarea = asyncio.create_task(lugar.precalentar(puntos))
    yield
    tarea.cancel()


app = FastAPI(title="Análogos Tierra — Luna y Marte", lifespan=_ciclo)
app.add_middleware(GZipMiddleware, minimum_size=1000)  # la grilla pesa ~200 KB sin comprimir


def _registros(df):
    """Tabla → lista de diccionarios para JSON (los vacíos quedan como null)."""
    if not len(df):
        return []
    t = df.reset_index()
    return t.astype(object).where(t.notna(), None).to_dict("records")


@app.get("/api/inicio")
def inicio():
    """Todo lo que la página necesita al abrir: destinos, sitios, variables y misiones."""
    sitios, f_sitios = datos.cargar_sitios()
    destinos, f_destinos = datos.cargar_destinos()
    variables, f_variables = datos.cargar_variables()
    misiones, errores, f_misiones = datos.cargar_misiones(variables, destinos)
    atributos, f_atr = datos.cargar_atributos()
    conteo = sitios["continente"].value_counts() if len(sitios) else {}
    continentes = [{"nombre": c, "sitios": int(conteo.get(c, 0))}
                   for c in datos.CONTINENTES + [datos.SIN_CONTINENTE] if conteo.get(c, 0)]

    # Para cada destino: qué parámetros tienen distancia calculada (columnas f_<variable> de F).
    # Los que no están (p. ej. humedad y viento en la Luna, que no tiene atmósfera) se desactivan en la app.
    lista_destinos = _registros(destinos)
    con_rejilla = rejilla.disponible()
    for d in lista_destinos:
        F = rejilla.F(d["id"]) if con_rejilla else datos.cargar_F(d["id"])[0]
        d["variables_disponibles"] = [c.removeprefix("f_") for c in F.columns if c.startswith("f_")]
        if con_rejilla:
            d["objetivos"] = rejilla.objetivos(d["id"])
    restricciones = (rejilla.VARIABLES if con_rejilla else list(atributos.columns) if len(atributos) else [])
    return {
        "continentes": continentes,
        "modelo": MODELO,
        "ia": lugar.estado_ia(),
        "fuentes": {"sitios": f_sitios, "destinos": f_destinos,
                    "variables": f_variables, "misiones": f_misiones, "atributos": f_atr},
        "destinos": lista_destinos,
        "atributos": _registros(atributos),
        "restricciones_disponibles": restricciones,
        # Grilla de Daniel: [lat, lon, temperatura, humedad, viento, variacion_temperatura, reflectancia]
        "rejilla": {"variables": rejilla.VARIABLES, "puntos": rejilla.puntos_json()} if con_rejilla else None,
        "sitios": _registros(sitios),
        "variables": _registros(variables),
        "misiones": misiones,
        "errores_misiones": errores,
    }


def _ubicar(resultado: dict, sitios) -> None:
    """Completa lat/lon/nombre de cada sitio del ranking y el campo "optimo" (el lugar óptimo).

    El modelo de Daniel puede devolver puntos que NO están en sitios.csv (por ejemplo, una celda
    de una grilla): en ese caso trae su propia lat/lon y aquí no se toca. Si el modelo ya trae
    "optimo", se respeta; si no, el óptimo es el primero del ranking.
    """
    for x in resultado.get("ranking", []):
        sid = x.get("sitio_id")
        if sid in sitios.index:
            fila = sitios.loc[sid]
            x.setdefault("lat", None if fila["lat"] != fila["lat"] else float(fila["lat"]))
            x.setdefault("lon", None if fila["lon"] != fila["lon"] else float(fila["lon"]))
            x.setdefault("nombre", fila.get("nombre", sid))
        else:
            x.setdefault("nombre", sid or "Unnamed point")
    if not resultado.get("optimo") and resultado.get("ranking"):
        p = resultado["ranking"][0]
        resultado["optimo"] = {k: p.get(k) for k in ("sitio_id", "nombre", "lat", "lon", "puntuacion")}
    resultado.setdefault("optimo", None)


@app.post("/api/recomendar")
def api_recomendar(consulta: Consulta):
    destinos, _ = datos.cargar_destinos()
    if consulta.destino not in destinos.index:
        raise HTTPException(400, f"Unknown destination: {consulta.destino}")
    if rejilla.disponible():
        return _recomendar_rejilla(consulta.model_dump(exclude={"continentes"}))
    sitios, f_sitios = datos.cargar_sitios()
    F, f_F = datos.cargar_F(consulta.destino)
    if not len(F):
        raise HTTPException(400, f"No distances computed for {consulta.destino}")
    atributos, f_atr = datos.cargar_atributos()

    # Filtro por continente: el modelo solo recibe los sitios de los continentes elegidos
    if consulta.continentes is None:
        ids = list(sitios.index)
    else:
        validos = set(datos.CONTINENTES) | {datos.SIN_CONTINENTE}
        elegidos = {datos.normalizar_continente(c) for c in consulta.continentes} & validos
        desconocidos = [c for c in consulta.continentes
                        if c != datos.SIN_CONTINENTE and datos.normalizar_continente(c) == datos.SIN_CONTINENTE]
        if desconocidos:
            raise HTTPException(400, f"Unknown continent: {', '.join(desconocidos)}")
        ids = list(sitios.index[sitios["continente"].isin(elegidos)])

    mision = consulta.model_dump(exclude={"continentes"})
    if not ids:
        resultado = {"ranking": [], "dominados": [], "descartados": []}
    else:
        try:
            resultado = recomendar(mision, F, atributos, ids)
        except ValueError as e:
            raise HTTPException(400, str(e))
    _ubicar(resultado, sitios)
    resultado["filtro"] = {"continentes": consulta.continentes, "sitios": len(ids), "total": len(sitios)}
    resultado["fuentes"] = {"sitios": f_sitios, "distancias": f_F, "atributos": f_atr}
    resultado["modelo"] = MODELO
    return resultado


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
    Fd = rejilla.F(destino)
    if not len(Fd):
        raise HTTPException(400, f"No target values for {destino} yet")
    obj = rejilla.objetivos(destino)
    no_aplica = [p["variable"] for p in mision["parametros"] if p["variable"] not in obj]
    if no_aplica:
        raise HTTPException(400, f"Not applicable at this destination: {', '.join(no_aplica)}")

    # Restricciones sin datos en la grilla (p. ej. la pendiente): no se aplican y se avisa
    aplicables = [r for r in mision["restricciones"] if r["variable"] in rejilla.VARIABLES]
    omitidas = [r["variable"] for r in mision["restricciones"] if r["variable"] not in rejilla.VARIABLES]
    m = rejilla.a_unidades_del_modelo({**mision, "restricciones": aplicables})

    clave = rejilla.firma({"d": destino, "p": m["parametros"], "r": aplicables})
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
    _ubicar(resultado, datos.cargar_sitios()[0])
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


@app.get("/api/ia/prueba")
async def api_ia_prueba():
    """Diagnóstico de la IA (sin mostrar la clave): ¿hay clave y qué responde el proveedor?"""
    return await lugar.probar_ia()


class ConsultaResumen(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    sitio: dict | None = None     # fila de sitios.csv + atributos, si el punto es un sitio del catálogo
    destino: dict | None = None   # destino de la misión (nombre, cuerpo)
    mision: str | None = None     # nombre de la misión
    evaluacion: dict | None = None  # cómo quedó el punto con la configuración actual (puesto, parámetros, pesos)


@app.post("/api/lugar/resumen")
async def api_lugar_resumen(c: ConsultaResumen):
    """Paso 2 (IA, en streaming): ficha breve en español hecha solo con los hechos del paso 1."""
    h = await lugar.hechos(c.lat, c.lon)
    contexto = {"sitio": c.sitio, "destino": c.destino, "mision": c.mision, "evaluacion": c.evaluacion}
    return StreamingResponse(lugar.resumen(h, contexto), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


app.mount("/static", StaticFiles(directory=AQUI / "static"), name="static")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(AQUI / "static" / "favicon.svg", media_type="image/svg+xml")


@app.get("/")
def pagina():
    return FileResponse(AQUI / "static" / "index.html")
