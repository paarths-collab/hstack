"""Offline packaging regressions; use synthetic archives, never install packages."""
import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("prepare_adk", Path(__file__).parents[1] / "prepare-adk.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixture(metadata=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr(builder.DIST + "METADATA", metadata or b"Version: 2.13.0\n" + b"\n".join(builder.REPLACEMENTS) + b"\n")
        archive.writestr(builder.DIST + "WHEEL", b"Wheel-Version: 1.0\nTag: py3-none-any\n")
        archive.writestr(builder.DIST + "RECORD", b"original record\n")
        archive.writestr("google/adk/example.py", b"# unchanged vendor code\n")
        archive.writestr(builder.DIST + "licenses/LICENSE", b"unchanged vendor licence\n")
    return stream.getvalue()


class BuildTests(unittest.TestCase):
    def test_wrong_upstream_hash_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            builder.build(fixture())

    def test_metadata_only_patch_preserves_code_license_and_version(self):
        source = fixture()
        with patch.object(builder, "UPSTREAM_SHA256", hashlib.sha256(source).hexdigest()):
            built = builder.build(source)
            self.assertEqual(built, builder.build(source))
        with zipfile.ZipFile(io.BytesIO(source)) as before, zipfile.ZipFile(io.BytesIO(built)) as after:
            changed = [name for name in before.namelist() if before.read(name) != after.read(name)]
            self.assertEqual(set(changed), {builder.DIST + name for name in ["METADATA", "WHEEL", "RECORD"]})
            metadata = after.read(builder.DIST + "METADATA")
            self.assertIn(b"Version: 2.13.0\n", metadata)
            for new in builder.REPLACEMENTS.values():
                self.assertIn(new + b"\n", metadata)
            self.assertIn(b"Build: 1hstack\n", after.read(builder.DIST + "WHEEL"))
            for name, digest, size in csv.reader(io.StringIO(after.read(builder.DIST + "RECORD").decode())):
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, size), ("", ""))
                else:
                    content = after.read(name)
                    self.assertEqual(digest, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode())
                    self.assertEqual(int(size), len(content))

    def test_unexpected_dependency_metadata_cannot_be_broadly_rewritten(self):
        source = fixture(b"Version: 2.13.0\nRequires-Dist: opentelemetry-api>=1.39,<=1.99\n")
        with patch.object(builder, "UPSTREAM_SHA256", hashlib.sha256(source).hexdigest()):
            with self.assertRaisesRegex(ValueError, "Unexpected dependency"):
                builder.build(source)


if __name__ == "__main__":
    unittest.main()
