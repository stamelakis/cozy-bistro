from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "src" / "assets" / "atlases"
TILE_W = 58
TILE_H = 30
MAX_ATLAS_W = 4096
MAX_ATLAS_H = 16384
PAD = 3
CHARACTER_VARIANT_COUNT = 10
FURNITURE_ATLAS_SCALE = 2

STYLE_OUTLINE = 0x5B4033
STYLE_SOFT_OUTLINE = 0x8F6A4F
STYLE_WARM_HIGHLIGHT = 0xFFF8E8
STYLE_CONTACT_SHADOW = 0x3F2D24

COZY_SKINS = (0xF5C6A4, 0xD99B74, 0xB87754, 0x8E5F43, 0xF0D0B6, 0xC98568, 0xA86F51, 0xE2B28A, 0x704A36, 0xFFD8B8)
COZY_HAIR = (0x3C2720, 0x241A17, 0x8A5630, 0x6B3428, 0xC8B18A, 0x4B2D22, 0x17120F, 0x74543A, 0x9F5A3A, 0xD8C4A4)
COZY_GUEST_SHIRTS = (0xC86F6B, 0x789B76, 0xD29A46, 0x7A6797, 0xB96678, 0x6E9BA8, 0xB9848D, 0x8E965D, 0xD2865E, 0x6B87B4)
COZY_WAITER_SHIRTS = (0x2F5C78, 0x335F73, 0x3C6B82, 0x294E67, 0x456C7A, 0x31596D, 0x49748C, 0x34546D, 0x294962, 0x3E6274)
COZY_CHEF_SHIRTS = (0xFFF8EC, 0xF8F1DE, 0xF3F4F1, 0xFFF7ED, 0xF7F2EA, 0xF4EFE3, 0xFFFFFF, 0xF7F4EA, 0xF1F4F2, 0xFFF2E6)
COZY_ERRAND_SHIRTS = (0x7B8B45, 0x6F7F3E, 0x8A7A42, 0x6D8A5A, 0x788F55, 0x8B6A45, 0x657C4C, 0x9A844F, 0x728B66, 0xA0724C)
COZY_GUEST_PANTS = (0x4F5D6B, 0x3E4F61, 0x65504A, 0x4D5A4D, 0x514A64, 0x5E5E55, 0x334B58, 0x6A513A, 0x4F4A5D, 0x455C62)
COZY_WAITER_PANTS = (0x20394D, 0x1D3347, 0x263F52, 0x1B2E42, 0x26394B, 0x243644, 0x2A4658, 0x223346, 0x22364A, 0x1B3546)
COZY_CHEF_PANTS = (0x59656B, 0x6A6F6D, 0x505D63, 0x666A6B, 0x5C6266, 0x545D60, 0x687277, 0x4F5960, 0x626D72, 0x555F66)
COZY_ERRAND_PANTS = (0x5D5132, 0x59462E, 0x4D5734, 0x61553D, 0x4B4F35, 0x6D5037, 0x474733, 0x5E5A3C, 0x586443, 0x6B5638)


@dataclass
class FurnitureItem:
  id: str
  name: str
  category: str
  width: int
  height: int
  color: int
  tier: int
  cooking_slots: int
  table_seat_capacity: int


class AtlasPacker:
  def __init__(self, image_name: str) -> None:
    self.image_name = image_name
    self.canvas = Image.new("RGBA", (MAX_ATLAS_W, MAX_ATLAS_H), (0, 0, 0, 0))
    self.frames: dict[str, dict[str, object]] = {}
    self.x = PAD
    self.y = PAD
    self.row_h = 0
    self.used_h = PAD

  def add(self, name: str, sprite: Image.Image) -> None:
    w, h = sprite.size
    if self.x + w + PAD > MAX_ATLAS_W:
      self.x = PAD
      self.y += self.row_h + PAD
      self.row_h = 0
    if self.y + h + PAD > MAX_ATLAS_H:
      raise RuntimeError(f"Atlas {self.image_name} is too small for {name}")

    self.canvas.alpha_composite(sprite, (self.x, self.y))
    frame_data: dict[str, object] = {
      "frame": {"x": self.x, "y": self.y, "w": w, "h": h},
      "rotated": False,
      "trimmed": False,
      "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
      "sourceSize": {"w": w, "h": h},
    }
    cozy_meta = sprite.info.get("cozy_meta")
    if isinstance(cozy_meta, dict):
      frame_data.update(cozy_meta)
    self.frames[name] = frame_data
    self.x += w + PAD
    self.row_h = max(self.row_h, h)
    self.used_h = max(self.used_h, self.y + h + PAD)

  def save(self, path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    image_path = path / self.image_name
    json_path = path / self.image_name.replace(".png", ".json")
    cropped = self.canvas.crop((0, 0, MAX_ATLAS_W, max(self.used_h, 16)))
    cropped.save(image_path)
    data = {
      "frames": self.frames,
      "meta": {
        "app": "cozy-bistro-atlas-generator",
        "version": "1.0",
        "image": self.image_name,
        "format": "RGBA8888",
        "size": {"w": cropped.size[0], "h": cropped.size[1]},
        "scale": "1",
      },
    }
    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def parse_furniture() -> list[FurnitureItem]:
  source = (ROOT / "src" / "data" / "furniture.ts").read_text(encoding="utf-8")
  start = source.index("[")
  end = source.rindex("];")
  catalog = source[start + 1:end]
  blocks: list[str] = []
  depth = 0
  block_start = -1
  for index, char in enumerate(catalog):
    if char == "{":
      if depth == 0:
        block_start = index
      depth += 1
    elif char == "}":
      depth -= 1
      if depth == 0 and block_start >= 0:
        blocks.append(catalog[block_start:index + 1])

  items: list[FurnitureItem] = []
  for block in blocks:
    def string_value(key: str, default = "") -> str:
      match = re.search(rf'{key}:\s*"([^"]+)"', block)
      return match.group(1) if match else default

    def int_value(key: str, default = 0) -> int:
      match = re.search(rf"{key}:\s*(\d+)", block)
      return int(match.group(1)) if match else default

    def hex_value(key: str, default = 0x9B704E) -> int:
      match = re.search(rf"{key}:\s*0x([0-9a-fA-F]+)", block)
      return int(match.group(1), 16) if match else default

    item_id = string_value("id")
    if not item_id:
      continue
    size_match = re.search(r"size:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}", block, re.S)
    width = int(size_match.group(1)) if size_match else 1
    height = int(size_match.group(2)) if size_match else 1
    items.append(
      FurnitureItem(
        id=item_id,
        name=string_value("name", item_id),
        category=string_value("category", "decoration"),
        width=width,
        height=height,
        color=hex_value("color"),
        tier=int_value("luxuryTier", 1),
        cooking_slots=int_value("cookingSlots", 0),
        table_seat_capacity=int_value("tableSeatCapacity", 0),
      )
    )
  return items


def rgba(color: int, alpha = 255) -> tuple[int, int, int, int]:
  return ((color >> 16) & 255, (color >> 8) & 255, color & 255, alpha)


def shade(color: int, amount: int) -> int:
  r = max(0, min(255, ((color >> 16) & 255) + amount))
  g = max(0, min(255, ((color >> 8) & 255) + amount))
  b = max(0, min(255, (color & 255) + amount))
  return (r << 16) | (g << 8) | b


def diamond_points(cx: float, top_y: float, width: float, height: float) -> list[tuple[float, float]]:
  return [(cx, top_y), (cx + width / 2, top_y + height / 2), (cx, top_y + height), (cx - width / 2, top_y + height / 2)]


def area_points(width_cells: int, height_cells: int) -> list[tuple[float, float]]:
  return [
    (0, 0),
    (width_cells * TILE_W / 2, width_cells * TILE_H / 2),
    ((width_cells - height_cells) * TILE_W / 2, (width_cells + height_cells) * TILE_H / 2),
    (-height_cells * TILE_W / 2, height_cells * TILE_H / 2),
  ]


def rotated_size(item: FurnitureItem, rotation: int) -> tuple[int, int]:
  return (item.height, item.width) if rotation in (90, 270) else (item.width, item.height)


def is_floor_textile(item: FurnitureItem) -> bool:
  return item.category == "decoration" and any(token in item.id for token in ("rug", "mat", "carpet"))


def draw_polygon(draw: ImageDraw.ImageDraw, points, fill: int, outline: int | None = None, width = 1) -> None:
  draw.polygon(points, fill=rgba(fill))
  if outline is not None:
    draw.line(points + [points[0]], fill=rgba(outline), width=width, joint="curve")


def upscale_sprite(sprite: Image.Image, scale: int) -> Image.Image:
  if scale <= 1:
    return sprite
  resample = getattr(Image, "Resampling", Image).LANCZOS
  upscaled = sprite.resize((sprite.size[0] * scale, sprite.size[1] * scale), resample)
  cozy_meta = sprite.info.get("cozy_meta")
  if isinstance(cozy_meta, dict):
    upscaled.info["cozy_meta"] = scale_sprite_metadata(cozy_meta, scale)
  return upscaled


def point_meta(point: tuple[float, float]) -> dict[str, float]:
  return {"x": round(point[0], 3), "y": round(point[1], 3)}


def scale_point_meta(point: dict[str, float], scale: int) -> dict[str, float]:
  return {"x": round(float(point["x"]) * scale, 3), "y": round(float(point["y"]) * scale, 3)}


def scale_sprite_metadata(metadata: dict[str, object], scale: int) -> dict[str, object]:
  scaled: dict[str, object] = {}
  for key, value in metadata.items():
    if isinstance(value, dict) and "x" in value and "y" in value:
      scaled[key] = scale_point_meta(value, scale)
    elif isinstance(value, list):
      scaled[key] = [
        scale_point_meta(item, scale)
        if isinstance(item, dict) and "x" in item and "y" in item
        else item
        for item in value
      ]
    else:
      scaled[key] = value
  return scaled


def set_sprite_metadata(
  image: Image.Image,
  anchor: tuple[float, float],
  seat_surface: list[tuple[float, float]] | None = None,
  table_service: list[tuple[float, float]] | None = None,
) -> None:
  metadata: dict[str, object] = {"anchorPx": point_meta(anchor)}
  if seat_surface:
    metadata["seatSurfacePx"] = [point_meta(point) for point in seat_surface]
  if table_service:
    metadata["tableServicePx"] = [point_meta(point) for point in table_service]
  image.info["cozy_meta"] = metadata


def set_sprite_metadata_points(image: Image.Image, key: str, points: list[tuple[float, float]]) -> None:
  metadata = image.info.setdefault("cozy_meta", {})
  if isinstance(metadata, dict):
    metadata[key] = [point_meta(point) for point in points]


def lerp_tuple(a: tuple[float, float], b: tuple[float, float], t: float) -> tuple[float, float]:
  return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def point_in_quad(quad: list[tuple[float, float]], u: float, v: float) -> tuple[float, float]:
  top = lerp_tuple(quad[0], quad[1], u)
  bottom = lerp_tuple(quad[3], quad[2], u)
  return lerp_tuple(top, bottom, v)


def draw_face_panel(
  draw: ImageDraw.ImageDraw,
  face: list[tuple[float, float]],
  u1: float,
  u2: float,
  v1: float,
  v2: float,
  fill: int,
  outline: int = 0x5B4033,
  alpha: int = 255,
) -> None:
  panel = [
    point_in_quad(face, u1, v1),
    point_in_quad(face, u2, v1),
    point_in_quad(face, u2, v2),
    point_in_quad(face, u1, v2),
  ]
  draw.polygon(panel, fill=rgba(fill, alpha))
  draw.line(panel + [panel[0]], fill=rgba(outline, min(alpha, 190)), width=1, joint="curve")


def draw_prism(draw: ImageDraw.ImageDraw, top, drop: int, color: int, outline = 0x5B4033) -> None:
  bottom = [(x, y + drop) for x, y in top]
  draw_polygon(draw, [top[1], top[2], bottom[2], bottom[1]], shade(color, -26), outline, 1)
  draw_polygon(draw, [top[2], top[3], bottom[3], bottom[2]], shade(color, -46), outline, 1)
  draw_polygon(draw, top, color, outline, 2)


def inset_points(points: list[tuple[float, float]], amount: float) -> list[tuple[float, float]]:
  cx, cy = polygon_center(points)
  return [(x * (1 - amount) + cx * amount, y * (1 - amount) + cy * amount) for x, y in points]


def draw_round_tableware(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale = 1.0) -> None:
  draw.ellipse((cx - 6 * scale, cy - 4 * scale, cx + 6 * scale, cy + 4 * scale), fill=rgba(0xFFF7E8), outline=rgba(0xC8AA7A), width=1)
  draw.ellipse((cx - 2.4 * scale, cy - 1.8 * scale, cx + 2.4 * scale, cy + 1.8 * scale), fill=rgba(0x6DA05E))
  draw.line((cx + 7 * scale, cy - 2 * scale, cx + 15 * scale, cy - 5 * scale), fill=rgba(0xE4D1B2), width=max(1, int(2 * scale)))


def draw_food_setting(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale = 1.0, variant = 0) -> None:
  plate_w = 23 * scale
  plate_h = 13 * scale
  draw.ellipse(
    (cx - plate_w / 2 + 2 * scale, cy - plate_h / 2 + 3 * scale, cx + plate_w / 2 + 2 * scale, cy + plate_h / 2 + 3 * scale),
    fill=(63, 45, 36, 34),
  )
  draw.ellipse(
    (cx - plate_w / 2, cy - plate_h / 2, cx + plate_w / 2, cy + plate_h / 2),
    fill=rgba(0xFFFDF2),
    outline=rgba(0xA58A66),
    width=max(1, int(1.6 * scale)),
  )
  draw.ellipse(
    (cx - plate_w * 0.35, cy - plate_h * 0.3, cx + plate_w * 0.35, cy + plate_h * 0.3),
    fill=rgba(0xF5E9CF),
    outline=rgba(0xD2BE92, 210),
    width=1,
  )

  dishes = (
    (0xC96F45, 0x6FA05F, 0xF2C866, "soup"),
    (0xF0CB6A, 0xB85642, 0x6CA867, "pasta"),
    (0x6FA05F, 0xE9D7A7, 0xD45F4D, "salad"),
    (0xB64D55, 0xF7E5A6, 0x6FA05F, "dessert"),
  )
  primary, secondary, garnish, kind = dishes[variant % len(dishes)]
  if kind == "soup":
    draw.ellipse((cx - 6 * scale, cy - 3 * scale, cx + 8 * scale, cy + 5 * scale), fill=rgba(primary))
    draw.arc((cx - 6 * scale, cy - 4 * scale, cx + 8 * scale, cy + 5 * scale), 190, 335, fill=rgba(0xFFF1B0, 170), width=1)
  elif kind == "pasta":
    for offset in (-4, 0, 4):
      draw.arc((cx - 6 * scale + offset * scale, cy - 5 * scale, cx + 8 * scale + offset * scale, cy + 5 * scale), 195, 340, fill=rgba(primary), width=max(1, int(1.3 * scale)))
    draw.ellipse((cx + 2 * scale, cy - 2 * scale, cx + 8 * scale, cy + 3 * scale), fill=rgba(secondary))
  elif kind == "salad":
    for offset, color in ((-5, primary), (-1, garnish), (4, secondary), (7, primary)):
      draw.ellipse((cx + offset * scale - 4 * scale, cy - 3 * scale, cx + offset * scale + 4 * scale, cy + 4 * scale), fill=rgba(color))
  else:
    draw.ellipse((cx - 7 * scale, cy - 2 * scale, cx + 2 * scale, cy + 4 * scale), fill=rgba(primary))
    draw.ellipse((cx + 2 * scale, cy - 5 * scale, cx + 9 * scale, cy + 2 * scale), fill=rgba(secondary))
    draw.ellipse((cx - 1 * scale, cy - 6 * scale, cx + 4 * scale, cy - 2 * scale), fill=rgba(garnish))

  cup_x = cx + 15 * scale
  cup_y = cy - 7 * scale
  draw.ellipse((cup_x - 4 * scale, cup_y - 5 * scale, cup_x + 4 * scale, cup_y + 5 * scale), fill=rgba(0xC7E3E4, 215), outline=rgba(0x6C8E96), width=1)
  draw.ellipse((cup_x - 2 * scale, cup_y - 3 * scale, cup_x + 2 * scale, cup_y + 2 * scale), fill=rgba(0xEAF9F9, 180))
  draw.line((cx - 14 * scale, cy + 6 * scale, cx - 2 * scale, cy + 2 * scale), fill=rgba(0xD8C09C), width=max(1, int(1.5 * scale)))


def draw_small_bottle(draw: ImageDraw.ImageDraw, x: float, y: float, color: int, scale = 1.0) -> None:
  draw.rounded_rectangle((x - 3 * scale, y - 13 * scale, x + 3 * scale, y + 4 * scale), radius=max(1, int(2 * scale)), fill=rgba(color), outline=rgba(0x5B4033), width=1)
  draw.rectangle((x - 2 * scale, y - 18 * scale, x + 2 * scale, y - 12 * scale), fill=rgba(shade(color, -18)), outline=rgba(0x5B4033))
  draw.line((x - 1 * scale, y - 7 * scale, x + 2 * scale, y - 7 * scale), fill=rgba(0xFFF1C6, 150), width=1)


def draw_neutral_shadow(draw: ImageDraw.ImageDraw, cx: float, y: float, w: float, h: float) -> None:
  draw.ellipse((cx - w / 2, y - h / 2, cx + w / 2, y + h / 2), fill=(55, 39, 31, 42))


def overlay_clipped(image: Image.Image, polygon: list[tuple[float, float]], painter: Callable[[ImageDraw.ImageDraw], None]) -> None:
  pattern = Image.new("RGBA", image.size, (0, 0, 0, 0))
  painter(ImageDraw.Draw(pattern))
  mask = Image.new("L", image.size, 0)
  ImageDraw.Draw(mask).polygon(polygon, fill=255)
  clipped = Image.new("RGBA", image.size, (0, 0, 0, 0))
  clipped.paste(pattern, (0, 0), mask)
  image.alpha_composite(clipped)


def draw_leaf(
  draw: ImageDraw.ImageDraw,
  x: float,
  y: float,
  length: float,
  width: float,
  angle: float,
  color: int,
  outline: int | None = None,
  alpha: int = 255,
) -> None:
  dx = math.cos(angle)
  dy = math.sin(angle)
  px = -dy
  py = dx
  base = (x - dx * length * 0.36, y - dy * length * 0.36)
  tip = (x + dx * length * 0.64, y + dy * length * 0.64)
  points = [
    tip,
    (x + px * width * 0.5, y + py * width * 0.5),
    base,
    (x - px * width * 0.5, y - py * width * 0.5),
  ]
  draw.polygon(points, fill=rgba(color, alpha))
  if outline is not None:
    draw.line(points + [points[0]], fill=rgba(outline, min(alpha, 155)), width=1)
  vein_start = (base[0] + dx * length * 0.18, base[1] + dy * length * 0.18)
  vein_end = (tip[0] - dx * length * 0.16, tip[1] - dy * length * 0.16)
  draw.line((vein_start[0], vein_start[1], vein_end[0], vein_end[1]), fill=rgba(shade(color, 34), min(alpha, 150)), width=1)


def draw_vine(
  draw: ImageDraw.ImageDraw,
  start: tuple[float, float],
  points: list[tuple[float, float]],
  color: int,
  leaf_color: int,
) -> None:
  path = [start, *points]
  draw.line(path, fill=rgba(color, 205), width=2)
  for index, point in enumerate(points):
    angle = -0.8 if index % 2 == 0 else -2.25
    draw_leaf(draw, point[0], point[1] - 1, 12, 6, angle, leaf_color, shade(leaf_color, -32), 230)


def polygon_center(points: list[tuple[float, float]]) -> tuple[float, float]:
  return (sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points))


def draw_iso_oval_prism(
  draw: ImageDraw.ImageDraw,
  cx: float,
  cy: float,
  width: float,
  height: float,
  drop: float,
  color: int,
  outline: int = 0x5B4033,
) -> None:
  front = shade(color, -42)
  side = shade(color, -22)
  draw.rounded_rectangle((cx - width / 2, cy - height * 0.08, cx + width / 2, cy + drop), radius=int(max(8, height * 0.36)), fill=rgba(side))
  draw.ellipse((cx - width / 2, cy - height / 2 + drop * 0.54, cx + width / 2, cy + height / 2 + drop * 0.54), fill=rgba(front), outline=rgba(outline), width=2)
  draw.rectangle((cx - width / 2 + 2, cy, cx + width / 2 - 2, cy + drop * 0.55), fill=rgba(front))
  draw.arc((cx - width / 2, cy - height / 2 + drop * 0.54, cx + width / 2, cy + height / 2 + drop * 0.54), 0, 180, fill=rgba(side), width=2)
  draw.ellipse((cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2), fill=rgba(color), outline=rgba(outline), width=2)
  draw.arc((cx - width / 2 + 8, cy - height / 2 + 5, cx + width / 2 - 8, cy + height / 2 - 2), 200, 330, fill=rgba(shade(color, 58), 150), width=3)


def draw_panel_with_thickness(
  draw: ImageDraw.ImageDraw,
  left: tuple[float, float],
  right: tuple[float, float],
  height: float,
  color: int,
  outline: int = 0x5B4033,
  cap_shift: tuple[float, float] = (6, -5),
) -> None:
  left_top = (left[0], left[1] - height)
  right_top = (right[0], right[1] - height)
  sl = (left[0] + cap_shift[0], left[1] + cap_shift[1])
  sr = (right[0] + cap_shift[0], right[1] + cap_shift[1])
  sl_top = (left_top[0] + cap_shift[0], left_top[1] + cap_shift[1])
  sr_top = (right_top[0] + cap_shift[0], right_top[1] + cap_shift[1])
  draw_polygon(draw, [sl_top, sr_top, right_top, left_top], shade(color, 28), outline, 1)
  draw_polygon(draw, [sr_top, sr, right, right_top], shade(color, -34), outline, 1)
  draw_polygon(draw, [left_top, right_top, right, left], color, outline, 2)
  draw.line((left_top[0] + 5, left_top[1] + 8, right_top[0] - 5, right_top[1] + 8), fill=rgba(shade(color, 62), 180), width=3)


def draw_front_posts(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], base_y: float) -> None:
  xs = [points[3][0] + 8, points[2][0] - 8]
  for x in xs:
    draw.rounded_rectangle((x - 3, base_y - 12, x + 3, base_y + 7), radius=3, fill=rgba(0x3F2D24))


def draw_furniture_leg(
  draw: ImageDraw.ImageDraw,
  x: float,
  y: float,
  length = 17,
  color = 0x3F2D24,
  alpha = 255,
  width = 4,
  lean = 0.0,
) -> None:
  foot_x = x + lean
  top_w = width * 0.46
  bottom_w = width * 0.54
  points = [
    (x - top_w, y),
    (x + top_w, y),
    (foot_x + bottom_w, y + length),
    (foot_x - bottom_w, y + length),
  ]
  draw.polygon(points, fill=rgba(shade(color, -32), min(alpha, 170)))
  inset = 0.65
  inner = [
    (x - max(0.8, top_w - inset), y + 1),
    (x + max(0.8, top_w - inset), y + 1),
    (foot_x + max(1, bottom_w - inset), y + length - 1),
    (foot_x - max(1, bottom_w - inset), y + length - 1),
  ]
  draw.polygon(inner, fill=rgba(color, alpha))
  draw.line(
    (x + top_w * 0.25, y + 2, foot_x + bottom_w * 0.08, y + length - 3),
    fill=rgba(shade(color, 42), min(alpha, 150)),
    width=1,
  )
  draw.ellipse(
    (foot_x - bottom_w - 1.4, y + length - 1.4, foot_x + bottom_w + 1.4, y + length + 2.6),
    fill=rgba(0x2F241C, min(alpha, 120)),
  )


