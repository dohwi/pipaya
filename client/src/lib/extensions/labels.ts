import { msg } from "../i18n";
import type { ExtensionPackage, Permission } from "./schema";

/** What an extension package brings, as labels for its card (Korean source strings, translated where shown). */
export const featuresOf = (pkg: ExtensionPackage): string[] => [pkg.theme ? msg("테마") : "", pkg.commands?.length ? msg("템플릿 명령") : "", pkg.locales?.length ? msg("언어팩") : "", pkg.code?.trim() ? msg("실행 코드") : "", pkg.styles ? msg("앱 스타일") : "", pkg.components ? msg("앱 컴포넌트") : "", pkg.assets ? msg("디자인 파일") : ""].filter(Boolean);

/** What each permission lets an extension do, as the sentence shown in the consent dialog. Every permission needs one. */
export const permissionLabels: Record<Permission, string> = {
		commands: msg("명령 등록: 슬래시 명령을 추가합니다."),
		composer: msg("입력창 접근: 입력 내용을 채우거나 입력창 버튼을 추가합니다."),
		status: msg("상태 표시: 화면에 상태 항목을 표시합니다."),
		context: msg("대화 정보: 세션 ID, 모델, 제공자와 실행·연결 상태를 읽습니다."),
		storage: msg("로컬 저장소: 확장 전용 데이터를 이 브라우저에 저장합니다."),
		notifications: msg("알림: 화면에 알림을 표시합니다."),
		locales: msg("언어팩: 이 확장이 담은 번역을 설정의 언어 목록에 추가하고, 서버에 올려 다른 기기에서도 쓸 수 있게 합니다."),
		"system-notifications": msg("시스템 알림: OS·모바일 푸시 알림을 보내고 앱이 닫혀 있어도 작업·승인 이벤트 알림을 등록합니다. 알림 문구가 OS와 푸시 제공자에 전달됩니다."),
		events: msg("이벤트 구독: 대화와 작업 상태 변경 이벤트를 받습니다."),
		ui: msg("확장 화면: 패널·폼·입력창 위젯을 표시하고, 사용자가 입력한 해당 화면의 값을 받습니다."),
		navbar: msg("내비게이션: 상단 영역에 읽기 전용 확장 항목(아이콘·텍스트·진행률)을 표시합니다."),
		configuration: msg("설정 내보내기·가져오기: 앱 승인 후 서버 주소·확장 패키지·비민감 설정에 접근합니다. 가져온 코드는 자동 실행하지 않습니다."),
		"configuration-background": msg("자동 설정 접근: 최초 승인 후 비민감 설정을 반복해서 읽고 일반 설정을 자동 적용합니다. 확장 코드 변경은 추가 승인이 필요합니다."),
		"http-write": msg("HTTP JSON 읽기·쓰기: 사용자 설정의 httpOrigin으로 요청하고 선택적인 httpToken을 Bearer 인증으로 사용합니다."),
		server: msg("서버 확장 연결: 서버에서 실행되는 확장의 메서드를 호출하고, 그 확장이 저장한 대화별 기록과 보낸 이벤트를 읽습니다."),
		shortcuts: msg("단축키 등록: Ctrl/⌘ 또는 Alt가 들어간 키 조합을 추가합니다. 앱의 기본 단축키는 바꿀 수 없습니다."),
		dialogs: msg("대화상자: 확인·선택·입력 창을 띄워 사용자에게 묻습니다."),
		session: msg("대화 제어: 열려 있는 대화에 메시지를 보내거나 실행을 중지합니다. 보낸 메시지는 에이전트가 실행합니다."),
		panes: msg("패널 제어: 열려 있는 그룹의 대화·터미널을 읽고, 메시지를 보내고, 모델·추론 강도를 바꾸고, 만들고 닫고, 배치를 바꿉니다. 보낸 메시지는 에이전트가 실행하고 터미널을 닫으면 실행 중인 작업이 끝납니다."),
		tools: msg("도구 결과 표시: 도구 호출 결과를 확장이 만든 화면으로 대신 보여줍니다. 결과 내용을 읽습니다."),
		messages: msg("기록 표시: 서버 확장이 대화에 남긴 기록을 대화 중간에 카드로 보여줍니다. 기록 내용을 읽습니다."),
		slots: msg("화면 영역: 헤더 아래와 입력창 위에 읽기 전용 항목을 표시합니다."),
		"composer-filter": msg("보내기 전 가공: 보내려는 메시지를 읽고, 바꾸거나 전송을 막을 수 있습니다. 입력한 내용이 확장 코드에 전달됩니다."),
		"session-labels": msg("대화 라벨: 사이드바와 대화 헤더의 제목 앞에 짧은 라벨을 붙입니다. 대화 목록을 읽지는 않습니다."),
		"composer-mentions": msg("@ 자동완성: 입력창의 @ 완성 목록과 강조를 확장이 정합니다. 입력 중인 내용은 읽지 않습니다."),
		"ui-style": msg("앱 전체 스타일: 앱 화면 전체에 CSS를 적용해 기존 디자인을 바꿉니다. 화면을 가리거나 다른 화면처럼 꾸밀 수 있습니다."),
		"ui-components": msg("앱 안에서 컴포넌트 실행(고위험): 확장의 Svelte 코드가 격리 없이 앱 안에서 실행되어 화면을 원하는 위치에 그리거나 기존 화면을 교체합니다. 대화 내용, 서버 연결 정보와 토큰 등 앱의 모든 데이터에 접근할 수 있습니다. 신뢰하는 개발자의 확장만 허용하세요."),
		http: msg("HTTP 읽기: extension이 설정한 서버 주소로 GET 요청을 보내 JSON을 읽습니다 (자격 증명 미전송)."),
	};
