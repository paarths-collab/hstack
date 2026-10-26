# Tests and validation

Run commands from the repository root. Test suites use disposable state and fake
credentials. Local checks establish the documented source and simulated behavior;
they do not establish live vendor access, gateway restart or Telegram delivery.

## Suite map

| Directory | Coverage |
|---|---|
| `recipes/` | Recipe registry, connector descriptors, plan construction, composer behavior and plugin manifests |
| `skills/` | Executable skill blocks against a simulated SSH target, native parser contracts and failure controls |
| `installer/` | Bash/PowerShell installation, ownership, preservation and repository validation scripts |

## Static checks

```bash
/bin/bash scripts/validate-skills.sh --quiet
/bin/bash scripts/check-skill-refs.sh --quiet
/bin/bash scripts/lint-md-bash.sh
git diff --check
```

## Runtime regressions

Use Node 20 or later, Python 3, Bash and the system tools described by the relevant
suite. Loopback scenarios require local socket access; SSH scenarios also require
OpenSSH tools. CI runs the main suites on Ubuntu and macOS.

```bash
node --test tests/recipes/*.mjs
node --test --test-concurrency=3 tests/skills/*.test.mjs
/bin/bash tests/installer/test-install.sh
/bin/bash tests/installer/test-scripts.sh
pwsh -NoProfile -File tests/installer/test-install.ps1
```

PowerShell needs a separate installation. Its cross-platform tests do not prove
native Windows ACL, junction or Windows PowerShell 5.1 behavior. The real filesystem
permission test is skipped when run as root; use an unprivileged account to cover it.

## Secret scanning

Use the Gitleaks version pinned in `VERSIONS.txt`:

```bash
gitleaks dir . --redact
gitleaks git . --redact
python3 scripts/test-secret-scan.py --gitleaks "$(command -v gitleaks)"
```

The controls verify that fixture exceptions remain narrow and other secret
patterns are detected. Keep scanner reports outside the repository.

Current executed results and remaining live checks are recorded in
[compatibility/VALIDATION.md](../compatibility/VALIDATION.md). CI definitions in
[.github/workflows/](../.github/workflows/) are the source of truth for hosted checks.
