# Preparing a public release

Publishing GitHub source and publishing an npm version are separate actions.
The 0.2.0 candidate remains unpublished on npm. Prepare and review the exact
source/artifact before either action.

## Source and history

1. Verify a clean candidate checkout, the MIT license, README, privacy notice,
   security policy, contribution guide, and changelog.
2. Run `npm run check:public -- --history`. Review historical content manually
   too, including diagnostics, native session IDs, paths, commit metadata, and
   any branches or tags that will become visible. A clean working tree alone is
   insufficient. Revoke any exposed credentials regardless of history cleanup.
3. Inspect existing GitHub branches, tags, PRs, issues, releases, Actions logs,
   and artifacts before changing an existing private repository's visibility.
   Hidden PR refs, cached commits, or previously shared copies can survive branch
   cleanup; coordinate sensitive-data removal with GitHub where necessary.
4. Push only reviewed refs explicitly. Do not publish private backup refs with
   `--all`, `--tags`, or `--mirror`. If history cleanup is required, retain a local
   private backup, prepare a separate sanitized candidate, review the rewrite,
   and use explicit leases when updating remote refs. Do not force-push casually.
5. Ensure the default branch contains the reviewed candidate. Review open PRs
   before rewriting their base/head history.

## GitHub settings

At publication, configure private vulnerability reporting, Dependabot alerts and
security updates, secret scanning and push protection where available. Confirm
that the Security tab's reporting action works; `SECURITY.md` provides a fallback
if it does not. Protect the default branch with required CI/review checks that
match the repository's available GitHub features.

The included CI workflow uses read-only repository permissions, immutable action
commits, full history for the public-file check, and no provider credentials or
plugin installation. It runs Node 24 checks on macOS and Linux. Its first hosted
run must pass before claiming hosted CI or Linux validation. It does not publish
packages or merge updates automatically.

## npm artifact

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm run lint:check
npm test
npm run check:public -- --history
npm run check:package
npm audit --omit=dev --audit-level=low
npm audit
npm pack --ignore-scripts
```

Inspect the actual archive, not only `.gitignore`. `check:package` verifies the
npm file inventory against an explicit allowlist; it does not guarantee that the
allowed files contain no secrets. Review bundled code/source maps and screenshots
as well. Runtime state, credentials, private plans, logs, and development caches
must not ship. Record the final commit and archive hash.

The complete dependency audit currently has a documented low-severity esbuild
development-server advisory; runtime audits are a separate check. Reassess current
advisories rather than treating a previous audit as permanent clearance.

Publishing a scoped package requires npm access to `@civicfs` and the account's
configured authentication/2FA or trusted-publishing flow. `publishConfig` selects
the public npm registry and public access. The prepublish hook runs build, type,
lint, tracked/history, and package-inventory checks. Run tests and review the
artifact before requesting publication; the hook is not a substitute for them.
After publication, verify npm metadata and installation from the advertised
version before claiming that self-update works against a live release.

## Trusted publishing setup

The prepared `.github/workflows/publish.yml` uses GitHub OIDC, without an npm
publish-token secret. It runs only by manual dispatch of a stable tag in the public
`civicfs/wigwag` repository, for example:

```sh
gh workflow run publish.yml --ref v0.2.0
```

The job checks main ancestry, package version, and equality between the checked-out
tag commit and GitHub's dispatch SHA, so provenance identifies the source actually
built. It repeats validation, then publishes. It uses a GitHub-hosted runner, Node 24, npm 11.5.1+, and no dependency
cache. GitHub OIDC publishing provides provenance for a public package from a
public repository. [npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Configure the npm package's trusted publisher with these exact values:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization | `civicfs` |
| Repository | `wigwag` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Permission | Allow direct `npm publish` |

Create the matching GitHub `npm` environment and restrict deployments to release tags matching `v*`;
configure maintainer review if desired. Grant OIDC only to the publish job.
Create the npm trust connection close to release: its first successful publish
must occur within two days. After validating it, disallow traditional publish
tokens in npm package settings. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed.

### First package registration

`@civicfs/wigwag` is currently unpublished. npm's
[trust-command prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
require an existing package, write access, and account 2FA. A maintainer must
establish the package before configuring trust; this setup has not been performed.

One supported bootstrap is an interactive `npm stage publish` of a separate,
reviewed temporary bootstrap package/version, for example `0.0.0-bootstrap.0`.
For a new name this creates a **public `0.0.0-stage` placeholder**. Keep the
bootstrap stage until the intended version has been published through OIDC, then
reject the unused bootstrap stage interactively. Never stage the intended release
version for this bootstrap: staged versions reserve that version number and would
block the direct publishing workflow. See
[npm staged publishing](https://docs.npmjs.com/staged-publishing/).

Bootstrap staging is a publishing side effect and requires an explicit release
decision; do not run it during repository preparation. It uses the maintainer's
interactive npm account, not a CI publish-token secret. Confirm package existence
and publisher configuration before triggering the actual release.

The workflow and configuration instructions are prepared; npm account setup,
OIDC exchange, provenance generation, hosted tests, and a real publication remain
unverified until executed after the repository is public.
