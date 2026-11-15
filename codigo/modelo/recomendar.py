# hola
# hola
"""Modelo multiobjetivo para elegir sitios análogos.

Parte 1 - optimizar_punto(): trabaja con la base de datos cruda
          (latitud, longitud, temperatura, humedad, viento, variacion_temperatura,
          reflectancia)
          y devuelve la latitud/longitud del punto óptimo (Chebyshev ponderado).
Parte 2 - recomendar(): función con el contrato exacto que pide la app
          (restricciones -> frente de Pareto -> Chebyshev -> robustez).

Ambas usan la misma distancia estandarizada:
    f_i = |x_i - v_i| / (max_i - min_i)   (v_i = valor objetivo; rango = el del catálogo)
"""
import numpy as np
import pandas as pd


# ----------------------------------------------------------------------
# Parte 1: base de datos cruda -> punto óptimo
# ----------------------------------------------------------------------
def distancias_normalizadas(df, objetivos):
    """f_i = |x_i - v_i| / (max_i - min_i) para cada variable de `objetivos`.

    Se divide entre el rango de la variable en el catálogo (max - min de `df`),
    así que el objetivo puede ser 0 o estar fuera de los datos, y el resultado
    no depende de las unidades. f = 1 es alejarse tanto como el ancho del catálogo.

    objetivos: dict {columna: valor_teorico}.
    """
    columnas = {}
    for variable, v in objetivos.items():
        if variable not in df.columns:
            raise ValueError(f"La base de datos no tiene la columna '{variable}'.")
        rango = df[variable].max() - df[variable].min()
        if not rango > 0:
            raise ValueError(
                f"'{variable}' tiene el mismo valor en todos los sitios: no se puede "
                f"estandarizar dividiendo entre su rango."
            )
        columnas[f"f_{variable}"] = (df[variable] - v).abs() / rango
    return pd.DataFrame(columnas, index=df.index)


def optimizar_punto(df, objetivos, pesos=None, agregacion="chebyshev",
                    col_lat="latitud", col_lon="longitud"):
    """Devuelve el punto de `df` que minimiza la función objetivo.

    df          : DataFrame con latitud, longitud y las variables.
    objetivos   : {"temperatura": -20, "humedad": 30, "viento": 5, ...}
    pesos       : {"temperatura": 0.4, "humedad": 0.2, ...}. Se normalizan para
                  que sumen 1. Si es None, todos pesan igual.
    agregacion  : "chebyshev"  -> min  max_i w_i f_i      (el oficial; lo que usa la app)
                  "suma"       -> min  sum_i w_i f_i      (solo para comparar)
    """
    if agregacion not in ("suma", "chebyshev"):
        raise ValueError("agregacion debe ser 'suma' o 'chebyshev'.")
    for c in (col_lat, col_lon):
        if c not in df.columns:
            raise ValueError(f"La base de datos no tiene la columna '{c}'.")

    variables = list(objetivos)
    if pesos is None:
        pesos = {v: 1.0 for v in variables}
    faltan = [v for v in variables if v not in pesos]
    if faltan:
        raise ValueError(f"Faltan pesos para: {', '.join(faltan)}.")
    w = np.array([float(pesos[v]) for v in variables])
    if (w < 0).any() or w.sum() <= 0:
        raise ValueError("Los pesos deben ser >= 0 y al menos uno mayor que 0.")
    w = w / w.sum()

    datos = df.dropna(subset=variables + [col_lat, col_lon])
    if datos.empty:
        raise ValueError("No quedan filas sin datos faltantes en las variables usadas.")

    F = distancias_normalizadas(datos, objetivos)
    ponderadas = F.to_numpy() * w
    puntuacion = ponderadas.sum(axis=1) if agregacion == "suma" else ponderadas.max(axis=1)

    k = int(np.argmin(puntuacion))
    fila = datos.iloc[k]
    return {
        "latitud": float(fila[col_lat]),
        "longitud": float(fila[col_lon]),
        "puntuacion": float(puntuacion[k]),
        "f": {v: float(F.iloc[k][f"f_{v}"]) for v in variables},
        "pesos": {v: float(wi) for v, wi in zip(variables, w)},
    }


