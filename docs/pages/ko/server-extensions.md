서버 확장은 **서버 프로세스 안에서 도는 플러그인**입니다. 도구를 추가하거나 바꾸고, 에이전트 동작에 훅을 걸고, `/명령`을 만들고, 클라이언트가 부를 메서드를 노출하고, 모델 프로바이더를 등록할 수 있습니다.

> [!DANGER]
> 서버 확장은 **서버의 모든 권한으로 실행됩니다.** 샌드박스도 시간 제한도 없고(확장 해제 훅의 2초 대기만 예외) 파일·네트워크·프로세스를 마음대로 다룰 수 있습니다. 신뢰하는 코드만 설치하세요. 그래서 확장 다시 읽기는 **관리자 토큰**만 할 수 있습니다.

## 위치와 불러오기

| 위치 | 설명 |
|---|---|
| `~/.pipaya/extensions/` | 데이터 디렉터리(`PIPAYA_DATA_DIR`)의 `extensions/` |
| `~/.agents/extensions/` | 서버 사용자의 홈 |

각 항목은 아래 중 하나입니다. 이름이 `.`으로 시작하는 것과 `node_modules`는 건너뜁니다.

- `.ts`, `.js`, `.mjs` 파일
- `index.ts` / `index.js` / `index.mjs`가 있는 폴더
- `package.json`의 `pipaya.extensions`에 파일 목록을 적은 폴더 (`{"pipaya": {"extensions": ["./a.ts", "./b.ts"]}}`)

서버를 재시작하지 않고 다시 읽으려면 `POST /server-extensions/reload`(관리자 토큰)를 부릅니다. 다시 읽을 때 이전 인스턴스를 내리면서 각 확장에 `extension_unload` 훅을 보내고 **최대 2초** 기다립니다.

| 확인 | API |
|---|---|
| 불러온 확장, 도구, 명령, 메서드, 오류 | `GET /server-extensions` |
| 로드·실행 오류 | `GET /server-extensions/errors` (최근 100개) |

로드 중 예외가 난 확장은 그 확장만 꺼지고 나머지는 정상 동작합니다. 오류는 `extension_error` 이벤트(저장 안 됨)로도 알려집니다.

## 기본 모양

확장은 `(pi) => { … }` 함수를 **default export**하는 모듈입니다.

```ts
// ~/.pipaya/extensions/guard.ts
export default (pi) => {
  const T = pi.Type;

  // 1. 모델이 부를 수 있는 도구
  pi.registerTool({
    name: "todo_add",
    description: "이 대화의 할 일 목록에 항목을 추가한다",
    parameters: T.Object({ text: T.String({ minLength: 1, maxLength: 200 }) }),
    mutating: false,                      // 기본 true = ask 정책에서 승인 필요
    execute: async (_id, params, ctx) => {
      ctx.appendEntry("todo", { text: params.text });   // 세션에 저장, 모델에는 안 감
      return { content: [{ type: "text", text: `추가함: ${params.text}` }] };
    },
  });

  // 2. 정책: 위험한 명령을 실행 전에 막기
  pi.on("tool_call", (e) =>
    e.toolName === "bash" && /\brm\s+-rf\s+\/(\s|$)/.test(String(e.args?.command))
      ? { block: true, reason: "guard가 거부함" }
      : undefined);

  // 3. 서버가 처리하는 /명령 (문자열을 돌려주면 사용자 메시지로 모델에 전달)
  pi.registerCommand("todos", {
    description: "할 일 목록을 요약해 달라고 요청",
    handler: async (_args, ctx) => {
      const items = ctx.entries("todo").map((e) => `- ${e.data.text}`);
      return items.length ? `내 할 일이야. 뭐부터 할지 제안해줘:\n${items.join("\n")}` : "할 일이 없어.";
    },
  });

  // 4. 클라이언트가 부르는 메서드
  pi.registerMethod("count", (_params, ctx) => ctx?.entries("todo").length ?? 0);

  pi.on("extension_unload", () => pi.log("guard 해제"));
};
```

