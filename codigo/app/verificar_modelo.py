"""Verifica que codigo/modelo/recomendar.py cumple el contrato con la app.

No revisa si la matemática es correcta (eso es de Daniel): revisa que la SALIDA tenga
el formato que la app necesita. Usa los datos de prueba de codigo/app/datos_prueba/.

Uso (con el venv activado), desde la carpeta codigo/:
    python app/verificar_modelo.py               # verifica el modelo de Daniel
    python app/verificar_modelo.py --provisional # verifica el provisional (para comparar)

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
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provisional", action="store_true", help="verificar el modelo provisional de la app")
    args = ap.parse_args()

    if args.provisional:
        from modelo_provisional import recomendar
        print("Verificando: codigo/app/modelo_provisional.py")
    else:
        if not (AQUI.parent / "modelo" / "recomendar.py").exists():
            sys.exit("No existe codigo/modelo/recomendar.py todavía.")
        recomendar = importlib.import_module("modelo.recomendar").recomendar
        print("Verificando: codigo/modelo/recomendar.py")

    P = datos.PRUEBA
    leer = lambda f: pd.read_csv(P / f).set_index("sitio_id")  # noqa: E731
    sitios_ids = list(pd.read_csv(P / "sitios.csv")["id"])
    atributos = leer("atributos.csv")
    variables = pd.read_csv(P / "variables.csv").set_index("variable")
    destinos = pd.read_csv(P / "destinos.csv").set_index("id")

    # Leer las misiones de prueba aunque datos/misiones.csv ya tenga datos reales
    real = datos.DATOS
    datos.DATOS = P.parent / "_no_existe"
    misiones, errores, _ = datos.cargar_misiones(variables, destinos)
    datos.DATOS = real
    revisar(not errores, f"las misiones de prueba tienen errores: {errores}")

    for m in misiones:
        F = leer(f"F_{m['destino']}.csv")
        try:
            salida = recomendar(copy.deepcopy(m), F, atributos, sitios_ids)
        except Exception as e:  # noqa: BLE001
            fallas.append(f"[{m['id']}] lanzó {type(e).__name__}: {e}")
            continue
        verificar_salida(m["id"], m, salida, sitios_ids)
        otra = recomendar(copy.deepcopy(m), F, atributos, sitios_ids)
        revisar(otra == salida, f"[{m['id']}] dos llamadas iguales dan resultados distintos (¿falta semilla fija?)")
        print(f"  {m['id']}: ranking = {[r.get('sitio_id') for r in salida.get('ranking', [])]}")

    # Filtro por continente: la app puede pasar solo una parte de los sitios.
    # El modelo debe trabajar únicamente con esos (aunque F tenga más filas).
    sitios = pd.read_csv(P / "sitios.csv").set_index("id")
    for m in misiones:
        sub = [s for s in sitios_ids if sitios.loc[s, "continente"] in ("América del Norte", "América del Sur")]
        try:
            salida = recomendar(copy.deepcopy(m), leer(f"F_{m['destino']}.csv"), atributos, sub)
            verificar_salida(f"{m['id']} solo América", m, salida, sub)
        except Exception as e:  # noqa: BLE001
            fallas.append(f"[{m['id']} solo América] lanzó {type(e).__name__}: {e}")

    # Debe avisar con ValueError si falta una columna f_<variable>
    m = copy.deepcopy(misiones[0])
    m["parametros"].append({"variable": "no_existe", "metodo": "tolerancia", "valor": 1.0, "peso": None,
                            "unidad": "", "texto": "", "fuente": ""})
    try:
        recomendar(m, leer(f"F_{m['destino']}.csv"), atributos, sitios_ids)
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