def draw_table_supports(
  draw: ImageDraw.ImageDraw,
  top: list[tuple[float, float]],
  drop: int,
  color: int,
  base_y: float,
  floor_center_y: float,
  round_like: bool,
  item_id: str,
) -> None:
  leg_color = 0x4D3428 if "marble" not in item_id else 0x5C5149
  cx, cy = polygon_center(top)
  if round_like:
    pedestal_top = max(y for _, y in top) + drop * 0.18
    pedestal_bottom = floor_center_y
    draw.rounded_rectangle(
      (cx - 6, pedestal_top, cx + 6, pedestal_bottom),
      radius=4,
      fill=rgba(shade(color, -60)),
      outline=rgba(0x3F2D24, 190),
      width=1,
    )
    draw.ellipse((cx - 18, pedestal_bottom - 3, cx + 18, pedestal_bottom + 6), fill=rgba(0x3F2D24, 205))
    draw.ellipse((cx - 14, pedestal_bottom - 5, cx + 14, pedestal_bottom + 4), fill=rgba(shade(color, -44)))
    return

  back_edge = (lerp_tuple(top[0], top[1], 0.18), lerp_tuple(top[0], top[1], 0.82))
  front_edge = (lerp_tuple(top[3], top[2], 0.16), lerp_tuple(top[3], top[2], 0.84))
  back_floor_y = floor_center_y - 8
  front_floor_y = floor_center_y + 10
  for x, y in back_edge:
    leg_top = y + drop * 0.72
    draw_furniture_leg(draw, x, leg_top, max(14, back_floor_y - leg_top), leg_color, 175, 3.6, 0.18)
  for x, y in front_edge:
    leg_top = y + drop * 0.9
    draw_furniture_leg(draw, x, leg_top, max(16, front_floor_y - leg_top), leg_color, 245, 4.1, 0.22)


def draw_surface_grain(draw: ImageDraw.ImageDraw, quad: list[tuple[float, float]], color: int, tier: int, dense = False) -> None:
  line_color = shade(color, -32)
  highlight = shade(color, 48)
  for v in (0.22, 0.42, 0.62, 0.8):
    a = point_in_quad(quad, 0.12, v)
    b = point_in_quad(quad, 0.88, v + (0.025 if dense else 0))
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(line_color, 42 + tier * 8), width=1)
  for u in (0.26, 0.52, 0.74):
    a = point_in_quad(quad, u, 0.2)
    b = point_in_quad(quad, u + 0.03, 0.82)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(highlight, 36 + tier * 7), width=1)
  if dense or tier >= 3:
    for u, v, length in ((0.22, 0.34, 0.22), (0.58, 0.28, 0.18), (0.68, 0.62, 0.22), (0.36, 0.72, 0.16)):
      start = point_in_quad(quad, u, v)
      end = point_in_quad(quad, min(0.9, u + length), v + 0.03)
      draw.arc((start[0] - 5, start[1] - 4, end[0] + 5, end[1] + 4), 190, 345, fill=rgba(line_color, 48), width=1)


def draw_tablecloth(draw: ImageDraw.ImageDraw, top: list[tuple[float, float]], drop: int, item: FurnitureItem, round_like: bool) -> None:
  if "crate" in item.id:
    return

  cloth_by_style = {
    "linen-table": (0xF8EFE2, 0xD47A76, "full"),
    "family-table": (0xF4E6D4, 0x76A68E, "runner"),
    "painted-table": (0xFFF0C7, 0xD67F7A, "runner"),
    "booth-table": (0xEFE3D1, 0xC98066, "runner"),
    "chef-table": (0xF5E8D6, 0x2F5260, "runner"),
    "marble-table": (0xFAF4E7, 0xC9D8D2, "mat"),
  }
  cloth_color, accent, style = cloth_by_style.get(
    item.id,
    (0xF7E9D6 if item.tier <= 2 else 0xF8EFE2, 0x89AFA1 if item.tier <= 3 else 0xD67F7A, "full" if item.tier >= 2 else "mat"),
  )
  cx, cy = polygon_center(top)

  if round_like:
    bounds_w = max(x for x, _ in top) - min(x for x, _ in top)
    bounds_h = max(y for _, y in top) - min(y for _, y in top)
    oval_w = min(bounds_w * 0.88, bounds_h * 2.24)
    oval_h = min(bounds_h * 0.86, bounds_w * 0.58)
    draw.ellipse(
      (cx - oval_w / 2, cy - oval_h / 2 + drop * 0.12, cx + oval_w / 2, cy + oval_h / 2 + drop * 0.12),
      fill=rgba(shade(cloth_color, -28), 225),
      outline=rgba(0xC6B59B, 190),
      width=1,
    )
    draw.ellipse(
      (cx - oval_w / 2, cy - oval_h / 2, cx + oval_w / 2, cy + oval_h / 2),
      fill=rgba(cloth_color),
      outline=rgba(0xC6B59B),
      width=2,
    )
    draw.ellipse((cx - oval_w * 0.28, cy - oval_h * 0.2, cx + oval_w * 0.28, cy + oval_h * 0.2), outline=rgba(accent, 155), width=2)
    for offset in (-0.26, 0, 0.26):
      draw.arc(
        (cx - oval_w * 0.42 + offset * oval_w, cy - oval_h * 0.2, cx - oval_w * 0.18 + offset * oval_w, cy + oval_h * 0.4),
        40,
        150,
        fill=rgba(accent, 95),
        width=1,
      )
    for ratio in (0.18, 0.36, 0.64, 0.82):
      x = cx - oval_w / 2 + oval_w * ratio
      draw.line((x - 3, cy - oval_h * 0.36, x + 3, cy + oval_h * 0.38), fill=rgba(accent, 62), width=1)
    return

  if style == "mat":
    cloth = [
      point_in_quad(top, 0.12, 0.17),
      point_in_quad(top, 0.88, 0.17),
      point_in_quad(top, 0.88, 0.83),
      point_in_quad(top, 0.12, 0.83),
    ]
    draw_polygon(draw, cloth, cloth_color, 0xC6B59B, 1)
    draw.line(cloth + [cloth[0]], fill=rgba(accent, 135), width=1)
    return

  if style == "runner":
    runner = [
      point_in_quad(top, 0.1, 0.3),
      point_in_quad(top, 0.9, 0.3),
      point_in_quad(top, 0.84, 0.7),
      point_in_quad(top, 0.16, 0.7),
    ]
    draw_polygon(draw, runner, cloth_color, 0xC6B59B, 1)
    draw.line((runner[0][0] + 5, runner[0][1] + 2, runner[1][0] - 5, runner[1][1] + 2), fill=rgba(accent, 150), width=2)
    draw.line((runner[3][0] + 5, runner[3][1] - 2, runner[2][0] - 5, runner[2][1] - 2), fill=rgba(accent, 125), width=2)
    return

  cloth = inset_points(top, 0.05)
  front_drop = min(drop * 0.72, 12)
  side_drop = min(drop * 0.52, 9)
  front_panel = [cloth[3], cloth[2], (cloth[2][0], cloth[2][1] + front_drop), (cloth[3][0], cloth[3][1] + front_drop)]
  side_panel = [cloth[1], cloth[2], (cloth[2][0], cloth[2][1] + side_drop), (cloth[1][0], cloth[1][1] + side_drop)]
  draw.polygon(side_panel, fill=rgba(shade(cloth_color, -22), 235))
  draw.line(side_panel + [side_panel[0]], fill=rgba(0xC6B59B, 145), width=1)
  draw.polygon(front_panel, fill=rgba(shade(cloth_color, -34), 245))
  draw.line(front_panel + [front_panel[0]], fill=rgba(0xC6B59B, 170), width=1)
  for ratio in (0.25, 0.5, 0.75):
    a = lerp_tuple(front_panel[0], front_panel[1], ratio)
    b = lerp_tuple(front_panel[3], front_panel[2], ratio)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(accent, 95), width=1)
  for ratio in (0.12, 0.28, 0.44, 0.6, 0.76, 0.9):
    a = point_in_quad(cloth, ratio, 0.08)
    b = point_in_quad(cloth, ratio, 0.92)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(accent, 45), width=1)
  draw_polygon(draw, cloth, cloth_color, 0xC6B59B, 1)
  inner = inset_points(cloth, 0.16)
  draw.line(inner + [inner[0]], fill=rgba(accent, 145), width=2)
  if item.tier >= 3:
    lace = inset_points(cloth, 0.08)
    for edge_start, edge_end in ((lace[0], lace[1]), (lace[3], lace[2])):
      for step in range(7):
        t = (step + 0.5) / 7
        bead = lerp_tuple(edge_start, edge_end, t)
        draw.ellipse((bead[0] - 1.5, bead[1] - 1, bead[0] + 1.5, bead[1] + 1), fill=rgba(0xFFF8EA, 155))


def get_table_service_points(top: list[tuple[float, float]], item: FurnitureItem) -> list[tuple[float, float, int]]:
  capacity = item.table_seat_capacity or (6 if item.width + item.height >= 5 else 4 if item.width == item.height else 2)
  if capacity <= 2:
    layout = [(0.5, 0.28), (0.5, 0.72)]
  elif capacity <= 4:
    layout = [(0.28, 0.3), (0.72, 0.3), (0.28, 0.7), (0.72, 0.7)]
  else:
    layout = [(0.22, 0.3), (0.5, 0.3), (0.78, 0.3), (0.22, 0.7), (0.5, 0.7), (0.78, 0.7)]
  return [(point_in_quad(top, u, v)[0], point_in_quad(top, u, v)[1], index + item.tier) for index, (u, v) in enumerate(layout[:capacity])]


def draw_chair_legs(
  draw: ImageDraw.ImageDraw,
  top: list[tuple[float, float]],
  back_edge: tuple[tuple[float, float], tuple[float, float]],
  front_edge: tuple[tuple[float, float], tuple[float, float]],
  drop: int,
  item_color: int,
) -> None:
  leg_color = 0x3F2D24
  back_left = lerp_tuple(back_edge[0], back_edge[1], 0.24)
  back_right = lerp_tuple(back_edge[0], back_edge[1], 0.76)
  front_left = lerp_tuple(front_edge[0], front_edge[1], 0.24)
  front_right = lerp_tuple(front_edge[0], front_edge[1], 0.76)
  floor_y = max(y for _, y in top) + 18
  for x, y in (back_left, back_right):
    leg_top = y + drop + 1
    draw_furniture_leg(draw, x, leg_top, max(11, floor_y - leg_top), leg_color, 180, 3.0, 0.04)
  for x, y in (front_left, front_right):
    leg_top = y + drop + 1
    draw_furniture_leg(draw, x, leg_top, max(12, floor_y - leg_top), leg_color, 240, 3.2, 0.06)


def project_from_floor_origin(
  origin: tuple[float, float],
  u: float,
  v: float,
  z: float = 0,
) -> tuple[float, float]:
  return (
    origin[0] + (u - v) * TILE_W / 2,
    origin[1] + (u + v) * TILE_H / 2 - z,
  )


def local_floor_quad(
  origin: tuple[float, float],
  u1: float,
  v1: float,
  u2: float,
  v2: float,
  z: float = 0,
) -> list[tuple[float, float]]:
  return [
    project_from_floor_origin(origin, u1, v1, z),
    project_from_floor_origin(origin, u2, v1, z),
    project_from_floor_origin(origin, u2, v2, z),
    project_from_floor_origin(origin, u1, v2, z),
  ]


def draw_projected_leg(
  draw: ImageDraw.ImageDraw,
  top: tuple[float, float],
  foot: tuple[float, float],
  color = 0x3F2D24,
  width = 4.0,
  alpha = 235,
) -> None:
  dx = foot[0] - top[0]
  dy = foot[1] - top[1]
  length = max(1, math.hypot(dx, dy))
  nx = -dy / length
  ny = dx / length
  top_w = width * 0.42
  foot_w = width * 0.58
  outer = [
    (top[0] - nx * top_w, top[1] - ny * top_w),
    (top[0] + nx * top_w, top[1] + ny * top_w),
    (foot[0] + nx * foot_w, foot[1] + ny * foot_w),
    (foot[0] - nx * foot_w, foot[1] - ny * foot_w),
  ]
  inner = [
    (top[0] - nx * max(0.7, top_w - 0.8), top[1] - ny * max(0.7, top_w - 0.8) + 1),
    (top[0] + nx * max(0.7, top_w - 0.8), top[1] + ny * max(0.7, top_w - 0.8) + 1),
    (foot[0] + nx * max(0.8, foot_w - 0.8), foot[1] + ny * max(0.8, foot_w - 0.8) - 1),
    (foot[0] - nx * max(0.8, foot_w - 0.8), foot[1] - ny * max(0.8, foot_w - 0.8) - 1),
  ]
  draw.polygon(outer, fill=rgba(shade(color, -34), min(alpha, 190)))
  draw.polygon(inner, fill=rgba(color, alpha))
  draw.line((top[0] + nx * 0.5, top[1] + 3, foot[0] + nx * 0.35, foot[1] - 4), fill=rgba(shade(color, 42), min(alpha, 145)), width=1)
  draw.ellipse((foot[0] - foot_w - 1, foot[1] - 2, foot[0] + foot_w + 1, foot[1] + 3), fill=rgba(0x2F241C, min(alpha, 115)))


def draw_projected_prism(
  draw: ImageDraw.ImageDraw,
  top: list[tuple[float, float]],
  drop: float,
  color: int,
  outline = 0x5B4033,
) -> list[tuple[float, float]]:
  bottom = [(x, y + drop) for x, y in top]
  draw_polygon(draw, [top[1], top[2], bottom[2], bottom[1]], shade(color, -28), outline, 1)
  draw_polygon(draw, [top[2], top[3], bottom[3], bottom[2]], shade(color, -48), outline, 1)
  draw_polygon(draw, top, color, outline, 2)
  return bottom


def projected_prism_faces(
  top: list[tuple[float, float]],
  drop: float,
) -> tuple[list[tuple[float, float]], list[tuple[float, float]], list[tuple[float, float]]]:
  bottom = [(x, y + drop) for x, y in top]
  front_face = [top[3], top[2], bottom[2], bottom[3]]
  side_face = [top[1], top[2], bottom[2], bottom[1]]
  return bottom, front_face, side_face


def draw_top_bevel(
  draw: ImageDraw.ImageDraw,
  top: list[tuple[float, float]],
  color: int,
  tier: int,
) -> None:
  bevel = inset_points(top, 0.08)
  inner = inset_points(top, 0.22)
  draw.line(bevel + [bevel[0]], fill=rgba(shade(color, 58), 125), width=2)
  draw.line(inner + [inner[0]], fill=rgba(shade(color, -28), 95), width=1)
  draw_surface_grain(draw, inset_points(top, 0.12), color, tier, False)


def sprite_canvas_for(item: FurnitureItem, rotation: int, drop: int, extra_top = 24) -> tuple[Image.Image, ImageDraw.ImageDraw, list[tuple[float, float]], float]:
  w_cells, h_cells = rotated_size(item, rotation)
  raw_top = area_points(w_cells, h_cells)
  min_x = min(x for x, _ in raw_top)
  max_x = max(x for x, _ in raw_top)
  max_y = max(y for _, y in raw_top)
  canvas_w = int(max(80, max_x - min_x + 54))
  x_offset = (canvas_w - (max_x - min_x)) / 2 - min_x
  top = [(x + x_offset, y + extra_top) for x, y in raw_top]
  base_y = extra_top + max_y + drop
  canvas_h = int(max(78, base_y + 12))
  image = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
  set_sprite_metadata(image, polygon_center(top))
  return image, ImageDraw.Draw(image), top, base_y


def draw_floor_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  w_cells, h_cells = rotated_size(item, rotation)
  raw_top = area_points(w_cells, h_cells)
  min_x = min(x for x, _ in raw_top)
  max_x = max(x for x, _ in raw_top)
  max_y = max(y for _, y in raw_top)
  image = Image.new("RGBA", (int(max_x - min_x + 12), int(max_y + 12)), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  top = [(x - min_x + 6, y + 6) for x, y in raw_top]
  set_sprite_metadata(image, polygon_center(top))
  draw_polygon(draw, top, item.color, shade(item.color, -28), 1)
  center = polygon_center(top)
  inset = [(x * 0.88 + center[0] * 0.12, y * 0.88 + center[1] * 0.12) for x, y in top]
  draw.line(inset + [inset[0]], fill=rgba(shade(item.color, 30), 110), width=1)
  min_px = min(x for x, _ in top)
  max_px = max(x for x, _ in top)
  min_py = min(y for _, y in top)
  max_py = max(y for _, y in top)

  def wood_pattern(pattern_draw: ImageDraw.ImageDraw) -> None:
    for i in range(-2, 7):
      offset = i / 6
      a = lerp_tuple(top[3], top[0], offset)
      b = lerp_tuple(top[2], top[1], offset)
      pattern_draw.line((a[0] + 3, a[1], b[0] - 3, b[1]), fill=rgba(shade(item.color, -34), 125), width=1)
    for i in range(3):
      u = (i + 1) / 4
      a = point_in_quad(top, u, 0.12)
      b = point_in_quad(top, u, 0.9)
      pattern_draw.line((a[0], a[1], b[0], b[1]), fill=rgba(shade(item.color, 22), 85), width=1)
    for i in range(4):
      knot = point_in_quad(top, (i % 2) * 0.5 + 0.25, 0.2 + i * 0.16)
      pattern_draw.ellipse((knot[0] - 3, knot[1] - 1.5, knot[0] + 3, knot[1] + 1.5), outline=rgba(shade(item.color, -46), 70), width=1)

  def mosaic_pattern(pattern_draw: ImageDraw.ImageDraw) -> None:
    accent = shade(item.color, 42)
    dark = shade(item.color, -36)
    for i in range(1, 4):
      a = lerp_tuple(top[0], top[1], i / 4)
      b = lerp_tuple(top[3], top[2], i / 4)
      pattern_draw.line((a[0], a[1], b[0], b[1]), fill=rgba(dark, 105), width=1)
      c = lerp_tuple(top[0], top[3], i / 4)
      d = lerp_tuple(top[1], top[2], i / 4)
      pattern_draw.line((c[0], c[1], d[0], d[1]), fill=rgba(dark, 105), width=1)
    for u, v, color in ((0.28, 0.3, 0xDFA36F), (0.62, 0.36, accent), (0.42, 0.68, 0xF1E3B8), (0.72, 0.72, 0x8CB5B0)):
      x, y = point_in_quad(top, u, v)
      pattern_draw.polygon([(x, y - 4), (x + 7, y), (x, y + 4), (x - 7, y)], fill=rgba(color, 150))

  def stone_pattern(pattern_draw: ImageDraw.ImageDraw) -> None:
    for i in range(1, 4):
      a = (min_px + i * (max_px - min_px) / 4, min_py)
      b = (min_px + (i - 0.35) * (max_px - min_px) / 4, max_py)
      pattern_draw.line((a[0], a[1], b[0], b[1]), fill=rgba(shade(item.color, -44), 90), width=1)
    for i in range(3):
      y = min_py + (i + 1) * (max_py - min_py) / 4
      pattern_draw.line((min_px + 8, y, max_px - 8, y + (4 if i % 2 else -4)), fill=rgba(shade(item.color, 34), 85), width=1)

  if "mosaic" in item.id or "painted" in item.id:
    overlay_clipped(image, top, mosaic_pattern)
  elif "stone" in item.id:
    overlay_clipped(image, top, stone_pattern)
  else:
    overlay_clipped(image, top, wood_pattern)
  return image


def draw_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  if item.id == "crate-table":
    return draw_crate_table_sprite(item, rotation)
  if item.id == "two-top-table":
    return draw_two_top_table_sprite(item, rotation)
  if item.id == "round-table":
    return draw_round_table_sprite(item, rotation)
  if item.id == "square-table":
    return draw_square_table_sprite(item, rotation)
  if item.id == "painted-table":
    return draw_painted_table_sprite(item, rotation)

  w_cells, h_cells = rotated_size(item, rotation)
  drop = min(15, 9 + item.tier)
  table_height = 31 + item.tier * 2
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin_u = 0.16 if w_cells <= 1 else 0.18
  margin_v = 0.16 if h_cells <= 1 else 0.18
  top = local_floor_quad(origin, margin_u, margin_v, w_cells - margin_u, h_cells - margin_v, table_height)
  cx, cy = polygon_center(top)
  w_cells, h_cells = rotated_size(item, rotation)
  bounds_w = max(x for x, _ in top) - min(x for x, _ in top)
  bounds_h = max(y for _, y in top) - min(y for _, y in top)
  draw_neutral_shadow(draw, floor_center[0] + 7, floor_center[1] + 11, image.size[0] * 0.46, 12)
  round_like = ("round" in item.id) and item.width == item.height

  leg_color = 0x4D3428 if "marble" not in item.id else 0x5C5149
  if round_like:
    pedestal_top = project_from_floor_origin(origin, w_cells / 2, h_cells / 2, table_height - drop * 0.4)
    pedestal_foot = project_from_floor_origin(origin, w_cells / 2, h_cells / 2, 0)
    draw.rounded_rectangle(
      (pedestal_top[0] - 7, pedestal_top[1], pedestal_top[0] + 7, pedestal_foot[1] + 2),
      radius=5,
      fill=rgba(shade(item.color, -62)),
      outline=rgba(0x3F2D24, 190),
      width=1,
    )
    draw.ellipse((pedestal_foot[0] - 20, pedestal_foot[1] - 4, pedestal_foot[0] + 20, pedestal_foot[1] + 6), fill=rgba(0x3F2D24, 180))
    draw.ellipse((pedestal_foot[0] - 15, pedestal_foot[1] - 6, pedestal_foot[0] + 15, pedestal_foot[1] + 3), fill=rgba(shade(item.color, -44)))
  else:
    leg_margin_u = margin_u + 0.08
    leg_margin_v = margin_v + 0.08
    for u, v, alpha in (
      (leg_margin_u, leg_margin_v, 170),
      (w_cells - leg_margin_u, leg_margin_v, 185),
      (leg_margin_u, h_cells - leg_margin_v, 235),
      (w_cells - leg_margin_u, h_cells - leg_margin_v, 245),
    ):
      foot = project_from_floor_origin(origin, u, v, 0)
      leg_top = project_from_floor_origin(origin, u, v, table_height - drop + 1)
      draw_projected_leg(draw, leg_top, foot, leg_color, 4.0, alpha)

  if round_like:
    oval_w = min(bounds_w * 0.78, bounds_h * 2.0)
    oval_h = min(bounds_h * 0.78, bounds_w * 0.5)
    draw_iso_oval_prism(draw, cx, cy, oval_w, oval_h, drop, item.color)
    draw.ellipse((cx - oval_w * 0.33, cy - oval_h * 0.22, cx + oval_w * 0.33, cy + oval_h * 0.22), outline=rgba(shade(item.color, 52), 140), width=2)
    for offset in (-0.28, 0, 0.28):
      draw.arc(
        (cx - oval_w * (0.42 - offset * 0.15), cy - oval_h * 0.26, cx + oval_w * (0.12 + offset * 0.15), cy + oval_h * 0.24),
        195,
        342,
        fill=rgba(shade(item.color, -30), 46 + item.tier * 7),
        width=1,
      )
  else:
    draw_projected_prism(draw, top, drop, item.color)
    draw_top_bevel(draw, top, item.color, item.tier)
    apron_left = lerp_tuple(top[3], top[2], 0.08)
    apron_right = lerp_tuple(top[3], top[2], 0.92)
    draw.line((apron_left[0], apron_left[1] + drop * 0.48, apron_right[0], apron_right[1] + drop * 0.48), fill=rgba(shade(item.color, -62), 120), width=1)
    if item.tier <= 2:
      for ratio in (0.28, 0.58):
        a = lerp_tuple(top[3], top[0], ratio)
        b = lerp_tuple(top[2], top[1], ratio)
        draw.line((a[0] + 7, a[1], b[0] - 7, b[1]), fill=rgba(shade(item.color, 24), 80), width=1)
    if "booth" in item.id or "family" in item.id:
      draw.line((top[0][0] + 10, top[0][1] + 7, top[1][0] - 10, top[1][1] + 7), fill=rgba(shade(item.color, 44), 150), width=3)
    if "painted" in item.id:
      for ratio in (0.28, 0.5, 0.72):
        a = lerp_tuple(top[3], top[0], ratio)
        b = lerp_tuple(top[2], top[1], ratio)
        draw.line((a[0] + 5, a[1], b[0] - 5, b[1]), fill=rgba(0xFFF1C6, 120), width=2)
  draw_tablecloth(draw, top, drop, item, round_like)
  setting_points = get_table_service_points(top, item)
  if "crate" in item.id:
    for ratio in (0.35, 0.66):
      a = lerp_tuple(top[3], top[0], ratio)
      b = lerp_tuple(top[2], top[1], ratio)
      draw.line((a[0], a[1], b[0], b[1]), fill=rgba(shade(item.color, -48), 120), width=2)
  if item.tier >= 3:
    vase = [(cx - 4, cy - 14), (cx + 6, cy - 12), (cx + 4, cy + 2), (cx - 6, cy)]
    draw_polygon(draw, vase, 0x6FA085, 0x496A58, 1)
    for angle in (-1.4, -0.7, -2.3):
      draw_leaf(draw, cx + math.cos(angle) * 7, cy - 16 + math.sin(angle) * 4, 12, 5, angle, 0x6DA05E, 0x416542, 220)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.72 if item.width + item.height < 5 else 0.62, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


# === Tier-1 table specializations ============================================
#
# These dedicated drawers replace the generic draw_table_sprite path for the
# two tier-1 tables. They establish the art-direction vocabulary the rest of
# the furniture upgrade will follow: visible material character (planks, grain,
# brass), strong silhouette, hand-painted accent stripes, consistent contact
# shadow + top-left light direction.


# Crate Table palette
CRATE_PLANK_TOP = 0xA88060      # warm reclaimed-wood top plank
CRATE_PLANK_HIGHLIGHT = 0xC79A78  # sun-bleached crest along plank edges
CRATE_BODY = 0x7C5938           # darker side faces (in shadow)
CRATE_BODY_DEEP = 0x5C402A      # right-side face (deepest shadow)
CRATE_SEAM = 0x2F1F15           # near-black plank gap
CRATE_STAMP = 0x3A4E78          # faded indigo brand mark
CRATE_NAIL = 0x3A2A1F           # nail/dot color


def draw_crate_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  """Repurposed wooden crate used as a small 2-seat table.

  Box-with-visible-sides rendering instead of a pedestal: a 1x1 crate sits
  on the floor with its top, left face, and right face visible. The top
  shows 3 plank seams perpendicular to the long axis; the side faces show
  horizontal slat lines and a faded brand stamp.
  """
  drop = 18  # tall enough to read as a box, not a flat tile
  table_height = 26  # crate top is lower than a true table — it's a stool-table
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  # The crate fills its 1x1 tile with a small margin so it doesn't look pinched.
  margin = 0.12
  top = local_floor_quad(origin, margin, margin, 1 - margin, 1 - margin, table_height)
  bottom = [(x, y + drop) for x, y in top]
  draw_neutral_shadow(draw, floor_center[0] + 6, floor_center[1] + 10, image.size[0] * 0.42, 11)

  # Side faces: front (top[3]-top[2] edge → forward in iso) and right.
  front_face = [top[3], top[2], bottom[2], bottom[3]]
  right_face = [top[2], top[1], bottom[1], bottom[2]]
  draw_polygon(draw, right_face, CRATE_BODY_DEEP, CRATE_SEAM, 1)
  draw_polygon(draw, front_face, CRATE_BODY, CRATE_SEAM, 1)
  # Top: plank base, then plank seams across it.
  draw_polygon(draw, top, CRATE_PLANK_TOP, CRATE_SEAM, 1)

  # Plank seams on the top — run parallel to the front edge (top[2]-top[3]).
  # 3 planks → 2 seams at 1/3 and 2/3 of the way back.
  for ratio in (0.34, 0.67):
    a = lerp_tuple(top[0], top[3], ratio)
    b = lerp_tuple(top[1], top[2], ratio)
    # Dark seam
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(CRATE_SEAM, 220), width=2)
    # Highlight crest just above seam
    ah = lerp_tuple(top[0], top[3], ratio - 0.04)
    bh = lerp_tuple(top[1], top[2], ratio - 0.04)
    draw.line((ah[0] + 1, ah[1], bh[0] - 1, bh[1]), fill=rgba(CRATE_PLANK_HIGHLIGHT, 100), width=1)

  # Top edge bevel (lighter rim catching the light)
  bevel = inset_points(top, 0.06)
  draw.line(bevel + [bevel[0]], fill=rgba(CRATE_PLANK_HIGHLIGHT, 130), width=1)

  # Slat boards on the visible side faces — two horizontal lines each face
  for face in (front_face, right_face):
    for v_ratio in (0.32, 0.68):
      a = lerp_tuple(face[0], face[3], v_ratio)
      b = lerp_tuple(face[1], face[2], v_ratio)
      draw.line((a[0] + 2, a[1], b[0] - 2, b[1]), fill=rgba(CRATE_SEAM, 165), width=1)
      # Subtle highlight one px above each slat
      draw.line((a[0] + 2, a[1] - 1, b[0] - 2, b[1] - 1), fill=rgba(CRATE_PLANK_HIGHLIGHT, 65), width=1)

  # Nail dots on the corners of each plank board (front face)
  for v_ratio in (0.18, 0.82):
    for u_ratio in (0.12, 0.88):
      px = lerp_tuple(lerp_tuple(front_face[0], front_face[1], u_ratio),
                     lerp_tuple(front_face[3], front_face[2], u_ratio), v_ratio)
      draw.ellipse((px[0] - 1, px[1] - 1, px[0] + 1, px[1] + 1), fill=rgba(CRATE_NAIL, 200))

  # Faded brand stamp on the front face — three short horizontal strokes suggesting "CRATE"
  stamp_center = lerp_tuple(lerp_tuple(front_face[0], front_face[1], 0.5),
                            lerp_tuple(front_face[3], front_face[2], 0.5), 0.5)
  for off, length in ((-3, 6), (1, 5), (5, 7)):
    draw.line(
      (stamp_center[0] - length, stamp_center[1] + off,
       stamp_center[0] + length, stamp_center[1] + off),
      fill=rgba(CRATE_STAMP, 110),
      width=1,
    )

  # Plate settings — same call as the generic table path.
  setting_points = get_table_service_points(top, item)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.72, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


