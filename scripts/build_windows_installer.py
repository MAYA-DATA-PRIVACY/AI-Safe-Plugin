#!/usr/bin/env python3
"""Assemble the Windows installer payload for AI-Safe Plugin."""

from __future__ import annotations

import json
import os
import shutil
import struct
import zlib
from binascii import crc32
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
STAGING_ROOT = DIST / "windows-installer"
STAGE_DIR = STAGING_ROOT / "stage"
METADATA_ISS = STAGING_ROOT / "metadata.iss"
INSTALLER_ICON = STAGING_ROOT / "ai-safe-plugin.ico"
MAYA_MARK = ROOT / "extension" / "assets" / "maya" / "maya-mark.png"
MODEL_ASSET_NAME = "ai-safe-plugin-model-fp16.tar.gz"
DEFAULT_EXTENSION_ID = "aggkonihfabdcbgomkfecjhdolddfabe"
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)
BUNDLE_RELEASE_ARCNAME = Path(".runtime") / "bundle_release.json"
COPY_PATHS = [
    ROOT / "server",
    ROOT / "scripts" / "installers",
    ROOT / "pyproject.toml",
    ROOT / "uv.lock",
    ROOT / ".python-version",
    ROOT / "LICENSE",
]
REPO_SLUG = "Maya-Data-Privacy/AI-Safe-Plugin"


def load_package_version() -> str:
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package_json["version"]).strip()


