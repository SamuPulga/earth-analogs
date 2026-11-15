"""Calcula el punto óptimo y el ranking del frente de Pareto a partir de datos reales.

Uso:
    python optimizacion.py                      # lee datos_sitios.csv
    python optimizacion.py otra_ruta.csv        # lee otro archivo

El CSV debe tener una fila por sitio y estas columnas (ver datos_sitios.csv):
    sitio_id, latitud, longitud, temperatura, humedad, viento,
    variacion_temperatura, reflectancia
Celda vacía = no hay dato: ese sitio no entra en el cálculo.

Además escribe resultados/F_<DESTINO>.csv, la tabla de distancias que lee la app
de Samuel (PARA_DANIEL.md §4): sitio_id + una columna f_<variable> por variable.
"""
import sys
from pathlib import Path

import pandas as pd

from recomendar import distancias_normalizadas, recomendar

ARCHIVO_DATOS = Path(__file__).with_name("datos_sitios.csv")

# Destino: debe ser el `id` que tiene en datos/destinos.csv de la app.
DESTINO = "shackleton"
CARPETA_RESULTADOS = Path(__file__).with_name("resultados")

# Valor objetivo/teórico de cada variable (el del destino que se quiere imitar).
# None = todavía no se conoce: hay que llenarlo antes de correr.
#
# Destino: polo sur lunar. Sus valores reales están fuera de lo que existe en la
# Tierra, así que en esas variables se busca el extremo del catálogo en la
# dirección lunar:  "min" = el menor valor de los datos, "max" = el mayor.
# Un número fijo se usa tal cual (sirve cuando el valor lunar cae dentro de los datos).
objetivos = {
    "temperatura": "min",            # Luna: ~ -183 °C (~90 K), piso de Shackleton
    "humedad": "min",                # Luna: 0 (sin atmósfera)
    "viento": "min",                 # Luna: 0 (sin atmósfera)
    "variacion_temperatura": "max",  # Luna: ~250 °C (Chandrayaan-3, ~69° S; confirmar)
    "reflectancia": 0.12,            # albedo del destino (está dentro de los datos)
}

# Importancia de cada variable. Se normalizan para que sumen 1.
pesos = {
    "temperatura": 0.6,
    "humedad": 0.1,
    "viento": 0.1,
    "variacion_temperatura": 0.1,
    "reflectancia": 0.1,
}

# Cuántos puntos del ranking se muestran (los mejores).
MAX_PUNTOS = 5


def cargar_datos(ruta):
    ruta = Path(ruta)
    if not ruta.exists():
        sys.exit(f"No encuentro el archivo de datos '{ruta}'.")
    df = pd.read_csv(ruta)
    if df.empty:
        sys.exit(f"'{ruta.name}' no tiene filas: agrega los datos de los sitios "
                 f"(una fila por sitio) debajo de los encabezados.")
    necesarias = ["latitud", "longitud", *objetivos]
    faltan = [c for c in necesarias if c not in df.columns]
    if faltan:
        sys.exit(f"A '{ruta.name}' le faltan las columnas: {', '.join(faltan)}.")
    if "sitio_id" in df.columns:
        df = df.set_index("sitio_id")
    else:
        df.index = [f"fila_{i + 1}" for i in range(len(df))]
    df.index = df.index.astype(str)
    return df


def revisar_configuracion():
    sin_objetivo = [v for v, x in objetivos.items() if x is None]
    sin_peso = [v for v, x in pesos.items() if x is None]
    if sin_objetivo or sin_peso:
        msg = ["Falta completar la configuración en optimizacion.py:"]
        if sin_objetivo:
            msg.append(f"  - valor objetivo de: {', '.join(sin_objetivo)}")
        if sin_peso:
            msg.append(f"  - peso de: {', '.join(sin_peso)}")
        sys.exit("\n".join(msg))


def resolver_objetivos(base):
    """Cambia "min"/"max" por el menor/mayor valor de esa columna en los datos."""
    reales = {}
    for v, x in objetivos.items():
        if x == "min":
            reales[v] = float(base[v].min())
        elif x == "max":
            reales[v] = float(base[v].max())
        elif isinstance(x, (int, float)):
            reales[v] = float(x)
        else:
            sys.exit(f"El objetivo de '{v}' debe ser un número, \"min\" o \"max\" (está {x!r}).")
    return reales


def exportar_F(F, destino=DESTINO, carpeta=CARPETA_RESULTADOS):
    """Escribe F en <carpeta>/F_<destino>.csv con el formato de PARA_DANIEL.md §4.

    Índice sitio_id, una columna f_<variable> por variable, f >= 0
    (0 = idéntico al objetivo) y celda vacía donde no hay dato.
    """
    if (F < 0).any().any():
        raise ValueError("Hay distancias negativas: F no cumple f >= 0.")
    carpeta.mkdir(exist_ok=True)
    ruta = carpeta / f"F_{destino}.csv"
    F.rename_axis("sitio_id").to_csv(ruta, na_rep="")
    return ruta


def main():
    revisar_configuracion()
    base = cargar_datos(sys.argv[1] if len(sys.argv) > 1 else ARCHIVO_DATOS)

    # --- objetivos "min"/"max" -> extremo del catálogo ---------------------
    reales = resolver_objetivos(base)
    print("Objetivos usados: " + ", ".join(f"{v} = {x:g}" for v, x in reales.items()) + "\n")

    # --- ranking según el frente de Pareto (Chebyshev ponderado) -----------
    F = distancias_normalizadas(base, reales)
    ruta_F = exportar_F(F)
    print(f"Tabla de distancias para la app: {ruta_F} "
          f"({len(F)} sitios, columnas {', '.join(F.columns)})\n")
    total = sum(pesos.values())
    mision = {
        "restricciones": [],
        "parametros": [{"variable": v, "metodo": "ahp", "valor": None,
                        "peso": pesos[v] / total} for v in objetivos],
    }
    salida = recomendar(mision, F, pd.DataFrame(index=base.index), list(base.index))

    # --- punto óptimo = 1.º del ranking (min max_i w_i f_i) ----------------
    if not salida["ranking"]:
        sys.exit("Ningún sitio tiene todos los datos: no hay punto óptimo.")
    mejor = salida["ranking"][0]
    fila = base.loc[mejor["sitio_id"]]
    print(f"Punto óptimo (Chebyshev): {mejor['sitio_id']} — latitud {fila['latitud']}, "
          f"longitud {fila['longitud']}, puntuación {mejor['puntuacion']:.3f}")

    print("\nRanking (frente de Pareto, de mejor a peor):")
    for puesto, r in enumerate(salida["ranking"][:MAX_PUNTOS], start=1):
        fila = base.loc[r["sitio_id"]]
        print(f"  {puesto}. {r['sitio_id']:<12} ({fila['latitud']}, {fila['longitud']})  "
              f"puntuación {r['puntuacion']:.3f}  lo decide: {r['parametro_decisivo']:<22} "
              f"robustez {r['robustez']:.0%}")
    resto = (len(salida["ranking"]) - MAX_PUNTOS if len(salida["ranking"]) > MAX_PUNTOS else 0)
    print(f"\n({resto} más en el frente, {len(salida['dominados'])} dominados, "
          f"{len(salida['descartados'])} descartados por falta de datos)")

if __name__ == "__main__":
    main()