# Two-Top Table palette
TWO_TOP_WOOD = 0xC48458         # light cafe wood top
TWO_TOP_GRAIN_DARK = 0x7C5031   # dark grain lines
TWO_TOP_GRAIN_LIGHT = 0xE3B888  # warm grain highlight
TWO_TOP_BRASS = 0xC79658        # brass trim around the top edge
TWO_TOP_BRASS_DARK = 0x8C683B   # shadowed underside of brass
TWO_TOP_LEG = 0x5B4033          # walnut leg
TWO_TOP_LEG_SHADOW = 0x3E2A1D
TWO_TOP_LINEN = 0xF8EFE2        # cream linen runner
TWO_TOP_LINEN_SHADOW = 0xDDCBAA
TWO_TOP_RUNNER_STRIPE = 0x2F5C78  # indigo stripe (matches waiterBlue)


def draw_two_top_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  """Small cafe two-top: light wood, brass-trimmed edge, cream linen runner."""
  w_cells, h_cells = rotated_size(item, rotation)
  drop = 11
  table_height = 33
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin_u = 0.16
  margin_v = 0.18 if h_cells > 1 else 0.16
  top = local_floor_quad(origin, margin_u, margin_v, w_cells - margin_u, h_cells - margin_v, table_height)
  cx, cy = polygon_center(top)
  draw_neutral_shadow(draw, floor_center[0] + 7, floor_center[1] + 10, image.size[0] * 0.48, 11)

  # Solid tapered legs at the 4 corners (slightly inset).
  leg_inset_u = margin_u + 0.06
  leg_inset_v = margin_v + 0.06
  for u, v, alpha in (
    (leg_inset_u, leg_inset_v, 195),
    (w_cells - leg_inset_u, leg_inset_v, 210),
    (leg_inset_u, h_cells - leg_inset_v, 240),
    (w_cells - leg_inset_u, h_cells - leg_inset_v, 250),
  ):
    foot = project_from_floor_origin(origin, u, v, 0)
    leg_top = project_from_floor_origin(origin, u, v, table_height - drop + 2)
    draw_projected_leg(draw, leg_top, foot, TWO_TOP_LEG, 4.4, alpha)
    # Brass foot cap
    draw.ellipse((foot[0] - 4, foot[1] - 1, foot[0] + 4, foot[1] + 3), fill=rgba(TWO_TOP_BRASS, 190))

  # Top + side faces using the standard projected prism.
  draw_projected_prism(draw, top, drop, TWO_TOP_WOOD)

  # Wood grain on the top — long lines along the long axis (the v direction).
  for u_ratio in (0.18, 0.32, 0.48, 0.62, 0.78):
    a = point_in_quad(top, u_ratio, 0.1)
    b = point_in_quad(top, u_ratio + 0.02, 0.9)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(TWO_TOP_GRAIN_DARK, 70), width=1)
  for u_ratio in (0.26, 0.54, 0.72):
    a = point_in_quad(top, u_ratio, 0.2)
    b = point_in_quad(top, u_ratio + 0.015, 0.82)
    draw.line((a[0] + 1, a[1], b[0], b[1]), fill=rgba(TWO_TOP_GRAIN_LIGHT, 95), width=1)
  # Two knot ovals for character
  for u, v in ((0.4, 0.32), (0.62, 0.7)):
    kx, ky = point_in_quad(top, u, v)
    draw.ellipse((kx - 3, ky - 1.4, kx + 3, ky + 1.4), outline=rgba(TWO_TOP_GRAIN_DARK, 90), width=1)

  # Brass trim around the top edge — two-line bevel
  bevel_outer = inset_points(top, 0.04)
  bevel_inner = inset_points(top, 0.09)
  draw.line(bevel_outer + [bevel_outer[0]], fill=rgba(TWO_TOP_BRASS, 215), width=2)
  draw.line(bevel_inner + [bevel_inner[0]], fill=rgba(TWO_TOP_BRASS_DARK, 130), width=1)

  # Linen runner across the LONG axis (between the two seats).
  # The two-top is 1 wide × 2 long; runner covers ~the middle in the v direction.
  # Use quad-relative coords: runner spans u=0.18..0.82, v=0.32..0.68.
  runner = [
    point_in_quad(top, 0.18, 0.34),
    point_in_quad(top, 0.82, 0.34),
    point_in_quad(top, 0.82, 0.66),
    point_in_quad(top, 0.18, 0.66),
  ]
  # Shadow strip just below the runner — gives it a sense of weight.
  shadow_quad = [(x, y + 1.5) for x, y in runner]
  draw_polygon(draw, shadow_quad, TWO_TOP_LINEN_SHADOW, TWO_TOP_LINEN_SHADOW, 0)
  draw_polygon(draw, runner, TWO_TOP_LINEN, 0xC6B59B, 1)
  # Indigo stripe along the runner long axis (two thin stripes inset from the edges).
  stripe_a_start = lerp_tuple(runner[0], runner[3], 0.18)
  stripe_a_end = lerp_tuple(runner[1], runner[2], 0.18)
  stripe_b_start = lerp_tuple(runner[0], runner[3], 0.82)
  stripe_b_end = lerp_tuple(runner[1], runner[2], 0.82)
  draw.line((stripe_a_start[0] + 3, stripe_a_start[1], stripe_a_end[0] - 3, stripe_a_end[1]),
            fill=rgba(TWO_TOP_RUNNER_STRIPE, 175), width=1)
  draw.line((stripe_b_start[0] + 3, stripe_b_start[1], stripe_b_end[0] - 3, stripe_b_end[1]),
            fill=rgba(TWO_TOP_RUNNER_STRIPE, 175), width=1)

  # Plates at the standard service points.
  setting_points = get_table_service_points(top, item)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.74, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


# === Tier-2 table specializations ============================================
#
# Tier-2 tables introduce: brass-trimmed top edges, full linen cloth coverage,
# small centerpiece detail, and (for painted) a chalk-paint finish in a
# distinct hue. Same lighting / contact-shadow / palette pattern as tier-1.


# Round Table palette
ROUND_WOOD = 0xB8774F           # warm brown body wood
ROUND_WOOD_DARK = 0x73482E      # pedestal in shadow
ROUND_BRASS = 0xC79658          # pedestal cap + bevel trim
ROUND_BRASS_DARK = 0x8C683B
ROUND_CLOTH = 0xF7E9D6          # cream linen
ROUND_CLOTH_SHADOW = 0xD9C9A7
ROUND_CLOTH_STRIPE = 0x89AFA1   # soft sage stripe
ROUND_CENTERPIECE = 0xC9826C    # terracotta sugar-shaker
ROUND_CENTERPIECE_LID = 0xD7B188


def draw_round_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  """Round cafe table on a brass-capped pedestal with a full cream linen cloth."""
  w_cells, h_cells = rotated_size(item, rotation)
  drop = 12
  table_height = 33
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin = 0.18
  top = local_floor_quad(origin, margin, margin, w_cells - margin, h_cells - margin, table_height)
  cx, cy = polygon_center(top)
  bounds_w = max(x for x, _ in top) - min(x for x, _ in top)
  bounds_h = max(y for _, y in top) - min(y for _, y in top)
  draw_neutral_shadow(draw, floor_center[0] + 8, floor_center[1] + 12, image.size[0] * 0.5, 13)

  # Pedestal column: dark wood, brass cap at top, foot disc on floor.
  pedestal_top = project_from_floor_origin(origin, w_cells / 2, h_cells / 2, table_height - drop * 0.4)
  pedestal_foot = project_from_floor_origin(origin, w_cells / 2, h_cells / 2, 0)
  draw.rounded_rectangle(
    (pedestal_top[0] - 7, pedestal_top[1], pedestal_top[0] + 7, pedestal_foot[1] + 2),
    radius=5,
    fill=rgba(ROUND_WOOD_DARK),
    outline=rgba(0x3F2D24, 200),
    width=1,
  )
  # Brass cap just under the top
  draw.rounded_rectangle(
    (pedestal_top[0] - 8, pedestal_top[1] - 1, pedestal_top[0] + 8, pedestal_top[1] + 4),
    radius=2,
    fill=rgba(ROUND_BRASS, 230),
    outline=rgba(ROUND_BRASS_DARK, 180),
    width=1,
  )
  # Foot disc on the floor
  draw.ellipse(
    (pedestal_foot[0] - 22, pedestal_foot[1] - 4, pedestal_foot[0] + 22, pedestal_foot[1] + 7),
    fill=rgba(0x3F2D24, 175),
  )
  draw.ellipse(
    (pedestal_foot[0] - 17, pedestal_foot[1] - 6, pedestal_foot[0] + 17, pedestal_foot[1] + 4),
    fill=rgba(ROUND_WOOD_DARK),
    outline=rgba(0x2C1E15, 200),
    width=1,
  )

  # Oval top prism (wood disc, will be mostly hidden by cloth).
  oval_w = min(bounds_w * 0.82, bounds_h * 2.1)
  oval_h = min(bounds_h * 0.82, bounds_w * 0.52)
  draw_iso_oval_prism(draw, cx, cy, oval_w, oval_h, drop, ROUND_WOOD)
  # Brass rim around the top of the wood disc (just under the cloth)
  draw.ellipse(
    (cx - oval_w / 2 + 1, cy - oval_h / 2 + 1, cx + oval_w / 2 - 1, cy + oval_h / 2 - 1),
    outline=rgba(ROUND_BRASS, 200), width=2,
  )

  # Full linen cloth covering the top (slightly larger than the wood disc so it drapes).
  cloth_w = oval_w * 1.08
  cloth_h = oval_h * 1.06
  # Shadow under the cloth's far edge
  draw.ellipse(
    (cx - cloth_w / 2, cy - cloth_h / 2 + drop * 0.18, cx + cloth_w / 2, cy + cloth_h / 2 + drop * 0.18),
    fill=rgba(ROUND_CLOTH_SHADOW, 225),
    outline=rgba(0xC6B59B, 190), width=1,
  )
  # Main cloth surface
  draw.ellipse(
    (cx - cloth_w / 2, cy - cloth_h / 2, cx + cloth_w / 2, cy + cloth_h / 2),
    fill=rgba(ROUND_CLOTH),
    outline=rgba(0xC6B59B), width=2,
  )
  # Sage decorative ring
  draw.ellipse(
    (cx - cloth_w * 0.28, cy - cloth_h * 0.22, cx + cloth_w * 0.28, cy + cloth_h * 0.22),
    outline=rgba(ROUND_CLOTH_STRIPE, 175), width=2,
  )
  # Drape folds along the edge
  for offset in (-0.28, 0, 0.28):
    draw.arc(
      (cx - cloth_w * 0.42 + offset * cloth_w * 0.55, cy - cloth_h * 0.2,
       cx - cloth_w * 0.18 + offset * cloth_w * 0.55, cy + cloth_h * 0.42),
      40, 150, fill=rgba(ROUND_CLOTH_STRIPE, 95), width=1,
    )

  # Centerpiece: small terracotta sugar shaker just off-center
  jar_x, jar_y = cx + 2, cy - 4
  draw.rounded_rectangle((jar_x - 3, jar_y - 5, jar_x + 3, jar_y + 3), radius=1,
                         fill=rgba(ROUND_CENTERPIECE), outline=rgba(0x6B3D2E, 200), width=1)
  draw.rectangle((jar_x - 2, jar_y - 6, jar_x + 2, jar_y - 5), fill=rgba(ROUND_CENTERPIECE_LID))
  # Tiny perforations on the lid
  for dx in (-1, 1):
    draw.point((jar_x + dx, jar_y - 6), fill=rgba(0x6B3D2E, 220))

  # Plate settings at the standard service points.
  setting_points = get_table_service_points(top, item)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.62, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


# Square Table palette
SQUARE_WOOD = 0xA96F4C
SQUARE_GRAIN_DARK = 0x6E4327
SQUARE_GRAIN_LIGHT = 0xD49B6E
SQUARE_BRASS = 0xC79658
SQUARE_BRASS_DARK = 0x8C683B
SQUARE_LEG = 0x5B4033
SQUARE_LEG_DARK = 0x3E2A1D
SQUARE_CLOTH = 0xF4E6CE         # warm beige linen
SQUARE_CLOTH_SHADOW = 0xCFB996
SQUARE_CLOTH_BORDER = 0x89AFA1  # sage trim


def draw_square_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  """Square 4-leg dining table with grain, brass trim, and a beige linen cloth."""
  w_cells, h_cells = rotated_size(item, rotation)
  drop = 13
  table_height = 35
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin = 0.18
  top = local_floor_quad(origin, margin, margin, w_cells - margin, h_cells - margin, table_height)
  cx, cy = polygon_center(top)
  draw_neutral_shadow(draw, floor_center[0] + 8, floor_center[1] + 12, image.size[0] * 0.5, 13)

  # Solid tapered legs at the 4 corners with brass foot caps.
  leg_inset = margin + 0.05
  for u, v, alpha in (
    (leg_inset, leg_inset, 190),
    (w_cells - leg_inset, leg_inset, 205),
    (leg_inset, h_cells - leg_inset, 240),
    (w_cells - leg_inset, h_cells - leg_inset, 252),
  ):
    foot = project_from_floor_origin(origin, u, v, 0)
    leg_top = project_from_floor_origin(origin, u, v, table_height - drop + 2)
    draw_projected_leg(draw, leg_top, foot, SQUARE_LEG, 5.0, alpha)
    draw.ellipse((foot[0] - 5, foot[1] - 1, foot[0] + 5, foot[1] + 4), fill=rgba(SQUARE_BRASS, 200))

  # Top prism with brass trim.
  draw_projected_prism(draw, top, drop, SQUARE_WOOD)
  bevel_outer = inset_points(top, 0.05)
  bevel_inner = inset_points(top, 0.1)
  draw.line(bevel_outer + [bevel_outer[0]], fill=rgba(SQUARE_BRASS, 220), width=2)
  draw.line(bevel_inner + [bevel_inner[0]], fill=rgba(SQUARE_BRASS_DARK, 130), width=1)

  # Wood grain visible around the cloth edges.
  for u_ratio in (0.16, 0.28, 0.5, 0.72, 0.84):
    a = point_in_quad(top, u_ratio, 0.08)
    b = point_in_quad(top, u_ratio + 0.02, 0.92)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(SQUARE_GRAIN_DARK, 60), width=1)
  for u, v in ((0.32, 0.32), (0.66, 0.7)):
    kx, ky = point_in_quad(top, u, v)
    draw.ellipse((kx - 3, ky - 1.4, kx + 3, ky + 1.4), outline=rgba(SQUARE_GRAIN_DARK, 80), width=1)

  # Square cloth dropped over the center (smaller than the top so wood shows around).
  cloth = [
    point_in_quad(top, 0.18, 0.22),
    point_in_quad(top, 0.82, 0.22),
    point_in_quad(top, 0.82, 0.78),
    point_in_quad(top, 0.18, 0.78),
  ]
  shadow = [(x + 1, y + 1.5) for x, y in cloth]
  draw_polygon(draw, shadow, SQUARE_CLOTH_SHADOW, SQUARE_CLOTH_SHADOW, 0)
  draw_polygon(draw, cloth, SQUARE_CLOTH, 0xC6B59B, 1)
  # Sage trim near the cloth border
  trim_outer = [
    lerp_tuple(cloth[0], cloth[2], 0.08),
    lerp_tuple(cloth[1], cloth[3], 0.08),
    lerp_tuple(cloth[2], cloth[0], 0.08),
    lerp_tuple(cloth[3], cloth[1], 0.08),
  ]
  draw.line(trim_outer + [trim_outer[0]], fill=rgba(SQUARE_CLOTH_BORDER, 150), width=1)

  # Plate settings
  setting_points = get_table_service_points(top, item)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.66, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


# Painted Table palette
PAINTED_BODY = 0x9CB0AD         # sage chalk-paint base
PAINTED_BODY_DARK = 0x6B7E7C    # shadow side
PAINTED_HIGHLIGHT = 0xD3DEDA    # painted highlight (top-left lit)
PAINTED_STRIPE = 0xFFF1C6       # cream painted stripes (existing motif)
PAINTED_TRIM = 0xC79658         # warm brass hardware
PAINTED_LEG = 0x6B7E7C
PAINTED_FLORAL = 0xD47A76       # tiny rose accent
PAINTED_FLORAL_LEAF = 0x6DA05E


def draw_painted_table_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  """Painted 4-leg square dining table — sage chalk-paint finish with cream stripes."""
  w_cells, h_cells = rotated_size(item, rotation)
  drop = 13
  table_height = 35
  image, draw, floor, base_y = sprite_canvas_for(item, rotation, table_height + drop + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin = 0.18
  top = local_floor_quad(origin, margin, margin, w_cells - margin, h_cells - margin, table_height)
  cx, cy = polygon_center(top)
  draw_neutral_shadow(draw, floor_center[0] + 8, floor_center[1] + 12, image.size[0] * 0.5, 13)

  # Painted legs in matching sage.
  leg_inset = margin + 0.05
  for u, v, alpha in (
    (leg_inset, leg_inset, 195),
    (w_cells - leg_inset, leg_inset, 210),
    (leg_inset, h_cells - leg_inset, 240),
    (w_cells - leg_inset, h_cells - leg_inset, 252),
  ):
    foot = project_from_floor_origin(origin, u, v, 0)
    leg_top = project_from_floor_origin(origin, u, v, table_height - drop + 2)
    draw_projected_leg(draw, leg_top, foot, PAINTED_LEG, 4.6, alpha)
    draw.ellipse((foot[0] - 4, foot[1] - 1, foot[0] + 4, foot[1] + 3), fill=rgba(PAINTED_TRIM, 195))

  # Top prism in painted sage.
  draw_projected_prism(draw, top, drop, PAINTED_BODY)
  # Painted finish: chalky brush streaks (very light, sparse).
  for u_ratio in (0.2, 0.4, 0.6, 0.8):
    a = point_in_quad(top, u_ratio, 0.12)
    b = point_in_quad(top, u_ratio + 0.015, 0.88)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(PAINTED_HIGHLIGHT, 55), width=1)
  for u in (0.3, 0.7):
    a = point_in_quad(top, u, 0.2)
    b = point_in_quad(top, u + 0.02, 0.8)
    draw.line((a[0] + 1, a[1], b[0] - 1, b[1]), fill=rgba(PAINTED_BODY_DARK, 70), width=1)

  # Brass-trimmed bevel.
  bevel_outer = inset_points(top, 0.05)
  bevel_inner = inset_points(top, 0.1)
  draw.line(bevel_outer + [bevel_outer[0]], fill=rgba(PAINTED_TRIM, 220), width=2)
  draw.line(bevel_inner + [bevel_inner[0]], fill=rgba(0x8C683B, 130), width=1)

  # Three cream painted accent stripes across the top (the signature motif).
  for ratio in (0.3, 0.5, 0.7):
    a = lerp_tuple(top[3], top[0], ratio)
    b = lerp_tuple(top[2], top[1], ratio)
    draw.line((a[0] + 6, a[1], b[0] - 6, b[1]), fill=rgba(PAINTED_STRIPE, 165), width=2)

  # Tiny floral motif near one corner — three pink dots + two green leaves
  flx, fly = point_in_quad(top, 0.78, 0.32)
  for dx, dy in ((0, 0), (2, -1), (-2, 1)):
    draw.ellipse((flx + dx - 1.6, fly + dy - 1.6, flx + dx + 1.6, fly + dy + 1.6),
                 fill=rgba(PAINTED_FLORAL, 220))
  draw.ellipse((flx - 4, fly + 0, flx - 1, fly + 2), fill=rgba(PAINTED_FLORAL_LEAF, 200))
  draw.ellipse((flx + 1, fly + 2, flx + 4, fly + 4), fill=rgba(PAINTED_FLORAL_LEAF, 200))

  # Plate settings
  setting_points = get_table_service_points(top, item)
  for marker_x, marker_y, variant in setting_points:
    draw_food_setting(draw, marker_x, marker_y, 0.66, variant)
  set_sprite_metadata_points(image, "tableServicePx", [(x, y) for x, y, _variant in setting_points])
  return image


