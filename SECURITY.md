# Security Policy

**English** · [한국어](#한국어)

## English

### Reporting a vulnerability

Please **do not open a public issue** for a security problem.
Report it privately through GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/dohwi/pipaya/security/advisories/new>).

Include the affected version or commit, steps to reproduce, and the impact you observed.

### Supported versions

Only the latest commit on `main` and the newest stable release (`latest`) receive fixes.

### Threat model

- The bearer token is an **administrator credential**. Anyone holding it can run commands as the server user through the agent tools. Expose the server only on a private network (for example Tailscale) or behind HTTPS; it listens on loopback unless `PIPAYA_HOST` says otherwise. Wrong tokens are throttled per address (20 different ones a minute), which slows guessing but does not replace a strong token.
- Pairing a phone by QR gives that phone **its own token** (stored only as a hash), not the administrator token. A paired device cannot pair other devices, manage tokens, install server extensions, reconfigure MCP servers or update the server, and the administrator can revoke one device at a time (Settings → Devices), which also closes its open connections; a device that has not connected for 90 days (`PIPAYA_DEVICE_TOKEN_IDLE_DAYS`) is revoked by itself. That is a limit on the API, **not on the machine**: a paired device can still run the agent's tools and open terminals as the server user, so it can read whatever that user can, the administrator token file included. Pair only devices you would hand the server to.
- The `bash` tool and the other tools run without asking and are **not sandboxed**. File tools and file previews are not confined to the working directory either: any path the server user can reach is reachable. Run the server in the Docker sandbox (`compose.yaml`) or under a dedicated user if the model or its inputs are not fully trusted. The container limits the damage but is not a complete boundary: it can still reach the network and fully controls its mounted workspace. `PIPAYA_RESTRICT_WORKSPACE=1` keeps the folder picker, session folders and terminals inside `PIPAYA_WORKSPACE`, but it is a convenience, not a boundary: the agent's tools still reach every path the server user can.
- Updates: the desktop app verifies a signature on what it downloads. The server's self-update follows the `latest` tag, and only installs a commit that lies on the protected `main` branch, so moving the tag alone cannot ship other code. That rests on GitHub and on the branch protection of this repository; it is not a signature, and a compromise of `main` itself is not covered.
- Model API keys are stored **unencrypted** in `pipaya.db`. Protect the data directory (`~/.pipaya`, mode `0700`) and its backups.
- Model connection URLs are fetched by the server, including private-network addresses. Register only endpoints you trust.
- Client extensions run in an isolated Worker without network access and communicate through permission-checked messages; an extension that you approve for a permission can use that permission.
- An extension's own requests (`network`) reach public addresses only; this machine, the LAN and the tailnet need the separate `network-local` permission, and redirects are checked hop by hop. Only the URL is checked, so a public name that resolves to a private address is not caught.
- The installed client extensions and their on/off states are shared through the server, but a device runs a package only after the user switched those exact contents on **on that device**. Extensions with `ui-components` run inside the app with access to its data, the server tokens included: approve them only from authors you trust.
- The API is plain HTTP. On a network you do not fully control, bind the server to a private interface only (for example `PIPAYA_HOST=<tailscale IP>`) or put it behind HTTPS.

## 한국어

### 취약점 제보

