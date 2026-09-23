"""Private CPU speech worker. Only the authenticated notification server exposes it."""
import io
import json
import logging
import os
from pathlib import Path
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

MAX_TEXT = 2000
MAX_AUDIO_SECONDS = 150
ROOT = Path(__file__).parent
VOICES = {v["id"]: v for v in json.loads((ROOT / "voices.json").read_text())}


def load_engine():
    directory = Path(os.environ.get("MODEL_DIR", "/models"))
    options = ort.SessionOptions()
    options.intra_op_num_threads = int(os.environ.get("KOKORO_THREADS", "2"))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        str(directory / "kokoro-v1.0.int8.onnx"), options,
        providers=["CPUExecutionProvider"],
    )
    engine = Kokoro.from_session(session, str(directory / "voices-v1.0.bin"))
    missing = VOICES.keys() - set(engine.get_voices())
    if missing:
        raise RuntimeError(f"Model is missing voices: {sorted(missing)}")
    # Warm up ONNX before reporting healthy, without logging notification text.
    engine.create("Your voice is ready.", voice="af_heart", lang="en-us", trim=False)
    return engine


def make_handler(engine):
    synthesis = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def log_message(self, *_args):
            pass

        def respond(self, status, body, content_type="application/json"):
            if not isinstance(body, bytes):
                body = json.dumps(body).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass  # Phone/server timed out and used its local fallback.

        def do_GET(self):
            self.respond(200 if self.path == "/health" else 404,
                         {"ok": self.path == "/health"})

        def do_POST(self):
            if self.path != "/speech":
                self.respond(404, {"error": "Not found"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16384:
                    self.respond(413, {"error": "Request too large"})
                    return
                payload = json.loads(self.rfile.read(size))
                text, voice = payload.get("text"), payload.get("voice")
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                    raise ValueError("Invalid text")
                if not isinstance(voice, str) or voice not in VOICES:
                    raise ValueError("Invalid voice")
            except (ValueError, AttributeError, TimeoutError):
                self.respond(400, {"error": "Invalid speech request"})
                return
            if not synthesis.acquire(blocking=False):
                self.respond(503, {"error": "Speech engine busy"})
                return
            started = time.monotonic()
            try:
                samples, rate = engine.create(text, voice=voice, speed=1.0,
                    lang=VOICES[voice]["language"].lower(), trim=False)
                if not len(samples) or len(samples) > rate * MAX_AUDIO_SECONDS or not np.isfinite(samples).all():
                    raise ValueError("Invalid audio")
                output = io.BytesIO()
                with wave.open(output, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(rate)
                    wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
                logging.info("Generated %s: %.1fs audio in %.2fs", voice, len(samples) / rate, time.monotonic() - started)
                self.respond(200, output.getvalue(), "audio/wav")
            except Exception:
                logging.error("Speech synthesis failed")
                self.respond(503, {"error": "Speech synthesis failed"})
            finally:
                synthesis.release()

    return Handler


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logging.getLogger("kokoro_onnx").setLevel(logging.WARNING)
    model = load_engine()
    logging.info("Kokoro ready with %d voices", len(VOICES))
    ThreadingHTTPServer(("0.0.0.0", 8880), make_handler(model)).serve_forever()