def draw_chair_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  if item.id == "bench-seat":
    return draw_bench_sprite(item, rotation)

  w_cells, h_cells = rotated_size(item, rotation)
  seat_z = 18
  seat_drop = 8
  back_h = 33 + item.tier * 5
  image, draw, floor, _base_y = sprite_canvas_for(item, rotation, seat_z + back_h + 16, 92)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin_u = 0.19
  margin_v = 0.19
  top = local_floor_quad(origin, margin_u, margin_v, w_cells - margin_u, h_cells - margin_v, seat_z)
  cx, cy = polygon_center(top)
  draw_neutral_shadow(draw, floor_center[0] + 5, floor_center[1] + 7, image.size[0] * 0.3, 10)
  edge_by_rotation = {
    0: (top[0], top[1]),
    90: (top[1], top[2]),
    180: (top[2], top[3]),
    270: (top[3], top[0]),
  }
  opposite_edge = {
    0: (top[3], top[2]),
    90: (top[0], top[3]),
    180: (top[0], top[1]),
    270: (top[1], top[2]),
  }
  left, right = edge_by_rotation[rotation]
  front_left, front_right = opposite_edge[rotation]

  leg_color = 0x3F2D24
  for u, v, alpha in (
    (margin_u + 0.05, margin_v + 0.05, 175),
    (w_cells - margin_u - 0.05, margin_v + 0.05, 185),
    (margin_u + 0.05, h_cells - margin_v - 0.05, 238),
    (w_cells - margin_u - 0.05, h_cells - margin_v - 0.05, 245),
  ):
    foot = project_from_floor_origin(origin, u, v, 0)
    leg_top = project_from_floor_origin(origin, u, v, seat_z - seat_drop + 1)
    draw_projected_leg(draw, leg_top, foot, leg_color, 3.4, alpha)

  back_center = polygon_center([left, right])
  front_center = polygon_center([front_left, front_right])
  back_is_camera_side = back_center[1] > front_center[1]

  def draw_back_panel() -> None:
    left_top = (left[0], left[1] - back_h)
    right_top = (right[0], right[1] - back_h)
    post_color = shade(item.color, -36)
    highlight = shade(item.color, 48)
    chair_id = item.id

    # --- Wooden chair: open slat-back (no solid panel) ----------------------
    if chair_id == "wooden-chair":
      # Posts on both sides
      draw.line((left[0], left[1], left_top[0], left_top[1]), fill=rgba(post_color), width=4)
      draw.line((right[0], right[1], right_top[0], right_top[1]), fill=rgba(post_color), width=4)
      # Top rail connecting the post tops
      draw.line((left_top[0] + 1, left_top[1] + 4, right_top[0] - 1, right_top[1] + 4),
                fill=rgba(item.color), width=4)
      draw.line((left_top[0] + 2, left_top[1] + 7, right_top[0] - 2, right_top[1] + 7),
                fill=rgba(highlight, 170), width=1)
      # 3 vertical slats inside the frame
      for ratio in (0.28, 0.5, 0.72):
        top_p = lerp_tuple(left_top, right_top, ratio)
        bottom_p = lerp_tuple(left, right, ratio)
        draw.line((top_p[0], top_p[1] + 6, bottom_p[0], bottom_p[1] - 2),
                  fill=rgba(post_color, 230), width=2)
        draw.line((top_p[0] + 1, top_p[1] + 7, bottom_p[0] + 1, bottom_p[1] - 3),
                  fill=rgba(highlight, 120), width=1)
      return

    # --- Cafe chair: Thonet-style rounded top + cross-rail -------------------
    if chair_id == "cafe-chair":
      # Posts curve very subtly inward at the top — render as two segments with a bend.
      bend_l = (left_top[0] + 3, left_top[1] + 4)
      bend_r = (right_top[0] - 3, right_top[1] + 4)
      draw.line((left[0], left[1], bend_l[0], bend_l[1]), fill=rgba(post_color), width=4)
      draw.line((right[0], right[1], bend_r[0], bend_r[1]), fill=rgba(post_color), width=4)
      # Curved top arch (the Thonet signature)
      arch_box = (
        min(bend_l[0], bend_r[0]) - 2,
        min(bend_l[1], bend_r[1]) - 8,
        max(bend_l[0], bend_r[0]) + 2,
        min(bend_l[1], bend_r[1]) + 8,
      )
      draw.arc(arch_box, 200, 340, fill=rgba(item.color), width=4)
      draw.arc((arch_box[0], arch_box[1] + 1, arch_box[2], arch_box[3] + 1),
               210, 330, fill=rgba(highlight, 175), width=2)
      # Single horizontal cross-rail at ~55% height
      cross_l = lerp_tuple(left_top, left, 0.5)
      cross_r = lerp_tuple(right_top, right, 0.5)
      draw.line((cross_l[0] + 1, cross_l[1], cross_r[0] - 1, cross_r[1]),
                fill=rgba(item.color), width=3)
      draw.line((cross_l[0] + 2, cross_l[1] + 2, cross_r[0] - 2, cross_r[1] + 2),
                fill=rgba(shade(item.color, -28), 150), width=1)
      return

    # --- Padded chair: rounded soft back with tufting ------------------------
    if chair_id == "padded-chair":
      panel_color = shade(item.color, 10)
      cushion_highlight = shade(item.color, 38)
      # Posts behind the cushion (visible at sides)
      draw.line((left[0], left[1], left_top[0], left_top[1]), fill=rgba(post_color, 200), width=3)
      draw.line((right[0], right[1], right_top[0], right_top[1]), fill=rgba(post_color, 200), width=3)
      # Soft rounded cushion panel
      cushion = [
        (left[0] - 1, left[1]),
        (right[0] + 1, right[1]),
        (right_top[0] + 1, right_top[1] + 6),
        (left_top[0] - 1, left_top[1] + 6),
      ]
      draw_polygon(draw, cushion, panel_color, 0x5B4033, 1)
      # Rounded top crown
      crown_box = (
        left_top[0] - 1,
        left_top[1] - 4,
        right_top[0] + 1,
        left_top[1] + 10,
      )
      draw.chord(crown_box, 200, 340, fill=rgba(panel_color), outline=rgba(0x5B4033, 200), width=1)
      # Top highlight
      draw.arc((crown_box[0] + 2, crown_box[1] + 2, crown_box[2] - 2, crown_box[3] - 4),
               215, 325, fill=rgba(cushion_highlight, 200), width=2)
      # 3 tufting buttons
      for ratio in (0.3, 0.5, 0.7):
        bx, by = lerp_tuple(left_top, right_top, ratio)
        bx += 0  # straight horizontal
        by += 13
        draw.ellipse((bx - 1.6, by - 1.6, bx + 1.6, by + 1.6),
                     fill=rgba(shade(item.color, -34), 180))
      return

    # --- Woven chair: oval rattan back with cross-hatch weave ----------------
    if chair_id == "woven-chair":
      # Posts (faint, behind the oval)
      draw.line((left[0], left[1], left_top[0], left_top[1]), fill=rgba(post_color, 175), width=3)
      draw.line((right[0], right[1], right_top[0], right_top[1]), fill=rgba(post_color, 175), width=3)
      # Oval back panel
      mid_y = (left_top[1] + left[1]) / 2
      oval_top = mid_y - back_h * 0.55
      oval_bottom = mid_y + back_h * 0.18
      oval_box = (left[0] - 2, oval_top, right[0] + 2, oval_bottom)
      draw.ellipse(oval_box, fill=rgba(item.color), outline=rgba(0x5B4033, 200), width=1)
      # Cross-hatch weave: 4 lines each direction
      ox1, oy1, ox2, oy2 = oval_box
      ow = ox2 - ox1
      oh = oy2 - oy1
      for r in (0.22, 0.4, 0.58, 0.76):
        # Lines descending left-to-right
        draw.line((ox1 + 2, oy1 + oh * r, ox2 - 2, oy1 + oh * (r + 0.18)),
                  fill=rgba(shade(item.color, -28), 130), width=1)
        # Lines descending right-to-left
        draw.line((ox2 - 2, oy1 + oh * r, ox1 + 2, oy1 + oh * (r + 0.18)),
                  fill=rgba(shade(item.color, 35), 110), width=1)
      # Highlight at top of oval
      draw.arc((ox1 + 2, oy1 + 1, ox2 - 2, oy1 + oh * 0.6),
               210, 330, fill=rgba(shade(item.color, 56), 200), width=1)
      return

    # --- Default + folding-chair: slatted thick panel ------------------------
    panel_color = shade(item.color, 5)
    rail_color = item.color
    draw_panel_with_thickness(draw, left, right, back_h, panel_color, 0x5B4033, (4, -5))
    draw.line((left[0], left[1], left_top[0], left_top[1]), fill=rgba(post_color), width=4)
    draw.line((right[0], right[1], right_top[0], right_top[1]), fill=rgba(post_color), width=4)
    draw.line((left_top[0] + 4, left_top[1] + 8, right_top[0] - 4, right_top[1] + 8), fill=rgba(highlight, 160), width=2)
    mid_l = lerp_tuple(left_top, left, 0.5)
    mid_r = lerp_tuple(right_top, right, 0.5)
    low_l = lerp_tuple(left_top, left, 0.75)
    low_r = lerp_tuple(right_top, right, 0.75)
    draw.line((mid_l[0], mid_l[1], mid_r[0], mid_r[1]), fill=rgba(rail_color), width=4)
    draw.line((low_l[0], low_l[1], low_r[0], low_r[1]), fill=rgba(shade(rail_color, -20)), width=3)
    slat_count = 2 if item.tier < 3 else 3
    for slat in range(slat_count):
      ratio = (slat + 1) / (slat_count + 1)
      top_p = lerp_tuple(left_top, right_top, ratio)
      bottom_p = lerp_tuple(low_l, low_r, ratio)
      draw.line((top_p[0], top_p[1] + 4, bottom_p[0], bottom_p[1] - 3), fill=rgba(highlight), width=2)
    if "folding" in chair_id or item.tier <= 1:
      draw.line((left_top[0] + 3, left_top[1] + 10, right[0] - 2, right[1] - 7), fill=rgba(shade(item.color, -42), 130), width=2)
      draw.line((right_top[0] - 3, right_top[1] + 10, left[0] + 2, left[1] - 7), fill=rgba(shade(item.color, -42), 130), width=2)

  if not back_is_camera_side:
    draw_back_panel()

  draw_projected_prism(draw, top, seat_drop, shade(item.color, 12))
  # Padded chair shows a visible cushion on top of the seat (lower-tier version of tufted).
  if item.tier >= 4 or item.id == "padded-chair":
    cushion_top = inset_points(top, 0.16)
    draw_polygon(draw, cushion_top, shade(item.color, 22), shade(item.color, -32), 1)
  seat_w = max(24, abs(top[1][0] - top[3][0]) * 0.46)
  seat_h = max(12, abs(top[2][1] - top[0][1]) * 0.46)
  draw.ellipse((cx - seat_w / 2, cy - seat_h / 2 + 2, cx + seat_w / 2, cy + seat_h / 2 + 2), fill=rgba(shade(item.color, 35)), outline=rgba(0x5B4033), width=1)
  draw.arc((cx - seat_w / 2 + 4, cy - seat_h / 2 + 4, cx + seat_w / 2 - 4, cy + seat_h / 2 + 3), 190, 340, fill=rgba(0xFFF1D0, 140), width=2)
  draw.arc((cx - seat_w / 2 + 6, cy - seat_h / 2 + 2, cx + seat_w / 2 - 5, cy + seat_h / 2 + 5), 205, 330, fill=rgba(shade(item.color, -34), 95), width=1)
  draw.line((cx - seat_w * 0.32, cy + 3, cx + seat_w * 0.32, cy + 3), fill=rgba(shade(item.color, -28), 80), width=1)
  if "tufted" in item.id or item.tier >= 4:
    for ox, oy in ((-5, -1), (0, 2), (5, -1)):
      draw.ellipse((cx + ox - 2, cy + oy - 2, cx + ox + 2, cy + oy + 2), fill=rgba(shade(item.color, -38), 150))
  if item.tier >= 3:
    draw.ellipse((cx - seat_w * 0.22, cy - 4, cx + seat_w * 0.22, cy + 6), fill=rgba(shade(item.color, 62), 150))

  if back_is_camera_side:
    draw_back_panel()

  set_sprite_metadata_points(image, "seatSurfacePx", [(cx, cy + 3)])
  return image


def draw_bench_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  w_cells, h_cells = rotated_size(item, rotation)
  seat_z = 19
  seat_drop = 10
  back_h = 44
  image, draw, floor, _base_y = sprite_canvas_for(item, rotation, seat_z + back_h + 18, 94)
  origin = floor[0]
  floor_center = polygon_center(floor)
  margin_u = 0.12
  margin_v = 0.14
  top = local_floor_quad(origin, margin_u, margin_v, w_cells - margin_u, h_cells - margin_v, seat_z)
  cx, cy = polygon_center(top)
  long_w = max(x for x, _ in top) - min(x for x, _ in top)
  draw_neutral_shadow(draw, floor_center[0] + 7, floor_center[1] + 8, max(54, long_w * 0.82), 13)

  edge_by_rotation = {
    0: (top[0], top[1]),
    90: (top[1], top[2]),
    180: (top[2], top[3]),
    270: (top[3], top[0]),
  }
  back_left, back_right = edge_by_rotation[rotation]
  opposite_edge = {
    0: (top[3], top[2]),
    90: (top[0], top[3]),
    180: (top[0], top[1]),
    270: (top[1], top[2]),
  }
  front_left, front_right = opposite_edge[rotation]

  leg_color = 0x3F2D24
  for ratio, alpha in ((0.12, 185), (0.5, 210), (0.88, 245)):
    back_leg = lerp_tuple(back_left, back_right, ratio)
    front_leg = lerp_tuple(front_left, front_right, ratio)
    for point, point_alpha in ((back_leg, max(160, alpha - 45)), (front_leg, alpha)):
      foot = (point[0], point[1] + seat_z)
      leg_top = (point[0], point[1] + seat_drop)
      draw_projected_leg(draw, leg_top, foot, leg_color, 3.8, point_alpha)

  seat_top = inset_points(top, 0.06)
  back_center = polygon_center([back_left, back_right])
  front_center = polygon_center([front_left, front_right])
  back_is_camera_side = back_center[1] > front_center[1]

  def draw_bench_back_panel() -> None:
    draw_panel_with_thickness(
      draw,
      back_left,
      back_right,
      back_h,
      shade(item.color, 4),
      0x5B4033,
      (5, -5),
    )
    seam_a = lerp_tuple(back_left, back_right, 0.08)
    seam_b = lerp_tuple(back_left, back_right, 0.92)
    draw.line((seam_a[0], seam_a[1] + 1, seam_b[0], seam_b[1] + 1), fill=rgba(shade(item.color, -42)), width=4)
    draw.line((seam_a[0] + 5, seam_a[1] - 3, seam_b[0] - 5, seam_b[1] - 3), fill=rgba(shade(item.color, 55), 180), width=2)
    for ratio in (0.22, 0.5, 0.78):
      upper = lerp_tuple((back_left[0], back_left[1] - back_h + 12), (back_right[0], back_right[1] - back_h + 12), ratio)
      lower = lerp_tuple(back_left, back_right, ratio)
      draw.line((upper[0], upper[1], lower[0], lower[1] - 8), fill=rgba(shade(item.color, -28), 115), width=2)
      button = lerp_tuple(upper, lower, 0.52)
      draw.ellipse((button[0] - 3, button[1] - 2, button[0] + 3, button[1] + 2), fill=rgba(shade(item.color, -38), 150))

  if not back_is_camera_side:
    draw_bench_back_panel()

  draw_projected_prism(draw, seat_top, seat_drop, shade(item.color, 24))

  cushion = inset_points(seat_top, 0.1)
  draw_polygon(draw, cushion, shade(item.color, 42), shade(item.color, -34), 1)
  front_lip_left = lerp_tuple(seat_top[3], seat_top[2], 0.06)
  front_lip_right = lerp_tuple(seat_top[3], seat_top[2], 0.94)
  draw.line((front_lip_left[0], front_lip_left[1] + seat_drop * 0.7, front_lip_right[0], front_lip_right[1] + seat_drop * 0.7), fill=rgba(shade(item.color, -48), 145), width=3)
  for ratio in (0.34, 0.66):
    a = point_in_quad(cushion, ratio, 0.1)
    b = point_in_quad(cushion, ratio, 0.92)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(shade(item.color, -28), 105), width=2)
  for ratio in (0.25, 0.5, 0.75):
    x, y = point_in_quad(cushion, ratio, 0.48)
    draw.ellipse((x - 3, y - 2, x + 3, y + 2), fill=rgba(shade(item.color, -35), 150))

  for ratio in (0.12, 0.88):
    top_p = point_in_quad(seat_top, ratio, 0.16)
    bottom_p = point_in_quad(seat_top, ratio, 0.92)
    draw.line((top_p[0], top_p[1], bottom_p[0], bottom_p[1]), fill=rgba(shade(item.color, -36), 120), width=2)

  # Rolled end arms make the two-person bench read as a sofa instead of a block.
  for ratio in (0.05, 0.95):
    arm_center = point_in_quad(seat_top, ratio, 0.52)
    arm_w = 11
    arm_h = 25
    draw.rounded_rectangle(
      (arm_center[0] - arm_w / 2, arm_center[1] - arm_h / 2, arm_center[0] + arm_w / 2, arm_center[1] + arm_h / 2),
      radius=5,
      fill=rgba(shade(item.color, 18)),
      outline=rgba(0x5B4033),
      width=1,
    )
    draw.line((arm_center[0] - 2, arm_center[1] - arm_h / 2 + 4, arm_center[0] - 2, arm_center[1] + arm_h / 2 - 4), fill=rgba(shade(item.color, 55), 150), width=1)

  if back_is_camera_side:
    draw_bench_back_panel()

  set_sprite_metadata_points(
    image,
    "seatSurfacePx",
    [point_in_quad(cushion, 0.34, 0.52), point_in_quad(cushion, 0.66, 0.52)],
  )

  return image


