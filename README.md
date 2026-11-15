# S.E.I.A.T

**Sistema Eafitense de Identificación Análoga Terrestre** (EAFIT Terrestrial Analog Identification System) · Universidad EAFIT

NASA Space Apps Challenge 2026 — *Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars*.

A web app that recommends places in the Americas to test a mission to the Moon or Mars, based on what the mission needs to test, and explains why they work and where they fall short.

- **Method:** each mission sets a target and a weight per parameter → normalized gaps → Pareto front → weighted Chebyshev → robustness.
- **Data:** NASA and partner open data (see the *More data* section of the app). Place lookups use OpenStreetMap Nominatim, Wikipedia and Open-Meteo.
- **AI:** place profiles and the translation of a described mission into targets and weights (Groq, openai/gpt-oss-120b). The recommended site is always chosen by the math.

## Run locally

```bash
pip install -r requirements.txt
cd codigo/app
uvicorn main:app --port 7860
```

Then open http://127.0.0.1:7860. Optional: set `IA_CLAVE` (a Groq API key) to enable AI summaries.

## Structure

- `codigo/app/` — FastAPI server (`main.py`) and web page (`static/`)
- `codigo/modelo/` — the mathematical model and the measured 1° grid of the Americas (`datos_sitios.csv`)
- `datos/` — mission settings: destinations, preset missions and variables
