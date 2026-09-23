"""Render the app's geometric waveform mark (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw
out = Path(__file__).resolve().parents[1] / 'apps/mobile/assets'
for name, transparent in [('icon.png', False), ('adaptive-icon.png', True)]:
    image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0) if transparent else '#101419')
    draw = ImageDraw.Draw(image)
    for x, height in [(312, 120), (412, 280), (512, 420), (612, 280), (712, 120)]:
        draw.rounded_rectangle((x-30, 512-height/2, x+30, 512+height/2), radius=30, fill='#b7f36b')
    image.save(out/name)
