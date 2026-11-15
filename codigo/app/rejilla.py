"""Grilla de Daniel: los puntos de América (1° x 1°) con los 5 parámetros medidos.

Lee codigo/modelo/datos_sitios.csv (sitio_id, latitud, longitud, temperatura, humedad, viento,
variacion_temperatura, reflectancia) y arma lo que necesita la función recomendar() de Daniel:

  F           distancias f_i = |x_i - v_i| / (max_i - min_i), con la función de Daniel
              (distancias_normalizadas), contra el valor objetivo v_i de cada destino.
  atributos   los valores medidos de cada punto, para las restricciones (p. ej. temperatura <= 0).

Tolerancias: las misiones las escriben en unidades físicas (°C, % HR, m/s...). Como f está
dividida entre el rango del catálogo, la tolerancia se divide igual (tau / rango): así
w·f = |x - v| / tau, y "puntuación <= 1" sigue significando "dentro de la tolerancia".

Si no existe datos_sitios.csv, la app sigue con el catálogo de sitios y F_<destino>.csv.

Dueño: Samuel (app/). Los valores objetivo son de investigación (Vale): POR VERIFICAR.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[1]
RUTAS = [RAIZ / "resultados" / "datos_sitios.csv", AQUI.parent / "modelo" / "datos_sitios.csv"]
VARIABLES = ["temperatura", "humedad", "viento", "variacion_temperatura", "reflectancia"]

# Valor objetivo de cada variable en cada destino. "min"/"max" = el extremo del catálogo en la
# dirección del destino (sus valores reales no existen en la Tierra). Una variable que no está
# NO aplica a ese destino (la Luna no tiene atmósfera: sin humedad ni viento, AGENTS.md §12).
OBJETIVOS = {
    "shackleton": {  # de Daniel (codigo/modelo/optimizacion.py)
        "temperatura": ("min", "Moon: ~ -183 °C (~90 K) at the floor of Shackleton; below anything on Earth"),
        "variacion_temperatura": ("max", "Moon: day–night swing of ~250 °C (Chandrayaan-3, ~69° S; TO BE VERIFIED)"),
        "reflectancia": (0.12, "Albedo of the lunar surface at the destination (TO BE VERIFIED)"),
    },
    "jezero": {  # provisional (Samuel), TO BE VERIFIED by the research team
        "temperatura": ("min", "Mars: mean ~ -60 °C at Jezero; colder than almost anywhere on Earth (TO BE VERIFIED)"),
        "humedad": ("min", "Martian air is extremely dry: the driest site on Earth is the target (TO BE VERIFIED)"),
        "viento": (4.0, "Typical wind at Jezero measured by Perseverance (MEDA), ~4 m/s (TO BE VERIFIED)"),
        "variacion_temperatura": ("max", "Mars: day–night swing of ~80 °C; larger than on Earth (TO BE VERIFIED)"),
        "reflectancia": (0.2, "Albedo of the Martian surface around Jezero, ~0.2 (TO BE VERIFIED)"),
    },
}


def ruta() -> Path | None:
    return next((r for r in RUTAS if r.exists()), None)


@lru_cache(maxsize=1)
def base() -> pd.DataFrame | None:
    r = ruta()
    if r is None:
        return None
    df = pd.read_csv(r)
    df["sitio_id"] = df["sitio_id"].astype(str)
    df = df.set_index("sitio_id")
    for c in ["latitud", "longitud", *VARIABLES]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.dropna(subset=["latitud", "longitud"])


def disponible() -> bool:
    return base() is not None


def rangos() -> dict[str, float]:
    b = base()
    return {v: float(b[v].max() - b[v].min()) for v in VARIABLES}


@lru_cache(maxsize=8)
def objetivos(destino: str) -> dict[str, dict]:
    """{variable: {"valor": número, "regla": "min"/"max"/"fijo", "por_que": texto}} del destino."""
    b = base()
    salida = {}
    for v, (x, por_que) in OBJETIVOS.get(destino, {}).items():
        if x == "min":
            valor, regla = float(b[v].min()), "min"
        elif x == "max":
            valor, regla = float(b[v].max()), "max"
        else:
            valor, regla = float(x), "fijo"
        salida[v] = {"valor": valor, "regla": regla, "por_que": por_que}
    return salida


@lru_cache(maxsize=8)
def F(destino: str) -> pd.DataFrame:
    """Distancias f_<variable> con la función de Daniel. Vacía si el destino no tiene objetivos."""
    from modelo.recomendar import distancias_normalizadas
    obj = objetivos(destino)
    if not obj:
        return pd.DataFrame()
    return distancias_normalizadas(base(), {v: o["valor"] for v, o in obj.items()})


def atributos() -> pd.DataFrame:
    return base()[VARIABLES]


def a_unidades_del_modelo(mision: dict) -> dict:
    """Copia de la misión con las tolerancias pasadas a la escala de F (tau / rango)."""
    r = rangos()
    m = json.loads(json.dumps(mision))
    for p in m["parametros"]:
        if p["metodo"] == "tolerancia" and p["variable"] in r:
            p["valor"] = p["valor"] / r[p["variable"]]
    return m


def puntos_json() -> list[list]:
    """Para la página (una sola vez): [id, lat, lon, temperatura, humedad, viento, variacion, reflectancia]."""
    t = base()[["latitud", "longitud", *VARIABLES]].round(4)
    return [[i, *(None if x != x else x for x in fila)] for i, fila in zip(t.index, t.itertuples(index=False, name=None))]


def ids() -> list[str]:
    return list(base().index)


def puntuaciones(mision_modelo: dict, Fd: pd.DataFrame, resultado: dict) -> list:
    """Puntuación Chebyshev de TODOS los puntos (para colorear el mapa) y su estado.

    Devuelve una lista alineada con ids(): [puntuacion, estado] con estado 0 = frente de Pareto,
    1 = dominado, 2 = descartado. Usa los mismos pesos que recomendar() de Daniel.
    """
    w, cols = [], []
    for p in mision_modelo["parametros"]:
        w.append(1.0 / p["valor"] if p["metodo"] == "tolerancia" else float(p["peso"]))
        cols.append(f"f_{p['variable']}")
    punt = (Fd[cols].to_numpy() * np.array(w)).max(axis=1)
    estado = np.full(len(Fd), 1, dtype=int)
    pos = {s: i for i, s in enumerate(Fd.index)}
    for x in resultado.get("ranking", []):
        estado[pos[x["sitio_id"]]] = 0
    for x in resultado.get("descartados", []):
        if x["sitio_id"] in pos:
            estado[pos[x["sitio_id"]]] = 2
    return [[None if not np.isfinite(s) else round(float(s), 4), int(e)] for s, e in zip(punt, estado)]


def firma(obj) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def nombre_punto(lat: float, lon: float) -> str:
    return f"{abs(lat):.1f}° {'N' if lat >= 0 else 'S'}, {abs(lon):.1f}° {'E' if lon >= 0 else 'W'}"


def celda_de(lat: float, lon: float) -> str | None:
    """Id del punto de la grilla cuyo cuadro de 1° contiene (lat, lon), o None si ese cuadro no tiene datos.
    No se busca el vecino más cercano: un cuadro de al lado describiría otro lugar."""
    import math
    la, lo = math.floor(lat) + 0.5, math.floor(lon) + 0.5
    b = base()
    fila = b[(b["latitud"] == la) & (b["longitud"] == lo)]
    return str(fila.index[0]) if len(fila) else None


def recortar(variable: str, valor: float) -> tuple[float, bool]:
    """Un objetivo puesto por el usuario se corta al rango que existe en América (mínimo–máximo de la grilla)."""
    b = base()[variable]
    lo, hi = float(b.min()), float(b.max())
    nuevo = min(max(float(valor), lo), hi)
    return nuevo, nuevo != float(valor)


def objetivos_con(destino: str, pedidos: dict[str, float]) -> dict[str, dict]:
    """Objetivos del destino, cambiando los que el usuario fijó (ya recortados al rango de la Tierra)."""
    obj = {v: dict(o) for v, o in objetivos(destino).items()}
    for v, x in pedidos.items():
        if v in obj:
            valor, recortado = recortar(v, x)
            obj[v].update({"valor": valor, "regla": "usuario", "pedido": float(x), "recortado": recortado,
                           "por_que": "Set by the user" + (" (clipped to the range found in the Americas)" if recortado else "")})
    return obj


@lru_cache(maxsize=64)
def F_con(destino: str, pedidos: tuple) -> pd.DataFrame:
    """Como F(destino), pero con los objetivos que fijó el usuario. pedidos = ((variable, valor), ...)."""
    from modelo.recomendar import distancias_normalizadas
    obj = objetivos_con(destino, dict(pedidos))
    return distancias_normalizadas(base(), {v: o["valor"] for v, o in obj.items()})
