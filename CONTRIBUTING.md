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
cd server && bun run typecheck && bun run lint -- --error-on-warnings && bun run test
cd client && bun run check && bun run test && bun run build
```

Screen smoke test (real browser, starts and removes its own server): `pip install playwright==1.63.0 && playwright install chromium`, then `python3 scripts/e2e-smoke.py --build`. On failure it leaves screenshots and a console log in `tmp/e2e/`.

### Korean and English

Every text a person reads ships in both. In the app, write `t("한국어 원문")` and add the English to
`client/src/lib/locales/en.ts`; the client tests fail on a missing entry or Korean outside `t()`. Extensions carry
their own `descriptions` and `translations`. The full rules: [docs/i18n.md](docs/i18n.md).

### Releases

Users only get an update when a version bump reaches `main`. Only the rolling `latest` release exists; version tags are not created.

1. Branch `chore/release-X.Y.Z`, run `bun scripts/bump-version.ts X.Y.Z`, commit `chore(release): vX.Y.Z`.
2. Merge it to `main`. The *Client release* workflow (triggered by the `tauri.conf.json` change) builds every platform and updates the `latest` release.

Every release raises the version by exactly 0.0.1, regardless of the change type. PATCH only runs 0–9 and rolls over into MINOR (`0.4.8` → `0.4.9` → `0.5.0`).
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
cd server && bun run typecheck && bun run lint -- --error-on-warnings && bun run test
cd client && bun run check && bun run test && bun run build
```

화면 스모크 테스트(실제 브라우저, 서버를 스스로 띄우고 지움): `pip install playwright==1.63.0 && playwright install chromium` 후 `python3 scripts/e2e-smoke.py --build`. 실패하면 `tmp/e2e/`에 스크린샷과 콘솔 로그가 남습니다.

### 한국어와 영어

사람이 읽는 문구는 모두 두 언어로 냅니다. 앱에서는 `t("한국어 원문")`으로 쓰고 영어를
`client/src/lib/locales/en.ts`에 넣습니다. 번역이 빠지거나 `t()` 밖에 한국어가 있으면 클라이언트 테스트가 실패합니다.
확장은 자체 `descriptions`와 `translations`를 담습니다. 전체 규칙: [docs/i18n.md](docs/i18n.md).

### 릴리스

사용자는 버전 업이 `main`에 반영돼야 업데이트를 받습니다. 롤링 `latest` 릴리스만 존재하며 버전 태그는 만들지 않습니다.

1. `chore/release-X.Y.Z` 브랜치에서 `bun scripts/bump-version.ts X.Y.Z`를 실행하고 `chore(release): vX.Y.Z`로 커밋합니다.
2. `main`에 병합합니다. `tauri.conf.json` 변경으로 *Client release* 워크플로가 실행되어 모든 플랫폼을 빌드하고 `latest` 릴리스를 갱신합니다.

버전은 `0.MINOR.PATCH`(1.0 전)를 쓰지만, 릴리스마다 올리는 폭은 변경 종류와 상관없이 항상 0.0.1입니다(`feat`가 있어도 minor를 올리지 않습니다).
작업 묶음은 오래 가는 버전 브랜치 대신 버전 이름의 GitHub 마일스톤으로 관리합니다.
