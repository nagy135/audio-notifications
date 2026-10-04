#!/usr/bin/env python3
"""Pair this Mac using the existing private producer configuration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request


def main():
    config = json.loads(Path(os.environ.get(
        'AUDIO_NOTIFY_CONFIG', '~/.config/audio-notifications/client.json'
    )).expanduser().read_text())
    request = urllib.request.Request(config['url'].rstrip('/') + '/v1/pairing',
        data=b'{}', headers={'Authorization': 'Bearer ' + config['token'],
                            'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        code = json.load(response)['code']
    binary = Path(__file__).resolve().parents[1] / 'build/Audio Notifications.app/Contents/MacOS/AudioNotifications'
    subprocess.run([str(binary), '--pair-stdin'],
        input=json.dumps({'url': config['url'], 'code': code}).encode(), check=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        print('Mac pairing failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)
