"""Fetch the pinned Kokoro v1.0 CPU model and verify the downloaded assets."""
import hashlib
from pathlib import Path
import sys
import urllib.request

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}


def download(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        target = directory / name
        if not target.exists():
            temporary = target.with_suffix(".download")
            with urllib.request.urlopen(BASE + name, timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            temporary.replace(target)
        with target.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise RuntimeError(f"Checksum mismatch for {name}")


if __name__ == "__main__":
    download(Path(sys.argv[1]))
