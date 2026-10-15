# UI 노드 (Frontend SDK)

확장은 **JSON view tree**를 보내고 앱이 이를 Svelte 컴포넌트로 그립니다. 상태와 동작은 격리된 Worker가 맡고, 표현은 데이터입니다. `ui` 권한이 필요합니다.

## 어디에 나타나나

- **패널**: 우상단 `확장 화면` 런처에서 여는 모달. 앱이 확장 이름과 출처를 표시합니다.
- **입력창 위젯**: `placement: 'composer'`로 등록하면 입력창 위에서 접고 펴는 박스가 됩니다. 서버가 없는 초기 화면에는 입력창이 없어서 위젯도 안 보입니다.
- **헤더 항목**(`navbar`): 읽기 전용 노드만 가능합니다.

한도: 확장당 패널 5개, 패널당 **200 노드 / 깊이 8 / 60 KiB**. 모든 노드에는 고유한 `id`가 필요합니다 (소문자로 시작, 소문자·숫자·하이픈, 40자 이하).

## 등록과 이벤트

```js
await sdk.ui.registerPanel(
  { id: 'request', title: '요청 작성', placement: 'panel', view },
  async (event) => { /* action | change | submit */ }
);
await sdk.ui.update('request', newView, { tone: 'danger' }); // tone은 '확장 화면' 배지 색
await sdk.ui.open('request');
```

이벤트는 세 종류입니다.

```ts
{ type: 'action', id: string }
{ type: 'change', id: string, value: string | boolean }
{ type: 'submit', id: string, values: Record<string, string | boolean> }
```

- `change`는 입력이 **확정**될 때 보냅니다. 키 입력마다 Worker로 보내지 않습니다. select와 checkbox는 바뀌는 즉시 보냅니다.
- 폼 값은 화면에서 임시로 관리하다가 `submit`에서 한꺼번에 전달합니다. 비활성 필드는 빠집니다.
- 호스트는 현재 view를 기준으로 대상 ID, 타입, 옵션, 길이, required/email/number를 다시 검증합니다. 임의 ID나 추가 필드는 보내지 못합니다.
- 같은 ID·타입·기본값으로 view를 갱신하면 편집 중인 값이 유지됩니다.
- 처리 중에는 해당 화면의 입력과 버튼이 비활성화되고, 대기 이벤트는 최대 20개입니다.

## 컴포넌트

공통 필수 필드는 `type`과 `id`입니다.

| 컴포넌트 | 주요 속성 | 용도 |
|---|---|---|
| `stack` | `children`, `direction?`, `gap?` | 수직·수평 레이아웃 |
| `grid` | `children`, `columns?: 1/2/3` | 반응형 1–3열 |
| `card` | `children`, `title?`, `description?` | 제목과 설명이 있는 그룹 |
| `tabs` | `items: {id,label,children}[]` | 키보드 탐색이 되는 탭 |
| `form` | `children`, `submitLabel`, `disabled?` | 검증 후 값 일괄 전달. 중첩 금지 |
| `text` | `text`, `size?: small/body/heading`, `tone?` | 텍스트·제목 |
| `badge` | `text`, `tone?` | 상태 라벨 |
| `alert` | `text`, `title?`, `tone?` | 안내·성공·오류 |
| `stat` | `label`, `value`, `hint?` | 통계 |
| `progress` | `label`, `value`, `max?` | 진행 상태 (기본 max 100) |
| `code` | `text`, `language?` | 이스케이프된 코드. 강조·실행 없음 |
| `divider` | | 구분선 |
| `icon` | `icon: {viewBox, paths}`, `size?`, `label?` | 데이터 기반 벡터 아이콘 |
| `gauge` | `label`, `rings`, `display?`, `icon?`, `hint?`, `stale?`, `size?`, `details?` | 동심원 게이지 |
| `table` | `columns`, `rows`, `caption?` | 의미 있는 HTML 표, 가로 스크롤 |
| `list` | `items: {id,title,description?,badge?}[]`, `emptyText?` | 목록과 빈 상태 |
| `button` | `label`, `variant?: primary/secondary/danger`, `disabled?` | action 이벤트 |
| `input` | `label`, `value?`, `inputType?: text/email/number`, `placeholder?` | 한 줄 입력 |
| `textarea` | `label`, `value?`, `placeholder?`, `rows?` | 여러 줄 입력 |
| `select` | `label`, `value?`, `options: {value,label}[]` | 옵션 선택 |
| `checkbox` | `label`, `checked?` | 불리언 |

입력 컴포넌트에는 `required?`, `disabled?`, `error?`가 있고, input/textarea에는 `minLength?`, `maxLength?`도 있습니다. `tone`은 `neutral` `info` `success` `warning` `danger`만 허용합니다.

