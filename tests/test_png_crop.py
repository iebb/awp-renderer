#!/usr/bin/env python3
"""Check the lossless PNG crop against Pillow's independent PNG decoder."""
import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageCms, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
MODULE = (ROOT / "dist/server/png.js").as_uri()
SCRIPT = f"""
import {{readFileSync,writeFileSync}} from 'node:fs';
import {{cropPassPng}} from {json.dumps(MODULE)};
writeFileSync(process.argv[2],cropPassPng(readFileSync(process.argv[1]),Number(process.argv[3])));
"""


class PngCropTest(unittest.TestCase):
    def crop(self, source, target, margin=3):
        return subprocess.run(
            ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", SCRIPT, str(source), str(target), str(margin)],
            capture_output=True, text=True, check=False,
        )

    def assert_pixels(self, source, target, margin=3):
        result = self.crop(source, target, margin)
        self.assertEqual(result.returncode, 0, result.stderr)
        with Image.open(source) as original, Image.open(target) as actual:
            expected = original.crop((margin, margin, original.width-margin, original.height-margin))
            self.assertEqual(expected.size, actual.size)
            # Compare unassociated RGBA, including RGB at zero alpha. For 16-bit
            # grayscale, compare original integer samples without reducing depth.
            if original.mode in ("I", "I;16", "I;16B"):
                self.assertEqual(list(expected.getdata()), list(actual.getdata()))
                self.assertEqual(target.read_bytes()[24], 16)
            else:
                self.assertEqual(expected.convert("RGBA").tobytes(), actual.convert("RGBA").tobytes())
            for key in ["icc_profile", "gamma", "srgb", "chromaticity", "transparency"]:
                self.assertEqual(original.info.get(key), actual.info.get(key), key)

    def test_rgb_rgba_and_grayscale_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for mode in ["RGB", "RGBA", "L", "LA"]:
                with self.subTest(mode=mode):
                    bands = len(mode)
                    image = Image.frombytes(mode, (31, 29), bytes((x*17+y*31+channel*43) % 256 for y in range(29) for x in range(31) for channel in range(bands)))
                    source, target = root / f"{mode}.png", root / f"{mode}-crop.png"
                    image.save(source)
                    self.assert_pixels(source, target)

    def test_packed_grayscale_and_palette(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new("1", (31, 29))
            image.putdata([(x*3+y*7) % 5 == 0 for y in range(29) for x in range(31)])
            image.save(root / "gray.png")
            self.assert_pixels(root / "gray.png", root / "gray-crop.png")
            for bits in [1, 2, 4, 8]:
                with self.subTest(bits=bits):
                    palette = Image.new("P", (31, 29))
                    palette.putpalette([value for i in range(256) for value in (i, (i*7) % 256, (i*13) % 256)])
                    palette.putdata([(x+y*3) % (1 << bits) for y in range(29) for x in range(31)])
                    source, target = root / f"palette-{bits}.png", root / f"palette-{bits}-crop.png"
                    palette.save(source, bits=bits, transparency=bytes(range(1 << bits)))
                    self.assert_pixels(source, target)

    def test_sixteen_bit_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pixels = b"".join(struct.pack("<H", (x*3137+y*5281) % 65536) for y in range(29) for x in range(31))
            Image.frombytes("I;16", (31, 29), pixels).save(root / "sixteen.png")
            self.assert_pixels(root / "sixteen.png", root / "sixteen-crop.png")

    def test_embedded_color_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new("RGB", (31, 29), (107, 143, 219))
            profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
            image.save(root / "icc.png", icc_profile=profile)
            self.assert_pixels(root / "icc.png", root / "icc-crop.png")
            info = PngImagePlugin.PngInfo()
            info.add(b"sRGB", b"\0")
            image.save(root / "srgb.png", pnginfo=info)
            self.assert_pixels(root / "srgb.png", root / "srgb-crop.png")

    def test_rejects_invalid_data_and_crop(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source.png", root / "result.png"
            Image.new("RGBA", (31, 29)).save(source)
            self.assertNotEqual(self.crop(source, target, 15).returncode, 0)
            self.assertNotEqual(self.crop(source, target, -1).returncode, 0)
            source.write_bytes(source.read_bytes()[:-4])
            self.assertNotEqual(self.crop(source, target).returncode, 0)
            source.write_bytes(b"not a PNG")
            self.assertNotEqual(self.crop(source, target).returncode, 0)


if __name__ == "__main__":
    unittest.main()
