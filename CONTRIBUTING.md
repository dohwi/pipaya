# Contributing

**English** · [한국어](#한국어)

## English

### Workflow

- One branch per change: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`. Open a pull request against `main`.
- `main` is always releasable. Merge small changes often; merging does **not** publish anything.
- Squash-merge, so the PR title becomes the commit message.

### Commits and PR titles

English, Conventional Commits: `type(scope): subject`

- type: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`
- imperative, lowercase start, no trailing period, at most 72 characters
- breaking change: `feat(scope)!: subject` or a `BREAKING CHANGE:` footer

### Checks

```sh
cd server && bun run typecheck && bun run lint && bun run test
cd client && bun run check && bun run test && bun run build
```

### Releases

Users only get an update when a version tag is pushed.

1. Branch `chore/release-X.Y.Z`, run `bun scripts/bump-version.ts X.Y.Z`, commit `chore(release): vX.Y.Z`.
2. Merge it to `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`. The *Client release* workflow builds every platform and updates the `latest` release.

Versioning is SemVer (`0.MINOR.PATCH` until 1.0): `fix` → patch, `feat` or breaking → minor.
Group work with a GitHub milestone named after the version, not with a long-lived version branch.

## 한국어

### 작업 방식

- 변경마다 브랜치 하나: `feat/<주제>`, `fix/<주제>`, `chore/<주제>`. `main`을 대상으로 풀 리퀘스트를 엽니다.
- `main`은 언제든 릴리스할 수 있는 상태로 유지합니다. 작은 변경을 자주 병합하세요. 병합만으로는 아무것도 배포되지 **않습니다**.
- Squash 병합을 하므로 PR 제목이 그대로 커밋 메시지가 됩니다.

### 커밋과 PR 제목

영어, Conventional Commits: `type(scope): subject`

- type: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`
- 명령형, 소문자로 시작, 마침표 없음, 72자 이내
- 호환을 깨는 변경: `feat(scope)!: subject` 또는 `BREAKING CHANGE:` 푸터

### 검증

```sh
cd server && bun run typecheck && bun run lint && bun run test
cd client && bun run check && bun run test && bun run build
```

### 릴리스

사용자는 버전 태그를 push해야 업데이트를 받습니다.

1. `chore/release-X.Y.Z` 브랜치에서 `bun scripts/bump-version.ts X.Y.Z`를 실행하고 `chore(release): vX.Y.Z`로 커밋합니다.
2. `main`에 병합합니다.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`. *Client release* 워크플로가 모든 플랫폼을 빌드하고 `latest` 릴리스를 갱신합니다.

버전은 SemVer를 따릅니다(1.0 전까지 `0.MINOR.PATCH`): `fix`는 patch, `feat`나 호환 깨짐은 minor입니다.
작업 묶음은 오래 가는 버전 브랜치 대신 버전 이름의 GitHub 마일스톤으로 관리합니다.
