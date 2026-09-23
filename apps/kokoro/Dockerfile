FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODEL_DIR=/models KOKORO_THREADS=2
COPY apps/kokoro/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/kokoro/download_models.py ./
RUN python download_models.py /models && useradd --uid 10001 --create-home speech
COPY apps/server/src/services/kokoro-voices.json ./voices.json
COPY apps/kokoro/server.py ./
USER speech
EXPOSE 8880
CMD ["python", "server.py"]
