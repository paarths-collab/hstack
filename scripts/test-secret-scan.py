#!/usr/bin/env python3
"""Prove narrow Gitleaks exceptions still detect other literals and paths.

Runs only on synthetic temporary files. Never prints a matched secret.
"""
import argparse
import json
import hashlib
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks", default="gitleaks")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    fixture = "123456789012345678"
    other = "987654321098765432"
    # Assembled synthetic canary; never a credential issued by a provider.
    pat = "g" + "hp_" + hashlib.sha256(b"synthetic scan canary, never issued").hexdigest()[:36]
    cases = [
        ("home ID exception", "tests/skills/hermes-home.test.mjs", f'discord_client_id = "{fixture}"', None),
        ("chat ID exception", "tests/skills/platform-chat.test.mjs", f'discord_client_id = "{fixture}"', None),
        ("different ID in home", "tests/skills/hermes-home.test.mjs", f'discord_client_id = "{other}"', "discord-client-id"),
        ("different ID in chat", "tests/skills/platform-chat.test.mjs", f'discord_client_id = "{other}"', "discord-client-id"),
        ("same ID elsewhere", "settings.txt", f'discord_client_id = "{fixture}"', "discord-client-id"),
        ("other detector in home", "tests/skills/hermes-home.test.mjs", f'github_token = "{pat}"', "github-pat"),
        ("other detector in chat", "tests/skills/platform-chat.test.mjs", f'github_token = "{pat}"', "github-pat"),
    ]
    for label, path, contents, expected in cases:
        with tempfile.TemporaryDirectory(prefix="hstack-scan-control-") as temp:
            work = Path(temp) / "source"
            file = work / path
            file.parent.mkdir(parents=True)
            file.write_text(contents + "\n")
            report = Path(temp) / "report.json"
            run = subprocess.run([args.gitleaks, "dir", str(work), "--config", str(root / ".gitleaks.toml"),
                                  "--redact", "--no-banner", "--report-format", "json", "--report-path", str(report)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
            findings = json.loads(report.read_text()) if report.exists() else []
            rules = {item["RuleID"] for item in findings}
            if run.returncode != (1 if expected else 0) or (expected is not None and expected not in rules) or (expected is None and rules):
                raise SystemExit(f"FAIL: {label} (exit {run.returncode}, rule IDs: {sorted(rules)})")
            print(f"PASS: {label}")
    print(f"{len(cases)} secret-scan controls passed")


if __name__ == "__main__":
    main()
