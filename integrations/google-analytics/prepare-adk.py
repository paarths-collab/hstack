"""Build a reproducible, metadata-only ADK compatibility wheel.

The verified upstream Python code and licences remain byte-identical. The two
OpenTelemetry dependency bounds admit the patched 1.45.1 pair. No installs/auth.
"""
import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

UPSTREAM_SHA256 = "bec4c4ee0aa3e63a2243c23365c5aef666ea539bc48c78dfbbf004dbddfc5f00"
UPSTREAM_URL = "https://files.pythonhosted.org/packages/e8/1a/6da4a8048b7cd47681928daed5d4d1c3ef971b3847fcc3cbc63f94df39d2/google_adk-2.13.0-py3-none-any.whl"
WHEEL_NAME = "google_adk-2.13.0-1hstack-py3-none-any.whl"
DIST = "google_adk-2.13.0.dist-info/"
REPLACEMENTS = {
    b"Requires-Dist: opentelemetry-api>=1.39,<=1.44": b"Requires-Dist: opentelemetry-api==1.45.1",
    b"Requires-Dist: opentelemetry-sdk>=1.39,<=1.44": b"Requires-Dist: opentelemetry-sdk==1.45.1",
}


def build(source: bytes) -> bytes:
    if hashlib.sha256(source).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("Upstream ADK wheel hash mismatch; nothing was changed")
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        entries = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    metadata = entries[DIST + "METADATA"]
    for old, new in REPLACEMENTS.items():
        if metadata.count(old + b"\n") != 1:
            raise ValueError("Unexpected dependency metadata; review the upstream wheel")
        metadata = metadata.replace(old + b"\n", new + b"\n")
    entries[DIST + "METADATA"] = metadata
    if b"Build:" in entries[DIST + "WHEEL"]:
        raise ValueError("Unexpected upstream wheel build tag")
    entries[DIST + "WHEEL"] += b"Build: 1hstack\n"
    record = DIST + "RECORD"
    entries.pop(record)
    rows = [[name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), str(len(data))]
            for name, data in sorted(entries.items())]
    rows.append([record, "", ""])
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\n").writerows(rows)
    entries[record] = output.getvalue().encode()
    wheel = io.BytesIO()
    # ZIP_STORED + fixed metadata avoids platform/zlib-dependent hashes.
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    return wheel.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--download", action="store_true", help="Download the fixed hash-verified public upstream wheel")
    mode.add_argument("--upstream-wheel", type=Path, help="Use an already downloaded upstream wheel; no network")
    args = parser.parse_args()
    if args.download:
        with urllib.request.urlopen(UPSTREAM_URL, timeout=30) as response:
            source = response.read(10_000_001)
        if len(source) > 10_000_000:
            raise ValueError("Unexpected upstream size")
    else:
        source = args.upstream_wheel.read_bytes()
    wheel = build(source)
    directory = Path(__file__).resolve().parents[2] / ".hstack-tools" / "analytics-wheels"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / WHEEL_NAME
    try:
        with target.open("xb") as output:
            output.write(wheel)
    except FileExistsError:
        if target.is_symlink() or target.read_bytes() != wheel:
            raise ValueError("Existing wheel differs; it was preserved")
    print(f"Prepared hash-verified metadata-only ADK build: {WHEEL_NAME}")
    print(f"SHA256: {hashlib.sha256(wheel).hexdigest()}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("ADK compatibility build failed; existing files were preserved. Review the pinned source and local setup.")
