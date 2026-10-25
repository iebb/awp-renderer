"""Checks that the parity verifier cannot falsely pass RGB-only differences."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageCms

spec = importlib.util.spec_from_file_location("pass_comparison", Path(__file__).resolve().parents[1] / "scripts/compare.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.native = Image.new("RGBA", (4, 3), (30, 80, 120, 255))
        self.native.save(self.root / "native.png")
        self.app = Image.new("RGBA", (6, 5))
        self.app.paste(self.native, (1, 1))

    def compare(self, **save_options):
        self.app.save(self.root / "app.png", **save_options)
        return comparison.compare_images(self.root / "app.png", self.root / "native.png", self.root / "result", 1, 1, 4)

    def test_exact_margin_crop(self):
        self.assertTrue(self.compare()["exact"])

    def test_rgb_change_with_identical_alpha_fails(self):
        self.app.putpixel((2, 2), (31, 80, 120, 255))
        result = self.compare()
        self.assertFalse(result["exact"])
        self.assertEqual(result["changedPixels"], 1)
        self.assertEqual(result["maximumChannelDifference"], 1)

    def test_alpha_only_change_fails(self):
        self.app.putpixel((2, 2), (30, 80, 120, 254))
        self.assertFalse(self.compare()["exact"])

    def test_color_profile_difference_is_not_declared_exact(self):
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        result = self.compare(icc_profile=profile)
        self.assertTrue(result["exactRgba"])
        self.assertFalse(result["exact"])

    def test_size_mismatch_is_rejected(self):
        self.app = Image.new("RGBA", (7, 5))
        with self.assertRaises(ValueError):
            self.compare()


if __name__ == "__main__":
    unittest.main()
