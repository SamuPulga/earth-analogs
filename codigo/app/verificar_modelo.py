"""Verifica que codigo/modelo/recomendar.py cumple el contrato con la app.

No revisa si la matemática es correcta (eso es de Daniel): revisa que la SALIDA tenga
el formato que la app necesita. Usa la grilla de Daniel y las misiones de datos/misiones.csv.

Uso (con el venv activado), desde la carpeta codigo/:
    python app/verificar_modelo.py

Dueño: Samuel (app/).
"""
from __future__ import annotations

import argparse
import copy
import importlib
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
sys.path.insert(1, str(AQUI.parent))

import pandas as pd  # noqa: E402

import datos  # noqa: E402

TIPOS_JSON = (str, int, float, bool, type(None))
fallas: list[str] = []


def revisar(cond: bool, mensaje: str) -> None:
    if not cond:
        fallas.append(mensaje)


def tipo_normal(valor, donde: str) -> None:
    """Debe ser un tipo normal de Python (no numpy), para poder enviarlo como JSON."""
    if isinstance(valor, dict):
        for k, v in valor.items():
            tipo_normal(v, f"{donde}.{k}")
    elif isinstance(valor, list):
        for i, v in enumerate(valor):
            tipo_normal(v, f"{donde}[{i}]")
    elif type(valor) not in TIPOS_JSON:
        t = type(valor)
        fallas.append(f"{donde}: es {t.__module__}.{t.__name__}; debe ser float/int/bool/str/None normal de Python")


def verificar_salida(nombre: str, mision: dict, salida, sitios_ids: list[str]) -> None:
    p = f"[{nombre}]"
    if not isinstance(salida, dict):
        fallas.append(f"{p} la salida debe ser un dict")
        return
    for clave in ("ranking", "dominados", "descartados"):
        revisar(isinstance(salida.get(clave), list), f"{p} falta la lista '{clave}'")
    if fallas and any(f.startswith(p) for f in fallas):
        return
    tipo_normal(salida, p)

    variables = [q["variable"] for q in mision["parametros"]]
    for i, r in enumerate(salida["ranking"]):
        q = f"{p} ranking[{i}]"
        for clave in ("sitio_id", "puntuacion", "parametro_decisivo", "dentro_tolerancia", "robustez", "detalle"):
            revisar(clave in r, f"{q}: falta '{clave}'")
        if "robustez" in r:
            revisar(0 <= r["robustez"] <= 1, f"{q}: robustez debe estar entre 0 y 1 (es fracción, no %)")
        if "parametro_decisivo" in r:
            revisar(r["parametro_decisivo"] in variables, f"{q}: parametro_decisivo no es una variable de la misión")
        if isinstance(r.get("detalle"), list):
            revisar([d.get("variable") for d in r["detalle"]] == variables,
                    f"{q}: 'detalle' debe tener un elemento por parámetro, en el mismo orden de la misión")
            for d in r["detalle"]:
                for clave in ("variable", "f", "w_f", "dentro_tolerancia"):
                    revisar(clave in d, f"{q}.detalle: falta '{clave}'")
            if r["detalle"] and "puntuacion" in r and all("w_f" in d for d in r["detalle"]):
                revisar(abs(max(d["w_f"] for d in r["detalle"]) - r["puntuacion"]) < 1e-3,
                        f"{q}: puntuacion debería ser el máximo de w_f (Chebyshev)")

    punt = [r.get("puntuacion", 0) for r in salida["ranking"]]
    revisar(punt == sorted(punt), f"{p} el ranking debe ir de menor a mayor puntuación (menor = mejor)")
    rob = [r.get("robustez", 0) for r in salida["ranking"]]
    if rob:
        revisar(abs(sum(rob) - 1) < 0.02, f"{p} las robusteces del ranking deberían sumar ~1 (suman {sum(rob):.3f})")

    for d in salida["dominados"]:
        revisar({"sitio_id", "dominado_por"} <= set(d), f"{p} dominados: cada uno necesita sitio_id y dominado_por")
    for d in salida["descartados"]:
        revisar({"sitio_id", "motivo"} <= set(d), f"{p} descartados: cada uno necesita sitio_id y motivo")

    vistos = [x.get("sitio_id") for k in ("ranking", "dominados", "descartados") for x in salida[k]]
    revisar(sorted(vistos) == sorted(sitios_ids),
            f"{p} cada sitio debe aparecer exactamente una vez entre ranking, dominados y descartados")


