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
(좌표는 `client/src/lib/faces.ts`와 같고, `at` 오프셋 없이 눈 영역 중심을 항상 줄기 중심에 맞춘다.)

## 다시 만들기

```
python3 logo/build.py
```

기하를 바꿀 땐 `build.py`와 `index.html` 두 곳을 같이 고친다.

## 미리보기

```
cd logo && python3 -m http.server 4747 --bind 0.0.0.0
```

## 아직 적용하지 않은 것

- `client/src/lib/faces.ts`
- `client/src-tauri/app-icon.svg` → `app-icon.png` → `client/scripts/make-icons.py`
