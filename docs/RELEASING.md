# Releasing AI-Safe Plugin

The release process is deliberately small. There is one trunk, one workflow, and
one trigger: pushing a version tag. No long-lived release branches.

## Branch model

- **`main`** — the only trunk. Always releasable.
- **`gh-pages`** — the project website. Published automatically; don't hand-edit.
- Everything else is a short-lived branch: open it, PR it into `main`, squash-merge,
  then delete it.

## Cutting a release

Pick the new version `X.Y.Z` (semver), then:

1. Bump the version in **`package.json`** (the single source of truth).
2. Run `npm run version:sync` — this propagates the version to
   `extension/manifest.json` and `pyproject.toml` via `scripts/sync_version.py`.
3. Add a `## [X.Y.Z]` section to **`CHANGELOG.md`** describing the changes.
4. Open a PR with these edits, get it green, and merge to `main`.
5. Tag the merge commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

That's it. The `Release` workflow (`.github/workflows/release.yml`) takes over on the
`v*` tag and does the rest:

- verifies `package.json`, `manifest.json`, and `pyproject.toml` all match the tag,
- confirms the `CHANGELOG.md` section exists and there are no conflict markers,
- runs the unit, Python, and end-to-end test suites,
- builds the extension ZIP, backend bundle, fp16 ONNX model bundle, and Windows installer,
- publishes a GitHub Release with all assets and a `SHA256SUMS` file.

## Pre-releases

Use a hyphenated tag (e.g. `v1.3.0-rc.1`). The workflow marks any tag containing `-`
as a GitHub pre-release automatically. Good for a dry run before a real cut.

## Rules of thumb

- Never tag a commit that isn't on `main`. The workflow rejects tags not reachable
  from `main`.
- Keep `main` green — CI (`ci.yml`) and CodeQL (`codeql.yml`) run on every push and PR.
- Don't create `release/*` branches. If a release needs a fix, fix it on `main` and
  cut a new patch tag.