보안 문제는 **공개 이슈로 올리지 마세요.**
이 저장소의 **Security → Report a vulnerability**
(<https://github.com/dohwi/pipaya/security/advisories/new>)로 비공개 제보해 주세요.

영향받는 버전 또는 커밋, 재현 절차, 확인한 영향을 함께 적어 주세요.

### 지원 범위

`main`의 최신 커밋과 최신 정식 릴리스(`latest`)만 수정 대상입니다.

### 위협 모델

- Bearer 토큰은 **관리자 자격 증명**입니다. 토큰을 가진 사람은 에이전트 도구를 통해 서버 사용자 권한으로 명령을 실행할 수 있습니다. 사설 네트워크(예: Tailscale) 또는 HTTPS 뒤에서만 노출하세요. `PIPAYA_HOST`를 지정하지 않으면 루프백에서만 수신합니다. 잘못된 토큰은 주소별로 제한되지만(1분에 서로 다른 20개) 추측을 늦출 뿐 강한 토큰을 대신하지는 않습니다.
- QR로 연결한 휴대폰은 관리자 토큰이 아닌 **기기 전용 토큰**(해시만 저장)을 받습니다. 연결된 기기는 다른 기기 연결, 토큰 관리, 서버 확장 설치, MCP 서버 설정 변경, 서버 업데이트를 할 수 없고, 관리자는 기기별로 접속을 취소할 수 있으며(설정 → 기기) 그 기기의 열린 연결도 함께 끊깁니다. 90일 동안 접속하지 않은 기기(`PIPAYA_DEVICE_TOKEN_IDLE_DAYS`)는 자동으로 취소됩니다. 다만 이것은 API에 대한 제한이지 **컴퓨터에 대한 제한이 아닙니다**. 연결된 기기도 서버 사용자 권한으로 에이전트 도구를 실행하고 터미널을 열 수 있으므로, 관리자 토큰 파일을 포함해 그 사용자가 읽을 수 있는 것은 모두 읽을 수 있습니다. 서버를 맡겨도 되는 기기만 연결하세요.
- `bash` 도구를 비롯한 모든 도구는 묻지 않고 실행되며 **샌드박스되지 않습니다**. 파일 도구와 파일 미리보기도 작업 폴더 안으로 제한되지 않아, 서버 사용자가 접근할 수 있는 경로는 모두 접근됩니다. 모델이나 입력을 완전히 신뢰할 수 없다면 Docker 샌드박스(`compose.yaml`)나 전용 사용자로 서버를 실행하세요. 컨테이너는 피해 범위를 줄일 뿐 완전한 경계가 아닙니다. 네트워크에는 여전히 접근할 수 있고, 마운트된 작업 폴더는 완전히 제어합니다. `PIPAYA_RESTRICT_WORKSPACE=1`은 폴더 선택기, 세션 작업 폴더, 터미널을 `PIPAYA_WORKSPACE` 안으로 제한하는 편의 기능일 뿐 보안 경계가 아닙니다. 에이전트 도구는 여전히 서버 사용자가 접근할 수 있는 모든 경로에 접근합니다.
- 업데이트: 데스크톱 앱은 내려받은 파일의 서명을 검증합니다. 서버의 자체 업데이트는 `latest` 태그를 따르되, 보호된 `main` 브랜치 위에 있는 커밋만 설치하므로 태그만 옮겨서는 다른 코드를 배포할 수 없습니다. 이는 GitHub와 이 저장소의 브랜치 보호에 기대는 것이며 서명이 아닙니다. `main` 자체가 침해된 경우는 막지 못합니다.
- 모델 API 키는 `pipaya.db`에 **암호화되지 않은 채** 저장됩니다. 데이터 디렉터리(`~/.pipaya`, `0700`)와 백업을 보호하세요.
- 모델 연결 URL은 사설 네트워크 주소를 포함해 서버가 직접 요청합니다. 신뢰하는 엔드포인트만 등록하세요.
- 클라이언트 확장은 네트워크가 차단된 격리 Worker에서 실행되고 권한이 검사되는 메시지로만 통신합니다. 다만 사용자가 승인한 권한은 확장이 그대로 사용할 수 있습니다.
- 확장이 직접 보내는 요청(`network`)은 공개 주소에만 닿습니다. 이 컴퓨터, LAN, Tailscale 주소에는 별도의 `network-local` 권한이 필요하고, 리디렉션도 단계마다 검사합니다. 다만 URL만 검사하므로, 공개 도메인이 사설 주소로 연결되는 경우까지는 막지 못합니다.
- 설치된 클라이언트 확장 목록과 켜짐 상태는 서버를 통해 공유되지만, 각 기기는 **그 기기에서** 사용자가 같은 내용의 패키지를 직접 켠 뒤에만 실행합니다. `ui-components` 권한을 가진 확장은 앱 안에서 실행되어 서버 토큰을 포함한 앱의 데이터에 접근할 수 있으니, 신뢰하는 개발자의 확장만 승인하세요.
- API는 평문 HTTP입니다. 완전히 통제하지 않는 네트워크에서는 사설 인터페이스에만 바인드하거나(예: `PIPAYA_HOST=<Tailscale IP>`) HTTPS 뒤에 두세요.