저장소의 `server/examples/extensions/todo.ts`가 같은 구성의 완성 예제입니다.

## `pi` (ExtensionAPI)

| 멤버 | 설명 |
|---|---|
| `pi.Type` | typebox. 도구 매개변수 스키마용 (`pi.Type.Object({…})`) |
| `pi.name` | 이 확장의 이름 (파일 또는 폴더 이름) |
| `pi.on(event, handler)` | 훅 등록. 핸들러는 **불러온 순서**대로 실행. 예외가 나면 기록하고 건너뜀 |
| `pi.registerTool(tool)` | 도구 추가. 이름이 내장 도구(`read`, `bash`…)와 같으면 **그 도구를 대체**. 이름 규칙 `^[A-Za-z0-9_-]{1,64}$` |
| `pi.builtinTool(name, cwd)` | 원래 내장 도구를 돌려줌 (대체하면서 감쌀 때) |
| `pi.registerCommand(name, cmd)` | `/이름 인자`로 부르는 서버 명령. 이름 규칙 `^[A-Za-z0-9_-]{1,40}$` |
| `pi.registerMethod(name, fn)` | 클라이언트가 `POST /server-extensions/:확장/methods/:이름`으로 부름. `fn(params, ctx \| null)` |
| `pi.registerProvider(p)` / `unregisterProvider(id)` | 모델 프로바이더(커스텀 엔드포인트, 프록시, OAuth 로그인 등). pi-ai의 `Provider`와 같은 모양 |
| `pi.registerFlag(name, flag?)` / `getFlag(name)` | 플래그. 값은 환경 변수 `PIPAYA_FLAG_<이름>`, 없으면 기본값 |
| `pi.emit(sessionId, type, data?, {ephemeral?})` | 클라이언트에 `extension_event` 발행. `sessionId: null`이면 전역. `ephemeral`이면 저장 안 함 |
| `pi.events.on(channel, fn)` / `emit(channel, data)` | 확장끼리의 **프로세스 내** 이벤트 버스. `on`은 해제 함수를 돌려줌 |
| `pi.dataDir` | 이 확장이 파일을 둘 수 있는 폴더 (처음 쓸 때 생성) |
| `pi.log(...)` | 로그 |

같은 이름을 두 확장이 등록하면 충돌을 오류로 기록합니다.

## 도구

| 필드 | 설명 |
|---|---|
| `name` | 도구 이름 |
| `label` | 표시 이름 (선택) |
| `description` | 모델이 읽는 설명 |
| `parameters` | typebox 스키마 |
| `mutating` | 기본 **true**. 변경 도구는 `ask`에서 **항상** 승인을 요청하고 `readonly`에서 차단됨. 읽기 전용이면 `false` |
| `defaultActive` | 새 세션의 기본 도구에 포함할지. 기본 true |
| `execute(toolCallId, params, ctx, signal?, onUpdate?)` | `{content: [{type:"text", text} \| {type:"image", data, mimeType}], details?}`를 돌려줌 |

> [!NOTE]
> 서버는 확장 도구가 프로젝트 밖에 닿는지 판단할 수 없어서, `mutating: true`(기본)인 확장 도구는 `ask` 정책에서 **프로젝트 안이라도 항상** 승인을 묻습니다 → [[tools]].

## 훅 (이벤트)

| 이벤트 | 페이로드 | 반환으로 할 수 있는 일 |
|---|---|---|
| `input` | `{sessionId, text, mode}` | `{text}`로 **바꿔 쓰기**, `{handled: true}`로 **삼키기** |
| `before_agent_start` | `{sessionId, text}` | `{systemPrompt?, appendSystemPrompt?, message?}` — 이번 실행에만 컨텍스트 추가 |
| `context` | `{sessionId, messages}` | `{messages}`로 **모델이 보는 메시지 바꾸기** (저장은 안 됨) |
| `tool_call` | `{sessionId, toolCallId, toolName, args}` | `args`를 제자리에서 고치거나 `{block: true, reason}`으로 **막기**. 하위 에이전트의 도구 호출도 거침 |
| `tool_result` | `{…, content, details, isError}` | `{content?, details?, isError?}`로 결과 **일부 교체** |
| `session_before_compact` | `{sessionId, reason: "manual"\|"threshold", messages, previousSummary, instructions?}` | `{cancel: true}` 또는 직접 쓴 `{summary}` |
| `agent_start` `agent_end` `turn_start` `turn_end` `message_end` | 세션 ID 등 | 관찰용 (반환 없음) |
| `session_start` `session_shutdown` `session_fork` `session_compact` | 세션 ID 등 | 관찰용 |
| `extension_unload` | `{name}` | 타이머·파일 정리. 2초 안에 끝내야 함 |
| `extensions_loaded` | `{names}` | 모든 확장을 불러온 뒤 한 번 |

