# Contributing to Wigwag

Bug reports, focused fixes, tests, and documentation improvements are welcome.
Read [SECURITY.md](SECURITY.md) before reporting a vulnerability and
[PRIVACY.md](PRIVACY.md) before sharing diagnostic material.

## Local development

Use Node 24 or newer and Git. The automated tests use fake provider executables
and isolated temporary state; they do not require Claude/OpenAI credentials.

```sh
git clone https://github.com/civicfs/wigwag.git
cd wigwag
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run lint:check
npm test
npm run check:public -- --history
npm run check:package
```

`install.sh` is for installing the live integration: it changes global plugin
configuration and links the global CLI to this checkout. It is not required for
tests. If you previously linked the global CLI here, rebuilding also changes
what your next `wigwag` invocation runs. Use a separate checkout for development
when your working sessions depend on that installation.

Provider integration tests are a separate manual step. Use disposable sessions,
synthetic data, and a separate `WIGWAG_HOME`; see the
[end-to-end checklist](docs/e2e-checklist.md). Report automated evidence separately
from real-provider behavior. Linux support remains unverified end to end until
CI or manual evidence establishes it.

## Changes and reviews

Keep each PR focused on a concrete behavior. Explain the problem, resulting
behavior, validation performed, and any remaining limits. Add regression coverage
for meaningful behavior or security changes. Formatting uses Biome;
`npm run lint` applies fixes and `npm run lint:check` only checks.

Preserve workspace scope, session identity checks, bounded tool responses, native
answer provenance, and human approval requirements. Relays should send only the
question/answer and necessary routing context. Do not add whole transcripts,
telemetry, automatic update installation, or real credentials to fixtures.

Use synthetic session names, IDs, paths, and messages in tests and screenshots.
Keep runtime state, private execution plans, logs, local account files, and built
packages out of Git. Secret checks supplement review; they are not a guarantee.
If you expose a credential, revoke it first and contact the maintainer privately.

By contributing, you agree that your contribution is licensed under the project's
[MIT license](LICENSE). Confirm you have the right to submit it.

Maintainer publication checks are in [docs/public-release.md](docs/public-release.md).
