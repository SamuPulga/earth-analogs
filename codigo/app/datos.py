"""Carga de las tablas compartidas del equipo (AGENTS.md §9), de la carpeta datos/.

Ya no hay datos de prueba: los puntos que se comparan son la grilla de Daniel (rejilla.py) y estas
tablas dan la configuración (destinos, misiones y nombres/unidades de las variables).
Si una tabla está vacía, su fuente queda como "sin datos" y la app lo avisa.

Dueño: Samuel (app/).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

RAIZ = Path(__file__).resolve().parents[2]  # carpeta NASA2026
DATOS = RAIZ / "datos"

TIPOS_MISION = {"mision", "restriccion", "parametro", "limite_tierra"}
OPERADORES = {"<=", ">="}
METODOS = {"tolerancia", "ahp"}


def _leer(real: Path) -> tuple[pd.DataFrame, str]:
    """Lee la tabla del equipo. Devuelve (tabla, fuente) con fuente "real" o "sin datos"."""
    if real.exists():
        df = pd.read_csv(real, dtype=str, keep_default_na=False)
        if len(df):
            return df, "real"
    return pd.DataFrame(), "sin datos"


def _numero(texto: str) -> float | None:
    texto = (texto or "").strip().replace(",", ".")
    if not texto:
        return None
    try:
        return float(texto)
    except ValueError:
        return None


def cargar_sitios() -> tuple[pd.DataFrame, str]:
    """Sitios con nombre (datos/sitios.csv). Opcional: hoy la app compara la grilla de Daniel."""
    df, fuente = _leer(DATOS / "sitios.csv")
    if len(df):
        df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
        df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
        df = df.set_index("id")
    return df, fuente


def cargar_destinos() -> tuple[pd.DataFrame, str]:
    df, fuente = _leer(DATOS / "destinos.csv")
    if len(df):
        df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
        df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
        df = df.set_index("id")
    return df, fuente


def cargar_variables() -> tuple[pd.DataFrame, str]:
    df, fuente = _leer(DATOS / "variables.csv")
    if len(df):
        df = df.set_index("variable")
    return df, fuente


def cargar_misiones(variables: pd.DataFrame | None = None,
                    destinos: pd.DataFrame | None = None) -> tuple[list[dict], list[str], str]:
    """Lee misiones.csv (una fila por regla, AGENTS.md §9.3) y la convierte en configuraciones.

    Devuelve (misiones, errores, fuente). Una misión con errores no se incluye;
    sus errores se reportan para que el equipo los corrija en la hoja.
    """
    df, fuente = _leer(DATOS / "misiones.csv")
    errores: list[str] = []
    misiones: list[dict] = []
    if not len(df):
        return misiones, errores, fuente

    faltan = {"mision_id", "tipo", "destino", "variable", "operador", "valor", "unidad",
              "metodo", "peso", "texto", "fuente", "estado"} - set(df.columns)
    if faltan:
        return [], [f"misiones.csv: missing columns {sorted(faltan)}"], fuente

    conocidas = set(variables.index) if variables is not None and len(variables) else None
    ids_destino = set(destinos.index) if destinos is not None and len(destinos) else None

    for mid, grupo in df.groupby("mision_id", sort=False):
        mid = mid.strip()
        propios: list[str] = []
        m = {"id": mid, "nombre": mid, "destino": "", "restricciones": [], "parametros": [],
             "limites_tierra": [], "estado": "borrador"}
        filas_mision = 0
        for n, f in grupo.iterrows():
            fila = f"misiones.csv row {n + 2} ({mid})"  # +2: encabezado y base 1
            tipo = f["tipo"].strip()
            if tipo not in TIPOS_MISION:
                propios.append(f"{fila}: type '{tipo}' is not one of {sorted(TIPOS_MISION)}")
                continue
            var = f["variable"].strip()
            if tipo in {"restriccion", "parametro"}:
                if not var:
                    propios.append(f"{fila}: missing variable")
                    continue
                if conocidas is not None and var not in conocidas:
                    propios.append(f"{fila}: variable '{var}' is not in variables.csv")
                    continue

            if tipo == "mision":
                filas_mision += 1
                m["nombre"] = f["texto"].strip() or mid
                m["destino"] = f["destino"].strip()
                m["estado"] = f["estado"].strip() or "borrador"
            elif tipo == "restriccion":
                op, valor = f["operador"].strip(), _numero(f["valor"])
                if op not in OPERADORES or valor is None:
                    propios.append(f"{fila}: a constraint needs an operator (<= or >=) and a numeric value")
                    continue
                m["restricciones"].append({"variable": var, "operador": op, "valor": valor,
                                           "unidad": f["unidad"], "texto": f["texto"],
                                           "fuente": f["fuente"]})
            elif tipo == "parametro":
                metodo = f["metodo"].strip()
                valor, peso = _numero(f["valor"]), _numero(f["peso"])
                if metodo not in METODOS:
                    propios.append(f"{fila}: method '{metodo}' is neither tolerancia nor ahp")
                    continue
                if metodo == "tolerancia" and (valor is None or valor <= 0):
                    propios.append(f"{fila}: a tolerance parameter needs a value > 0")
                    continue
                if metodo == "ahp" and (peso is None or peso <= 0):
                    propios.append(f"{fila}: an AHP parameter needs a weight > 0")
                    continue
                m["parametros"].append({"variable": var, "metodo": metodo, "valor": valor,
                                        "peso": peso, "unidad": f["unidad"], "texto": f["texto"],
                                        "fuente": f["fuente"]})
            else:  # limite_tierra
                if f["texto"].strip():
                    m["limites_tierra"].append(f["texto"].strip())

        if filas_mision != 1:
            propios.append(f"misiones.csv ({mid}): must have exactly one row of type 'mision'")
        elif ids_destino is not None and m["destino"] not in ids_destino:
            propios.append(f"misiones.csv ({mid}): destination '{m['destino']}' is not in destinos.csv")
        if not m["parametros"]:
            propios.append(f"misiones.csv ({mid}): has no valid parameters")

        if propios:
            errores.extend(propios)
        else:
            misiones.append(m)
    return misiones, errores, fuente
