"""Versión PROVISIONAL del modelo, solo para construir y probar la app.

La versión oficial es de Daniel (codigo/modelo/recomendar.py). Cuando ese archivo
exista, main.py lo usa automáticamente y este se deja de usar.
El contrato que ambos cumplen está en codigo/INTERFAZ.md.

Método (AGENTS.md §5): restricciones → frente de Pareto → Chebyshev ponderado → robustez.

Dueño: Samuel (app/), mientras Daniel termina la oficial.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _peso(p: dict) -> float:
    """w_i = 1/τ_i si hay tolerancia física; si no, el peso AHP (AGENTS.md §5.4)."""
    return 1.0 / p["valor"] if p["metodo"] == "tolerancia" else float(p["peso"])


def _domina(a: np.ndarray, b: np.ndarray) -> bool:
    """a domina a b: igual o mejor en todo y estrictamente mejor en algo (menor f = mejor)."""
    return bool(np.all(a <= b) and np.any(a < b))


def recomendar(mision: dict, F: pd.DataFrame, atributos: pd.DataFrame,
               sitios_ids: list[str], n_robustez: int = 500, ruido: float = 0.2,
               semilla: int = 0) -> dict:
    """Ranking de análogos para una misión. Ver codigo/INTERFAZ.md."""
    params = mision["parametros"]
    columnas = [f"f_{p['variable']}" for p in params]
    sin_columna = [c for c in columnas if c not in F.columns]
    if sin_columna:
        raise ValueError("The destination has no data for: "
                         + ", ".join(c.removeprefix("f_") for c in sin_columna))
    W = np.array([_peso(p) for p in params])

    # 1. Restricciones → Ω
    descartados, omega = [], []
    for sid in sitios_ids:
        if sid not in F.index or F.loc[sid, columnas].isna().any():
            descartados.append({"sitio_id": sid, "motivo": "No distance data for this destination"})
            continue
        motivo = None
        for r in mision.get("restricciones", []):
            v = atributos.loc[sid, r["variable"]] \
                if sid in atributos.index and r["variable"] in atributos.columns else np.nan
            if pd.isna(v):
                motivo = f"No data for {r['variable']}"
            elif (r["operador"] == "<=" and v > r["valor"]) or (r["operador"] == ">=" and v < r["valor"]):
                motivo = f"{r['variable']} = {v:g} (must be {r['operador']} {r['valor']:g} {r.get('unidad', '')})".strip()
            if motivo:
                break
        if motivo:
            descartados.append({"sitio_id": sid, "motivo": motivo})
        else:
            omega.append(sid)

    if not omega:
        return {"ranking": [], "dominados": [], "descartados": descartados}

    M = F.loc[omega, columnas].to_numpy(dtype=float)

    # 2. Frente de Pareto, O(m N²)
    dominados, frente = [], []
    for i, sid in enumerate(omega):
        dominador = next((omega[j] for j in range(len(omega)) if j != i and _domina(M[j], M[i])), None)
        if dominador:
            dominados.append({"sitio_id": sid, "dominado_por": dominador})
        else:
            frente.append(i)
    Mf = M[frente]

    # 3. Chebyshev ponderado: puntuación = max_i w_i f_i (menor = mejor)
    WF = Mf * W
    puntuacion = WF.max(axis=1)

    # 4. Robustez: % de veces que cada sitio queda primero con pesos un poco distintos
    rng = np.random.default_rng(semilla)
    primeros = np.zeros(len(frente))
    for _ in range(n_robustez):
        Wp = W * np.exp(rng.normal(0.0, ruido, size=W.shape))
        primeros[np.argmin((Mf * Wp).max(axis=1))] += 1
    robustez = primeros / n_robustez

    ranking = []
    for k in np.argsort(puntuacion, kind="stable"):
        detalle = []
        for p, f, wf in zip(params, Mf[k], WF[k]):
            detalle.append({"variable": p["variable"], "f": round(float(f), 4),
                            "w_f": round(float(wf), 4),
                            "dentro_tolerancia": bool(wf <= 1) if p["metodo"] == "tolerancia" else None})
        con_tol = [d["dentro_tolerancia"] for d in detalle if d["dentro_tolerancia"] is not None]
        ranking.append({
            "sitio_id": omega[frente[k]],
            "puntuacion": round(float(puntuacion[k]), 4),
            "parametro_decisivo": params[int(np.argmax(WF[k]))]["variable"],
            "dentro_tolerancia": all(con_tol) if con_tol else None,
            "robustez": round(float(robustez[k]), 3),
            "detalle": detalle,
        })
    return {"ranking": ranking, "dominados": dominados, "descartados": descartados}
