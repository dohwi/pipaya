모델 연결과 **모델 라우팅**(어떤 상황에 어떤 모델을 쓸지)을 설명합니다. 모든 설정은 서버에 저장되어 접속한 모든 기기가 공유합니다.

> [!NOTE]
> 새 서버에는 모델이 연결되어 있지 않습니다. 모델 목록이 비어 있는 동안에는 채팅할 수 없고, 화면에 **모델 연결** 버튼이 나옵니다.

## 연결 방법

**설정 → 모델 연결 → 연결 추가**

### 내장 프로바이더

서버에 내장된 프로바이더입니다(OpenAI, Anthropic, Google, OpenRouter, GitHub Copilot 등). 인증 방식은 프로바이더마다 다르고 `GET /providers`의 `loginMethods`로 알 수 있습니다.

| 방식 | 설명 |
|---|---|
| API 키 | 키를 입력하면 서버에 저장 |
| 로그인(OAuth) | 서버가 로그인 절차를 진행하고 앱이 링크 열기·코드 입력을 안내. 리디렉션 URL을 붙여넣어 마칠 수도 있음 |

키가 필요한 프로바이더 일부는 `API 키 설정`에 추가 질문이 이어지는 대화형 설정을 가집니다. 로그인 절차는 `POST /providers/:id/login`으로 시작하고, `GET /logins/:id`로 진행 상태(열 링크, 기기 코드, 대기 중인 질문)를 확인하며, `POST /logins/:id/answer`로 질문에 답하고 `POST /logins/:id/cancel`로 취소합니다. 로그인 한 번은 **10분** 뒤 만료되고, 같은 프로바이더에서 새로 시작하면 이전 것은 취소됩니다.

### 로컬 모델 프리셋

키 없이 쓰는 OpenAI 호환 서버입니다.

| 이름 | 기본 주소 |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

> [!WARNING]
> 이 주소에는 **서버**가 접속합니다. `localhost`는 앱을 연 기기가 아니라 서버 머신입니다. 서버를 Docker로 띄웠다면 호스트의 모델은 `host.docker.internal`로 가리켜야 합니다 → [[installation]].

### 직접 입력 (커스텀 엔드포인트)

| 필드 | 규칙 |
|---|---|
| 이름 | 표시용 |
| ID | 소문자로 시작, 소문자·숫자·`_`·`-`, 최대 64자 |
| Base URL | `http(s)://`. 계정 정보·쿼리·프래그먼트 불가 |
| API 형식 | `openai-completions`, `openai-responses`, `anthropic-messages` |
| 키 필요 | `authRequired` — 로컬 서버는 끔 |
| 모델 ID | 직접 입력. 연결당 최대 100개 |
| 컨텍스트 윈도우 | 128 ~ 10,000,000 |
| 최대 출력 | 1 ~ 컨텍스트 윈도우 |
| 추론 / 이미지 | 모델이 지원하면 체크 (`reasoning`, `vision`) |

API로 등록할 때의 본문입니다.

```json
{
  "name": "Local Ollama",
  "baseUrl": "http://model-host:11434/v1",
  "api": "openai-completions",
  "authRequired": false,
  "models": [
    { "id": "qwen3:8b", "name": "Qwen 3 8B", "contextWindow": 32768, "maxTokens": 4096, "reasoning": false, "vision": false }
  ]
}
```

모델 ID 자동완성용으로 번들된 OpenRouter 카탈로그(`GET /configuration/catalog`)가 있고, 엔드포인트가 모델 목록을 제공하면 `POST /configuration/discover`로 불러올 수 있습니다. 연결의 모델 목록은 시작할 때 백그라운드에서 업스트림과 동기화되며(`POST /configuration/providers/:id/refresh`로 수동 갱신), 업스트림에서 사라진 모델은 `available: false`로 표시됩니다.

### 연결 테스트

`POST /configuration/test`는 **실제 모델 요청을 한 번** 보냅니다(출력 최대 32토큰, 제한 30초). 응답은 `{ok, durationMs, text?, error?}`이고 **요금이 발생할 수 있습니다.**

### 알아둘 점

- 엔드포인트를 수정하면 **다음 요청부터** 적용됩니다.
- 기본값이나 세션이 쓰는 프로바이더·모델을 삭제하면 `409`로 거부됩니다.
- 커스텀 연결에는 가격이 없어 기록되는 비용이 0입니다. 무료라는 뜻은 아닙니다.
- 연결 주소는 LAN·Tailscale 대상을 의도적으로 허용합니다. 신뢰하는 주소만 등록하세요.
- 키는 서버 SQLite에 **암호화 없이** 저장됩니다 → [[security]].

## 모델 라우팅

용도에 따라 모델을 따로 지정할 수 있습니다. 비싼 모델은 본 대화에, 저렴한 모델은 요약·조사·제목 생성에 쓰는 구성이 가능합니다.

