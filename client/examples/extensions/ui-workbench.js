// Authoring source: build portable JSON via scripts/build-extension.cjs.
// No application imports or DOM access: the host renders this typed view tree.
const saved = await sdk.storage.get('draft');
let draft = { goal: '', style: 'review', tests: true, notes: '', ...(saved || {}) };
let count = 0;
let message = '목표와 옵션을 선택하면 입력창 초안을 만들 수 있습니다.';
let tone = 'info';

function view() {
  return {
    type: 'stack', id: 'workbench', gap: 'large', children: [
      { type: 'alert', id: 'notice', title: '사용자 확인 후 전송', text: message, tone },
      { type: 'grid', id: 'metrics', columns: 3, children: [
        { type: 'stat', id: 'drafts', label: '이번 실행의 초안', value: String(count), hint: '자동 전송하지 않습니다' },
        { type: 'stat', id: 'mode', label: '작성 모드', value: draft.style === 'review' ? '코드 리뷰' : '구현 계획' },
        { type: 'stat', id: 'validation', label: '테스트 검토', value: draft.tests ? '포함' : '제외' }
      ]},
      { type: 'tabs', id: 'pages', items: [
        { id: 'compose-tab', label: '초안 작성', children: [
          { type: 'card', id: 'draft-card', title: '목표에 맞춘 요청', description: '입력은 이 확장의 폼에만 전달됩니다. 저장한 초안은 이 클라이언트에만 남습니다.', children: [
            { type: 'form', id: 'draft-form', submitLabel: '입력창에 초안 넣기', children: [
              { type: 'input', id: 'goal', label: '작업 목표', value: draft.goal, placeholder: '예: 인증 흐름의 오류 처리 개선', required: true, minLength: 3, maxLength: 300 },
              { type: 'select', id: 'style', label: '작성 모드', value: draft.style, options: [ { value: 'review', label: '코드 리뷰' }, { value: 'plan', label: '구현 계획' } ] },
              { type: 'textarea', id: 'notes', label: '추가 제약 및 참고', value: draft.notes, rows: 4, placeholder: '호환성, 성능, 접근성 등', maxLength: 4000 },
              { type: 'checkbox', id: 'tests', label: '테스트·접근성·예외 상황까지 검토', checked: draft.tests }
            ]}
          ]}
        ]},
        { id: 'guide-tab', label: '검토 체크리스트', children: [
          { type: 'list', id: 'checklist', items: [
            { id: 'states', title: '상태별 화면', description: '로딩·빈 데이터·성공·오류·비활성', badge: 'UX' },
            { id: 'keyboard', title: '키보드와 스크린 리더', description: '라벨·포커스·탭 이동·오류 안내', badge: 'A11y' },
            { id: 'responsive', title: '작은 화면과 긴 콘텐츠', description: '모바일·줄바꿈·표 스크롤', badge: '반응형' }
          ]},
          { type: 'table', id: 'scope', caption: '확장 권한의 경계', columns: [ { id: 'feature', label: '기능' }, { id: 'access', label: '접근 범위' } ], rows: [
            { id: 'ui', cells: ['UI', '자신의 화면과 폼 값'] },
            { id: 'storage', cells: ['저장소', '자신의 로컬 JSON'] },
            { id: 'composer', cells: ['입력창', '초안 교체, 자동 전송 없음'] }
          ]},
          { type: 'code', id: 'sdk-sample', language: 'javascript', text: "await sdk.ui.update('workbench', nextView);" }
        ]}
      ]},
      { type: 'stack', id: 'actions', direction: 'horizontal', gap: 'small', children: [
        { type: 'button', id: 'reset', label: '저장 초안 초기화', variant: 'secondary' },
        { type: 'badge', id: 'local-only', text: '클라이언트 로컬', tone: 'neutral' }
      ]}
    ]
  };
}

await sdk.ui.registerPanel({ id: 'workbench', title: '초안 워크벤치', description: '폼·탭·표·목록을 조합한 확장 UI 예제', view: view() }, async event => {
  if (event.type === 'change') {
    draft[event.id] = event.value;
  } else if (event.type === 'submit' && event.id === 'draft-form') {
    draft = { ...draft, ...event.values };
    const task = draft.style === 'review' ? '코드를 리뷰해 주세요.' : '구현 계획을 작성해 주세요.';
    await sdk.composer.setText(`${draft.goal}\n${task}\n${draft.tests ? '테스트·접근성·예외 처리를 포함해 주세요.\n' : ''}${draft.notes}`);
    await sdk.storage.set('draft', draft);
    count++;
    message = '초안을 입력창에 넣었습니다. 전송 전에 내용을 확인하세요.';
    tone = 'success';
    await sdk.ui.update('workbench', view());
  } else if (event.type === 'action' && event.id === 'reset') {
    draft = { goal: '', style: 'review', tests: true, notes: '' };
    await sdk.storage.set('draft', draft);
    message = '저장한 초안을 초기화했습니다.'; tone = 'info';
    await sdk.ui.update('workbench', view());
  }
});

await sdk.ui.registerPanel({ id: 'quick-note', title: '빠른 요청 메모', placement: 'composer', view: {
  type: 'form', id: 'quick-form', submitLabel: '초안으로 사용', children: [
    { type: 'textarea', id: 'quick-text', label: '요청 메모', placeholder: '메시지로 보낼 내용을 작성하세요', rows: 2, required: true, maxLength: 4000 }
  ]
}}, async event => {
  if (event.type === 'submit') await sdk.composer.setText(String(event.values['quick-text']));
});

await sdk.commands.register({ name: 'workbench', description: '초안 워크벤치 열기' }, async () => sdk.ui.open('workbench'));
