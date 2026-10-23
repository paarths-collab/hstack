"""Build the reviewed, self-contained Python runtime; never downloads code."""
import argparse
import io
import os
from pathlib import Path
import tempfile
import zipfile


def build():
    here = Path(__file__).resolve().parent
    sources = {"workflow.py": here / "workflow.py", "github_brief.py": here / "github-brief.py",
               "prepare.py": here / "prepare.py",
               "telegram_delivery.py": here / "telegram_delivery.py", "deployment.py": here / "deployment.py",
               "native_adapter.py": here.parent / "acceptance" / "target" / "native-hermes-v0_22_5.py"}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        content = {name: file.read_bytes() for name, file in sources.items()}
        content["__main__.py"] = b"from workflow import main\nraise SystemExit(main())\n"
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, data)
    return output.getvalue()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    data = build()
    if args.output.exists() or args.output.is_symlink():
        raise SystemExit("refusing_existing_output")
    fd, temp = tempfile.mkstemp(dir=str(args.output.parent), prefix=".hstack-brief-")
    try:
        os.fchmod(fd, 0o700)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temp, args.output)
    finally:
        os.unlink(temp)
    print("Built self-contained runtime; review it before installing.")


if __name__ == "__main__":
    main()
