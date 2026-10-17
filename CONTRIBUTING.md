# Contributing

## Workflow

- One branch per change: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`. Open a pull request against `main`.
- `main` is always releasable. Merge small changes often; merging does **not** publish anything.
- Squash-merge, so the PR title becomes the commit message.

## Commits and PR titles

English, Conventional Commits: `type(scope): subject`

- type: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`
- imperative, lowercase start, no trailing period, at most 72 characters
- breaking change: `feat(scope)!: subject` or a `BREAKING CHANGE:` footer

## Checks

```sh
cd server && bun run typecheck && bun run lint && bun run test
cd client && bun run check && bun run test && bun run build
```

## Releases

Users only get an update when a version tag is pushed.

1. Branch `chore/release-X.Y.Z`, run `bun scripts/bump-version.ts X.Y.Z`, commit `chore(release): vX.Y.Z`.
2. Merge it to `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`. The *Client release* workflow builds every platform and updates the `latest` release.

Versioning is SemVer (`0.MINOR.PATCH` until 1.0): `fix` → patch, `feat` or breaking → minor.
Group work with a GitHub milestone named after the version, not with a long-lived version branch.
