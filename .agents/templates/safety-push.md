---
description: 남은 커밋·브랜치 점검 → 검증 후 main 반영 → 브랜치 정리 → 푸시 → CI 확인
---
pipaya 저장소에 남은 작업을 안전하게 점검하고, main에 반영하고, 브랜치를 정리한 뒤 푸시하고 CI 결과까지 확인해줘. $ARGUMENTS

AGENTS.md의 Git 워크플로우를 따른다. 문제가 생기면 억지로 진행하지 말고 멈춘 다음 보고한다.

## 1. 현황 파악
- `git fetch --prune origin`
- `git status -sb`, `git stash list`
- `git log --oneline origin/main..main`: 아직 푸시하지 않은 main 커밋
- `git log --oneline main..origin/main`: 원격에만 있는 커밋. 하나라도 있으면 멈추고 보고한다(임의로 rebase/merge하지 않는다).
- `git branch -vv`, `git branch --no-merged main`, `git branch --merged main`
- 병합되지 않은 브랜치는 각각 `git log --oneline main..<브랜치>`와 `git diff --stat main...<브랜치>`로 내용을 확인한다.

## 2. 남은 작업 점검
- 커밋하지 않은 변경, 미추적 파일, stash가 있으면 무엇인지 정리해서 보여주고 어떻게 할지 물어본다. 내 마음대로 커밋하거나 버리지 않는다.
- 반영할 diff 전체(`git diff origin/main...main`과 병합할 브랜치)에서 아래를 확인한다.
  - 비밀값: `.env`, 토큰, 키, 인증서 등. 발견하면 즉시 멈춘다. 값은 출력하지 않는다.
  - 충돌 마커(`<<<<<<<`, `>>>>>>>`), 디버그용 코드, 남겨둔 `console.log`나 임시 파일
  - 끝나지 않은 커밋(WIP, fixup!, squash!)
- 병합할지 애매한 브랜치(작업 중으로 보이거나 오래됐거나 목적이 불분명한 브랜치)는 건드리지 말고 목록으로 보여주고 물어본다.

## 3. 검증
변경된 영역에 맞춰 실행한다. 하나라도 실패하면 멈추고 원인을 보고한다.
- server/: `cd server && bun run typecheck && bun test`
- client/: `cd client && bun run check && bun run test && bun run build` (CI의 validate 잡과 같은 명령)
- 병합할 브랜치가 있으면 병합한 뒤의 main에서 다시 검증한다.

## 4. main에 반영
- `git switch main` 후 완료된 브랜치를 하나씩 `git merge <브랜치>`로 병합한다.
- 충돌이 나면 `git merge --abort`로 되돌리고 보고한다. 임의로 해결하지 않는다.

## 5. 브랜치 정리
- main에 완전히 병합된 작업 브랜치만 `git branch -d <브랜치>`로 삭제한다. `-D`는 쓰지 않는다.
- 원격에도 있는 브랜치면 `git push origin --delete <브랜치>`로 지운다.
- 병합되지 않았거나 관련 없는 브랜치는 남겨둔다.

## 6. 푸시
- `git push origin main`. force push는 하지 않는다. 푸시가 거부되면 원인을 보고하고 멈춘다.

## 7. CI 확인
- `.github/workflows/client-release.yml`은 main 푸시 중 `client/**` 또는 그 워크플로우 파일이 바뀐 경우에만 실행된다. 이번 푸시에 해당 변경이 없으면 CI가 실행되지 않는다고 알려준다.
- 실행됐다면 `gh run list --branch main --commit $(git rev-parse HEAD) --limit 5`로 run을 찾고 `gh run watch <id> --exit-status`로 끝날 때까지 기다린다. 데스크톱·모바일 빌드까지 있어 오래 걸릴 수 있다.
- 실패하면 `gh run view <id> --log-failed`로 원인을 요약하고 고치는 방법을 제안한다. 요청이 없으면 다시 커밋하거나 푸시하지 않는다.

## 마지막 요약
- 반영된 커밋 범위(이전 origin/main → 새 HEAD)
- 병합한 브랜치와 삭제한 브랜치(로컬/원격)
- 남겨둔 브랜치, 변경, stash와 그 이유
- 검증 결과, CI 결과(성공/실패/미실행, run URL)