## 폼 예제

```js
await sdk.ui.registerPanel({
  id: 'request', title: '요청 작성', view: {
    type: 'form', id: 'request-form', submitLabel: '초안 넣기', children: [
      { type: 'input', id: 'goal', label: '작업 목표', required: true, minLength: 3, maxLength: 300 },
      { type: 'select', id: 'mode', label: '방식', value: 'review', options: [
        { value: 'review', label: '리뷰' }, { value: 'plan', label: '계획' } ] },
      { type: 'checkbox', id: 'tests', label: '테스트 포함', checked: true }
    ]
  }
}, async (event) => {
  if (event.type === 'submit') {
    const { goal, mode, tests } = event.values;
    await sdk.composer.setText(`${goal}\n${mode}\n테스트: ${tests}`);
  }
});
```

## 게이지와 아이콘

```js
const icon = { viewBox: '0 0 24 24', paths: [{ d: 'M12 2 L22 22 H2 Z', fill: 'currentColor' }] };
{ type: 'gauge', id: 'g', label: '사용률', display: '42%', size: 'small',
  rings: [{ value: 42, color: 'accent' }, { value: null, max: 200, label: '보조' }] }
```

- `rings`: 1–3개, 바깥쪽부터. `value`는 `0..max` 숫자이거나 `null`(알 수 없음)입니다. **`null`은 0이 아니라 "모름"**이라서 점선 트랙과 `—`로 표시합니다.
- `color`: `#rrggbb` 또는 `accent` `ok` `warn` `danger`
- `details`: hover·포커스·탭 시 뜨는 상세 팝오버. 행 1–12개, `updatedAt`(epoch ms)을 주면 "N초 전 업데이트됨"을 표시합니다.
- `stale: true`면 흐리게 표시하고 "오래된 데이터"를 알립니다.
- **IconSpec**: `viewBox`는 숫자 4개(너비·높이 1–512), `paths`는 1–8개, 각 `d`는 8,192자 이하 SVG path 문자만 허용합니다. 호스트가 이 값만으로 `<svg aria-hidden>`을 만들기 때문에 원시 SVG·HTML·URL·그라디언트·CSS는 받지 않습니다.

## 헤더(navbar) 항목

```js
await sdk.navbar.set('usage', {
  label: '사용 현황',
  view: { type: 'stack', id: 'root', direction: 'horizontal', children: [
    { type: 'gauge', id: 'main', label: '사용률', rings: [{ value: 42 }], display: '42%', size: 'small' } ] }
});
```

비대화형 노드(`stack` `grid` `text` `badge` `divider` `progress` `stat` `gauge` `icon`)만 허용합니다. 버튼·폼·입력·탭·표·목록·코드·알림·카드는 거부됩니다. 노드 60개, 깊이 4, 직렬화 32 KiB 한도이고, 슬롯 폭은 `min(40%, 160px)`로 제한되어 제목이 항상 우선합니다.

## 잘 만드는 규칙

1. **상태를 모두 설계**하세요: 초기 안내, 로딩, 빈 목록, 성공, 실패, 비활성.
2. **상태는 Worker에, 표현은 view에**. 순수한 `view(state)` 함수를 두고 이벤트에서 상태를 바꾼 뒤 `ui.update` 하세요.
3. **ID를 안정적으로** 붙이세요. 구조와 의미에 따라 붙이면 입력값과 포커스가 유지됩니다.
4. 접근성의 틀(label, 표 구조, 탭 키보드 탐색, 오류 라이브 영역, 모달 포커스 트랩)은 앱이 줍니다. **설명 문구와 버튼 문구는 작성자 몫**입니다.
5. 큰 표를 중첩 카드 안에 넣지 마세요. 긴 코드와 표는 내부 스크롤합니다.
6. 폼 입력은 민감할 수 있습니다. 로그에 무작정 출력하지 마세요.
7. HTML 문자열은 안 됩니다. 앱의 권한 승인창처럼 보이게 위장하는 것도 막혀 있습니다.

## 지원하지 않는 것

임의 Svelte·React 컴포넌트, 자체 CSS, 웹 콘텐츠 iframe, 차트 캔버스, 파일·드래그 앤 드롭, 원격 데이터 요청(`http` 권한 제외). 새 컴포넌트가 필요하면 타입이 있는 스키마, 검증기, 렌더러, 접근성, 보안 검토를 함께 추가해야 합니다.

저장소 `client/examples/extensions/ui-workbench.*`가 거의 모든 노드를 쓰는 실행 예제입니다.