| 용도 | 설정하는 곳 | 비고 |
|---|---|---|
| 기본 모델 | 설정 → 모델 연결 → 기본값 | **새 세션에만** 적용 |
| 세션 모델 | 대화의 모델 선택창 ({{Alt+M}}) | 세션마다 다름 |
| 즐겨찾기 순환 | {{Alt+Shift+M}} | 별표한 모델만 순서대로 |
| 컨텍스트 압축 | 설정 → 모델 연결 → 압축 (`/compaction`) | 요약 모델. 비우면 세션 모델 |
| 하위 에이전트 | 설정 → 에이전트 | 도우미별 모델. 비우면 호출한 대화의 모델 |
| 시스템 모델 | `/system-model` | 세션 **제목과 역할**을 쓰는 가벼운 모델. 비우면 끔 |
| 역할(role) | `/model-roles` | 서버·확장이 쓰는 이름 붙은 모델 슬롯 |

```text
세션 모델  ─ 대화 자체는 이 모델로 실행
   │
   ├─ 압축할 때            → 압축용 모델 (없으면 세션 모델)
   ├─ delegate 호출         → 도우미의 모델 (없으면 호출한 대화의 모델)
   ├─ 세션 제목·역할 생성   → 시스템 모델 (없으면 끔: 제목은 첫 메시지 앞 60자)
   └─ 서버·확장의 단발 호출 → role 매핑 (없으면 기본 모델)
```

시작 기본값은 환경 변수 `PIPAYA_PROVIDER` / `PIPAYA_MODEL`로 줄 수 있습니다. 저장된 기본값이 있으면 그쪽이 우선합니다. 기본값을 `null`로 지우면 시작 기본값이나 처음 구성된 모델로 돌아갑니다.

### 시스템 모델

서버가 대화와 별개로 쓰는 **가벼운 모델**입니다. 지금은 세션의 제목과 역할(무엇을 맡은 세션인지)을 지을 때 씁니다. 역할은 다른 세션이 `@`로 부르기 전에 "이 세션은 무엇을 하나"를 알 수 있게 합니다 → [[orchestration]].

- `PUT /system-model` `{"model": {"provider", "model", "thinkingLevel"?} 또는 null}`
- `null`이면 꺼집니다. 설정한 모델이 나중에 삭제되면 조용히 꺼집니다.
- 제목은 최대 60자(모델에게는 40자 이내를 요청), 역할은 최대 120자(모델에게는 80자 이내), 출력은 최대 400토큰입니다.

### 역할(role)

`light`, `summary`, `explore`처럼 이름 붙인 **모델 슬롯**입니다. 서버와 확장은 구체적인 모델이 아니라 역할 이름만 참조해서, 나중에 저렴한 모델을 바꿀 때 매핑 한 줄만 고치면 됩니다.

- 이름: 소문자로 시작, 소문자·숫자·`-`, 최대 40자
- 최대 20개. `PUT /model-roles`는 **전체 표를 교체**하므로 먼저 `GET`으로 가져와 고치세요.
- 매핑한 모델이 실제로 있어야 저장됩니다(오타는 저장 시점에 거부).
- 매핑이 없거나 모델이 사라졌으면 기본 모델을 씁니다.

`POST /llm/complete`는 세션 없이 도구도 기록도 없는 **단발 텍스트 완성**입니다. 요약, 분류, 번역처럼 서버·확장이 쓰는 기본 블록이며, `role`(역할) 또는 `provider`+`model` 중 하나로 대상을 정합니다(둘 다 주면 `400`).

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"roles":{"light":{"provider":"openai","model":"gpt-5-mini"}}}' \
  http://<서버 주소>:8787/model-roles
```

> [!NOTE]
> 예시의 `openai`, `gpt-5-mini`는 자리 표시용입니다. `GET /models`로 확인한 실제 프로바이더·모델 ID로 바꾸세요.

## 추론 강도

| 단계 | 설명 |
|---|---|
| `minimal` | 최소. 하위 에이전트의 기본값 |
| `low` | 낮음 |
| `medium` | **기본값** |
| `high` | 높음 |
| `xhigh` | 매우 높음 |
| `max` | 최대 |

- `off`(추론 끄기)는 지원하지 않습니다. 기존 `off` 세션은 `medium`으로 옮겨집니다.
- 추론을 지원하지 않는 모델은 선택한 강도를 무시합니다.
- 모델마다 받을 수 있는 단계가 달라서, `GET /models`의 `thinkingLevels`로 모델별 목록을 봅니다.
- {{Alt+T}}로 순환합니다 (`minimal → … → max`, 끝에서 처음으로).

## 모델 카탈로그 조회

`GET /models?provider=&configured=true`가 돌려주는 항목입니다.

| 필드 | 설명 |
|---|---|
| `provider`, `id`, `name` | 식별 |
| `api` | API 형식 |
| `reasoning`, `thinkingLevels` | 추론 지원 여부와 받는 단계 |
| `contextWindow`, `maxTokens` | 컨텍스트 윈도우, 최대 출력 |
| `vision` | 이미지 입력 지원 → 첨부 이미지가 이미지로 전달되는지 결정 ([[composer]]) |
| `configured` | 인증이 준비됐는지 |
| `available` | 연결의 모델 목록에 아직 있는지 |

## API 키 관리

| 동작 | API |
|---|---|
| 키 저장 | `PUT /providers/:id/credential` `{key}` |
| 키 삭제 | `DELETE /providers/:id/credential` |
| 프로바이더 상태 | `GET /providers` (키 값은 돌려주지 않음) |
| 로그인 시작 | `POST /providers/:id/login` |
