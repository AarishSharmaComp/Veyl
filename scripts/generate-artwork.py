#!/usr/bin/env python3
"""Render Veyl's own SVG masters with Pillow; write only the declared PNGs.

Python 3.10+, Pillow 12.3. No SVG converter, browser, network, or npm dependency.
This intentionally small SVG reader supports the vocabulary used by our masters,
not arbitrary SVG: shapes, absolute M/L/H/V/C/Q/Z paths, translate/scale, groups,
local uses, SVG images, user-space gradients, clipping, and single-line text.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
import math
from pathlib import Path
import random
import re
import sys
import xml.etree.ElementTree as ET

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, __version__ as PILLOW_VERSION
except ImportError:
    raise SystemExit("Pillow is required. Use a Python environment with Pillow 12.3 installed.")


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SEED = 0x5645594C  # VEYL. Used only for subtle, reproducible raster dithering.
NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?"
INHERITED = (
    "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "fill-opacity", "stroke-opacity", "font-family", "font-size", "font-weight",
    "letter-spacing", "text-anchor",
)


@dataclass(frozen=True)
class Asset:
    source: str
    output: str
    size: tuple[int, int]
    transparent: bool = False
    antialias: int = 2


OUTPUTS = (
    *(Asset("assets/brand/veyl-mark.svg", f"public/icons/veyl-{n}.png", (n, n), True, 8)
      for n in (16, 32, 48, 128)),
    Asset("assets/brand/veyl-mark.svg", "assets/brand/veyl-mark.png", (1024, 1024), True),
    Asset("assets/promotional/veyl-cover.svg", "assets/promotional/veyl-cover.png", (1600, 900)),
    Asset("assets/promotional/veyl-cws-tile.svg", "assets/promotional/uploads/veyl-cws-tile.png", (440, 280)),
    Asset("assets/promotional/veyl-cws-marquee.svg", "assets/promotional/uploads/veyl-cws-marquee.png", (1400, 560)),
)


def name(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def numbers(value: str) -> list[float]:
    return [float(n) for n in re.findall(NUMBER, value)]


def fraction(value: str) -> float:
    return float(value.rstrip("%")) / (100 if value.endswith("%") else 1)


def color(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError(f"Use six-digit hex colors in artwork masters, got {value!r}")
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


@dataclass(frozen=True)
class Transform:
    sx: float = 1
    sy: float = 1
    tx: float = 0
    ty: float = 0

    def point(self, x: float, y: float) -> tuple[float, float]:
        return x * self.sx + self.tx, y * self.sy + self.ty

    def compose(self, child: Transform) -> Transform:
        return Transform(self.sx * child.sx, self.sy * child.sy,
                         self.tx + self.sx * child.tx, self.ty + self.sy * child.ty)

    def svg(self, value: str) -> Transform:
        result = self
        remaining = re.sub(r"(translate|scale)\([^)]*\)", "", value).strip(" ,")
        if remaining:
            raise ValueError(f"Unsupported SVG transform: {value}")
        for operation, args in re.findall(r"(translate|scale)\(([^)]*)\)", value):
            values = numbers(args)
            if not 1 <= len(values) <= 2:
                raise ValueError(f"Invalid SVG transform: {value}")
            if operation == "translate":
                local = Transform(tx=values[0], ty=values[1] if len(values) == 2 else 0)
            else:
                local = Transform(sx=values[0], sy=values[-1])
                if local.sx <= 0 or local.sy <= 0:
                    raise ValueError("Artwork scales must be positive")
            result = result.compose(local)
        return result


@dataclass
class Document:
    path: Path
    root: ET.Element
    ids: dict[str, ET.Element]
    viewbox: list[float]

    @staticmethod
    @lru_cache(maxsize=16)
    def load(path: Path) -> Document:
        path = path.resolve()
        if not path.is_relative_to(ASSETS) or path.suffix != ".svg":
            raise ValueError(f"Only local SVG sources under assets/ are allowed: {path}")
        root = ET.parse(path).getroot()
        viewbox = numbers(root.get("viewBox", ""))
        if len(viewbox) != 4 or min(viewbox[2:]) <= 0:
            raise ValueError(f"A positive SVG viewBox is required: {path}")
        return Document(path, root, {n.attrib["id"]: n for n in root.iter() if n.get("id")}, viewbox)


@dataclass(frozen=True)
class Fonts:
    regular: str | None
    bold: str | None

    @lru_cache(maxsize=64)
    def get(self, bold: bool, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        path = self.bold if bold else self.regular
        if path:
            return ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.BASIC)
        return ImageFont.load_default(size=size)


def select_fonts(regular: str | None, bold: str | None) -> Fonts:
    candidates = (
        ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    )
    fallback = next(((r, b) for r, b in candidates if Path(r).is_file() and Path(b).is_file()), (None, None))
    fonts = Fonts(regular or fallback[0], bold or fallback[1])
    fonts.get(False, 16)
    fonts.get(True, 16)
    return fonts


def path_points(data: str, scale: float) -> list[tuple[list[tuple[float, float]], bool]]:
    """Flatten our absolute SVG curves at subpixel precision for Pillow masks."""
    tokens = re.findall(rf"[A-Za-z]|{NUMBER}", data)
    paths = []
    points = []
    current = (0.0, 0.0)
    command = ""
    i = 0
    arity = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "Q": 4}
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command == "Z":
                if points:
                    paths.append((points, True))
                    current = points[0]
                    points = []
                command = ""
                continue
        if command not in arity:
            raise ValueError(f"Unsupported path command {command!r}; use absolute M/L/H/V/C/Q/Z")
        count = arity[command]
        values = [float(t) for t in tokens[i:i + count]]
        if len(values) != count:
            raise ValueError("Incomplete SVG path")
        i += count
        if command == "M":
            if points:
                paths.append((points, False))
            current = (values[0], values[1])
            points = [current]
            command = "L"
        elif command in ("L", "H", "V"):
            current = ((values[0], values[1]) if command == "L" else
                       (values[0], current[1]) if command == "H" else (current[0], values[0]))
            points.append(current)
        else:
            controls = [current, *list(zip(values[::2], values[1::2]))]
            length = sum(math.dist(a, b) for a, b in zip(controls, controls[1:]))
            steps = min(512, max(8, math.ceil(length * scale / 2)))
            for step in range(1, steps + 1):
                t = step / steps
                u = 1 - t
                if command == "C":
                    weights = (u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3)
                else:
                    weights = (u * u, 2 * u * t, t * t)
                points.append((sum(p[0] * w for p, w in zip(controls, weights)),
                               sum(p[1] * w for p, w in zip(controls, weights))))
            current = controls[-1]
    if points:
        paths.append((points, False))
    return paths


@lru_cache(maxsize=1)
def radial_ramp() -> Image.Image:
    # A clamped radial field; unlike effect_noise(), this has no hidden RNG.
    return Image.frombytes("L", (513, 513), bytes(
        min(255, round(math.hypot(x - 256, y - 256) * 255 / 256))
        for y in range(513) for x in range(513)
    ))


class Renderer:
    """Source geometry is shared by every SVG layout and every PNG export."""

    def __init__(self, size: tuple[int, int], fonts: Fonts):
        self.size = size
        self.fonts = fonts
        self.clips: dict[tuple, Image.Image] = {}

    def render(self, document: Document) -> Image.Image:
        x, y, width, height = document.viewbox
        transform = Transform(self.size[0] / width, self.size[1] / height)
        transform = transform.compose(Transform(tx=-x, ty=-y))
        canvas = Image.new("RGBA", self.size)
        self.node(document.root, document, transform, {}, canvas)
        return canvas

    def node(self, node: ET.Element, doc: Document, transform: Transform,
             inherited: dict[str, str], target: Image.Image) -> None:
        tag = name(node)
        if tag in ("defs", "title", "desc", "metadata"):
            return
        for unsupported in ("filter", "mask", "style", "stroke-dasharray", "fill-rule"):
            if unsupported in node.attrib:
                raise ValueError(f"Unsupported {unsupported!r} in {doc.path.name}; see this script's SVG vocabulary")
        transform = transform.svg(node.get("transform", ""))
        style = {**inherited, **{k: node.attrib[k] for k in INHERITED if k in node.attrib}}
        opacity = float(node.get("opacity", "1"))
        clip = node.get("clip-path")
        if opacity != 1 or clip:
            layer = Image.new("RGBA", self.size)
            self.content(node, doc, transform, style, layer)
            alpha = layer.getchannel("A")
            if clip:
                match = re.fullmatch(r"url\(#([\w-]+)\)", clip)
                if not match:
                    raise ValueError(f"Invalid local clipping reference: {clip}")
                key = (doc.path, match[1], transform)
                if key not in self.clips:
                    clip_canvas = Image.new("RGBA", self.size)
                    for child in doc.ids[match[1]]:
                        self.node(child, doc, transform, {}, clip_canvas)
                    self.clips[key] = clip_canvas.getchannel("A")
                alpha = ImageChops.multiply(alpha, self.clips[key])
            if not 0 <= opacity <= 1:
                raise ValueError("SVG opacity must be between zero and one")
            layer.putalpha(alpha.point([round(i * opacity) for i in range(256)]))
            target.alpha_composite(layer)
        else:
            self.content(node, doc, transform, style, target)

    def content(self, node: ET.Element, doc: Document, transform: Transform,
                style: dict[str, str], target: Image.Image) -> None:
        tag = name(node)
        if tag in ("g", "svg"):
            for child in node:
                self.node(child, doc, transform, style, target)
        elif tag == "use":
            reference = node.get("href", "")
            if not reference.startswith("#"):
                raise ValueError("Use <image> for external SVG sources; <use> must be local")
            local = Transform(tx=float(node.get("x", 0)), ty=float(node.get("y", 0)))
            self.node(doc.ids[reference[1:]], doc, transform.compose(local), style, target)
        elif tag == "image":
            source = Document.load(doc.path.parent / node.attrib["href"])
            x, y = float(node.get("x", 0)), float(node.get("y", 0))
            width, height = float(node.attrib["width"]), float(node.attrib["height"])
            vx, vy, vw, vh = source.viewbox
            ratio = min(width / vw, height / vh)  # SVG's default xMidYMid meet.
            local = Transform(ratio, ratio, x + (width - vw * ratio) / 2 - vx * ratio,
                              y + (height - vh * ratio) / 2 - vy * ratio)
            self.node(source.root, source, transform.compose(local), {}, target)
        elif tag == "text":
            self.text(node, doc, transform, style, target)
        elif tag in ("path", "rect", "circle", "ellipse", "line", "polygon", "polyline"):
            self.shape(node, doc, transform, style, target)
        else:
            raise ValueError(f"Unsupported SVG element <{tag}> in {doc.path.name}")

    def bounds(self, points: list[tuple[float, float]], padding: float = 2) -> tuple[int, int, int, int]:
        xs, ys = zip(*points)
        return (max(0, math.floor(min(xs) - padding)), max(0, math.floor(min(ys) - padding)),
                min(self.size[0], math.ceil(max(xs) + padding)),
                min(self.size[1], math.ceil(max(ys) + padding)))

    def shape(self, node: ET.Element, doc: Document, tr: Transform,
              style: dict[str, str], target: Image.Image) -> None:
        tag = name(node)
        get = lambda key, default=0: float(node.get(key, default))
        paths = []
        rect = None
        if tag == "path":
            paths = [([tr.point(*p) for p in pts], closed) for pts, closed in
                     path_points(node.attrib["d"], max(tr.sx, tr.sy))]
        elif tag in ("polygon", "polyline", "line"):
            coords = (numbers(node.attrib["points"]) if tag != "line" else
                      [get("x1"), get("y1"), get("x2"), get("y2")])
            paths = [([tr.point(x, y) for x, y in zip(coords[::2], coords[1::2])], tag == "polygon")]
        else:
            if tag == "rect":
                x, y, width, height = get("x"), get("y"), get("width"), get("height")
            else:
                rx = get("r") if tag == "circle" else get("rx")
                ry = rx if tag == "circle" else get("ry")
                x, y, width, height = get("cx") - rx, get("cy") - ry, rx * 2, ry * 2
            rect = (*tr.point(x, y), *tr.point(x + width, y + height))
        points = [p for pts, _ in paths for p in pts] if rect is None else [(rect[0], rect[1]), (rect[2], rect[3])]
        if not points:
            return
        stroke_width = float(style.get("stroke-width", 1)) * (tr.sx + tr.sy) / 2
        box = self.bounds(points, stroke_width / 2 + 2)
        left, top, right, bottom = box
        if right <= left or bottom <= top:
            return
        for kind in ("fill", "stroke"):
            paint = style.get(kind, "#000000" if kind == "fill" else "none")
            if paint == "none":
                continue
            mask = Image.new("L", (right - left, bottom - top))
            draw = ImageDraw.Draw(mask)
            width = max(1, round(stroke_width))
            if rect is not None:
                local_rect = (rect[0] - left, rect[1] - top, rect[2] - left, rect[3] - top)
                radius = get("rx") * min(tr.sx, tr.sy)
                if kind == "stroke":
                    half = stroke_width / 2
                    local_rect = (local_rect[0] - half, local_rect[1] - half,
                                  local_rect[2] + half, local_rect[3] + half)
                    radius += half
                if tag == "rect":
                    if kind == "fill":
                        draw.rounded_rectangle(local_rect, radius=radius, fill=255)
                    else:
                        draw.rounded_rectangle(local_rect, radius=radius, outline=255, width=width)
                else:
                    if kind == "fill":
                        draw.ellipse(local_rect, fill=255)
                    else:
                        draw.ellipse(local_rect, outline=255, width=width)
            for pts, closed in paths:
                local = [(x - left, y - top) for x, y in pts]
                if kind == "fill" and len(local) >= 3:
                    draw.polygon(local, fill=255)
                elif kind == "stroke" and len(local) >= 2:
                    draw.line(local + ([local[0]] if closed else []), fill=255, width=width, joint="curve")
                    if not closed and style.get("stroke-linecap") == "round":
                        radius = width / 2
                        for x, y in (local[0], local[-1]):
                            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
            self.composite(mask, box, paint, float(style.get(f"{kind}-opacity", 1)), doc, tr, target)

    def text(self, node: ET.Element, doc: Document, tr: Transform,
             style: dict[str, str], target: Image.Image) -> None:
        if not math.isclose(tr.sx, tr.sy, rel_tol=1e-5):
            raise ValueError("Text requires a uniform SVG scale")
        text = "".join(node.itertext())
        font = self.fonts.get(int(style.get("font-weight", 400)) >= 600,
                              max(1, round(float(style.get("font-size", 16)) * tr.sy)))
        spacing = float(style.get("letter-spacing", 0)) * tr.sx
        advances = [font.getlength(c) + spacing for c in text]
        length = sum(advances) - spacing if text else 0
        x, y = tr.point(float(node.get("x", 0)), float(node.get("y", 0)))
        x -= length * {"start": 0, "middle": .5, "end": 1}[style.get("text-anchor", "start")]
        positions = []
        corners = []
        for char, advance in zip(text, advances):
            positions.append((char, x))
            a, b, c, d = font.getbbox(char, anchor="ls")
            corners.extend(((x + a, y + b), (x + c, y + d)))
            x += advance
        if not corners:
            return
        box = self.bounds(corners)
        left, top, right, bottom = box
        if right <= left or bottom <= top:
            return
        mask = Image.new("L", (right - left, bottom - top))
        draw = ImageDraw.Draw(mask)
        for char, x in positions:
            draw.text((x - left, y - top), char, font=font, fill=255, anchor="ls")
        self.composite(mask, box, style.get("fill", "#000000"),
                       float(style.get("fill-opacity", 1)), doc, tr, target)

    def composite(self, mask: Image.Image, box: tuple[int, int, int, int], paint: str,
                  opacity: float, doc: Document, tr: Transform, target: Image.Image) -> None:
        if paint == "none":
            return
        if not 0 <= opacity <= 1:
            raise ValueError("Paint opacity must be between zero and one")
        if paint.startswith("url(#") and paint.endswith(")"):
            layer = self.gradient(doc.ids[paint[5:-1]], box, tr)
            alpha = ImageChops.multiply(mask, layer.getchannel("A"))
        else:
            layer = Image.new("RGBA", mask.size, (*color(paint), 255))
            alpha = mask
        layer.putalpha(alpha.point([round(i * opacity) for i in range(256)]))
        target.alpha_composite(layer, (box[0], box[1]))

    def gradient(self, node: ET.Element, box: tuple[int, int, int, int], tr: Transform) -> Image.Image:
        if node.get("gradientUnits") != "userSpaceOnUse":
            raise ValueError("Artwork gradients must use userSpaceOnUse")
        left, top, right, bottom = box
        size = (right - left, bottom - top)
        get = lambda key, default=0: float(node.get(key, default))
        if name(node) == "linearGradient":
            dx, dy = get("x2") - get("x1"), get("y2") - get("y1")
            denominator = dx * dx + dy * dy
            if denominator == 0:
                raise ValueError("Linear gradient endpoints must differ")
            a, b = dx / denominator / tr.sx, dy / denominator / tr.sy
            c = ((-tr.tx / tr.sx - get("x1")) * dx + (-tr.ty / tr.sy - get("y1")) * dy) / denominator
            origin = a * left + b * top + c
            values = [origin, origin + a * size[0], origin + b * size[1], origin + a * size[0] + b * size[1]]
            low, high = min(values) - .001, max(values) + .001
            factor = 255 / (high - low)
            ramp = Image.linear_gradient("L").transform(size, Image.Transform.AFFINE,
                (0, 0, 128, a * factor, b * factor, (origin - low) * factor), Image.Resampling.BILINEAR)
            positions = [low + i * (high - low) / 255 for i in range(256)]
        elif name(node) == "radialGradient":
            cx, cy = tr.point(get("cx"), get("cy"))
            fx, fy = 256 / (get("r") * tr.sx), 256 / (get("r") * tr.sy)
            ramp = radial_ramp().transform(size, Image.Transform.AFFINE,
                (fx, 0, 256 + (left - cx) * fx, 0, fy, 256 + (top - cy) * fy),
                Image.Resampling.BILINEAR, fillcolor=255)
            positions = [i / 255 for i in range(256)]
        else:
            raise ValueError("Paint reference must identify a linear or radial gradient")
        stops = [(fraction(n.get("offset", "0")), (*color(n.attrib["stop-color"]),
                  round(float(n.get("stop-opacity", 1)) * 255))) for n in node]
        if not stops or stops != sorted(stops, key=lambda item: item[0]):
            raise ValueError("Gradient stops must be present and ordered")
        table = []
        for position in positions:
            if position <= stops[0][0]:
                table.append(stops[0][1])
            elif position >= stops[-1][0]:
                table.append(stops[-1][1])
            else:
                for (start, c1), (end, c2) in zip(stops, stops[1:]):
                    if start <= position <= end:
                        t = (position - start) / (end - start)
                        table.append(tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)))
                        break
        return Image.merge("RGBA", tuple(ramp.point([entry[channel] for entry in table]) for channel in range(4)))


def render_asset(asset: Asset, fonts: Fonts) -> Image.Image:
    size = (asset.size[0] * asset.antialias, asset.size[1] * asset.antialias)
    image = Renderer(size, fonts).render(Document.load(ROOT / asset.source))
    image = image.resize(asset.size, Image.Resampling.LANCZOS)
    if asset.transparent:
        # Remove negligible Lanczos ringing outside the rounded container.
        alpha = image.getchannel("A").point([0 if i <= 3 else 255 if i >= 252 else i for i in range(256)])
        image.putalpha(alpha)
        return image
    if image.getchannel("A").getextrema() != (255, 255):
        raise ValueError(f"Promotional source must have an opaque background: {asset.source}")
    image = image.convert("RGB")
    # +/- one code value, in luminance only. Geometry and particles remain SVG-driven.
    seed = SEED ^ int.from_bytes(sha256(asset.output.encode("utf-8")).digest()[:8], "big")
    random_bytes = random.Random(seed).randbytes(math.prod(asset.size))
    noise = Image.frombytes("L", asset.size, random_bytes).point([0] * 64 + [1] * 128 + [2] * 64)
    return ImageChops.add(image, Image.merge("RGB", (noise, noise, noise)), offset=-1)


def png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.info.clear()  # No timestamps, machine paths, or variable metadata.
    image.save(buffer, format="PNG", compress_level=9, optimize=False)
    return buffer.getvalue()


def validate_png(data: bytes, asset: Asset) -> str:
    with Image.open(BytesIO(data)) as image:
        image.verify()
    with Image.open(BytesIO(data)) as image:
        if image.format != "PNG" or image.size != asset.size:
            raise ValueError(f"Incorrect format or dimensions: {asset.output}")
        expected_mode = "RGBA" if asset.transparent else "RGB"
        if image.mode != expected_mode:
            raise ValueError(f"Expected {expected_mode}: {asset.output}")
        if asset.transparent:
            alpha = image.getchannel("A")
            w, h = asset.size
            if any(alpha.getpixel(p) != 0 for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))):
                raise ValueError(f"Icon corners must be fully transparent: {asset.output}")
            if alpha.getpixel((w // 2, h // 2)) != 255 or not sum(alpha.histogram()[1:255]):
                raise ValueError(f"Expected opaque center and antialiased alpha edges: {asset.output}")
            return "RGBA; clear corners, opaque center, antialiased alpha"
        if "transparency" in image.info:
            raise ValueError(f"Store/documentation artwork must be opaque: {asset.output}")
        return "RGB; opaque"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Re-render in memory and compare every PNG byte; write nothing")
    parser.add_argument("--font-regular", help="Path to an installed regular TrueType/OpenType font")
    parser.add_argument("--font-bold", help="Path to an installed bold TrueType/OpenType font")
    args = parser.parse_args()
    fonts = select_fonts(args.font_regular, args.font_bold)
    print(f"Pillow {PILLOW_VERSION}; seed {SEED:#x}; Lanczos downsampling")
    for label, path in (("Regular", fonts.regular), ("Bold", fonts.bold)):
        fingerprint = sha256(Path(path).read_bytes()).hexdigest()[:16] if path else "built-in"
        print(f"{label} font: {path or 'Pillow scalable default'} (sha256 {fingerprint})")
    stale = []
    for asset in OUTPUTS:
        data = png_bytes(render_asset(asset, fonts))
        description = validate_png(data, asset)
        path = ROOT / asset.output
        if args.check:
            if not path.is_file() or path.read_bytes() != data:
                stale.append(asset.output)
                action = "STALE"
            else:
                action = "MATCH"
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            action = "WROTE"
        print(f"{action} {asset.output}: {asset.size[0]}x{asset.size[1]}, {description}; sha256 {sha256(data).hexdigest()[:16]}")
    if stale:
        print("Missing/stale artwork. Run this script without --check using the same fonts.", file=sys.stderr)
        return 1
    print(f"{'Verified' if args.check else 'Generated and validated'} {len(OUTPUTS)} PNGs.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"Artwork error: {error}") from error