def build_release_metadata() -> dict[str, str]:
    version = load_package_version()
    tag = str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_TAG") or "").strip() or f"v{version}"
    return {
        "tag": tag,
        "published_at": str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_PUBLISHED_AT") or "").strip(),
        "html_url": str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_HTML_URL") or "").strip()
        or f"https://github.com/{REPO_SLUG}/releases/tag/{tag}",
        "repository": REPO_SLUG,
    }


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def _paeth_predictor(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    distance_left = abs(estimate - left)
    distance_above = abs(estimate - above)
    distance_upper_left = abs(estimate - upper_left)
    if distance_left <= distance_above and distance_left <= distance_upper_left:
        return left
    if distance_above <= distance_upper_left:
        return above
    return upper_left


def _read_png_rgba(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"Icon source is not a PNG: {path}")

    offset = 8
    width = height = bit_depth = color_type = None
    idat_parts: list[bytes] = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            if bit_depth != 8 or compression != 0 or filter_method != 0 or interlace != 0:
                raise ValueError("Only non-interlaced 8-bit PNG sources are supported")
        elif chunk_type == b"IDAT":
            idat_parts.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or color_type is None:
        raise ValueError(f"PNG metadata is incomplete: {path}")

    channels_by_type = {0: 1, 2: 3, 4: 2, 6: 4}
    if color_type not in channels_by_type:
        raise ValueError(f"Unsupported PNG color type {color_type} in {path}")

    channels = channels_by_type[color_type]
    stride = width * channels
    raw = zlib.decompress(b"".join(idat_parts))
    rows: list[bytes] = []
    previous = bytearray(stride)
    cursor = 0
    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        row = bytearray(raw[cursor : cursor + stride])
        cursor += stride
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            above = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            if filter_type == 1:
                row[i] = (value + left) & 0xFF
            elif filter_type == 2:
                row[i] = (value + above) & 0xFF
            elif filter_type == 3:
                row[i] = (value + ((left + above) // 2)) & 0xFF
            elif filter_type == 4:
                row[i] = (value + _paeth_predictor(left, above, upper_left)) & 0xFF
            elif filter_type != 0:
                raise ValueError(f"Unsupported PNG filter type {filter_type}")
        rows.append(bytes(row))
        previous = row

    rgba = bytearray(width * height * 4)
    out = 0
    for row in rows:
        for x in range(width):
            pos = x * channels
            if color_type == 6:
                r, g, b, a = row[pos : pos + 4]
            elif color_type == 2:
                r, g, b = row[pos : pos + 3]
                a = 255
            elif color_type == 4:
                r = g = b = row[pos]
                a = row[pos + 1]
            else:
                r = g = b = row[pos]
                a = 255
            rgba[out : out + 4] = bytes((r, g, b, a))
            out += 4
    return width, height, bytes(rgba)


def _resize_rgba(src_width: int, src_height: int, pixels: bytes, size: int) -> bytes:
    if src_width == size and src_height == size:
        return pixels
    output = bytearray(size * size * 4)
    for y in range(size):
        src_y = min(src_height - 1, int((y + 0.5) * src_height / size))
        for x in range(size):
            src_x = min(src_width - 1, int((x + 0.5) * src_width / size))
            src = (src_y * src_width + src_x) * 4
            dst = (y * size + x) * 4
            output[dst : dst + 4] = pixels[src : src + 4]
    return bytes(output)


def _inside_rounded_rect(x: float, y: float, size: int, radius: float) -> bool:
    inner_left = radius
    inner_right = size - radius
    inner_top = radius
    inner_bottom = size - radius
    if inner_left <= x <= inner_right or inner_top <= y <= inner_bottom:
        return 0 <= x <= size and 0 <= y <= size
    cx = inner_left if x < inner_left else inner_right
    cy = inner_top if y < inner_top else inner_bottom
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius


def _rounded_alpha(x: int, y: int, size: int) -> int:
    radius = size * 0.22
    samples = 0
    for sy in (0.25, 0.75):
        for sx in (0.25, 0.75):
            if _inside_rounded_rect(x + sx, y + sy, size, radius):
                samples += 1
    return round(samples * 255 / 4)


def _build_icon_image(mark_width: int, mark_height: int, mark_rgba: bytes, size: int) -> bytes:
    top_left = (0x7B, 0x61, 0xC4)
    bottom_right = (0x67, 0x50, 0xA4)
    canvas = bytearray(size * size * 4)
    denom = max(1, (size - 1) * 2)
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            alpha = _rounded_alpha(x, y, size)
            dst = (y * size + x) * 4
            canvas[dst] = round(top_left[0] * (1 - t) + bottom_right[0] * t)
            canvas[dst + 1] = round(top_left[1] * (1 - t) + bottom_right[1] * t)
            canvas[dst + 2] = round(top_left[2] * (1 - t) + bottom_right[2] * t)
            canvas[dst + 3] = alpha

    mark_size = max(1, round(size * 0.68))
    resized = _resize_rgba(mark_width, mark_height, mark_rgba, mark_size)
    offset = (size - mark_size) // 2
    for y in range(mark_size):
        for x in range(mark_size):
            src = (y * mark_size + x) * 4
            src_alpha = resized[src + 3]
            if src_alpha == 0:
                continue
            dst_x = offset + x
            dst_y = offset + y
            if not (0 <= dst_x < size and 0 <= dst_y < size):
                continue
            dst = (dst_y * size + dst_x) * 4
            out_alpha = src_alpha + canvas[dst + 3] * (255 - src_alpha) // 255
            # Force the Maya atom white while preserving the PNG's antialiasing alpha.
            for channel in range(3):
                canvas[dst + channel] = (255 * src_alpha + canvas[dst + channel] * canvas[dst + 3] * (255 - src_alpha) // 255) // max(1, out_alpha)
            canvas[dst + 3] = out_alpha
    return bytes(canvas)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc32(chunk_type + data) & 0xFFFFFFFF)


def _encode_png(width: int, height: int, rgba: bytes) -> bytes:
    scanlines = bytearray()
    stride = width * 4
    for y in range(height):
        scanlines.append(0)
        start = y * stride
        scanlines.extend(rgba[start : start + stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", zlib.compress(bytes(scanlines), 9)) + _png_chunk(b"IEND", b"")


def generate_installer_icon() -> None:
    mark_width, mark_height, mark_rgba = _read_png_rgba(MAYA_MARK)
    images = []
    for size in ICON_SIZES:
        rgba = _build_icon_image(mark_width, mark_height, mark_rgba, size)
        images.append((size, _encode_png(size, size, rgba)))

    header = struct.pack("<HHH", 0, 1, len(images))
    directory = bytearray()
    offset = 6 + 16 * len(images)
    payload = bytearray()
    for size, png in images:
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if size == 256 else size,
                0 if size == 256 else size,
                0,
                0,
                1,
                32,
                len(png),
                offset,
            )
        )
        payload.extend(png)
        offset += len(png)

    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    INSTALLER_ICON.write_bytes(header + bytes(directory) + bytes(payload))


def copy_path(path: Path, destination_root: Path) -> None:
    target = destination_root / path.relative_to(ROOT)
    if path.is_dir():
        shutil.copytree(path, target, dirs_exist_ok=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)


def write_release_metadata(stage_dir: Path) -> None:
    target = stage_dir / BUNDLE_RELEASE_ARCNAME
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(build_release_metadata(), indent=2) + "\n"
    target.write_text(payload, encoding="utf-8")


def write_metadata_iss() -> None:
    version = load_package_version()
    release_metadata = build_release_metadata()
    tag = release_metadata["tag"]
    model_asset_url = f"https://github.com/{REPO_SLUG}/releases/download/{tag}/{MODEL_ASSET_NAME}"
    escaped_stage_dir = str(STAGE_DIR).replace("\\", "\\\\")
    lines = [
        f'#define MyAppName "AI-Safe Plugin"',
        f'#define MyAppVersion "{version}"',
        f'#define MyAppPublisher "Maya Data Privacy"',
        f'#define MyAppCopyright "Copyright (c) Maya Data Privacy"',
        f'#define MyAppUrl "https://github.com/{REPO_SLUG}"',
        f'#define MyReleaseTag "{tag}"',
        f'#define MyRepositorySlug "{REPO_SLUG}"',
        f'#define MyDefaultExtensionId "{DEFAULT_EXTENSION_ID}"',
        f'#define MyModelAssetName "{MODEL_ASSET_NAME}"',
        f'#define MyModelAssetUrl "{model_asset_url}"',
        f'#define MyStageDir "{escaped_stage_dir}"',
        "",
    ]
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    METADATA_ISS.write_text("\n".join(lines), encoding="utf-8")


def build_stage() -> None:
    clean_dir(STAGE_DIR)
    for path in COPY_PATHS:
        if not path.exists():
            raise FileNotFoundError(f"Required installer input is missing: {path}")
        copy_path(path, STAGE_DIR)
    write_release_metadata(STAGE_DIR)
    generate_installer_icon()
    write_metadata_iss()


def main() -> None:
    build_stage()
    print(f"Built Windows installer staging directory at {STAGE_DIR}")
    print(f"Wrote Inno Setup metadata to {METADATA_ISS}")


if __name__ == "__main__":
    main()
