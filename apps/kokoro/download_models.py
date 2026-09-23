"""Fetch the pinned Kokoro v1.0 CPU model and verify the downloaded assets."""
import hashlib
from pathlib import Path
import sys
import urllib.request

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = {
    "kokoro-v1.0.int8.onnx": "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}


def download(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        target = directory / name
        if not target.exists():
            temporary = target.with_suffix(".download")
            urllib.request.urlretrieve(BASE + name, temporary)
            temporary.replace(target)
        with target.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise RuntimeError(f"Checksum mismatch for {name}")


if __name__ == "__main__":
    download(Path(sys.argv[1]))
