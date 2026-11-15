# Imagen de la app (Render, o cualquier servicio con Docker).
# La arma codigo/publicar/preparar.py; no editar la copia publicada.
FROM python:3.13-slim

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user . .

# La app busca datos/ y resultados/ dos carpetas arriba de codigo/app
WORKDIR /home/user/app/codigo/app
# Render indica el puerto en la variable PORT; en local se usa 7860
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]
