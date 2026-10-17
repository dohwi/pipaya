# pipaya logo

pi agent + papaya. 파파야 나무 줄기가 얼굴이고, 잎 5장과 열매 2개가 달려 있다. 128 그리드의 평면 기하 도형이다.

```
logo/
├─ index.html   미리보기 (표정 8종 · 깜빡임 · 다크/라이트 · 앱 아이콘 타일)
├─ build.py     svg/ 생성기 (기하의 기준)
└─ svg/
   ├─ pipaya.svg · pipaya-light.svg          투톤 (다크/라이트 배경용)
   ├─ pipaya-mono.svg                        단색, currentColor
   ├─ pipaya-animated.svg · -mono-animated   눈 깜빡임 (3초, 0.8s/1.9s 두 번)
   ├─ app-icon.svg                           1024×1024 앱 아이콘 마스터
   └─ faces/<표정>.svg · <표정>-mono.svg     표정 8종
```

표정: block · slit · pixel · happy · focus · curious · wink · sleepy
(표정 시안용이다. 앱에서는 눈 없는 `PipayaMark`를 쓰며 `client/src/lib/faces.ts`는 삭제했다. `at` 오프셋 없이 눈 영역 중심을 항상 줄기 중심에 맞춘다.)

## 다시 만들기

```
python3 logo/build.py
```

기하를 바꿀 땐 `build.py`와 `index.html` 두 곳을 같이 고친다.

## 미리보기

```
cd logo && python3 -m http.server 4747 --bind 0.0.0.0
```

## 앱 적용 상태 (정사각 크라운 마크)

- 마크 기하의 기준은 `build_mark.py`. 양쪽 잎을 수평 아래로 늘어뜨려 크라운을 1:1에 가깝게 만들고 열매를 키웠다.
- 사이드바·레일·빈 화면·QR 등은 `client/src/components/PipayaMark.svelte` (`build_mark.py`와 같은 값). 단색이던 곳은 단색, `color`인 곳은 투톤 그대로.
- 파비콘(`client/public/favicon*`)과 문서 사이트(별도 저장소 `wiki`의 `public/img/`)는 같은 마크. 파비콘은 단색 `#111`.
- 앱 아이콘은 크림 타일(`#fbf3e2`) + 라이트 팔레트 컬러 나무. 크라운이 타일 폭의 86%, 줄기는 타일 아래로 흘러 나간다.
- 알림 아이콘(안드로이드 상태 표시줄)은 나무 전체 실루엣(`app-icon-mark.svg`).

### 다시 만들기

```
python3 logo/build_mark.py                  # logo/svg/ 의 mark*, favicon, app-icon* SVG
cd client && bun scripts/render-icons.ts    # SVG -> src-tauri/app-icon*.png, public/favicon*
python3 scripts/make-icons.py               # OS별 아이콘 세트 (데스크톱·안드로이드·iOS·apple-touch)
```

`PipayaMark.svelte`과 문서 사이트의 `public/img/`(별도 `wiki` 저장소)는 `build_mark.py` 값을 바꿨을 때 직접 맞춘다.
`build.py`(표정 시안), `build_papaya.py`, `build_small.py`는 이전 시안 생성기 (`svg/papaya/`, `svg/small/`, `papaya.html`, `small.html`).