# ----------------------------------------------------------------------
# Parte 2: contrato con la app
# ----------------------------------------------------------------------
N_REPETICIONES = 500
SIGMA_PESOS = 0.2
SEMILLA = 12345


def _frente_pareto(M):
    """Índices NO dominados (minimización). M: matriz n x k."""
    n = M.shape[0]
    dominado = np.zeros(n, dtype=bool)
    # Cambio de Samuel (15/11/2026): mismo resultado, comparando bloques de 256 filas a la vez
    # en vez de una por una (más rápido con miles de puntos de la grilla).
    for a in range(0, n, 256):
        B = M[a:a + 256, None, :]                     # bloque de filas i
        dom = np.all(M[None] <= B, axis=2) & np.any(M[None] < B, axis=2)   # dom[i, k]: k domina a i
        dominado[a:a + 256] = dom.any(axis=1)
    return dominado


def _numero(x, que):
    """Convierte a float o lanza ValueError con un mensaje en español."""
    try:
        return float(x)
    except (TypeError, ValueError):
        raise ValueError(f"{que} debe ser un número (llegó {x!r}).") from None


def recomendar(mision: dict, F: pd.DataFrame, atributos: pd.DataFrame,
               sitios_ids: list[str]) -> dict:
    """Restricciones -> frente de Pareto -> Chebyshev ponderado -> robustez (AGENTS.md §5).

    Contrato con la app: ver PARA_DANIEL.md §2. Sin efectos secundarios (no
    modifica `mision`, no imprime ni escribe archivos) y reproducible (semilla fija).
    """
    parametros = mision.get("parametros") or []
    if not parametros:
        raise ValueError("La misión no tiene parámetros para comparar.")
    restricciones = mision.get("restricciones") or []

    # --- validación de configuración -------------------------------------
    variables, w, es_tol = [], [], []
    for p in parametros:
        var = p.get("variable")
        if not var:
            raise ValueError("Hay un parámetro de la misión sin 'variable'.")
        if f"f_{var}" not in F.columns:
            raise ValueError(
                f"La tabla de distancias no tiene la columna 'f_{var}' "
                f"que pide la misión."
            )
        # pesos (AGENTS.md §5.4): tolerancia -> w = 1/tau ; ahp -> w = peso
        metodo = p.get("metodo")
        if metodo == "tolerancia":
            tau = _numero(p.get("valor"), f"La tolerancia de '{var}'")
            if tau <= 0:
                raise ValueError(f"La tolerancia de '{var}' debe ser mayor que 0.")
            w.append(1.0 / tau)
        elif metodo == "ahp":
            peso = _numero(p.get("peso"), f"El peso AHP de '{var}'")
            if peso <= 0:
                raise ValueError(f"El peso AHP de '{var}' debe ser mayor que 0.")
            w.append(peso)
        else:
            raise ValueError(
                f"El método de '{var}' debe ser 'tolerancia' o 'ahp' (llegó {metodo!r})."
            )
        variables.append(var)
        es_tol.append(metodo == "tolerancia")
    w = np.array(w, dtype=float)
    cols_f = [f"f_{v}" for v in variables]

    reglas = []
    for r in restricciones:
        var = r.get("variable")
        if var not in atributos.columns:
            raise ValueError(
                f"La tabla de atributos no tiene la variable '{var}' "
                f"que usa una restricción."
            )
        if r.get("operador") not in ("<=", ">="):
            raise ValueError(
                f"El operador de la restricción de '{var}' debe ser '<=' o '>='."
            )
        reglas.append((var, r["operador"],
                       _numero(r.get("valor"), f"El límite de '{var}'"),
                       r.get("unidad")))

    # --- 1) restricciones y datos faltantes -------------------------------
    # cada sitio aparece una sola vez aunque venga repetido en sitios_ids
    sitios_ids = list(dict.fromkeys(sitios_ids))
    descartados, candidatos = [], []
    # Cambio de Samuel (15/11/2026): sitios con todas las distancias, calculado una sola vez
    # (antes F.loc[...] por cada sitio tomaba ~2 s con la grilla).
    completos = set(F.index[F[cols_f].notna().all(axis=1)])
    for sid in sitios_ids:
        motivo = None
        for var, op, limite, unidad in reglas:
            if sid not in atributos.index or pd.isna(atributos.at[sid, var]):
                motivo = f"Sin dato de {var} para este sitio"
                break
            val = float(atributos.at[sid, var])
            ok = val <= limite if op == "<=" else val >= limite
            if not ok:
                txt_unidad = f" {unidad}" if unidad else ""
                motivo = f"{var} = {val:g} (debe ser {op} {limite:g}{txt_unidad})"
                break
        if motivo is None:
            if sid not in completos:
                motivo = "Sin datos de distancia para este destino"
        if motivo is None:
            candidatos.append(sid)
        else:
            descartados.append({"sitio_id": str(sid), "motivo": motivo})

    if not candidatos:
        return {"ranking": [], "dominados": [], "descartados": descartados}

    # --- 2) frente de Pareto sobre las f_i --------------------------------
    Fc = F.loc[candidatos, cols_f].astype(float).to_numpy()
    dominado = _frente_pareto(Fc)
    idx_frente = np.where(~dominado)[0]
    idx_dom = np.where(dominado)[0]

    # --- 3) Chebyshev ponderado: max_i w_i f_i ----------------------------
    WF = Fc * w
    punt = WF.max(axis=1)
    orden = idx_frente[np.argsort(punt[idx_frente], kind="stable")]

    # --- 4) robustez: pesos perturbados w * exp(N(0, sigma)) --------------
    rng = np.random.default_rng(SEMILLA)
    W = w * np.exp(rng.normal(0.0, SIGMA_PESOS, size=(N_REPETICIONES, len(w))))
    sc = (W[:, None, :] * Fc[idx_frente][None, :, :]).max(axis=2)
    victorias = np.bincount(np.argmin(sc, axis=1), minlength=len(idx_frente))
    robustez = {int(i): victorias[j] / N_REPETICIONES for j, i in enumerate(idx_frente)}

    # --- salida ------------------------------------------------------------
    tol_idx = [j for j, t in enumerate(es_tol) if t]
    ranking = []
    for i in orden:
        i = int(i)
        detalle = [
            {"variable": variables[j], "f": float(Fc[i, j]),
             "w_f": float(WF[i, j]), "dentro_tolerancia": bool(WF[i, j] <= 1.0)}
            for j in range(len(variables))
        ]
        ranking.append({
            "sitio_id": str(candidatos[i]),
            "puntuacion": float(punt[i]),
            "parametro_decisivo": variables[int(np.argmax(WF[i]))],
            "dentro_tolerancia": (bool(all(WF[i, j] <= 1.0 for j in tol_idx))
                                  if tol_idx else None),
            "robustez": float(robustez[i]),
            "detalle": detalle,
        })

    dominados = []
    # Cambio de Samuel (15/11/2026): mismo resultado, pero comparando contra todo el frente
    # de una vez con numpy. Con la grilla de 3.857 puntos, el ciclo anterior tardaba ~10 s.
    Ff = Fc[idx_frente]
    for i in idx_dom:
        domina = np.all(Ff <= Fc[i], axis=1) & np.any(Ff < Fc[i], axis=1)
        dom_por = idx_frente[domina]
        mejor = int(dom_por[np.argmin(punt[dom_por])])  # el primero con la menor puntuación, como min()
        dominados.append({"sitio_id": str(candidatos[int(i)]),
                          "dominado_por": str(candidatos[mejor])})

    return {"ranking": ranking, "dominados": dominados, "descartados": descartados}


# Para correr con datos reales: python optimizacion.py (lee datos_sitios.csv)
