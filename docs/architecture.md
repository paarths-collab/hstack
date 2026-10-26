# Repository structure

hstack is a skill catalogue with executable workflow packages and a browser planner.
The layout separates procedures, executable code, declarative inputs, validation
and documentation. Component READMEs stay beside the code they describe.

```text
hstack/
├── README.md                   # Product overview and entry points
├── install.sh / install.ps1     # Public universal installers
├── setup*                      # Public per-agent setup commands
├── skills/                     # Canonical agent-readable procedures
│   └── <skill-name>/SKILL.md
├── packages/                   # Executable implementation
│   ├── recipe-core/            # Shared plan construction and validation
│   ├── founder-brief/          # Activity, review and release workflow workers
│   └── acceptance/             # Experimental reversible transaction engine
├── apps/composer/              # Browser UI for reviewing and exporting plans
├── recipes/                    # Declarative recipe registry and definitions
├── connectors/                 # Declarative integration/platform descriptors
├── blueprints/                 # Example plans accepted by blueprint validation
├── acceptance/                 # Versioned transaction contracts (data)
├── compatibility/              # Hermes pins, evidence and promotion policy
├── templates/                  # Authoring templates
├── scripts/                    # Repository validation and maintenance commands
├── tests/                      # Executable regressions, helpers and fixtures
├── docs/
│   ├── README.md               # Documentation entry point
│   ├── architecture.md         # This directory map and placement rules
│   ├── reference/              # Troubleshooting reference
│   ├── maintainers/            # Maintainer-facing content briefs
│   └── archive/                # Historical plans, explicitly labelled
├── assets/                     # Shared static assets
├── metrics/                    # Traffic snapshots, renderer and documentation
├── .github/workflows/          # CI and repository automation
└── .*plugin/                   # Agent-specific plugin manifests
```

Root-level policy and metadata files include `CONTRIBUTING.md`, `SECURITY.md`,
`CHANGELOG.md`, `LICENSE`, `NOTICE` and `VERSIONS.txt`. `CLAUDE.md`, `GEMINI.md`,
`gemini-extension.json` and the plugin manifests are agent discovery entry points.

## Component boundaries

| Component | Responsibility |
|---|---|
| `skills/` | Instructions a coding agent follows, including SSH preflight, configuration and recovery |
| `recipes/`, `connectors/`, `blueprints/` | Declarative inputs and examples; they do not deploy themselves |
| `packages/recipe-core/` | Turns supported inputs into reviewable plans; shared by the composer and acceptance code |
| `apps/composer/` | Presents the plan builder; does not hold credentials or run a remote deployment |
| `packages/founder-brief/` | Prepares and runs the three deterministic report packs |
| `acceptance/` | JSON contracts describing required behavior and runtime boundaries |
| `packages/acceptance/` | Executes the experimental transaction and produces receipts against those contracts |
| `compatibility/` | Records source pins, test evidence and the separate requirements for live verification |

The two acceptance directories serve different purposes: one holds contracts,
the other holds implementation. The runnable workflow packs have their own
implementation and guide in `packages/founder-brief/`.

## Where new work belongs

- Add or update a procedure in `skills/<name>/SKILL.md`. Keep this flat discovery layout: installers and agent manifests consume it.
- Put reusable execution code in its owning package; keep browser UI code in `apps/composer/`.
- Keep fixtures under the matching `tests/<component>/` directory. Upstream source fixtures retain their provenance and hashes.
- Put cross-project guides under `docs/`; keep implementation-specific instructions in the component README.
- Put historical planning documents under `docs/archive/`, clearly labelled as historical.
- Keep local credentials, generated workers, receipts, logs and scratch output outside tracked source.

The root installer and `setup*` paths are public entry points used by existing
installation commands. Moving them requires a compatibility plan. There is no
root npm workspace: the browser planner is static, JavaScript packages are
private modules, and workflow workers are Python. The [test guide](../tests/README.md)
lists the direct commands used for each layer.