모든 핸들러는 `(event, ctx)`를 받습니다.

## ctx (ExtensionContext)

| 멤버 | 설명 |
|---|---|
| `sessionId`, `cwd` | 세션과 작업 디렉터리 |
| `appendEntry(type, data)` | 세션에 **기록 저장**. 재시작해도 남고 모델에는 가지 않음. `extension_entry` 이벤트로도 발행 |
| `entries(type?)` | 이 확장이 이 세션에 저장한 기록 (오래된 순) |
| `sendUserMessage(text, mode?)` | 사용자 메시지를 대기열에 넣음. 대기 중이면 새 실행 시작(`prompt`), 아니면 `steer`/`follow_up` |
| `abort()` | 실행 중인 에이전트 중단 |
| `isRunning()` | 작업 중인지 |

`registerMethod` 핸들러의 `ctx`는 요청에 `?sessionId=`가 없으면 `null`입니다.

## `/명령`

사용자가 입력창에서 `/이름 인자`를 보내면 서버가 확장 명령을 실행합니다. 핸들러가 **문자열(또는 `{prompt}`)을 돌려주면 그것이 사용자 메시지로 모델에 전달**되고, 아무것도 돌려주지 않으면 처리만 하고 끝납니다. 앱의 `/` 메뉴에는 불러온 확장 명령이 함께 나옵니다.

## 클라이언트와 연결

| 방향 | 방법 |
|---|---|
| 클라이언트 → 서버 | 클라이언트 확장이 `sdk.server.call("확장", "메서드", params)` → `registerMethod` |
| 서버 → 클라이언트 | `pi.emit(...)`, `ctx.appendEntry(...)` → 클라이언트 확장이 `sdk.server.on(...)`으로 받음 |
| 저장된 기록 읽기 | `GET /sessions/:id/extension-entries?extension=&type=`, `sdk.server.entries(...)` |

서버 확장의 메서드는 QR로 연결한 기기도 부를 수 있지만(`403`이 아님), 다시 읽기는 관리자만 합니다. 화면은 클라이언트 확장이 그립니다 → [[client-extensions]].

## 만들고 디버깅하기

::: steps
### 파일 만들기

`~/.pipaya/extensions/hello.ts`에 위 예제의 일부를 둡니다.

### 다시 읽기

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -X POST -H "Authorization: Bearer $TOKEN" http://<서버 주소>:8787/server-extensions/reload
```

### 확인

`GET /server-extensions`에서 도구·명령·메서드가 보이는지, `GET /server-extensions/errors`에서 오류가 없는지 확인합니다. 로드 오류가 났다면 메시지에 어느 단계(`where`)인지 나옵니다.
:::

- 변경한 도구·명령은 **다시 읽은 뒤** 새로 만드는 세션부터 확실히 반영됩니다.
- 정책 훅(`tool_call`)은 모든 세션과 하위 에이전트에 적용되므로, 위험한 동작을 막는 용도로 좋습니다. 단, 서버 확장이 로드되지 않으면 정책도 적용되지 않습니다.

## 에이전트에게 맡기기

내장 스킬 `pipaya-server-extensions`가 위 내용을 담고 있어, "서버 확장으로 `rm -rf /`를 막아줘" 같은 요청을 에이전트가 이해하고 파일을 만들어 줍니다.
