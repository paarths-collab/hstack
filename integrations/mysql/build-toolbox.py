"""Explicit, checksum-verified MySQL Toolbox compatibility build. No account APIs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def mysql_registrations(source: bytes, expected_blob: str) -> bytes:
    blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
    if blob != expected_blob:
        raise ValueError("Registration source changed; review the fixed upstream tag")
    text = source.decode()
    selected = [line for line in text.splitlines() if
                '_ "github.com/googleapis/mcp-toolbox/internal/sources/mysql"' in line or
                '_ "github.com/googleapis/mcp-toolbox/internal/tools/mysql/' in line]
    if len(selected) != 11:
        raise ValueError("Unexpected MySQL registration set")
    return (text[:text.index("import (")] +
            "// Hstack MySQL build: register only the native MySQL source and tools.\nimport (\n" +
            "\n".join(selected) + "\n)\n").encode()


def align_telemetry(source: bytes, expected_blob: str) -> bytes:
    blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
    if blob != expected_blob or source.count(b"otel/semconv/v1.41.0") != 1:
        raise ValueError("Telemetry source changed; review compatibility before building")
    return source.replace(b"otel/semconv/v1.41.0", b"otel/semconv/v1.43.0")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", type=Path, required=True, help="Absolute path to the reviewed Go 1.27.3 executable")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".hstack-tools/mysql-build-cache")
    args = parser.parse_args()
    if not args.go.is_absolute():
        raise ValueError("Use an absolute Go executable path")
    manifest = json.loads((HERE / "toolbox-release.json").read_text())
    build = manifest["compatibilityBuild"]
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="source-", dir=cache))
    env = {"PATH": str(args.go.parent) + os.pathsep + "/usr/bin:/bin", "HOME": str(workspace),
           "GOPATH": str(cache / "modules"), "GOCACHE": str(cache / "build-cache"),
           "GOTOOLCHAIN": "local", "GOWORK": "off", "CGO_ENABLED": "0",
           "GOPROXY": "https://proxy.golang.org", "GOSUMDB": "sum.golang.org"}
    def run(*values, cwd=workspace):
        return subprocess.check_output([str(args.go), *values], cwd=cwd, env=env, stderr=subprocess.PIPE)
    try:
        version = run("version").decode().split()[2]
        if version != build["goVersion"]:
            raise ValueError("Use the reviewed Go compiler version")
        info = json.loads(run("mod", "download", "-json", "github.com/googleapis/mcp-toolbox@v1.15.0"))
        if info["Origin"]["Hash"] != manifest["sourceCommit"] or info["Sum"] != build["sourceModuleSum"]:
            raise ValueError("Tag provenance or module checksum changed")
        source = workspace / "source"
        source.mkdir()
        prefix = "github.com/googleapis/mcp-toolbox@v1.15.0/"
        with zipfile.ZipFile(info["Zip"]) as archive:
            for name in archive.namelist():
                if not name.startswith(prefix):
                    raise ValueError("Unexpected archive layout")
                relative = Path(name[len(prefix):])
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe archive path")
                if not relative.parts:
                    continue
                target = source / relative
                if name.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
        registrations = source / "cmd/internal/imports.go"
        registrations.write_bytes(mysql_registrations(registrations.read_bytes(), build["registrationSourceBlob"]))
        telemetry = source / "internal/telemetry/telemetry.go"
        telemetry.write_bytes(align_telemetry(telemetry.read_bytes(), build["telemetrySourceBlob"]))
        for name in ["go.mod", "go.sum"]:
            shutil.copyfile(HERE / "build" / name, source / name)
        output = workspace / "toolbox-mysql"
        run("build", "-mod=readonly", "-trimpath", "-buildvcs=false",
            "-ldflags=-X github.com/googleapis/mcp-toolbox/cmd.buildType=hstack-mysql -X github.com/googleapis/mcp-toolbox/cmd.commitSha=8e8e569",
            "-o", str(output), ".", cwd=source)
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        # No stripped symbols: the binary must remain precisely auditable.
        system = run("env", "GOOS", "GOARCH").decode().split()
        key = system[0] + "-" + {"amd64": "x64"}.get(system[1], system[1])
        expected = build["platforms"].get(key, {}).get("sha256")
        if expected is None or digest != expected:
            raise ValueError("Build has no matching validated platform hash; candidate was not installed")
        directory = ROOT / ".hstack-tools/toolbox"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "toolbox-mysql-1.15.0"
        output.chmod(0o755)
        try:
            os.link(output, target)
        except FileExistsError:
            if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("Existing executable differs; it was preserved")
        print("Prepared validated Hstack MySQL Toolbox compatibility build; no service contacted.")
        print(f"Executable: {target}")
    finally:
        shutil.rmtree(workspace)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("MySQL compatibility build failed; existing executables were preserved. Review compiler, pinned source and dependencies.")
