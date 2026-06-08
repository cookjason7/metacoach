"""
Generate Android launcher icons for WarriorFIT AI.
Background: #1e2a3a (navy)
Logo fill: 72% of canvas (larger than previous 61%)
Run from repo root: python scripts/gen_icons.py
"""
from PIL import Image
import os

SRC = "client/public/brand/warriorfit-app-icon-orig.png"
BG  = (0x1e, 0x2a, 0x3a, 255)   # #1e2a3a navy, fully opaque

# (density, size_px)
SIZES = [
    ("mdpi",   48),
    ("hdpi",   72),
    ("xhdpi",  96),
    ("xxhdpi", 144),
    ("xxxhdpi",192),
]

# Adaptive foreground layer canvas is 108dp; safe zone is 72dp (66.7% of 108).
# We want logo to fill ~72% of the final rendered icon — that means
# ~108% of the 72dp safe zone = the full 108dp canvas * 0.72 = 77.8dp effective.
# For the foreground PNG we render at 108dp equivalent so the logo is 76% of that.
ADAPTIVE_FILL = 0.76   # logo occupies 76% of the 108dp adaptive foreground canvas

ADAPTIVE_SIZES = [
    ("mdpi",    108),
    ("hdpi",    162),
    ("xhdpi",   216),
    ("xxhdpi",  324),
    ("xxxhdpi", 432),
]

logo_src = Image.open(SRC).convert("RGBA")

def make_square_icon(size, fill=0.72):
    """Square icon: navy bg + centred logo at fill% of canvas."""
    canvas = Image.new("RGBA", (size, size), BG)
    logo_size = int(size * fill)
    logo = logo_src.resize((logo_size, logo_size), Image.LANCZOS)
    offset = (size - logo_size) // 2
    canvas.paste(logo, (offset, offset), logo)
    return canvas.convert("RGB")

def make_round_icon(size, fill=0.72):
    """Circular icon: navy bg + centred logo, circular mask."""
    from PIL import ImageDraw
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # Draw navy circle
    draw = ImageDraw.Draw(canvas)
    draw.ellipse([0, 0, size - 1, size - 1], fill=BG)
    # Paste logo
    logo_size = int(size * fill)
    logo = logo_src.resize((logo_size, logo_size), Image.LANCZOS)
    offset = (size - logo_size) // 2
    canvas.paste(logo, (offset, offset), logo)
    # Circular mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(canvas, mask=mask)
    return result

def make_foreground(size, fill=ADAPTIVE_FILL):
    """Adaptive foreground: transparent bg + centred logo at fill% of canvas."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    logo_size = int(size * fill)
    logo = logo_src.resize((logo_size, logo_size), Image.LANCZOS)
    offset = (size - logo_size) // 2
    canvas.paste(logo, (offset, offset), logo)
    return canvas

base = "android/app/src/main/res"

for density, size in SIZES:
    path = f"{base}/mipmap-{density}"
    os.makedirs(path, exist_ok=True)

    make_square_icon(size).save(f"{path}/ic_launcher.png")
    make_round_icon(size).save(f"{path}/ic_launcher_round.png")
    print(f"  {density}: {size}px square + round")

for density, size in ADAPTIVE_SIZES:
    path = f"{base}/mipmap-{density}"
    os.makedirs(path, exist_ok=True)
    make_foreground(size).save(f"{path}/ic_launcher_foreground.png")
    print(f"  {density}: {size}px adaptive foreground")

# Background XML — solid navy, consistent with values/ic_launcher_background.xml
bg_xml = '''<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="#1e2a3a" />
</shape>
'''
drawable_path = f"{base}/drawable"
os.makedirs(drawable_path, exist_ok=True)
with open(f"{drawable_path}/ic_launcher_background.xml", "w") as f:
    f.write(bg_xml)
print("  drawable/ic_launcher_background.xml updated")

print("\nAll icons generated.")