def main() -> None:
    import rejilla
    if not (AQUI.parent / "modelo" / "recomendar.py").exists():
        sys.exit("No existe codigo/modelo/recomendar.py todavía.")
    if not rejilla.disponible():
        sys.exit("No existe la grilla codigo/modelo/datos_sitios.csv.")
    recomendar = importlib.import_module("modelo.recomendar").recomendar
    print("Verificando: codigo/modelo/recomendar.py con la grilla de Daniel y las misiones de datos/misiones.csv")

    variables, _ = datos.cargar_variables()
    destinos, _ = datos.cargar_destinos()
    misiones, errores, _ = datos.cargar_misiones(variables, destinos)
    revisar(not errores, f"datos/misiones.csv tiene errores: {errores}")
    revisar(bool(misiones), "datos/misiones.csv no tiene misiones")
    atributos, ids = rejilla.atributos(), rejilla.ids()

    def preparar(m):
        """Igual que la app: solo parámetros con objetivo en el destino y restricciones con datos."""
        obj = rejilla.objetivos(m["destino"])
        m = {**copy.deepcopy(m), "parametros": [q for q in m["parametros"] if q["variable"] in obj],
             "restricciones": [r for r in m["restricciones"] if r["variable"] in rejilla.VARIABLES]}
        return m, rejilla.a_unidades_del_modelo(m)

    for m0 in misiones:
        m, mm = preparar(m0)
        F = rejilla.F(m["destino"])
        try:
            salida = recomendar(copy.deepcopy(mm), F, atributos, ids)
        except Exception as e:  # noqa: BLE001
            fallas.append(f"[{m['id']}] lanzó {type(e).__name__}: {e}")
            continue
        verificar_salida(m["id"], m, salida, ids)
        otra = recomendar(copy.deepcopy(mm), F, atributos, ids)
        revisar(otra == salida, f"[{m['id']}] dos llamadas iguales dan resultados distintos (¿falta semilla fija?)")
        print(f"  {m['id']}: óptimo = {salida['ranking'][0]['sitio_id'] if salida['ranking'] else '—'} "
              f"({len(salida['ranking'])} en el frente)")

        # Solo debe trabajar con sitios_ids, aunque F tenga más filas
        sub = ids[::7]
        try:
            verificar_salida(f"{m['id']} subconjunto", m, recomendar(copy.deepcopy(mm), F, atributos, sub), sub)
        except Exception as e:  # noqa: BLE001
            fallas.append(f"[{m['id']} subconjunto] lanzó {type(e).__name__}: {e}")

    # Debe avisar con ValueError si falta una columna f_<variable>
    m, mm = preparar(misiones[0])
    mm["parametros"].append({"variable": "no_existe", "metodo": "tolerancia", "valor": 1.0, "peso": None,
                             "unidad": "", "texto": "", "fuente": ""})
    try:
        recomendar(mm, rejilla.F(m["destino"]), atributos, ids)
        fallas.append("Con una variable sin columna en F debería lanzar ValueError, y no lanzó nada")
    except ValueError:
        pass
    except Exception as e:  # noqa: BLE001
        fallas.append(f"Con una variable sin columna en F lanzó {type(e).__name__}; debe ser ValueError")

    if fallas:
        print(f"\nNO CUMPLE ({len(fallas)} problemas):")
        for f in fallas:
            print("  -", f)
        sys.exit(1)
    print("\nCUMPLE el contrato con la app.")


if __name__ == "__main__":
    main()
