#!/usr/bin/env python3
"""Generate reproducible fake-ward minimap presets from the current map asset."""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps/web/public/vendor/community/anti-snipe"
BASE_PATH = ASSET_DIR / "dota-7.40-minimap.png"
REFERENCE_PATH = ASSET_DIR / "dota-7.27-full.png"

# Normalized playable-map locations. The generator samples a believable subset
# for every seed, so animated presets can cross-fade without repeating a layout.
WARD_SITES = [
    (0.13, 0.18), (0.20, 0.14), (0.29, 0.13), (0.39, 0.14), (0.50, 0.14),
    (0.61, 0.14), (0.72, 0.15), (0.82, 0.18), (0.18, 0.25), (0.28, 0.23),
    (0.39, 0.25), (0.51, 0.23), (0.63, 0.25), (0.76, 0.25), (0.86, 0.28),
    (0.12, 0.36), (0.22, 0.34), (0.34, 0.35), (0.45, 0.33), (0.56, 0.35),
    (0.67, 0.34), (0.78, 0.36), (0.88, 0.38), (0.16, 0.45), (0.27, 0.44),
    (0.38, 0.45), (0.49, 0.43), (0.60, 0.45), (0.71, 0.44), (0.82, 0.47),
    (0.11, 0.55), (0.22, 0.54), (0.33, 0.55), (0.44, 0.54), (0.55, 0.55),
    (0.66, 0.54), (0.77, 0.55), (0.88, 0.57), (0.16, 0.65), (0.27, 0.64),
    (0.38, 0.65), (0.49, 0.64), (0.60, 0.65), (0.71, 0.64), (0.82, 0.67),
    (0.12, 0.75), (0.22, 0.74), (0.32, 0.76), (0.43, 0.74), (0.54, 0.75),
    (0.65, 0.74), (0.76, 0.76), (0.87, 0.75), (0.18, 0.84), (0.29, 0.84),
    (0.40, 0.84), (0.51, 0.83), (0.62, 0.85), (0.73, 0.84), (0.83, 0.83),
]


def extract_ward_icon() -> Image.Image:
    """Extract the authentic neon-green minimap eye from the old reference."""
    source = Image.open(REFERENCE_PATH).convert("RGBA")
    # One complete eye glyph in the reference image.
    crop = source.crop((66, 37, 90, 53))
    mask = Image.new("L", crop.size)
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b, a = crop.getpixel((x, y))
            if a > 100 and g > 165 and r < 125 and b < 125:
                mask.putpixel((x, y), 255)

    scale = 2
    mask = mask.resize((mask.width * scale, mask.height * scale), Image.Resampling.NEAREST)
    outline = mask.filter(ImageFilter.MaxFilter(5))
    icon = Image.new("RGBA", outline.size, (0, 0, 0, 0))
    icon.paste((5, 13, 8, 220), mask=outline)
    icon.paste((72, 255, 42, 255), mask=mask)
    return icon


def make_layout(seed: int, count: int, opacity: int, filename: str) -> None:
    rng = random.Random(seed)
    # Keep the live Dota minimap and its HUD frame visible. Replacing it with a
    # captured map image causes a conspicuous nested square as soon as Valve
    # changes terrain or the player's HUD scale differs. The preset therefore
    # contains only decoy ward glyphs on transparency.
    source = Image.open(BASE_PATH)
    base = Image.new("RGBA", source.size, (0, 0, 0, 0))
    icon = extract_ward_icon()
    if opacity < 255:
        icon.putalpha(icon.getchannel("A").point(lambda alpha: alpha * opacity // 255))

    sites = rng.sample(WARD_SITES, count)
    for nx, ny in sites:
        jitter_x = rng.randint(-13, 13)
        jitter_y = rng.randint(-13, 13)
        x = round(nx * base.width - icon.width / 2 + jitter_x)
        y = round(ny * base.height - icon.height / 2 + jitter_y)
        base.alpha_composite(icon, (x, y))

    base.save(ASSET_DIR / filename, optimize=True)


def main() -> None:
    make_layout(74101, 52, 255, "dota-7.40-fake-wards-dense-a.png")
    make_layout(74102, 52, 255, "dota-7.40-fake-wards-dense-b.png")
    make_layout(74103, 52, 255, "dota-7.40-fake-wards-dense-c.png")
    make_layout(74111, 44, 230, "dota-7.40-fake-wards-balanced-a.png")
    make_layout(74112, 44, 230, "dota-7.40-fake-wards-balanced-b.png")


if __name__ == "__main__":
    main()
