import io
import json
import threading
import unittest
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer

import numpy as np
from server import make_handler


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.samples = np.array([0.0, 0.5, -0.5], dtype=np.float32)

    def create(self, text, **kwargs):
        self.calls.append((text, kwargs))
        self.entered.set()
        self.release.wait(3)
        return self.samples, 24000


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.engine))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.engine.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def speech(self, payload):
        req = urllib.request.Request(self.base + "/speech", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=4) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_wav_and_voice_language(self):
        status, audio = self.speech({"text": "Hello there", "voice": "bf_emma"})
        self.assertEqual(status, 200)
        with wave.open(io.BytesIO(audio)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()), (1, 2, 24000, 3))
        self.assertEqual(self.engine.calls[0][1]["lang"], "en-gb")

    def test_invalid_input_does_not_run_model(self):
        for payload in [None, [], {"text": "", "voice": "af_heart"},
                        {"text": "x" * 2001, "voice": "af_heart"},
                        {"text": "Hello", "voice": "unknown"}]:
            self.assertEqual(self.speech(payload)[0], 400)
        self.assertEqual(self.engine.calls, [])

    def test_busy_engine_does_not_queue_unbounded_work(self):
        self.engine.release.clear()
        results = []
        first = threading.Thread(target=lambda: results.append(self.speech({"text": "First", "voice": "af_heart"})))
        first.start()
        self.assertTrue(self.engine.entered.wait(1))
        self.assertEqual(self.speech({"text": "Second", "voice": "af_heart"})[0], 503)
        with urllib.request.urlopen(self.base + "/health") as response:
            self.assertEqual(response.status, 200)
        self.engine.release.set()
        first.join()
        self.assertEqual(results[0][0], 200)

    def test_invalid_samples_return_failure_for_android_fallback(self):
        self.engine.samples = np.array([np.nan], dtype=np.float32)
        self.assertEqual(self.speech({"text": "Hello", "voice": "af_heart"})[0], 503)


if __name__ == "__main__":
    unittest.main()
