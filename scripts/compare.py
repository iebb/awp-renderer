#!/usr/bin/env python3
"""Strict comparison with Pass Designer build 28's Copy Pass as Image PNG.

That exporter uses scale 4 and translates the pass by 50 points inside a
100-point-larger canvas. Only that documented margin is removed. Images are
never resized, shifted to find a match, color-converted, or thresholded.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageChops


def load_png(source: Path, scale: int, native: bool = False):
    if source.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Reference file exceeds 32 MiB.")
    data = source.read_bytes()
    declared = None
    if native and source.suffix.lower() == ".json":
        declared = json.loads(data)
        if declared.get("renderer") != "apple-passkit" or declared.get("scale") != scale:
            raise ValueError("Native response must use apple-passkit and the requested scale.")
        data = base64.b64decode(declared["png"], validate=True)
    if len(data) < 25 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Use original PNG exports, not screenshots or JPEGs.")
    if data[24] != 8:
        raise ValueError("This comparator requires 8-bit PNGs; do not silently reduce a higher bit depth.")
    image = Image.open(io.BytesIO(data))
    if image.width * image.height > 32_000_000:
        raise ValueError("Reference image exceeds 32 million pixels.")
    image.load()
    if declared and (image.width != round(declared["width"] * scale) or image.height != round(declared["height"] * scale)):
        raise ValueError("Native response dimensions disagree with its PNG.")
    profile = image.info.get("icc_profile")
    metadata = {
        "iccSha256": hashlib.sha256(profile).hexdigest() if profile else None,
        "gamma": image.info.get("gamma"),
        "srgb": image.info.get("srgb"),
        "chromaticity": list(image.info["chromaticity"]) if "chromaticity" in image.info else None,
    }
    return image.convert("RGBA"), metadata


def compare_images(app_path: Path, native_path: Path, output: Path, scale=4, margin_points=50, width_points=343):
    app, app_color = load_png(app_path, scale)
    native, native_color = load_png(native_path, scale, native=True)
    margin = margin_points * scale
    if margin != int(margin) or margin < 0:
        raise ValueError("The requested margin must be a nonnegative whole number of pixels.")
    margin = int(margin)
    if native.width != round(width_points * scale):
        raise ValueError(f"Native PNG width is {native.width}; expected {width_points} points at {scale}x. Re-render at the correct scale.")
    expected = (native.width + 2 * margin, native.height + 2 * margin)
    if app.size != expected:
        raise ValueError(f"App export is {app.size}; expected {expected}. Verify the same pass, platform, scale, and native view bounds. No automatic fitting is performed.")
    app_pass = app.crop((margin, margin, app.width - margin, app.height - margin))
    difference = ImageChops.difference(app_pass, native)
    red, green, blue, alpha = difference.split()
    # RGBA.getbbox() defaults to testing alpha alone in Pillow. Combine every
    # channel explicitly so an RGB difference with identical alpha is caught.
    maximum = ImageChops.lighter(ImageChops.lighter(red, green), ImageChops.lighter(blue, alpha))
    histogram = maximum.histogram()
    changed = native.width * native.height - histogram[0]
    metadata_equal = app_color == native_color
    result = {
        "appExport": str(app_path.resolve()),
        "nativeReference": str(native_path.resolve()),
        "scale": scale,
        "removedAppMarginPixels": margin,
        "appExportSize": list(app.size),
        "passSize": list(native.size),
        "comparison": "all raw RGBA8 channels; no resampling, color conversion, alignment search, or tolerance",
        "changedPixels": changed,
        "differenceBounds": list(maximum.getbbox()) if changed else None,
        "maximumChannelDifference": max((index for index, count in enumerate(histogram) if count), default=0),
        "exactRgba": changed == 0,
        "colorMetadataEqual": metadata_equal,
        "appColorMetadata": app_color,
        "nativeColorMetadata": native_color,
        "exact": changed == 0 and metadata_equal,
    }
    output.mkdir(parents=True, exist_ok=True)
    app_pass.save(output / "app-pass.png")
    native.save(output / "native-pass.png")
    visual = maximum.point(lambda value: min(255, value * 8))
    Image.merge("RGB", (visual, Image.new("L", visual.size), Image.new("L", visual.size))).save(output / "difference.png")
    (output / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app_export", type=Path)
    parser.add_argument("native_reference", type=Path, help="Native PNG or /render JSON response at the same scale")
    parser.add_argument("--output", type=Path, default=Path("analysis/pass-designer/app-comparison"))
    parser.add_argument("--scale", type=int, choices=(1, 2, 3, 4), default=4)
    parser.add_argument("--app-margin-points", type=float, default=50)
    parser.add_argument("--pass-width-points", type=float, default=343)
    args = parser.parse_args()
    try:
        result = compare_images(args.app_export, args.native_reference, args.output, args.scale, args.app_margin_points, args.pass_width_points)
        print(json.dumps(result, indent=2))
        return 0 if result["exact"] else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        args.output.mkdir(parents=True, exist_ok=True)
        result = {"exact": False, "error": str(error)}
        (args.output / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
