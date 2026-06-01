from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
PET_DIR = ROOT / "resources" / "default-pets" / "ainz"
ICON_DIR = ROOT / "resources" / "icons"

FRAME_W = 192
FRAME_H = 208
COLS = 8
ROWS = 9


def draw_pet(draw: ImageDraw.ImageDraw, ox: int, oy: int, frame: int, row: int) -> None:
    bob = math.sin(frame * 0.9 + row * 0.2) * 4
    sway = math.sin(frame * 0.7) * 3
    cx = ox + FRAME_W // 2 + int(sway)
    base = oy + 184 + int(bob)
    robe = [(cx - 46, base - 86), (cx + 46, base - 86), (cx + 35, base - 8), (cx - 35, base - 8)]
    hood = [cx - 38, base - 142, cx + 38, base - 66]
    skull = [cx - 25, base - 126, cx + 25, base - 76]

    aura = (30 + row * 18) % 210
    draw.ellipse([cx - 58, base - 156, cx + 58, base - 38], outline=(70, 120 + aura // 3, 185, 52), width=3)
    draw.polygon(robe, fill=(35, 40, 58, 235), outline=(10, 16, 28, 255))
    draw.ellipse(hood, fill=(21, 26, 42, 250), outline=(9, 12, 24, 255), width=3)
    draw.ellipse(skull, fill=(224, 224, 205, 255), outline=(72, 66, 58, 255), width=2)
    draw.ellipse([cx - 16, base - 111, cx - 7, base - 101], fill=(148, 24, 35, 255))
    draw.ellipse([cx + 7, base - 111, cx + 16, base - 101], fill=(148, 24, 35, 255))
    draw.rectangle([cx - 13, base - 92, cx + 13, base - 88], fill=(93, 85, 73, 255))

    arm_phase = math.sin(frame * 1.1)
    left_arm = [(cx - 35, base - 78), (cx - 66, base - 62 - int(arm_phase * 10))]
    right_arm = [(cx + 35, base - 78), (cx + 64, base - 62 + int(arm_phase * 12))]

    if row == 3:
        right_arm[1] = (cx + 58, base - 112 + int(math.sin(frame * 1.8) * 18))
    elif row == 4:
        base -= int(abs(math.sin(frame * 1.2)) * 18)
    elif row == 5:
        draw.arc([cx - 50, base - 150, cx + 50, base - 50], 210, 330, fill=(185, 28, 28, 180), width=5)
    elif row == 6:
        draw.arc([cx - 64, base - 162, cx + 64, base - 34], frame * 30, frame * 30 + 110, fill=(13, 148, 136, 150), width=4)
    elif row == 7:
        for n in range(3):
            y = base - 26 - n * 22 - frame * 3 % 16
            draw.line([cx - 58, y, cx + 58, y - 8], fill=(37, 99, 235, 75), width=3)
    elif row == 8:
        draw.rectangle([cx + 42, base - 118, cx + 72, base - 80], fill=(245, 245, 239, 235), outline=(70, 70, 70, 255))

    draw.line(left_arm, fill=(19, 25, 42, 255), width=11)
    draw.line(right_arm, fill=(19, 25, 42, 255), width=11)
    draw.ellipse([left_arm[1][0] - 7, left_arm[1][1] - 7, left_arm[1][0] + 7, left_arm[1][1] + 7], fill=(224, 224, 205, 255))
    draw.ellipse([right_arm[1][0] - 7, right_arm[1][1] - 7, right_arm[1][0] + 7, right_arm[1][1] + 7], fill=(224, 224, 205, 255))
    draw.ellipse([cx - 38, base - 12, cx + 38, base + 0], fill=(15, 23, 42, 55))


def main() -> None:
    PET_DIR.mkdir(parents=True, exist_ok=True)
    ICON_DIR.mkdir(parents=True, exist_ok=True)

    sheet = Image.new("RGBA", (FRAME_W * COLS, FRAME_H * ROWS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    row_frames = [6, 8, 8, 4, 5, 8, 6, 6, 6]

    for row, frames in enumerate(row_frames):
        for frame in range(frames):
            draw_pet(draw, frame * FRAME_W, row * FRAME_H, frame, row)

    sheet.save(PET_DIR / "spritesheet.webp", "WEBP", lossless=True, quality=100, method=6)

    icon = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    icon_draw = ImageDraw.Draw(icon)
    icon_draw.rounded_rectangle([26, 26, 230, 230], radius=52, fill=(22, 42, 78, 255))
    icon_draw.ellipse([78, 58, 178, 158], fill=(230, 230, 210, 255), outline=(49, 46, 41, 255), width=5)
    icon_draw.ellipse([102, 96, 120, 116], fill=(190, 35, 45, 255))
    icon_draw.ellipse([136, 96, 154, 116], fill=(190, 35, 45, 255))
    icon_draw.rectangle([101, 132, 155, 141], fill=(82, 75, 65, 255))
    icon_draw.polygon([(72, 206), (184, 206), (160, 146), (96, 146)], fill=(38, 48, 70, 255))
    icon.save(ICON_DIR / "yumate.png", "PNG")
    icon.save(ICON_DIR / "yumate.ico", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