def draw_stove_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  burners = max(item.cooking_slots, 1)
  w_cells, h_cells = rotated_size(item, rotation)
  body_h = 34 + min(8, item.tier * 2)
  image, draw, floor, _base_y = sprite_canvas_for(item, rotation, body_h + 18, 54)
  origin = floor[0]
  floor_center = polygon_center(floor)
  top = local_floor_quad(origin, 0.08, 0.12, w_cells - 0.08, h_cells - 0.12, body_h)
  cx, cy = polygon_center(top)
  draw_neutral_shadow(draw, floor_center[0] + 9, floor_center[1] + 10, image.size[0] * 0.66, 18)
  bottom, front_face, _side_face = projected_prism_faces(top, body_h)
  draw_projected_prism(draw, top, body_h, item.color, 0x263238)
  draw.line((front_face[0][0] + 7, front_face[0][1] + 4, front_face[1][0] - 7, front_face[1][1] + 4), fill=rgba(0x1F2A2E), width=3)

  if w_cells >= h_cells:
    back_a, back_b = top[0], top[1]
    front_a, front_b = top[3], top[2]
  else:
    back_a, back_b = top[0], top[3]
    front_a, front_b = top[1], top[2]

  def lerp_point(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

  strip_back_a = lerp_point(back_a, front_a, 0.28)
  strip_back_b = lerp_point(back_b, front_b, 0.28)
  strip_front_b = lerp_point(back_b, front_b, 0.78)
  strip_front_a = lerp_point(back_a, front_a, 0.78)
  cook_a = lerp_point(back_a, front_a, 0.53)
  cook_b = lerp_point(back_b, front_b, 0.53)

  draw_polygon(draw, [strip_back_a, strip_back_b, strip_front_b, strip_front_a], 0x2F383E, 0x182126, 2)
  highlight_a = lerp_point(back_a, front_a, 0.18)
  highlight_b = lerp_point(back_b, front_b, 0.18)
  draw.line((highlight_a[0] + 8, highlight_a[1], highlight_b[0] - 8, highlight_b[1]), fill=rgba(0xB6C4CA), width=3)

  for index in range(burners):
    t = (index + 1) / (burners + 1)
    x = cook_a[0] + (cook_b[0] - cook_a[0]) * t
    y = cook_a[1] + (cook_b[1] - cook_a[1]) * t
    draw.ellipse((x - 11, y - 7, x + 11, y + 7), fill=rgba(0x171D20), outline=rgba(0x91A0A6), width=1)
    draw.ellipse((x - 5, y - 3, x + 5, y + 3), fill=rgba(0xF2B45F))
    if item.tier >= 2 or index == 0:
      pan_y = y - 8
      draw.ellipse((x - 13, pan_y - 5, x + 13, pan_y + 6), fill=rgba(0xD8D2C6), outline=rgba(0x2E363A), width=2)
      draw.ellipse((x - 8, pan_y - 2, x + 8, pan_y + 4), fill=rgba(0xF2D48B), outline=rgba(0xB56F3D), width=1)
      handle_dir = -1 if index % 2 == 0 else 1
      draw.line((x + handle_dir * 11, pan_y, x + handle_dir * 23, pan_y - 5), fill=rgba(0x2E363A), width=4)
      draw.line((x + handle_dir * 12, pan_y - 1, x + handle_dir * 21, pan_y - 5), fill=rgba(0x7F8A8E), width=1)

  panel_a = (front_a[0], front_a[1] + 20)
  panel_b = (front_b[0], front_b[1] + 20)
  draw.line((panel_a[0] + 10, panel_a[1], panel_b[0] - 10, panel_b[1]), fill=rgba(0x1F2A2E), width=2)
  for index in range(max(2, burners)):
    t = (index + 1) / (max(2, burners) + 1)
    x = panel_a[0] + (panel_b[0] - panel_a[0]) * t
    y = panel_a[1] + (panel_b[1] - panel_a[1]) * t
    draw.ellipse((x - 3, y + 5, x + 3, y + 11), fill=rgba(0xD7B56A))
  return image


def draw_counter_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  body_h = 40
  w_cells, h_cells = rotated_size(item, rotation)
  image, draw, floor, _base_y = sprite_canvas_for(item, rotation, body_h + 18, 56)
  origin = floor[0]
  floor_center = polygon_center(floor)
  top_overhang = local_floor_quad(origin, 0.03, 0.05, w_cells - 0.03, h_cells - 0.05, body_h)
  cx, cy = polygon_center(top_overhang)
  body_top = local_floor_quad(origin, 0.11, 0.13, w_cells - 0.11, h_cells - 0.13, body_h - 3)
  body_bottom = [(x, y + body_h - 3) for x, y in body_top]
  front_face = [body_top[3], body_top[2], body_bottom[2], body_bottom[3]]
  side_face = [body_top[1], body_top[2], body_bottom[2], body_bottom[1]]
  top_inset = [(x * 0.82 + cx * 0.18, y * 0.82 + cy * 0.18) for x, y in top_overhang]

  draw_neutral_shadow(draw, floor_center[0] + 8, floor_center[1] + 10, image.size[0] * 0.7, 17)
  draw_polygon(draw, side_face, shade(item.color, -28), 0x5B4033, 1)
  draw_polygon(draw, front_face, shade(item.color, -50), 0x5B4033, 1)
  draw_polygon(draw, body_top, shade(item.color, -10), 0x5B4033, 1)
  draw_polygon(draw, top_overhang, shade(item.color, 18), 0x5B4033, 2)
  draw.line((top_overhang[3][0] + 5, top_overhang[3][1] + 2, top_overhang[2][0] - 5, top_overhang[2][1] + 2), fill=rgba(shade(item.color, -32)), width=4)
  draw_polygon(draw, top_inset, shade(item.color, 36), None)

  # Big, high-contrast details so counters still read at game zoom.
  draw_face_panel(draw, side_face, 0.13, 0.84, 0.18, 0.78, shade(item.color, -39), 0x4C352B, 210)
  for u1, u2 in ((0.06, 0.29), (0.36, 0.64), (0.71, 0.94)):
    draw_face_panel(draw, front_face, u1, u2, 0.16, 0.42, shade(item.color, -29), 0x4C352B, 235)
  for u1, u2 in ((0.07, 0.47), (0.53, 0.93)):
    draw_face_panel(draw, front_face, u1, u2, 0.51, 0.88, shade(item.color, -59), 0x4C352B, 240)

  kick_a = point_in_quad(front_face, 0.06, 0.91)
  kick_b = point_in_quad(front_face, 0.94, 0.91)
  draw.line((kick_a[0], kick_a[1], kick_b[0], kick_b[1]), fill=rgba(0x2F211B, 210), width=5)

  for u in (0.19, 0.5, 0.81):
    knob = point_in_quad(front_face, u, 0.34)
    draw.ellipse((knob[0] - 3.2, knob[1] - 3.2, knob[0] + 3.2, knob[1] + 3.2), fill=rgba(0xE0BE72), outline=rgba(0x6A4B34))
  for u in (0.28, 0.72):
    handle = point_in_quad(front_face, u, 0.7)
    draw.line((handle[0] - 10, handle[1], handle[0] + 10, handle[1]), fill=rgba(0xD9C394), width=3)

  is_sink = "sink" in item.id
  is_dishwasher = "dishwasher" in item.id
  is_cash = "cash" in item.id
  is_host = "host" in item.id
  is_espresso = "espresso" in item.id
  is_prep = "prep" in item.id

  for u in (0.16, 0.31, 0.46, 0.61, 0.76, 0.91):
    a = point_in_quad(front_face, u, 0.12)
    b = point_in_quad(front_face, u, 0.88)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(shade(item.color, -72), 92), width=1)

  if is_sink or is_dishwasher:
    basin_w = 54 if item.width >= 2 else 42
    draw.ellipse((cx - basin_w / 2, cy - 13, cx + basin_w / 2, cy + 11), fill=rgba(0xCFE7E9), outline=rgba(0x687780), width=2)
    draw.ellipse((cx - basin_w / 2 + 7, cy - 8, cx + basin_w / 2 - 7, cy + 6), fill=rgba(0x9DC6CA, 150))
    draw.arc((cx - 13, cy - 20, cx + 13, cy - 1), 205, 345, fill=rgba(0x697A80), width=3)
    draw.ellipse((cx + 12, cy - 9, cx + 18, cy - 3), fill=rgba(0x697A80))
    if is_dishwasher:
      draw_face_panel(draw, front_face, 0.18, 0.82, 0.2, 0.9, 0xC2CAD0, 0x65747D, 245)
      handle = point_in_quad(front_face, 0.5, 0.34)
      draw.line((handle[0] - 18, handle[1], handle[0] + 18, handle[1]), fill=rgba(0x7A8790), width=3)
      light = point_in_quad(front_face, 0.76, 0.52)
      draw.ellipse((light[0] - 3, light[1] - 3, light[0] + 3, light[1] + 3), fill=rgba(0x7FC37D))
    return image

  if is_espresso:
    shelf_back = point_in_quad(top_overhang, 0.13, 0.26)
    shelf_front = point_in_quad(top_overhang, 0.86, 0.26)
    draw.line((shelf_back[0], shelf_back[1], shelf_front[0], shelf_front[1]), fill=rgba(0x3D2B22), width=5)
    machine = [
      (cx - 30, cy - 28),
      (cx + 18, cy - 20),
      (cx + 18, cy + 4),
      (cx - 30, cy - 4),
    ]
    draw_polygon(draw, machine, 0x25333A, 0x162127, 2)
    draw.rectangle((cx - 20, cy - 21, cx + 2, cy - 13), fill=rgba(0x6DC3D1))
    draw.ellipse((cx + 8, cy - 13, cx + 18, cy - 3), fill=rgba(0xD9C081), outline=rgba(0x503A2B))
    for cup_x in (cx + 28, cx + 42):
      draw.ellipse((cup_x - 6, cy - 6, cup_x + 6, cy + 2), fill=rgba(0xFFF5E3), outline=rgba(0x7A6A5A), width=1)
      draw.rectangle((cup_x - 5, cy - 3, cup_x + 5, cy + 8), fill=rgba(0xFFF5E3), outline=rgba(0x7A6A5A), width=1)
    for index, syrup_color in enumerate((0xB3302A, 0xE3B54E, 0x7B3E7A)):
      bottle_x = cx - 2 + index * 10
      draw_small_bottle(draw, bottle_x, cy + 11, syrup_color, 0.72)
    wand_top = (cx + 20, cy - 22)
    wand_bottom = (cx + 31, cy - 3)
    draw.line((wand_top[0], wand_top[1], wand_bottom[0], wand_bottom[1]), fill=rgba(0xE9EEF0), width=2)
    for steam_x in (cx + 30, cx + 39):
      draw.arc((steam_x - 4, cy - 29, steam_x + 5, cy - 12), 235, 55, fill=rgba(0xFFFFFF, 155), width=2)
    return image

  if is_cash:
    # Make payment furniture read clearly as a cash/POS counter, not a mystery screen.
    receipt = [
      point_in_quad(top_overhang, 0.15, 0.3),
      point_in_quad(top_overhang, 0.34, 0.34),
      point_in_quad(top_overhang, 0.29, 0.58),
      point_in_quad(top_overhang, 0.1, 0.54),
    ]
    draw_polygon(draw, receipt, 0xFFF8E8, 0xB99F7C, 1)
    for line in (0.38, 0.47, 0.56):
      a = point_in_quad(receipt, 0.18, line)
      b = point_in_quad(receipt, 0.82, line)
      draw.line((a[0], a[1], b[0], b[1]), fill=rgba(0xC7B799), width=1)

    cash_pad = [
      point_in_quad(top_overhang, 0.55, 0.42),
      point_in_quad(top_overhang, 0.89, 0.5),
      point_in_quad(top_overhang, 0.78, 0.79),
      point_in_quad(top_overhang, 0.44, 0.7),
    ]
    draw_polygon(draw, cash_pad, 0xEFE4CE, 0x8B684A, 1)
    for row in range(3):
      for col in range(4):
        key = point_in_quad(cash_pad, 0.2 + col * 0.18, 0.22 + row * 0.22)
        draw.ellipse((key[0] - 1.6, key[1] - 1.2, key[0] + 1.6, key[1] + 1.2), fill=rgba(0x8F725B))

    pole_base = point_in_quad(top_overhang, 0.42, 0.36)
    draw.line((pole_base[0], pole_base[1] + 1, pole_base[0] + 2, pole_base[1] - 17), fill=rgba(0x5A473C), width=3)
    register = [
      (pole_base[0] - 22, pole_base[1] - 31),
      (pole_base[0] + 21, pole_base[1] - 24),
      (pole_base[0] + 17, pole_base[1] - 4),
      (pole_base[0] - 26, pole_base[1] - 11),
    ]
    draw_polygon(draw, register, 0x27353B, 0x162127, 2)
    draw_polygon(draw, [
      (pole_base[0] - 15, pole_base[1] - 26),
      (pole_base[0] + 8, pole_base[1] - 22),
      (pole_base[0] + 6, pole_base[1] - 12),
      (pole_base[0] - 17, pole_base[1] - 16),
    ], 0x87C8D0, 0x162127, 1)
    draw.text((pole_base[0] - 11, pole_base[1] - 24), "$", fill=rgba(0xEAF9F9), font=ImageFont.load_default())
    scanner = [
      point_in_quad(top_overhang, 0.78, 0.26),
      point_in_quad(top_overhang, 0.93, 0.31),
      point_in_quad(top_overhang, 0.89, 0.43),
      point_in_quad(top_overhang, 0.74, 0.38),
    ]
    draw_polygon(draw, scanner, 0x303A3F, 0x182126, 1)
    scan_line_a = point_in_quad(scanner, 0.22, 0.46)
    scan_line_b = point_in_quad(scanner, 0.8, 0.46)
    draw.line((scan_line_a[0], scan_line_a[1], scan_line_b[0], scan_line_b[1]), fill=rgba(0x78D5DD), width=2)
    drawer = point_in_quad(front_face, 0.5, 0.62)
    draw.line((drawer[0] - 22, drawer[1], drawer[0] + 22, drawer[1]), fill=rgba(0xE3C273), width=3)
    for coin_x in (drawer[0] - 14, drawer[0] - 2, drawer[0] + 11):
      draw.ellipse((coin_x - 3, drawer[1] + 8, coin_x + 3, drawer[1] + 12), fill=rgba(0xD5AF54), outline=rgba(0x765D2E), width=1)
    return image

  if is_host:
    # Host stands should feel like a reception podium/menu station, not a register.
    book = [
      point_in_quad(top_overhang, 0.22, 0.25),
      point_in_quad(top_overhang, 0.74, 0.34),
      point_in_quad(top_overhang, 0.65, 0.68),
      point_in_quad(top_overhang, 0.12, 0.58),
    ]
    draw_polygon(draw, book, 0xF8E8C7, 0x8B684A, 1)
    spine_a = point_in_quad(book, 0.52, 0.1)
    spine_b = point_in_quad(book, 0.46, 0.9)
    draw.line((spine_a[0], spine_a[1], spine_b[0], spine_b[1]), fill=rgba(0xC79B5D), width=2)
    for v in (0.34, 0.48, 0.62):
      a = point_in_quad(book, 0.12, v)
      b = point_in_quad(book, 0.4, v + 0.02)
      draw.line((a[0], a[1], b[0], b[1]), fill=rgba(0xA98B68), width=1)
    bell = point_in_quad(top_overhang, 0.78, 0.48)
    draw.ellipse((bell[0] - 9, bell[1] - 5, bell[0] + 9, bell[1] + 5), fill=rgba(0xD9B65F), outline=rgba(0x7B6030), width=1)
    draw.ellipse((bell[0] - 3, bell[1] - 10, bell[0] + 3, bell[1] - 5), fill=rgba(0xE7CF83), outline=rgba(0x7B6030), width=1)
    front_plate = point_in_quad(front_face, 0.5, 0.48)
    draw.rounded_rectangle((front_plate[0] - 21, front_plate[1] - 7, front_plate[0] + 21, front_plate[1] + 8), radius=3, fill=rgba(0xEAD6A5), outline=rgba(0x6C4C39), width=1)
    draw.text((front_plate[0] - 14, front_plate[1] - 7), "HOST", fill=rgba(0x6C4C39), font=ImageFont.load_default())
    return image

  if is_prep:
    rail_a = point_in_quad(top_overhang, 0.12, 0.18)
    rail_b = point_in_quad(top_overhang, 0.9, 0.18)
    draw.line((rail_a[0], rail_a[1], rail_b[0], rail_b[1]), fill=rgba(0xF7D9A2), width=5)
    board = [
      (cx - 32, cy - 10),
      (cx + 10, cy - 4),
      (cx + 0, cy + 10),
      (cx - 40, cy + 4),
    ]
    draw_polygon(draw, board, 0xE5B774, 0x8B6038, 1)
    draw.line((cx - 21, cy - 5, cx + 3, cy - 2), fill=rgba(0xFFF0C7), width=2)
    for offset, color in ((19, 0x6EA66B), (31, 0xC25F45), (41, 0xE0BE72)):
      draw.ellipse((cx + offset - 6, cy - 5, cx + offset + 6, cy + 7), fill=rgba(color), outline=rgba(0x416542), width=1)
    draw.line((cx - 33, cy + 6, cx + 14, cy + 11), fill=rgba(0x8B6038), width=2)
    return image

  shelf_a = point_in_quad(top_overhang, 0.13, 0.24)
  shelf_b = point_in_quad(top_overhang, 0.87, 0.24)
  draw.line((shelf_a[0], shelf_a[1], shelf_b[0], shelf_b[1]), fill=rgba(0xF7D9A2), width=5)
  case_back = point_in_quad(top_overhang, 0.16, 0.2)
  case_right = point_in_quad(top_overhang, 0.86, 0.3)
  case_front = point_in_quad(top_overhang, 0.74, 0.72)
  case_left = point_in_quad(top_overhang, 0.08, 0.62)
  draw.polygon([case_back, case_right, case_front, case_left], fill=rgba(0xDDF0F4, 120), outline=rgba(0x6E8790, 190))
  for ratio in (0.3, 0.55, 0.78):
    a = lerp_tuple(case_left, case_front, ratio)
    b = lerp_tuple(case_back, case_right, ratio)
    draw.line((a[0], a[1], b[0], b[1]), fill=rgba(0xFFFFFF, 120), width=1)
  tray = [
    (cx - 28, cy - 10),
    (cx + 22, cy - 3),
    (cx + 12, cy + 9),
    (cx - 36, cy + 2),
  ]
  draw_polygon(draw, tray, 0xFFF0C7, 0x9B7650, 1)
  for bx, by, color in ((-22, -5, 0xE0BE72), (-10, -2, 0xF6D28E), (4, -1, 0xF7F1DF), (16, 2, 0xC98755)):
    draw.ellipse((cx + bx - 7, cy + by - 4, cx + bx + 7, cy + by + 5), fill=rgba(color), outline=rgba(0x8B684A), width=1)
  basket = [
    (cx - 48, cy + 3),
    (cx - 18, cy + 8),
    (cx - 23, cy + 17),
    (cx - 54, cy + 12),
  ]
  draw_polygon(draw, basket, 0xB87536, 0x70451F, 1)
  for loaf in range(3):
    lx = cx - 47 + loaf * 10
    draw.ellipse((lx, cy - 1, lx + 18, cy + 12), fill=rgba(0xF1BF68), outline=rgba(0x8A5725), width=1)
    draw.line((lx + 5, cy + 3, lx + 12, cy + 5), fill=rgba(0xFFF0B8), width=1)
  for index, bottle_color in enumerate((0xB8322A, 0xE5D849, 0x7A52AA, 0x52A66F)):
    draw_small_bottle(draw, cx + 28 + index * 9, cy + 1, bottle_color, 0.65)
  if item.tier >= 3:
    vase = [
      (cx + 29, cy - 14),
      (cx + 40, cy - 11),
      (cx + 36, cy + 4),
      (cx + 25, cy + 1),
    ]
    draw_polygon(draw, vase, 0x6FA085, 0x496A58, 1)
    draw.line((cx + 32, cy - 15, cx + 24, cy - 27), fill=rgba(0x5F7C4A), width=2)
    draw.line((cx + 34, cy - 15, cx + 42, cy - 27), fill=rgba(0x5F7C4A), width=2)
  if item.tier >= 4:
    shine_a = lerp_tuple(top_overhang[3], top_overhang[0], 0.18)
    shine_b = lerp_tuple(top_overhang[2], top_overhang[1], 0.18)
    draw.line((shine_a[0] + 8, shine_a[1], shine_b[0] - 8, shine_b[1]), fill=rgba(0xFFF7E1), width=4)
  return image


