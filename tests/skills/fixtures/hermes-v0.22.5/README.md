# Tagged Hermes CLI syntax fixtures

Exact source bytes from NousResearch/hermes-agent v0.22.5 at
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`, fetched read-only from GitHub.
`provenance.json` records upstream paths, Git blob identities and SHA-256 digests.
Upstream MIT notice is preserved in LICENSE.

The parser harness imports these actual argparse builders and executes only AST-selected
early profile selection functions from main.py. Profile-directory resolution and service
presence are injected boundaries; active-profile selection and argument stripping are real. Application handlers,
help-text home lookup and release-channel-name validation are injected boundaries;
no Hermes runtime, plugin, installer stage, network request or credential is used.
This proves the tested invocation syntax, not runtime/service/provider compatibility.
The installer is run only with --help or rejected arguments, before its stages execute.
Do not extend this syntax evidence into a live-compatibility claim.
