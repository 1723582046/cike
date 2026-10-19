#!/usr/bin/env python3
"""Generate per-profile Dock icons: profile name at top + smaller CK logo."""
import sys
from PIL import Image, ImageDraw, ImageFont

def make_profile_icon(profile_name, ck_path, out_path, size=1024):
    # Canvas: transparent
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # Load CK logo
    ck = Image.open(ck_path).convert('RGBA')

    # Layout: name at top (20% of height), logo below (70%)
    name_h = int(size * 0.22)
    logo_size = int(size * 0.68)
    logo_y = int(size * 0.26)

    # Draw profile name (centered, bold, dark with white outline for readability)
    try:
        # Try system fonts for CJK support
        font = None
        for fp in [
            '/System/Library/Fonts/PingFang.ttc',
            '/System/Library/Fonts/STHeiti Light.ttc',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        ]:
            try:
                font = ImageFont.truetype(fp, int(size * 0.11))
                break
            except:
                continue
        if not font:
            font = ImageFont.load_default()
    except:
        font = ImageFont.load_default()

    text = profile_name[:12]  # truncate long names
    # Get text size
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2
    ty = (name_h - th) // 2

    # White outline + dark text
    for dx in (-3, 3):
        for dy in (-3, 3):
            draw.text((tx+dx, ty+dy), text, font=font, fill=(255,255,255,255))
    draw.text((tx, ty), text, font=font, fill=(30,30,30,255))

    # Draw CK logo (smaller, centered below name)
    ck_small = ck.resize((logo_size, logo_size), Image.LANCZOS)
    lx = (size - logo_size) // 2
    canvas.paste(ck_small, (lx, logo_y), ck_small)

    # Save as ICNS
    sizes = [(16,16), (32,32), (64,64), (128,128), (256,256), (512,512), (1024,1024)]
    canvas.save(out_path, format='ICNS', sizes=sizes)
    print(f'Icon saved: {out_path}')

if __name__ == '__main__':
    make_profile_icon(sys.argv[1], sys.argv[2], sys.argv[3])