def draw_decor_sprite(item: FurnitureItem, rotation: int) -> Image.Image:
  if item.category == "wallDecoration":
    image = Image.new("RGBA", (96, 90), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    set_sprite_metadata(image, (48, 74))
    draw.rounded_rectangle((15, 12, 81, 72), radius=5, fill=rgba(0xFAF6EE), outline=rgba(0xC9B9A6), width=3)
    draw.rounded_rectangle((24, 22, 72, 62), radius=3, fill=rgba(item.color), outline=rgba(shade(item.color, -40)), width=2)
    if item.tier >= 3:
      draw.line((28, 30, 68, 30), fill=rgba(0xFFFFFF, 140), width=2)
      draw.arc((31, 34, 64, 58), 190, 350, fill=rgba(0xFFE4A8), width=2)
    return image

  if is_floor_textile(item):
    image, draw, top, _base_y = sprite_canvas_for(item, rotation, 0, 10)
    center = polygon_center(top)
    inset = [(x * 0.9 + center[0] * 0.1, y * 0.9 + center[1] * 0.1) for x, y in top]
    fringe_a = [(top[0][0] * 0.82 + top[3][0] * 0.18, top[0][1] * 0.82 + top[3][1] * 0.18), (top[1][0] * 0.82 + top[2][0] * 0.18, top[1][1] * 0.82 + top[2][1] * 0.18)]
    fringe_b = [(top[3][0] * 0.82 + top[0][0] * 0.18, top[3][1] * 0.82 + top[0][1] * 0.18), (top[2][0] * 0.82 + top[1][0] * 0.18, top[2][1] * 0.82 + top[1][1] * 0.18)]
    draw_polygon(draw, top, shade(item.color, 16), shade(item.color, -38), 2)
    draw_polygon(draw, inset, item.color, shade(item.color, -18), 1)
    if "checker" in item.id:
      for ratio in (0.33, 0.66):
        left = (top[3][0] + (top[0][0] - top[3][0]) * ratio, top[3][1] + (top[0][1] - top[3][1]) * ratio)
        right = (top[2][0] + (top[1][0] - top[2][0]) * ratio, top[2][1] + (top[1][1] - top[2][1]) * ratio)
        draw.line((left[0], left[1], right[0], right[1]), fill=rgba(shade(item.color, 44), 120), width=2)
      for ratio in (0.33, 0.66):
        left = (top[0][0] + (top[1][0] - top[0][0]) * ratio, top[0][1] + (top[1][1] - top[0][1]) * ratio)
        right = (top[3][0] + (top[2][0] - top[3][0]) * ratio, top[3][1] + (top[2][1] - top[3][1]) * ratio)
        draw.line((left[0], left[1], right[0], right[1]), fill=rgba(shade(item.color, -28), 95), width=2)
    else:
      draw.line((fringe_a[0][0], fringe_a[0][1], fringe_a[1][0], fringe_a[1][1]), fill=rgba(0xFFF1D2, 155), width=3)
      draw.line((fringe_b[0][0], fringe_b[0][1], fringe_b[1][0], fringe_b[1][1]), fill=rgba(0xFFF1D2, 120), width=2)
      draw.line((inset[3][0] + 8, inset[3][1], inset[1][0] - 8, inset[1][1]), fill=rgba(0xFFF1D2, 105), width=2)
    return image

  if item.category == "plant":
    w_cells, h_cells = rotated_size(item, rotation)
    pot_h = 16
    image, draw, floor, _base_y = sprite_canvas_for(item, rotation, pot_h + 58, 86)
    origin = floor[0]
    floor_center = polygon_center(floor)
    top = local_floor_quad(origin, 0.12, 0.16, w_cells - 0.12, h_cells - 0.16, pot_h)
    cx, _cy = polygon_center(top)
    draw_neutral_shadow(draw, floor_center[0] + 6, floor_center[1] + 8, image.size[0] * 0.44, 12)
    pot_color = 0x9B674B if item.tier < 4 else 0x8D765C
    draw_projected_prism(draw, top, pot_h, pot_color)
    rim = [(x * 0.84 + cx * 0.16, y * 0.84 + (top[0][1] + top[2][1]) * 0.08) for x, y in top]
    draw_polygon(draw, rim, shade(pot_color, 30), shade(pot_color, -30), 1)
    soil = [(x * 0.72 + cx * 0.28, y * 0.72 + (top[0][1] + top[2][1]) * 0.14) for x, y in top]
    draw_polygon(draw, soil, 0x5B4033, None)

    soil_cx, soil_cy = polygon_center(soil)
    stem_base_y = soil_cy + 4
    plant_height = 20 + item.tier * 3
    if "succulent" in item.id:
      plant_height = 10 + item.tier * 2
    elif "fern" in item.id:
      plant_height = 18 + item.tier * 2
    elif "flower" in item.id or "orchid" in item.id:
      plant_height = 28 + item.tier * 2
    elif "olive" in item.id:
      plant_height = 34 + item.tier * 3
    stem_top = soil_cy - plant_height
    leaf_base = item.color if item.id not in ("flower-pot", "orchid-planter") else 0x5E9A65
    leaf_dark = shade(leaf_base, -34)
    leaf_light = shade(leaf_base, 28)
    stem_color = 0x4C7040 if "olive" not in item.id else 0x6B503C

    if "succulent" in item.id:
      rosette_y = soil_cy - 7
      for ring, radius in enumerate((18, 11, 5)):
        count = 10 - ring * 2
        for index in range(count):
          angle = math.radians(index * 360 / count + ring * 17)
          x = cx + math.cos(angle) * radius * 0.62
          y = rosette_y + math.sin(angle) * radius * 0.34
          draw_leaf(draw, x, y, 19 - ring * 3, 8 - ring, angle, shade(leaf_base, 10 - ring * 9), leaf_dark)
      draw.ellipse((cx - 4, rosette_y - 2, cx + 4, rosette_y + 6), fill=rgba(shade(leaf_base, 45)))
      return image

    if "fern" in item.id:
      for frond in range(9):
        angle = math.radians(198 + frond * 18)
        start = (soil_cx, stem_base_y - 4)
        end = (
          soil_cx + math.cos(angle) * (15 + item.tier * 1.2),
          stem_base_y - 5 + math.sin(angle) * (17 + item.tier * 0.7),
        )
        draw.line((start[0], start[1], end[0], end[1]), fill=rgba(stem_color), width=2)
        for leaf_index in range(1, 6):
          t = leaf_index / 6
          lx = start[0] + (end[0] - start[0]) * t
          ly = start[1] + (end[1] - start[1]) * t
          draw_leaf(draw, lx, ly, 8.5, 3.6, angle + 1.2, leaf_light, leaf_dark, 225)
          draw_leaf(draw, lx, ly, 8.5, 3.6, angle - 1.2, shade(leaf_base, -2), leaf_dark, 225)
      for cluster in range(8):
        angle = math.radians(205 + cluster * 18)
        x = soil_cx + math.cos(angle) * (7 + (cluster % 3) * 2.2)
        y = stem_base_y - 10 + math.sin(angle) * (7 + (cluster % 2) * 2)
        draw_leaf(draw, x, y, 13, 5, angle + 0.25, shade(leaf_base, 16), leaf_dark, 230)
      return image

    if "olive" in item.id:
      trunk_top = stem_top + 24
      draw.line((soil_cx - 3, stem_base_y - 2, cx - 8, trunk_top + 18), fill=rgba(0x6B503C), width=5)
      draw.line((soil_cx + 1, stem_base_y - 3, cx + 9, trunk_top + 16), fill=rgba(0x7A5A42), width=4)
      draw.line((cx - 4, trunk_top + 14, cx + 13, trunk_top - 5), fill=rgba(0x6B503C), width=3)
      draw.line((cx + 2, trunk_top + 12, cx - 16, trunk_top - 3), fill=rgba(0x6B503C), width=3)
      for index in range(34):
        angle = math.radians((index * 137) % 360)
        radius = 8 + (index % 5) * 4
        x = cx + math.cos(angle) * radius
        y = trunk_top + math.sin(angle) * radius * 0.48
        draw_leaf(draw, x, y, 14, 5, angle + 0.4, shade(leaf_base, 18 if index % 3 == 0 else -8), leaf_dark, 235)
      return image

    if "orchid" in item.id:
      for stem_offset in (-9, 0, 9):
        draw.line((soil_cx + stem_offset * 0.15, stem_base_y - 2, cx + stem_offset, stem_top + 7), fill=rgba(stem_color), width=2)
        for bloom in range(3):
          bx = cx + stem_offset + (-4 + bloom * 4)
          by = stem_top + 4 + bloom * 12
          for petal in range(5):
            angle = math.radians(petal * 72)
            draw.ellipse((bx + math.cos(angle) * 5 - 5, by + math.sin(angle) * 3 - 4, bx + math.cos(angle) * 5 + 5, by + math.sin(angle) * 3 + 4), fill=rgba(item.color), outline=rgba(shade(item.color, -36), 160), width=1)
          draw.ellipse((bx - 2, by - 2, bx + 2, by + 2), fill=rgba(0xF3D48B))
      for angle in (-2.8, -2.25, -0.9, -0.35):
        draw_leaf(draw, cx + math.cos(angle) * 10, stem_base_y - 9 + math.sin(angle) * 5, 21, 8, angle, leaf_base, leaf_dark)
      return image

    draw.line((soil_cx, stem_base_y, soil_cx, stem_top + 20), fill=rgba(stem_color), width=4)
    draw.line((soil_cx - 6, stem_base_y - 2, soil_cx + 3, stem_top + 25), fill=rgba(0x6B503C), width=2)
    leaf_specs = []
    for angle in range(198, 344, 18):
      radians = math.radians(angle)
      radius_x = 10 + item.tier * 0.9 + (angle % 3) * 0.6
      radius_y = 8 + item.tier * 0.45 + (angle % 4) * 0.35
      x = soil_cx + math.cos(radians) * radius_x
      y = stem_base_y - 16 + math.sin(radians) * radius_y
      leaf_specs.append((x, y, radians))
      draw.line((soil_cx, stem_base_y - 3, x, y + 3), fill=rgba(stem_color, 105), width=1)
    for x, y, radians in leaf_specs:
      draw_leaf(draw, x, y, 14, 5.4, radians + 0.35, shade(leaf_base, -8 if int(math.degrees(radians)) % 72 == 0 else 16), leaf_dark)
    for cluster_index, (ox, oy, radius) in enumerate(((-8, -15, 9), (0, -20, 10), (8, -15, 9), (-3, -11, 8), (4, -10, 8))):
      color = shade(leaf_base, 20 if cluster_index % 2 else -2)
      draw.ellipse(
        (soil_cx + ox - radius, stem_base_y + oy - radius * 0.62, soil_cx + ox + radius, stem_base_y + oy + radius * 0.62),
        fill=rgba(color, 232),
        outline=rgba(leaf_dark, 135),
        width=1,
      )

    if "flower" in item.id:
      for flower_index, offset in enumerate((-16, -5, 8, 17)):
        fx = cx + offset
        fy = stem_top + 4 + (flower_index % 2) * 8
        draw.line((soil_cx, stem_base_y - 8, fx, fy + 8), fill=rgba(stem_color), width=2)
        for petal in range(6):
          angle = math.radians(petal * 60)
          draw.ellipse((fx + math.cos(angle) * 5 - 5, fy + math.sin(angle) * 4 - 4, fx + math.cos(angle) * 5 + 5, fy + math.sin(angle) * 4 + 4), fill=rgba(item.color), outline=rgba(shade(item.color, -36), 150), width=1)
        draw.ellipse((fx - 2, fy - 2, fx + 2, fy + 2), fill=rgba(0xF3D48B))
    else:
      for sprig in range(6):
        angle = math.radians(212 + sprig * 25)
        tip = (
          soil_cx + math.cos(angle) * (12 + (sprig % 2) * 3),
          stem_base_y - 9 + math.sin(angle) * (10 + (sprig % 3)),
        )
        draw.line((soil_cx, stem_base_y - 5, tip[0], tip[1]), fill=rgba(stem_color, 160), width=1)
        draw_leaf(draw, tip[0], tip[1], 10, 4, angle + 0.35, shade(leaf_base, 12), leaf_dark, 225)
  elif item.category == "lighting":
    w_cells, h_cells = rotated_size(item, rotation)
    base_h = 10
    image, draw, floor, _base_y = sprite_canvas_for(item, rotation, base_h + 62, 78)
    origin = floor[0]
    floor_center = polygon_center(floor)
    top = local_floor_quad(origin, 0.24, 0.24, w_cells - 0.24, h_cells - 0.24, base_h)
    cx, _cy = polygon_center(top)
    draw_neutral_shadow(draw, floor_center[0] + 5, floor_center[1] + 8, image.size[0] * 0.34, 10)
    draw_projected_prism(draw, top, base_h, shade(item.color, -20))
    draw.line((cx, top[0][1] - 34, cx, floor_center[1] - 10), fill=rgba(0x6D5238), width=3)
    draw.ellipse((cx - 18, floor_center[1] - 44, cx + 18, floor_center[1] - 20), fill=rgba(item.color, 230), outline=rgba(0x8B6A3E), width=2)
    draw.ellipse((cx - 8, floor_center[1] - 37, cx + 8, floor_center[1] - 25), fill=rgba(0xFFF3BA, 170))
  else:
    w_cells, h_cells = rotated_size(item, rotation)
    decor_h = 16
    image, draw, floor, _base_y = sprite_canvas_for(item, rotation, decor_h + 28, 54)
    origin = floor[0]
    floor_center = polygon_center(floor)
    top = local_floor_quad(origin, 0.13, 0.16, w_cells - 0.13, h_cells - 0.16, decor_h)
    cx, _cy = polygon_center(top)
    draw_neutral_shadow(draw, floor_center[0] + 6, floor_center[1] + 8, image.size[0] * 0.44, 12)
    draw_projected_prism(draw, top, decor_h, item.color)
    draw.ellipse((cx - 16, floor_center[1] - 36, cx + 16, floor_center[1] - 6), fill=rgba(shade(item.color, 20)), outline=rgba(0x5B4033), width=2)
  return image


def draw_furniture_item(item: FurnitureItem, rotation: int) -> Image.Image:
  if item.category == "flooring":
    return draw_floor_sprite(item, rotation)
  if item.category == "table":
    return draw_table_sprite(item, rotation)
  if item.category == "chair":
    return draw_chair_sprite(item, rotation)
  if item.category == "stove":
    return draw_stove_sprite(item, rotation)
  if item.category == "counter":
    return draw_counter_sprite(item, rotation)
  return draw_decor_sprite(item, rotation)


def draw_character(role: str, action: str, facing: str, variant = 0) -> Image.Image:
  image = Image.new("RGBA", (90, 122), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  cx = 45
  base_y = 110
  seated = action == "sit"
  carry = action in ("carry", "serve", "clean")
  variant = variant % CHARACTER_VARIANT_COUNT
  skin_palette = (0xFFD2AA, 0xF2BE92, 0xD99770, 0xB97856, 0xE8C6A3, 0xF8D9C0, 0x8E5F43, 0xC98568, 0xE6AF83, 0xA86F51)
  hair_palette = (0x4B2D22, 0x2D211C, 0xC9853D, 0x7A3D2C, 0xD8C4A4, 0x6B3428, 0x1F1A17, 0x8D6A42, 0x3C2720, 0xB45E3C)
  guest_shirts = (0xD48682, 0x7FB08A, 0xD9A24E, 0x8E74AA, 0xD46B65, 0x75A5B1, 0xC286A6, 0xA7A25D, 0xE09063, 0x6F9BC6)
  waiter_shirts = (0x456B82, 0x3E6478, 0x4C6F86, 0x365B70, 0x506F7D, 0x3F6171, 0x55768C, 0x425E75, 0x314E66, 0x526578)
  chef_shirts = (0xFAF5E8, 0xF8F1DE, 0xF3F4F1, 0xFFF7ED, 0xF7F2EA, 0xF4EFE3, 0xFFFFFF, 0xF7F4EA, 0xF1F4F2, 0xFFF2E6)
  errand_shirts = (0x7B8B45, 0x6F7F3E, 0x8A7A42, 0x6D8A5A, 0x788F55, 0x8B6A45, 0x657C4C, 0x9A844F, 0x728B66, 0xA0724C)
  role_shirts = {"guest": guest_shirts, "waiter": waiter_shirts, "chef": chef_shirts, "errand": errand_shirts}
  role_pants = {
    "guest": (0x4F5D6B, 0x3E4F61, 0x65504A, 0x4D5A4D, 0x514A64, 0x5E5E55, 0x334B58, 0x6A513A, 0x4F4A5D, 0x455C62),
    "waiter": (0x263F52, 0x22384B, 0x2E4355, 0x1E3345, 0x2D3F50, 0x293A49, 0x30495A, 0x243647, 0x26394A, 0x1F3A4A),
    "chef": (0x59656B, 0x6A6F6D, 0x505D63, 0x666A6B, 0x5C6266, 0x545D60, 0x687277, 0x4F5960, 0x626D72, 0x555F66),
    "errand": (0x5D5132, 0x59462E, 0x4D5734, 0x61553D, 0x4B4F35, 0x6D5037, 0x474733, 0x5E5A3C, 0x586443, 0x6B5638),
  }
  tie_palette = (0x7B2530, 0xA85F2B, 0x2E5A73, 0x6A334D, 0x8A722D, 0x7D2B30, 0x445C8A, 0x5F402A, 0x356A64, 0x7B3D6A)
  skin = skin_palette[variant]
  hair = 0xFFFFFF if role == "chef" else hair_palette[variant]
  shirt = role_shirts[role][variant]
  pants = role_pants[role][variant]
  tie_color = tie_palette[variant]
  eye_color = 0x2F2926 if variant not in (3, 7) else 0x355064
  lip_color = (0x8C4D43, 0x9B5A47, 0x7E4B42, 0xA15B68, 0x7A4E3C, 0x93534B, 0x6D463B, 0xA76755, 0x8E5146, 0x744039)[variant]
  glasses = variant in (2, 6)
  moustache = variant == 5 and role != "chef"
  step = -5 if action == "walk-1" else 5 if action == "walk-2" else 0
  body_h = 18 if seated else 34
  body_y = base_y - (38 if seated else 63)
  head_y = body_y - (15 if seated else 20)
  side = facing in ("left", "right")
  back = facing == "up"
  head_x = cx + (5 if facing == "right" else -5 if facing == "left" else 0)

  def draw_foot(x: float, y: float, direction = 0, color = 0x2F2926, width = 13) -> None:
    if direction == 0:
      draw.rounded_rectangle((x - width / 2, y - 3, x + width / 2, y + 4), radius=3, fill=rgba(color))
      draw.ellipse((x - width / 2 - 1, y - 3, x + width / 2 + 1, y + 4), outline=rgba(0x1F1917, 160), width=1)
    else:
      toe = x + direction * width * 0.34
      heel = x - direction * width * 0.38
      draw.rounded_rectangle((min(heel, toe) - 3, y - 3, max(heel, toe) + 5, y + 4), radius=3, fill=rgba(color))
      draw.ellipse((toe - 3, y - 3, toe + 6, y + 4), fill=rgba(color), outline=rgba(0x1F1917, 150), width=1)

  draw.ellipse((cx - 20, base_y - (2 if seated else 6), cx + 24, base_y + 8), fill=(55, 39, 31, 34))
  if not seated:
    if side:
      dir_ = 1 if facing == "right" else -1
      near_foot_x = cx + dir_ * (10 + step * 0.6)
      far_foot_x = cx - dir_ * (11 - step * 0.6)
      draw.line((cx - 5, base_y - 38, near_foot_x, base_y - 5), fill=rgba(shade(pants, -22)), width=8)
      draw.line((cx + 5, base_y - 38, far_foot_x, base_y - 5), fill=rgba(pants), width=8)
      draw_foot(far_foot_x, base_y - 3, -dir_, shade(0x2F2926, 8), 14)
      draw_foot(near_foot_x, base_y - 2, dir_, 0x2F2926, 15)
    else:
      left_foot_y = base_y - 3 - step * 0.45
      right_foot_y = base_y - 3 + step * 0.45
      draw.line((cx - 6, base_y - 38, cx - 8, left_foot_y), fill=rgba(shade(pants, -20)), width=8)
      draw.line((cx + 6, base_y - 38, cx + 8, right_foot_y), fill=rgba(pants), width=8)
      draw_foot(cx - 8, left_foot_y, 0, shade(0x2F2926, 8), 13)
      draw_foot(cx + 8, right_foot_y, 0, 0x2F2926, 13)
  else:
    hip_y = body_y + body_h - 3
    seat_front_y = hip_y + 4
    foot_y = base_y - 5
    draw.ellipse((cx - 14, hip_y - 5, cx + 14, hip_y + 7), fill=rgba(shade(pants, -12), 210))
    if side:
      dir_ = 1 if facing == "right" else -1
      near_knee_x = cx + dir_ * 16
      near_knee_y = seat_front_y
      far_knee_x = cx + dir_ * 10
      far_knee_y = seat_front_y + 1
      near_foot_x = near_knee_x + dir_ * 1
      far_foot_x = far_knee_x + dir_ * 1
      draw.line((cx - dir_ * 2, hip_y - 1, far_knee_x, far_knee_y), fill=rgba(shade(pants, -28)), width=9)
      draw.line((far_knee_x, far_knee_y, far_foot_x, foot_y), fill=rgba(shade(pants, -16)), width=7)
      draw.line((cx + dir_ * 3, hip_y, near_knee_x, near_knee_y), fill=rgba(pants), width=10)
      draw.line((near_knee_x, near_knee_y, near_foot_x, foot_y), fill=rgba(shade(pants, 6)), width=8)
      draw.ellipse((far_knee_x - 4, far_knee_y - 4, far_knee_x + 4, far_knee_y + 4), fill=rgba(shade(pants, -22)))
      draw.ellipse((near_knee_x - 4, near_knee_y - 4, near_knee_x + 4, near_knee_y + 4), fill=rgba(shade(pants, 2)))
      draw_foot(far_foot_x, foot_y + 1, dir_, shade(0x2F2926, 10), 11)
      draw_foot(near_foot_x, foot_y, dir_, 0x2F2926, 12)
    elif facing == "up":
      knee_y = seat_front_y + 1
      draw.line((cx - 4, hip_y - 1, cx - 5, knee_y), fill=rgba(shade(pants, -24)), width=8)
      draw.line((cx + 4, hip_y - 1, cx + 5, knee_y), fill=rgba(shade(pants, -8)), width=8)
      draw.line((cx - 5, knee_y, cx - 6, foot_y), fill=rgba(shade(pants, -18)), width=7)
      draw.line((cx + 5, knee_y, cx + 6, foot_y), fill=rgba(pants), width=7)
      draw_foot(cx - 6, foot_y, 0, shade(0x2F2926, 10), 10)
      draw_foot(cx + 6, foot_y, 0, 0x2F2926, 10)
    else:
      knee_y = seat_front_y + 2
      draw.line((cx - 5, hip_y - 1, cx - 6, knee_y), fill=rgba(shade(pants, -20)), width=9)
      draw.line((cx + 5, hip_y - 1, cx + 6, knee_y), fill=rgba(pants), width=9)
      draw.line((cx - 6, knee_y, cx - 7, foot_y), fill=rgba(shade(pants, -10)), width=7)
      draw.line((cx + 6, knee_y, cx + 7, foot_y), fill=rgba(shade(pants, 8)), width=7)
      draw.ellipse((cx - 10, knee_y - 3, cx - 3, knee_y + 4), fill=rgba(shade(pants, -16)))
      draw.ellipse((cx + 3, knee_y - 3, cx + 10, knee_y + 4), fill=rgba(shade(pants, 4)))
      draw_foot(cx - 7, foot_y, 0, shade(0x2F2926, 8), 10)
      draw_foot(cx + 7, foot_y, 0, 0x2F2926, 10)
  draw.rounded_rectangle((cx - 15, body_y, cx + 15, body_y + body_h), radius=9, fill=rgba(shade(shirt, -20)), outline=rgba(0x3F3029), width=2)
  draw.rounded_rectangle((cx - 15, body_y, cx + 9, body_y + body_h - 2), radius=8, fill=rgba(shirt))
  draw.line((cx + 10, body_y + 5, cx + 10, body_y + body_h - 4), fill=rgba(shade(shirt, -42)), width=3)
  if role == "waiter":
    draw.polygon([(cx - 6, body_y + 4), (cx + 6, body_y + 4), (cx, body_y + 13)], fill=rgba(0xF4E6CE))
    draw.polygon([(cx - 4, body_y + 10), (cx + 4, body_y + 10), (cx, body_y + min(25, body_h - 4))], fill=rgba(tie_color))
    draw.line((cx - 13, body_y + body_h - 5, cx + 12, body_y + body_h - 5), fill=rgba(0xF4E6CE, 160), width=2)
  if role == "chef":
    draw.rounded_rectangle((cx - 9, body_y + 8, cx + 9, body_y + body_h), radius=4, fill=rgba(0xFFFFFF), outline=rgba(0xD8D8D8), width=1)
    scarf = (0xC94D3F, 0xE0B24E, 0x5F9D92, 0x7A86BF, 0xB36C8F, 0xB87944, 0x6090B0, 0x8E6F52, 0x4E8E72, 0x9A5B68)[variant]
    draw.line((cx - 8, body_y + 7, cx + 8, body_y + 7), fill=rgba(scarf), width=3)
  if role == "guest" and variant in (1, 4, 7):
    draw.line((cx - 11, body_y + 9, cx + 8, body_y + 23), fill=rgba(shade(shirt, -42), 135), width=2)
    draw.line((cx + 11, body_y + 9, cx - 8, body_y + 23), fill=rgba(shade(shirt, -42), 105), width=2)
  if role == "errand":
    draw.line((cx - 13, body_y + 8, cx + 9, body_y + 21), fill=rgba(0xC9B06F, 140), width=3)
  arm_end_y = body_y + (18 if seated else 30)
  if seated:
    draw.line((cx - 13, body_y + 10, cx - 6, arm_end_y), fill=rgba(skin), width=5)
    draw.line((cx + 13, body_y + 10, cx + 6, arm_end_y), fill=rgba(shade(skin, -18)), width=5)
    draw.ellipse((cx - 7, arm_end_y - 2, cx + 7, arm_end_y + 3), fill=rgba(shade(skin, -10), 220))
  else:
    draw.line((cx - 15, body_y + 11, cx - 22, arm_end_y), fill=rgba(skin), width=5)
    draw.line((cx + 15, body_y + 11, cx + 22, arm_end_y), fill=rgba(shade(skin, -18)), width=5)
  if carry:
    plate_y = body_y + 20
    draw.ellipse((cx + 12, plate_y - 8, cx + 36, plate_y + 9), fill=rgba(0xF9F3E3), outline=rgba(0x8B7764), width=2)
    if action != "clean":
      draw.ellipse((cx + 22, plate_y - 2, cx + 31, plate_y + 7), fill=rgba(0x6DA05E))
  draw.ellipse((head_x - 15, head_y - 15, head_x + 15, head_y + 15), fill=rgba(skin), outline=rgba(0x3F3029), width=2)
  draw.ellipse((head_x + 4, head_y - 11, head_x + 15, head_y + 12), fill=rgba(shade(skin, -18), 95))
  draw.ellipse((head_x - 9, head_y - 10, head_x - 2, head_y - 3), fill=rgba(0xFFFFFF, 65))
  if role == "chef":
    for ox, oy, radius in ((-9, -14, 8), (0, -19, 9), (9, -14, 8)):
      draw.ellipse((head_x + ox - radius, head_y + oy - radius, head_x + ox + radius, head_y + oy + radius), fill=rgba(0xFFFFFF), outline=rgba(0xD8D8D8))
    draw.rounded_rectangle((head_x - 12, head_y - 15, head_x + 12, head_y - 5), radius=4, fill=rgba(0xFFFFFF))
    if not back and variant in (1, 6):
      draw.arc((head_x - 7, head_y + 1, head_x + 7, head_y + 9), 20, 160, fill=rgba(shade(hair_palette[variant], -12)), width=2)
  else:
    if back:
      draw.pieslice((head_x - 16, head_y - 18, head_x + 16, head_y + 12), 180, 360, fill=rgba(hair))
      draw.ellipse((head_x - 13, head_y - 12, head_x + 13, head_y + 5), fill=rgba(shade(hair, -12)))
      if variant in (3, 7):
        draw.ellipse((head_x + 7, head_y - 8, head_x + 18, head_y + 6), fill=rgba(hair), outline=rgba(shade(hair, -18)), width=1)
    else:
      if variant == 1:
        draw.pieslice((head_x - 17, head_y - 19, head_x + 17, head_y + 13), 180, 360, fill=rgba(hair))
        draw.ellipse((head_x - 16, head_y - 4, head_x - 9, head_y + 13), fill=rgba(hair))
        draw.ellipse((head_x + 9, head_y - 4, head_x + 16, head_y + 13), fill=rgba(hair))
      elif variant == 3:
        draw.ellipse((head_x - 17, head_y - 19, head_x + 10, head_y + 2), fill=rgba(hair))
        draw.ellipse((head_x + 4, head_y - 16, head_x + 20, head_y - 2), fill=rgba(shade(hair, -8)))
      elif variant == 4:
        draw.pieslice((head_x - 16, head_y - 19, head_x + 16, head_y + 7), 180, 360, fill=rgba(hair))
        draw.line((head_x - 13, head_y - 2, head_x + 10, head_y - 12), fill=rgba(shade(hair, 18)), width=3)
      elif variant == 7:
        draw.pieslice((head_x - 16, head_y - 17, head_x + 16, head_y + 10), 180, 360, fill=rgba(hair))
        draw.ellipse((head_x + 10, head_y - 15, head_x + 23, head_y - 3), fill=rgba(hair), outline=rgba(shade(hair, -18)), width=1)
      else:
        draw.pieslice((head_x - 16, head_y - 18, head_x + 16, head_y + 10), 180, 360, fill=rgba(hair))
      draw.ellipse((head_x - 14, head_y - 13, head_x + 14, head_y - 1), fill=rgba(shade(hair, -8), 230))
      if variant in (0, 2, 5, 6):
        draw.line((head_x - 13, head_y - 4, head_x + 11, head_y - 9), fill=rgba(shade(hair, 18), 190), width=3)
  if not back:
    if side:
      profile = 1 if facing == "right" else -1
      eye_x = head_x + profile * 7
      draw.ellipse((eye_x - 2, head_y - 3, eye_x + 2, head_y + 1), fill=rgba(eye_color))
      if glasses:
        draw.ellipse((eye_x - 4, head_y - 5, eye_x + 4, head_y + 3), outline=rgba(0x2B2B2B), width=1)
      draw.line((head_x + profile * 8, head_y + 1, head_x + profile * (12 + variant % 2), head_y + 3), fill=rgba(0xA26A52), width=1)
      if moustache:
        draw.line((head_x + profile * 3, head_y + 6, head_x + profile * 12, head_y + 6), fill=rgba(shade(hair, -12)), width=2)
      draw.line((head_x + profile * 6, head_y + 8, head_x + profile * 11, head_y + 8), fill=rgba(lip_color), width=1)
    else:
      eye_y = head_y - 3 + (variant % 2)
      draw.ellipse((head_x - 7, eye_y, head_x - 3, eye_y + 4), fill=rgba(eye_color))
      draw.ellipse((head_x + 3, eye_y, head_x + 7, eye_y + 4), fill=rgba(eye_color))
      if glasses:
        draw.ellipse((head_x - 10, eye_y - 2, head_x - 1, eye_y + 6), outline=rgba(0x2B2B2B), width=1)
        draw.ellipse((head_x + 1, eye_y - 2, head_x + 10, eye_y + 6), outline=rgba(0x2B2B2B), width=1)
        draw.line((head_x - 1, eye_y + 2, head_x + 1, eye_y + 2), fill=rgba(0x2B2B2B), width=1)
      brow_offset = -1 if variant in (0, 4) else 0
      draw.line((head_x - 9, eye_y + brow_offset - 3, head_x - 2, eye_y + brow_offset - 4), fill=rgba(shade(hair, -22), 165), width=1)
      draw.line((head_x + 2, eye_y + brow_offset - 4, head_x + 9, eye_y + brow_offset - 3), fill=rgba(shade(hair, -22), 165), width=1)
      nose_x = head_x + (variant % 3) - 1
      draw.line((nose_x, head_y + 1, nose_x + 2, head_y + 5), fill=rgba(0xA26A52), width=1)
      if moustache:
        draw.arc((head_x - 8, head_y + 3, head_x + 1, head_y + 9), 200, 350, fill=rgba(shade(hair, -12)), width=2)
        draw.arc((head_x - 1, head_y + 3, head_x + 8, head_y + 9), 190, 340, fill=rgba(shade(hair, -12)), width=2)
      draw.arc((head_x - 5, head_y + 3, head_x + 5, head_y + 10), 15, 165, fill=rgba(lip_color), width=1)
  return image


def draw_character_v2(role: str, action: str, facing: str, variant = 0) -> Image.Image:
  # Character atlas v2: draw above logical resolution, but keep the packed
  # texture under a 4096px height ceiling. Older/integrated GPUs often fail or
  # flicker when a WebGL texture exceeds that, which makes unrelated UI vanish.
  logical_w = 96
  logical_h = 136
  scale = 1.2
  image = Image.new("RGBA", (round(logical_w * scale), round(logical_h * scale)), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  cx = logical_w / 2
  base_y = 126
  seated = action == "sit"
  carry = action in ("carry", "serve", "clean")
  cook = action.startswith("cook")
  walk_step = -1 if action.endswith("-1") else 1 if action.endswith("-2") else 0
  cook_step = -1 if action == "cook-1" else 1 if action == "cook-2" else 0
  side = facing in ("left", "right")
  back = facing == "up"
  dir_x = -1 if facing == "left" else 1

  def sp(value: float) -> float:
    return value * scale

  def box(x1: float, y1: float, x2: float, y2: float) -> tuple[float, float, float, float]:
    return (sp(x1), sp(y1), sp(x2), sp(y2))

  def pts(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(sp(x), sp(y)) for x, y in points]

  def ellipse(x1: float, y1: float, x2: float, y2: float, fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.ellipse(box(x1, y1, x2, y2), fill=rgba(fill, alpha), outline=rgba(outline) if outline is not None else None, width=max(1, round(width * scale)))

  def rounded(x1: float, y1: float, x2: float, y2: float, radius: float, fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.rounded_rectangle(
      box(x1, y1, x2, y2),
      radius=max(1, round(radius * scale)),
      fill=rgba(fill, alpha),
      outline=rgba(outline) if outline is not None else None,
      width=max(1, round(width * scale)),
    )

  def polygon(points: list[tuple[float, float]], fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.polygon(pts(points), fill=rgba(fill, alpha))
    if outline is not None:
      draw.line(pts(points + [points[0]]), fill=rgba(outline, min(alpha, 230)), width=max(1, round(width * scale)), joint="curve")

  def line(points: list[tuple[float, float]], fill: int, width = 1, alpha = 255) -> None:
    draw.line(pts(points), fill=rgba(fill, alpha), width=max(1, round(width * scale)), joint="curve")

  def limb(a: tuple[float, float], b: tuple[float, float], width: float, color: int, shade_edge = True) -> None:
    line([a, b], shade(color, -10 if shade_edge else 0), width + 1)
    line([(a[0] - 0.5, a[1] - 0.5), (b[0] - 0.5, b[1] - 0.5)], color, width)
    ellipse(a[0] - width * 0.32, a[1] - width * 0.32, a[0] + width * 0.32, a[1] + width * 0.32, color, None, 1)
    ellipse(b[0] - width * 0.32, b[1] - width * 0.32, b[0] + width * 0.32, b[1] + width * 0.32, color, None, 1)

  def foot(x: float, y: float, direction: int, front = True) -> None:
    color = 0x26201D if front else 0x342A26
    if direction == 0:
      rounded(x - 6.5, y - 2.5, x + 7.5, y + 4, 3, color, 0x1F1917, 0.8)
      ellipse(x - 5, y - 3, x + 8, y + 2, shade(color, 8), None, 1, 115)
    else:
      rounded(x - 6, y - 2.5, x + 8, y + 4, 3, color, 0x1F1917, 0.8)
      ellipse(x + direction * 2, y - 3, x + direction * 10, y + 3, shade(color, 8), None, 1, 130)

  skin_palette = (0xFFD2AA, 0xF2BE92, 0xD99770, 0xB97856, 0xE8C6A3, 0xF8D9C0, 0x8E5F43, 0xC98568, 0xE6AF83, 0xA86F51)
  hair_palette = (0x4B2D22, 0x2D211C, 0xC9853D, 0x7A3D2C, 0xD8C4A4, 0x6B3428, 0x1F1A17, 0x8D6A42, 0x3C2720, 0xB45E3C)
  guest_shirts = (0xD48682, 0x7FB08A, 0xD9A24E, 0x8E74AA, 0xD46B65, 0x75A5B1, 0xC286A6, 0xA7A25D, 0xE09063, 0x6F9BC6)
  waiter_shirts = (0x2F5C78, 0x355F73, 0x406D86, 0x294E67, 0x456C7A, 0x31596D, 0x49748C, 0x34546D, 0x294962, 0x3E6274)
  chef_shirts = (0xFAF5E8, 0xF8F1DE, 0xF3F4F1, 0xFFF7ED, 0xF7F2EA, 0xF4EFE3, 0xFFFFFF, 0xF7F4EA, 0xF1F4F2, 0xFFF2E6)
  errand_shirts = (0x7B8B45, 0x6F7F3E, 0x8A7A42, 0x6D8A5A, 0x788F55, 0x8B6A45, 0x657C4C, 0x9A844F, 0x728B66, 0xA0724C)
  role_shirts = {"guest": guest_shirts, "waiter": waiter_shirts, "chef": chef_shirts, "errand": errand_shirts}
  role_pants = {
    "guest": (0x4F5D6B, 0x3E4F61, 0x65504A, 0x4D5A4D, 0x514A64, 0x5E5E55, 0x334B58, 0x6A513A, 0x4F4A5D, 0x455C62),
    "waiter": (0x20394D, 0x1D3347, 0x263F52, 0x1B2E42, 0x26394B, 0x243644, 0x2A4658, 0x223346, 0x22364A, 0x1B3546),
    "chef": (0x59656B, 0x6A6F6D, 0x505D63, 0x666A6B, 0x5C6266, 0x545D60, 0x687277, 0x4F5960, 0x626D72, 0x555F66),
    "errand": (0x5D5132, 0x59462E, 0x4D5734, 0x61553D, 0x4B4F35, 0x6D5037, 0x474733, 0x5E5A3C, 0x586443, 0x6B5638),
  }
  tie_palette = (0x9B2638, 0xB76B35, 0x2E5A73, 0x7F3A5C, 0x94792D, 0x942E36, 0x465F95, 0x765032, 0x35756D, 0x894875)
  variant = variant % CHARACTER_VARIANT_COUNT
  skin = skin_palette[variant]
  hair = 0xFFFFFF if role == "chef" else hair_palette[variant]
  shirt = role_shirts[role][variant]
  pants = role_pants[role][variant]
  tie_color = tie_palette[variant]
  eye_color = 0x2F2926 if variant not in (3, 7) else 0x2C5570
  lip_color = (0x8C4D43, 0x9B5A47, 0x7E4B42, 0xA15B68, 0x7A4E3C, 0x93534B, 0x6D463B, 0xA76755, 0x8E5146, 0x744039)[variant]
  glasses = variant in (2, 6, 8)
  moustache = variant == 5 and role != "chef"

  draw_neutral_shadow(draw, sp(cx + (3 if side and facing == "right" else -3 if side else 2)), sp(base_y + 1), sp(36 if seated else 42), sp(9 if seated else 11))

  if seated:
    hip_y = 88
    knee_y = 108
    foot_y = 124
    if side:
      near_knee = (cx + dir_x * 15, knee_y)
      far_knee = (cx + dir_x * 8, knee_y + 1)
      near_foot = (near_knee[0] + dir_x * 2, foot_y)
      far_foot = (far_knee[0] + dir_x * 2, foot_y + 1)
      limb((cx + dir_x * 1, hip_y), far_knee, 6, shade(pants, -20))
      limb(far_knee, far_foot, 5.5, shade(pants, -12))
      limb((cx + dir_x * 5, hip_y - 1), near_knee, 7, pants)
      limb(near_knee, near_foot, 5.8, shade(pants, 4))
      foot(far_foot[0], far_foot[1], dir_x, False)
      foot(near_foot[0], near_foot[1], dir_x, True)
    else:
      knee_spread = 5 if facing == "up" else 7
      left_knee = (cx - knee_spread, knee_y)
      right_knee = (cx + knee_spread, knee_y + 1)
      left_foot = (cx - knee_spread - 1, foot_y)
      right_foot = (cx + knee_spread + 1, foot_y)
      limb((cx - 5, hip_y), left_knee, 6.5, shade(pants, -18))
      limb(left_knee, left_foot, 5.5, shade(pants, -9))
      limb((cx + 5, hip_y), right_knee, 6.5, pants)
      limb(right_knee, right_foot, 5.5, shade(pants, 6))
      foot(left_foot[0], left_foot[1], 0, False)
      foot(right_foot[0], right_foot[1], 0, True)
    body_y = 62
    body_h = 29
  else:
    hip_y = 82
    if side:
      near_foot = (cx + dir_x * (12 + walk_step * 4), base_y - 2)
      far_foot = (cx - dir_x * (10 - walk_step * 4), base_y - 3)
      limb((cx + dir_x * 4, hip_y), far_foot, 6, shade(pants, -22))
      limb((cx - dir_x * 2, hip_y), near_foot, 7, pants)
      foot(far_foot[0], far_foot[1], -dir_x, False)
      foot(near_foot[0], near_foot[1], dir_x, True)
    else:
      stride = walk_step * (1 if facing == "down" else -1)
      left_foot = (cx - 7, base_y - 3 - stride * 5)
      right_foot = (cx + 7, base_y - 2 + stride * 5)
      limb((cx - 5, hip_y), left_foot, 6, shade(pants, -18))
      limb((cx + 5, hip_y), right_foot, 7, pants)
      foot(left_foot[0], left_foot[1], 0, stride > 0)
      foot(right_foot[0], right_foot[1], 0, stride <= 0)
    body_y = 47
    body_h = 37

  shoulder_y = body_y + 5
  body_w = 25 if side else 30
  body_x = cx + (dir_x * 4 if side else 0)
  front_color = shirt
  side_color = shade(shirt, -28)
  dark_edge = 0x3F3029
  if role == "chef":
    front_color = 0xFFF9EF
    side_color = 0xE6E3DB
  elif role == "waiter":
    front_color = 0x2F5C78
    side_color = 0x20394D

  # Far arm first, then torso volume, then near arm/details.
  far_arm_x = body_x - (body_w / 2 + 3) if not side else body_x - dir_x * 8
  near_arm_x = body_x + (body_w / 2 + 3) if not side else body_x + dir_x * 9
  arm_y = shoulder_y + 8
  if cook:
    far_target = (body_x - 13 + cook_step * 1.5, body_y + 22)
    near_target = (body_x + 13 - cook_step * 1.5, body_y + 21)
    limb((body_x - 9, arm_y), far_target, 4.5, shade(skin, -16))
    limb((body_x + 9, arm_y), near_target, 4.5, skin)
  else:
    far_hand = (far_arm_x - (dir_x * 2 if side else 2), body_y + (24 if seated else 31))
    limb((body_x - body_w / 2 + 2, arm_y), far_hand, 4.5, shade(skin, -16))

  polygon(
    [
      (body_x - body_w / 2, body_y + 3),
      (body_x + body_w / 2 - 2, body_y + 1),
      (body_x + body_w / 2 + 5, body_y + body_h - 4),
      (body_x - body_w / 2 + 4, body_y + body_h),
    ],
    side_color,
    dark_edge,
    1,
  )
  rounded(body_x - body_w / 2, body_y, body_x + body_w / 2, body_y + body_h, 10, front_color, dark_edge, 1.4)
  rounded(body_x - body_w / 2 + 2, body_y + 2, body_x + body_w / 2 - 6, body_y + body_h - 3, 8, shade(front_color, 12), None, 1, 210)

  if role == "waiter" and not back:
    polygon([(body_x - 8, body_y + 5), (body_x + 8, body_y + 5), (body_x, body_y + 16)], 0xF4E6CE)
    polygon([(body_x - 4, body_y + 12), (body_x + 4, body_y + 12), (body_x, body_y + min(body_h - 3, 29))], tie_color, shade(tie_color, -25), 0.8)
    line([(body_x - 10, body_y + body_h - 6), (body_x + 10, body_y + body_h - 6)], 0xF4E6CE, 1.5, 160)
  elif role == "waiter":
    line([(body_x - 9, body_y + 10), (body_x + 9, body_y + 12)], shade(front_color, -18), 2, 130)

  if role == "chef":
    rounded(body_x - 9, body_y + 9, body_x + 9, body_y + body_h - 1, 4, 0xFFFFFF, 0xD8D8D8, 0.9)
    line([(body_x, body_y + 10), (body_x, body_y + body_h - 3)], 0xD8D8D8, 1)
    scarf = (0xC94D3F, 0xE0B24E, 0x5F9D92, 0x7A86BF, 0xB36C8F, 0xB87944, 0x6090B0, 0x8E6F52, 0x4E8E72, 0x9A5B68)[variant]
    line([(body_x - 9, body_y + 8), (body_x + 8, body_y + 8)], scarf, 2.3)

  if role == "errand":
    line([(body_x - 12, body_y + 9), (body_x + 10, body_y + 25)], 0xC9B06F, 3, 150)
    rounded(body_x + 8, body_y + 20, body_x + 19, body_y + 33, 3, 0xB58B54, 0x5B4033, 0.8)

  if role == "guest" and variant in (1, 4, 7, 9):
    line([(body_x - 10, body_y + 11), (body_x + 8, body_y + 26)], shade(shirt, -42), 1.4, 130)

  if not cook:
    if carry:
      hand = (near_arm_x + (dir_x * 5 if side else 4), body_y + 24)
      limb((body_x + body_w / 2 - 2, arm_y), hand, 4.5, skin)
      plate_x = hand[0] + (dir_x * 7 if side else 9)
      plate_y = hand[1] - 4
      ellipse(plate_x - 10, plate_y - 5, plate_x + 12, plate_y + 7, 0xFFF9EC, 0x8B7764, 1)
      if action == "clean":
        ellipse(plate_x - 4, plate_y - 1, plate_x + 1, plate_y + 3, 0xB9A884, None, 1)
        line([(plate_x + 4, plate_y + 3), (plate_x + 10, plate_y + 6)], 0x7D6B56, 1.2)
      else:
        ellipse(plate_x - 3, plate_y - 2, plate_x + 7, plate_y + 5, 0x6DA05E)
        ellipse(plate_x + 4, plate_y - 4, plate_x + 10, plate_y + 2, 0xE7B95A)
    else:
      near_hand = (near_arm_x + (dir_x * 2 if side else 2), body_y + (23 if seated else 31))
      limb((body_x + body_w / 2 - 2, arm_y), near_hand, 4.5, skin)

  head_x = cx + (dir_x * 5 if side else 0)
  head_y = body_y - (14 if seated else 17)
  neck_y = body_y - 2
  rounded(head_x - 5, neck_y - 5, head_x + 5, neck_y + 5, 4, shade(skin, -10), None, 1)
  ellipse(head_x - 15, head_y - 15, head_x + 15, head_y + 15, skin, dark_edge, 1.2)
  ellipse(head_x + 3, head_y - 11, head_x + 15, head_y + 11, shade(skin, -16), None, 1, 95)
  ellipse(head_x - 9, head_y - 10, head_x - 2, head_y - 4, 0xFFFFFF, None, 1, 65)

  if role == "chef":
    for ox, oy, radius in ((-10, -14, 7.8), (0, -20, 9), (10, -14, 7.8), (0, -12, 8)):
      ellipse(head_x + ox - radius, head_y + oy - radius, head_x + ox + radius, head_y + oy + radius, 0xFFFFFF, 0xD8D8D8, 0.8)
    rounded(head_x - 13, head_y - 15, head_x + 13, head_y - 5, 4, 0xFFFFFF, 0xD8D8D8, 0.8)
    if not back and variant in (1, 6):
      line([(head_x - 6, head_y + 4), (head_x + 6, head_y + 5)], shade(hair_palette[variant], -12), 1.5)
  else:
    if back:
      ellipse(head_x - 16, head_y - 17, head_x + 16, head_y + 8, hair, None, 1)
      ellipse(head_x - 14, head_y - 10, head_x + 14, head_y + 8, shade(hair, -14), None, 1)
      if variant in (3, 7):
        ellipse(head_x + 8, head_y - 8, head_x + 19, head_y + 6, hair, shade(hair, -18), 0.8)
    else:
      if variant == 1:
        ellipse(head_x - 17, head_y - 18, head_x + 17, head_y + 9, hair, None, 1)
        ellipse(head_x - 18, head_y - 2, head_x - 9, head_y + 14, hair, None, 1)
        ellipse(head_x + 9, head_y - 2, head_x + 18, head_y + 14, hair, None, 1)
      elif variant == 3:
        ellipse(head_x - 18, head_y - 18, head_x + 10, head_y + 4, hair, None, 1)
        ellipse(head_x + 4, head_y - 16, head_x + 20, head_y - 2, shade(hair, -8), None, 1)
      elif variant == 4:
        ellipse(head_x - 16, head_y - 18, head_x + 16, head_y + 6, hair, None, 1)
        line([(head_x - 12, head_y - 2), (head_x + 10, head_y - 12)], shade(hair, 20), 2)
      elif variant == 7:
        ellipse(head_x - 16, head_y - 17, head_x + 16, head_y + 8, hair, None, 1)
        ellipse(head_x + 10, head_y - 15, head_x + 23, head_y - 3, hair, shade(hair, -18), 0.8)
      elif variant == 8:
        rounded(head_x - 16, head_y - 18, head_x + 16, head_y - 1, 8, hair, None, 1)
        line([(head_x - 14, head_y - 7), (head_x + 13, head_y - 10)], shade(hair, 18), 2)
      else:
        ellipse(head_x - 16, head_y - 18, head_x + 16, head_y + 7, hair, None, 1)
      rounded(head_x - 14, head_y - 13, head_x + 14, head_y - 2, 5, shade(hair, -8), None, 1, 225)
      if variant in (0, 2, 5, 6):
        line([(head_x - 13, head_y - 4), (head_x + 11, head_y - 9)], shade(hair, 18), 2, 190)

  if not back:
    if side:
      eye_x = head_x + dir_x * 7
      ellipse(eye_x - 2.2, head_y - 3, eye_x + 2.2, head_y + 1.3, eye_color)
      if glasses:
        ellipse(eye_x - 4.3, head_y - 5, eye_x + 4.3, head_y + 3.5, 0x000000, None, 1, 0)
        draw.ellipse(box(eye_x - 4.3, head_y - 5, eye_x + 4.3, head_y + 3.5), outline=rgba(0x2B2B2B), width=max(1, round(1.1 * scale)))
      line([(head_x + dir_x * 8, head_y + 1), (head_x + dir_x * (12 + variant % 2), head_y + 3)], 0xA26A52, 1)
      if moustache:
        line([(head_x + dir_x * 3, head_y + 6), (head_x + dir_x * 12, head_y + 6)], shade(hair, -12), 1.8)
      line([(head_x + dir_x * 6, head_y + 8), (head_x + dir_x * 11, head_y + 8)], lip_color, 1.1)
    else:
      eye_y = head_y - 3 + (variant % 2) * 0.5
      ellipse(head_x - 7.5, eye_y, head_x - 3.2, eye_y + 4.2, eye_color)
      ellipse(head_x + 3.2, eye_y, head_x + 7.5, eye_y + 4.2, eye_color)
      ellipse(head_x - 6.5, eye_y + 0.3, head_x - 5.2, eye_y + 1.6, 0xFFFFFF, None, 1, 170)
      ellipse(head_x + 4.2, eye_y + 0.3, head_x + 5.5, eye_y + 1.6, 0xFFFFFF, None, 1, 170)
      if glasses:
        draw.ellipse(box(head_x - 10.5, eye_y - 2.5, head_x - 1, eye_y + 6.2), outline=rgba(0x2B2B2B), width=max(1, round(1.1 * scale)))
        draw.ellipse(box(head_x + 1, eye_y - 2.5, head_x + 10.5, eye_y + 6.2), outline=rgba(0x2B2B2B), width=max(1, round(1.1 * scale)))
        line([(head_x - 1, eye_y + 2), (head_x + 1, eye_y + 2)], 0x2B2B2B, 0.9)
      line([(head_x - 9, eye_y - 3), (head_x - 2, eye_y - 4)], shade(hair, -24), 0.9, 165)
      line([(head_x + 2, eye_y - 4), (head_x + 9, eye_y - 3)], shade(hair, -24), 0.9, 165)
      nose_x = head_x + (variant % 3) - 1
      line([(nose_x, head_y + 1), (nose_x + 2, head_y + 5)], 0xA26A52, 1)
      if moustache:
        draw.arc(box(head_x - 8, head_y + 3, head_x + 1, head_y + 9), 200, 350, fill=rgba(shade(hair, -12)), width=max(1, round(1.5 * scale)))
        draw.arc(box(head_x - 1, head_y + 3, head_x + 8, head_y + 9), 190, 340, fill=rgba(shade(hair, -12)), width=max(1, round(1.5 * scale)))
      draw.arc(box(head_x - 5, head_y + 3, head_x + 5, head_y + 10), 15, 165, fill=rgba(lip_color), width=max(1, round(1.1 * scale)))

  return image


def draw_character_v3(role: str, action: str, facing: str, variant = 0) -> Image.Image:
  logical_w = 96
  logical_h = 136
  scale = 1.2
  image = Image.new("RGBA", (round(logical_w * scale), round(logical_h * scale)), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  cx = logical_w / 2
  base_y = 124
  seated = action == "sit"
  carry = action in ("carry", "serve", "clean")
  cook = action.startswith("cook")
  walk_step = -1 if action.endswith("-1") else 1 if action.endswith("-2") else 0
  cook_step = -1 if action == "cook-1" else 1 if action == "cook-2" else 0
  side = facing in ("left", "right")
  back = facing == "up"
  direction = -1 if facing == "left" else 1

  def sp(value: float) -> float:
    return value * scale

  def box(x1: float, y1: float, x2: float, y2: float) -> tuple[float, float, float, float]:
    return (sp(x1), sp(y1), sp(x2), sp(y2))

  def pts(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(sp(x), sp(y)) for x, y in points]

  def rounded(x1: float, y1: float, x2: float, y2: float, radius: float, fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.rounded_rectangle(
      box(x1, y1, x2, y2),
      radius=max(1, round(radius * scale)),
      fill=rgba(fill, alpha),
      outline=rgba(outline) if outline is not None else None,
      width=max(1, round(width * scale)),
    )

  def ellipse(x1: float, y1: float, x2: float, y2: float, fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.ellipse(
      box(x1, y1, x2, y2),
      fill=rgba(fill, alpha),
      outline=rgba(outline) if outline is not None else None,
      width=max(1, round(width * scale)),
    )

  def poly(points: list[tuple[float, float]], fill: int, outline: int | None = None, width = 1, alpha = 255) -> None:
    draw.polygon(pts(points), fill=rgba(fill, alpha))
    if outline is not None:
      draw.line(pts(points + [points[0]]), fill=rgba(outline, min(235, alpha)), width=max(1, round(width * scale)), joint="curve")

  def line(points: list[tuple[float, float]], fill: int, width = 1, alpha = 255) -> None:
    draw.line(pts(points), fill=rgba(fill, alpha), width=max(1, round(width * scale)), joint="curve")

  def tapered_limb(
    start: tuple[float, float],
    end: tuple[float, float],
    start_width: float,
    end_width: float,
    color: int,
    outline: int = 0x2F2926,
    alpha = 255,
  ) -> None:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = max(0.001, math.sqrt(dx * dx + dy * dy))
    nx = -dy / length
    ny = dx / length
    points = [
      (start[0] + nx * start_width / 2, start[1] + ny * start_width / 2),
      (start[0] - nx * start_width / 2, start[1] - ny * start_width / 2),
      (end[0] - nx * end_width / 2, end[1] - ny * end_width / 2),
      (end[0] + nx * end_width / 2, end[1] + ny * end_width / 2),
    ]
    poly(points, color, outline, 0.8, alpha)
    highlight = shade(color, 24)
    line(
      [
        (start[0] + nx * start_width * 0.18, start[1] + ny * start_width * 0.18),
        (end[0] + nx * end_width * 0.12, end[1] + ny * end_width * 0.12),
      ],
      highlight,
      0.7,
      125,
    )

  def shoe(x: float, y: float, facing_dir: int, front = True) -> None:
    fill = 0x211D1B if front else 0x332A25
    if facing_dir == 0:
      rounded(x - 7, y - 2.8, x + 8, y + 4.2, 3.5, fill, 0x1A1513, 0.8)
      ellipse(x - 5, y - 3.4, x + 8, y + 0.8, shade(fill, 16), None, 1, 120)
    else:
      rounded(x - 6, y - 2.5, x + 8, y + 4.2, 3.2, fill, 0x1A1513, 0.8)
      ellipse(x + facing_dir * 1, y - 3, x + facing_dir * 10, y + 3.4, shade(fill, 14), None, 1, 130)

  skin_palette = COZY_SKINS
  hair_palette = COZY_HAIR
  guest_shirts = COZY_GUEST_SHIRTS
  waiter_shirts = COZY_WAITER_SHIRTS
  chef_shirts = COZY_CHEF_SHIRTS
  errand_shirts = COZY_ERRAND_SHIRTS
  role_shirts = {"guest": guest_shirts, "waiter": waiter_shirts, "chef": chef_shirts, "errand": errand_shirts}
  role_pants = {
    "guest": COZY_GUEST_PANTS,
    "waiter": COZY_WAITER_PANTS,
    "chef": COZY_CHEF_PANTS,
    "errand": COZY_ERRAND_PANTS,
  }
  tie_palette = (0xB12C40, 0xB76B35, 0x2E5A73, 0x7F3A5C, 0x94792D, 0x942E36, 0x465F95, 0x765032, 0x35756D, 0x894875)
  variant = variant % CHARACTER_VARIANT_COUNT
  skin = skin_palette[variant]
  hair = 0xFFFFFF if role == "chef" else hair_palette[variant]
  shirt = role_shirts[role][variant]
  pants = role_pants[role][variant]
  tie = tie_palette[variant]
  glasses = variant in (2, 6, 8)
  moustache = variant == 5 and role != "chef"
  eye = 0x211916 if variant not in (3, 7) else 0x315D77
  lip = (0x9A554D, 0xA66250, 0x884D44, 0xA95F73, 0x814E3D, 0x9E5D52, 0x74463C, 0xAD6D5B, 0x96574C, 0x80463B)[variant]

  body_y = 61 if seated else 48
  body_h = 30 if seated else 39
  hip_y = body_y + body_h - (5 if seated else 3)
  head_y = body_y - (14 if seated else 17)
  body_x = cx + (direction * 4 if side else 0)
  body_w = 28 if seated else 31
  if side:
    body_w = 25 if seated else 27

  draw_neutral_shadow(draw, sp(cx + (direction * 3 if side else 2)), sp(base_y + 1), sp(39 if seated else 43), sp(9 if seated else 11))

  # Legs are real tapered shapes with knees and shoes, not thin robot lines.
  if seated:
    knee_y = 105
    foot_y = 123
    if side:
      near_knee = (cx + direction * 15, knee_y - 1)
      far_knee = (cx + direction * 8, knee_y + 1)
      near_foot = (near_knee[0] + direction * 2, foot_y)
      far_foot = (far_knee[0] + direction * 1, foot_y + 1)
      tapered_limb((body_x + direction * 4, hip_y), far_knee, 8, 7, shade(pants, -21))
      tapered_limb(far_knee, far_foot, 7, 5.4, shade(pants, -10))
      tapered_limb((body_x + direction * 8, hip_y - 1), near_knee, 9, 7.5, pants)
      tapered_limb(near_knee, near_foot, 7.5, 5.6, shade(pants, 9))
      shoe(far_foot[0], far_foot[1], direction, False)
      shoe(near_foot[0], near_foot[1], direction, True)
    else:
      spread = 6 if facing == "up" else 7
      left_knee = (cx - spread, knee_y)
      right_knee = (cx + spread, knee_y + 1)
      left_foot = (cx - spread - 1, foot_y)
      right_foot = (cx + spread + 1, foot_y)
      tapered_limb((cx - 5, hip_y), left_knee, 8, 6.8, shade(pants, -18))
      tapered_limb(left_knee, left_foot, 6.8, 5.2, shade(pants, -8))
      tapered_limb((cx + 5, hip_y), right_knee, 8, 6.8, pants)
      tapered_limb(right_knee, right_foot, 6.8, 5.2, shade(pants, 8))
      shoe(left_foot[0], left_foot[1], 0, False)
      shoe(right_foot[0], right_foot[1], 0, True)
  else:
    stride = walk_step
    if side:
      near_foot = (cx + direction * (12 + stride * 5), base_y - 2)
      far_foot = (cx - direction * (9 - stride * 5), base_y - 3)
      tapered_limb((body_x + direction * 3, hip_y), far_foot, 8, 5.5, shade(pants, -22))
      tapered_limb((body_x - direction * 3, hip_y), near_foot, 9, 5.8, pants)
      shoe(far_foot[0], far_foot[1], -direction, False)
      shoe(near_foot[0], near_foot[1], direction, True)
    else:
      depth_stride = stride * (1 if facing == "down" else -1)
      left_foot = (cx - 7, base_y - 3 - depth_stride * 5)
      right_foot = (cx + 7, base_y - 2 + depth_stride * 5)
      tapered_limb((cx - 5, hip_y), left_foot, 8, 5.5, shade(pants, -18))
      tapered_limb((cx + 5, hip_y), right_foot, 9, 5.8, pants)
      shoe(left_foot[0], left_foot[1], 0, depth_stride > 0)
      shoe(right_foot[0], right_foot[1], 0, depth_stride <= 0)

  torso_front = shirt
  torso_side = shade(shirt, -32)
  if role == "chef":
    torso_front = 0xFFF8EC
    torso_side = 0xE4E1D7
  elif role == "waiter":
    torso_front = 0x2F5C78
    torso_side = 0x20394D

  shoulder_y = body_y + 7
  far_arm_end = (body_x - body_w / 2 - (4 if not side else direction * 7), body_y + (24 if seated else 32))
  near_arm_end = (body_x + body_w / 2 + (4 if not side else direction * 7), body_y + (23 if seated else 32))
  if side:
    far_arm_end = (body_x - direction * 9, body_y + (24 if seated else 31))
    near_arm_end = (body_x + direction * 12, body_y + (23 if seated else 31))

  if cook:
    far_arm_end = (body_x - 13 + cook_step * 2, body_y + 22)
    near_arm_end = (body_x + 13 - cook_step * 2, body_y + 21)
  tapered_limb((body_x - body_w / 2 + 2, shoulder_y), far_arm_end, 5.5, 4.5, shade(skin, -12), 0x5D4032)

  # Torso has a front face and shaded side face so the character reads 2.5D.
  poly(
    [
      (body_x - body_w / 2, body_y + 2),
      (body_x + body_w / 2 - 3, body_y),
      (body_x + body_w / 2 + 6, body_y + body_h - 5),
      (body_x - body_w / 2 + 5, body_y + body_h),
    ],
    torso_side,
    0x3F3029,
    0.9,
  )
  rounded(body_x - body_w / 2, body_y, body_x + body_w / 2, body_y + body_h, 9, torso_front, 0x3F3029, 1.1)
  poly(
    [
      (body_x - body_w / 2 + 3, body_y + 4),
      (body_x + body_w / 2 - 7, body_y + 2),
      (body_x + body_w / 2 - 4, body_y + body_h - 5),
      (body_x - body_w / 2 + 6, body_y + body_h - 3),
    ],
    shade(torso_front, 15),
    None,
    1,
    180,
  )

  if role == "waiter":
    if not back:
      poly([(body_x - 8, body_y + 5), (body_x + 8, body_y + 5), (body_x, body_y + 17)], 0xF4E6CE)
      poly([(body_x - 4, body_y + 13), (body_x + 4, body_y + 13), (body_x + 1, body_y + min(body_h - 2, 31)), (body_x - 2, body_y + min(body_h - 2, 31))], tie, shade(tie, -25), 0.7)
    rounded(body_x - 11, body_y + body_h - 8, body_x + 11, body_y + body_h - 4, 2, 0xF4E6CE, None, 1, 145)
  elif role == "chef":
    rounded(body_x - 10, body_y + 8, body_x + 10, body_y + body_h - 1, 4, 0xFFFFFF, 0xD8D8D8, 0.8)
    line([(body_x, body_y + 9), (body_x, body_y + body_h - 4)], 0xD8D8D8, 0.9)
    for button_y in (body_y + 14, body_y + 21, body_y + 28):
      ellipse(body_x - 3, button_y - 1.2, body_x - 0.6, button_y + 1.2, 0xCAD0CE)
      ellipse(body_x + 3, button_y - 1.2, body_x + 5.4, button_y + 1.2, 0xCAD0CE)
  elif role == "errand":
    line([(body_x - 12, body_y + 9), (body_x + 10, body_y + 25)], 0xC9B06F, 3, 150)
    rounded(body_x + 7, body_y + 21, body_x + 20, body_y + 34, 3, 0xB58B54, 0x5B4033, 0.8)
  elif variant in (1, 4, 7, 9):
    line([(body_x - 10, body_y + 11), (body_x + 8, body_y + 27)], shade(shirt, -45), 1.4, 130)
  elif role == "guest":
    collar = shade(shirt, 42)
    line([(body_x - 7, body_y + 8), (body_x, body_y + 14), (body_x + 7, body_y + 8)], collar, 1.4, 150)

  if role == "guest":
    if variant in (0, 3, 6):
      line([(body_x - 11, body_y + body_h - 9), (body_x + 11, body_y + body_h - 8)], shade(shirt, -44), 1.6, 130)
      rounded(body_x - 3, body_y + body_h - 10, body_x + 3, body_y + body_h - 5, 1.5, 0xD7B46A, None, 1, 150)
    if variant in (2, 8):
      rounded(body_x - body_w / 2 + 2, body_y + 3, body_x + body_w / 2 - 2, body_y + 13, 4, shade(shirt, 26), None, 1, 115)
    if variant in (5, 9):
      line([(body_x - body_w / 2 + 4, body_y + 5), (body_x + body_w / 2 - 5, body_y + body_h - 6)], shade(shirt, -34), 1.2, 105)

  tapered_limb((body_x + body_w / 2 - 2, shoulder_y), near_arm_end, 5.8, 4.5, skin, 0x5D4032)
  if carry:
    plate_x = near_arm_end[0] + (direction * 10 if side else 12)
    plate_y = near_arm_end[1] - 5
    ellipse(plate_x - 11, plate_y - 5.5, plate_x + 12, plate_y + 7, 0xFFF9EC, 0x8B7764, 1)
    if action == "clean":
      ellipse(plate_x - 5, plate_y - 1.8, plate_x + 2, plate_y + 3.5, 0xB9A884, None, 1)
      line([(plate_x + 4, plate_y + 3), (plate_x + 10, plate_y + 6)], 0x7D6B56, 1.1)
    else:
      ellipse(plate_x - 4, plate_y - 2.5, plate_x + 7, plate_y + 5.4, 0x6DA05E)
      ellipse(plate_x + 3, plate_y - 4.5, plate_x + 10, plate_y + 2.4, 0xE7B95A)

  # Head and hair: hair is built around the scalp only, then the face is drawn
  # cleanly on top so features do not disappear under bangs.
  head_x = cx + (direction * 5 if side else 0)
  if seated and side:
    head_x += direction * 1.5
  neck_y = body_y - 2
  rounded(head_x - 5, neck_y - 5, head_x + 5, neck_y + 5, 4, shade(skin, -9), None, 1)

  if role != "chef":
    if variant in (1, 7):
      ellipse(head_x - 20, head_y - 5, head_x - 11, head_y + 7, hair, shade(hair, -18), 0.8)
      ellipse(head_x + 11, head_y - 5, head_x + 20, head_y + 7, hair, shade(hair, -18), 0.8)
    if variant == 3:
      ellipse(head_x - 18, head_y - 18, head_x + 8, head_y + 5, hair)
      ellipse(head_x + 6, head_y - 16, head_x + 21, head_y - 2, shade(hair, -8))
    elif variant == 4:
      ellipse(head_x - 17, head_y - 18, head_x + 17, head_y + 7, hair)
    elif variant == 8:
      rounded(head_x - 17, head_y - 17, head_x + 17, head_y + 1, 9, hair)
    else:
      ellipse(head_x - 17, head_y - 18, head_x + 17, head_y + 8, hair)

  if side:
    face = [
      (head_x - direction * 10, head_y - 12),
      (head_x + direction * 11, head_y - 13),
      (head_x + direction * 15, head_y - 2),
      (head_x + direction * 11, head_y + 12),
      (head_x - direction * 4, head_y + 15),
      (head_x - direction * 12, head_y + 6),
    ]
    poly(face, skin, 0x3F3029, 1)
  else:
    rounded(head_x - 14, head_y - 14, head_x + 14, head_y + 14, 11, skin, 0x3F3029, 1)
    poly([(head_x - 10, head_y + 4), (head_x + 10, head_y + 4), (head_x + 6, head_y + 15), (head_x - 6, head_y + 15)], skin, 0x3F3029, 0.8)
  ellipse(head_x + 4, head_y - 10, head_x + 15, head_y + 11, shade(skin, -16), None, 1, 72)
  ellipse(head_x - 9, head_y - 9, head_x - 2, head_y - 4, 0xFFFFFF, None, 1, 55)
  ellipse(head_x - 15, head_y - 1, head_x - 11, head_y + 5, shade(skin, -8), 0x8E5F43, 0.6, 190)
  ellipse(head_x + 11, head_y - 1, head_x + 15, head_y + 5, shade(skin, -14), 0x8E5F43, 0.6, 190)

  if role == "chef":
    for ox, oy, radius in ((-10, -14, 7.5), (0, -20, 8.8), (10, -14, 7.5), (0, -12, 8)):
      ellipse(head_x + ox - radius, head_y + oy - radius, head_x + ox + radius, head_y + oy + radius, 0xFFFFFF, 0xD8D8D8, 0.7)
    rounded(head_x - 13, head_y - 15, head_x + 13, head_y - 5, 4, 0xFFFFFF, 0xD8D8D8, 0.8)
  elif not back:
    rounded(head_x - 14, head_y - 15, head_x + 14, head_y - 7, 4, shade(hair, -8), None, 1, 230)
    if variant in (0, 2, 5, 6):
      line([(head_x - 12, head_y - 6), (head_x + 10, head_y - 10)], shade(hair, 22), 2, 185)
    elif variant == 4:
      line([(head_x - 12, head_y - 4), (head_x + 9, head_y - 12)], shade(hair, 20), 2)
  else:
    rounded(head_x - 14, head_y - 14, head_x + 14, head_y + 8, 10, shade(hair, -10), None, 1, 245)

  if not back:
    if side:
      eye_x = head_x + direction * 6.7
      ellipse(eye_x - 3, head_y - 3.8, eye_x + 3.2, head_y + 2.2, 0xFFF6E8)
      ellipse(eye_x - 1.2, head_y - 2.3, eye_x + 2.2, head_y + 1.6, eye)
      ellipse(eye_x, head_y - 1.8, eye_x + 0.9, head_y - 0.9, 0xFFFFFF, None, 1, 170)
      if glasses:
        draw.ellipse(box(eye_x - 4.5, head_y - 5.2, eye_x + 4.5, head_y + 3.8), outline=rgba(0x2B2B2B), width=max(1, round(1.2 * scale)))
      poly([(head_x + direction * 9, head_y + 1), (head_x + direction * 13, head_y + 3.2), (head_x + direction * 8.4, head_y + 4.5)], shade(skin, -20), 0xA26A52, 0.45)
      if moustache:
        line([(head_x + direction * 3, head_y + 6), (head_x + direction * 12, head_y + 6.5)], shade(hair, -12), 1.6)
      line([(head_x + direction * 6, head_y + 8), (head_x + direction * 11, head_y + 8.4)], lip, 1.2)
    else:
      eye_y = head_y - 2.8 + (variant % 2) * 0.4
      for ex in (-6.5, 6.5):
        ellipse(head_x + ex - 3.2, eye_y - 1.8, head_x + ex + 3.2, eye_y + 3.5, 0xFFF6E8)
        ellipse(head_x + ex - 1.3, eye_y - 0.8, head_x + ex + 1.8, eye_y + 2.6, eye)
        ellipse(head_x + ex - 0.2, eye_y - 0.3, head_x + ex + 0.8, eye_y + 0.7, 0xFFFFFF, None, 1, 160)
      if glasses:
        draw.ellipse(box(head_x - 10.5, eye_y - 3, head_x - 1, eye_y + 6), outline=rgba(0x2B2B2B), width=max(1, round(1.1 * scale)))
        draw.ellipse(box(head_x + 1, eye_y - 3, head_x + 10.5, eye_y + 6), outline=rgba(0x2B2B2B), width=max(1, round(1.1 * scale)))
        line([(head_x - 1, eye_y + 2), (head_x + 1, eye_y + 2)], 0x2B2B2B, 0.8)
      line([(head_x - 9, eye_y - 3.1), (head_x - 2, eye_y - 4.2)], shade(hair, -24), 0.9, 165)
      line([(head_x + 2, eye_y - 4.2), (head_x + 9, eye_y - 3.1)], shade(hair, -24), 0.9, 165)
      poly([(head_x - 1.4, head_y + 1), (head_x + 2.2, head_y + 4.8), (head_x - 1.8, head_y + 5.5)], shade(skin, -18), 0xA26A52, 0.45)
      if moustache:
        draw.arc(box(head_x - 8, head_y + 3, head_x + 1, head_y + 9), 200, 350, fill=rgba(shade(hair, -12)), width=max(1, round(1.5 * scale)))
        draw.arc(box(head_x - 1, head_y + 3, head_x + 8, head_y + 9), 190, 340, fill=rgba(shade(hair, -12)), width=max(1, round(1.5 * scale)))
      draw.arc(box(head_x - 5, head_y + 3.5, head_x + 5, head_y + 10), 15, 165, fill=rgba(lip), width=max(1, round(1.1 * scale)))
      ellipse(head_x - 11, head_y + 2, head_x - 7, head_y + 6, 0xEAA48D, None, 1, 85)
      ellipse(head_x + 7, head_y + 2, head_x + 11, head_y + 6, 0xEAA48D, None, 1, 70)

  return image


def make_furniture_atlas() -> None:
  packer = AtlasPacker("furniture.png")
  for item in parse_furniture():
    for rotation in (0, 90, 180, 270):
      packer.add(f"{item.id}-r{rotation}", upscale_sprite(draw_furniture_item(item, rotation), FURNITURE_ATLAS_SCALE))
  packer.save(ASSET_DIR)


def make_character_atlas() -> None:
  packer = AtlasPacker("characters.png")
  roles = ("guest", "waiter", "chef", "errand")
  facings = ("down", "up", "left", "right")
  role_actions = {
    "guest": ("idle", "walk-1", "walk-2", "sit"),
    "waiter": ("idle", "walk-1", "walk-2", "carry", "serve", "clean"),
    "chef": ("idle", "walk-1", "walk-2", "cook-1", "cook-2"),
    "errand": ("idle", "walk-1", "walk-2", "carry"),
  }
  for role in roles:
    for action in role_actions[role]:
      for facing in facings:
        for variant in range(CHARACTER_VARIANT_COUNT):
          packer.add(f"{role}-{action}-{facing}-v{variant}", draw_character_v3(role, action, facing, variant))
  packer.save(ASSET_DIR)


def make_environment_atlas() -> None:
  packer = AtlasPacker("environment.png")
  specs: dict[str, Callable[[], Image.Image]] = {
    "wall-back": lambda: simple_wall(180, 88),
    "wall-side": lambda: simple_wall(90, 132),
    "wall-corner": lambda: simple_wall(118, 132, True),
    "entrance-door": simple_door,
    "locked-grass": simple_grass,
    "expansion-sign": simple_sign,
  }
  for name, factory in specs.items():
    packer.add(name, factory())
  packer.save(ASSET_DIR)


def simple_wall(width: int, height: int, corner = False) -> Image.Image:
  image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  draw.rectangle((0, 0, width - 1, height - 1), fill=rgba(0xFFF9EC), outline=rgba(0xD8C8B0), width=3)
  draw.rectangle((0, height - 14, width, height), fill=rgba(0xE8D8C3))
  draw.line((0, 10, width, 10), fill=rgba(0xFFFFFF, 180), width=2)
  if corner:
    draw.rectangle((width - 18, 0, width - 1, height), fill=rgba(0xEDE0CF))
  return image


def simple_door() -> Image.Image:
  image = Image.new("RGBA", (96, 116), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  draw.rounded_rectangle((18, 8, 78, 106), radius=8, fill=rgba(0x6E4931), outline=rgba(0x4A3328), width=3)
  draw.rectangle((28, 16, 68, 88), fill=rgba(0x86BBC7), outline=rgba(0xF2E4CC), width=2)
  draw.ellipse((63, 60, 70, 67), fill=rgba(0xE6C16C))
  return image


def simple_grass() -> Image.Image:
  image = Image.new("RGBA", (70, 44), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  top = diamond_points(35, 5, 58, 30)
  draw_polygon(draw, top, 0xA5B884, 0x7E9966, 1)
  draw.line((top[3][0] + 8, top[3][1] + 1, top[1][0] - 8, top[1][1] + 1), fill=rgba(0xBFD0A1, 120), width=1)
  return image


def simple_sign() -> Image.Image:
  image = Image.new("RGBA", (174, 106), (0, 0, 0, 0))
  draw = ImageDraw.Draw(image)
  draw.rectangle((82, 50, 92, 96), fill=rgba(0x6E4931))
  draw.ellipse((48, 82, 128, 104), fill=(55, 88, 61, 100))
  draw.rounded_rectangle((8, 10, 166, 58), radius=8, fill=rgba(0x8F6251), outline=rgba(0x5B4033), width=3)
  draw.ellipse((24, 22, 34, 32), fill=rgba(0xCAA06D))
  draw.ellipse((140, 22, 150, 32), fill=rgba(0xCAA06D))
  return image


def make_ui_atlas() -> None:
  packer = AtlasPacker("ui-icons.png")

  def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (48, 48), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((6, 8, 42, 40), fill=rgba(0xFFF8E8, 242), outline=rgba(STYLE_SOFT_OUTLINE), width=2)
    draw.arc((9, 10, 39, 38), 205, 340, fill=rgba(0xFFFFFF, 165), width=2)
    return image, draw

  def plate_icon(kind = "food") -> Image.Image:
    image, draw = canvas()
    draw.ellipse((14, 18, 34, 30), fill=rgba(0xFFFDF2), outline=rgba(0x8B7764), width=2)
    if kind == "dirty":
      draw.ellipse((18, 22, 23, 26), fill=rgba(0xB9A884))
      draw.line((27, 25, 33, 29), fill=rgba(0x7D6B56), width=2)
    else:
      draw.ellipse((18, 21, 25, 27), fill=rgba(0x6DA05E))
      draw.ellipse((25, 20, 32, 26), fill=rgba(0xE7B95A))
    return image

  def flame_icon() -> Image.Image:
    image, draw = canvas()
    draw.polygon([(18, 31), (24, 13), (31, 31)], fill=rgba(0xFF9F2E), outline=rgba(0xA85522))
    draw.polygon([(21, 31), (25, 19), (29, 31)], fill=rgba(0xFFE08A))
    draw.ellipse((15, 29, 34, 36), fill=rgba(0x263238, 210))
    return image

  def pay_icon() -> Image.Image:
    image, draw = canvas()
    draw.rounded_rectangle((13, 16, 35, 31), radius=4, fill=rgba(0x2F5C78), outline=rgba(0x263238), width=2)
    draw.rectangle((15, 19, 33, 22), fill=rgba(0xE8C45A))
    draw.line((17, 27, 27, 27), fill=rgba(0xFFF8E8), width=2)
    return image

  def box_icon() -> Image.Image:
    image, draw = canvas()
    draw.polygon([(14, 22), (24, 16), (35, 22), (24, 29)], fill=rgba(0xD7A25E), outline=rgba(STYLE_OUTLINE))
    draw.polygon([(14, 22), (24, 29), (24, 38), (14, 31)], fill=rgba(0xB9824D), outline=rgba(STYLE_OUTLINE))
    draw.polygon([(35, 22), (24, 29), (24, 38), (35, 31)], fill=rgba(0xC99155), outline=rgba(STYLE_OUTLINE))
    return image

  def warning_icon() -> Image.Image:
    image, draw = canvas()
    draw.polygon([(24, 12), (37, 34), (11, 34)], fill=rgba(0xD8874F), outline=rgba(STYLE_OUTLINE))
    draw.line((24, 19, 24, 27), fill=rgba(0xFFF8E8), width=3)
    draw.ellipse((22, 30, 26, 34), fill=rgba(0xFFF8E8))
    return image

  simple_icons: dict[str, Callable[[], Image.Image]] = {
    "coin": lambda: pay_icon(),
    "star": lambda: plate_icon("food"),
    "stock": lambda: box_icon(),
    "warning": warning_icon,
    "order": lambda: plate_icon("food"),
    "eat": lambda: plate_icon("food"),
    "cook": flame_icon,
    "pay": pay_icon,
    "clean": lambda: plate_icon("dirty"),
    "shop": box_icon,
    "ready": lambda: plate_icon("food"),
  }

  for name, factory in simple_icons.items():
    packer.add(name, factory())
  packer.save(ASSET_DIR)


def main() -> None:
  make_furniture_atlas()
  make_character_atlas()
  make_environment_atlas()
  make_ui_atlas()


if __name__ == "__main__":
  main()
