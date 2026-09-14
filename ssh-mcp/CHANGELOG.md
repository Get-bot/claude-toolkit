# Changelog

사용자에게 보이는 변경만 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [SemVer](https://semver.org/lang/ko/)를 따릅니다. **0.x 동안은 minor 올림이 호환성을 깰 수 있습니다.** `npx -y @get-bot/ssh-mcp`처럼 버전을 지정하지 않고 등록한 클라이언트는 다음 세션부터 자동으로 새 버전을 받으므로, 호환성에 영향이 있는 항목은 아래에서 **굵게** 표시합니다.

## [Unreleased]

## [0.2.0] - 2026-09-14

### Added

- `ssh-mcp install <claude-code|claude-desktop>` — 클라이언트 등록을 대신 해 주는 서브커맨드. 운영체제와 클라이언트에 맞는 명령 형태(Windows의 `cmd /c` 감싸기 포함)를 고르고, Claude Code는 `claude mcp add`에 위임하며, Claude Desktop은 설정 파일을 백업한 뒤 원자적으로 병합한다. 옵션: `--name`, `--scope local|user|project`, `--home`, `--config`, `--force`, `--dry-run`. 종료 코드 0/1/2, 출력은 stderr.
- `install claude-code`에서 `--scope`를 생략하고 터미널에서 실행하면 현재 디렉터리를 보여주며 local(이 프로젝트만)과 user(모든 프로젝트) 중 하나를 고르게 한다. 터미널이 아니면 Claude Code 기본값 local로 진행하고 안내 한 줄을 남긴다.
- 방향키 메뉴. `↑`/`↓`(또는 `k`/`j`)로 이동, `Enter`로 확정, 숫자 키로 즉시 선택한다. Node 내장 기능만 쓰며 런타임 의존성은 늘지 않았다. stdin과 stderr가 **모두** 터미널일 때만 그리고, 아니면 같은 질문을 텍스트로 묻는다.
- `install`을 클라이언트 없이 터미널에서 실행하면 Claude Code / Claude Desktop / 둘 다 중에서 고를 수 있다. 각 항목에 감지 결과(`PATH`의 `claude`, Desktop 설정 폴더)를 힌트로 붙이지만 감지 실패가 선택을 막지는 않는다. 터미널이 아니면 추측하지 않고 사용법 오류로 끝낸다.
- `setup`을 인자 없이 터미널에서 실행하면 호스트 주소·사용자명·포트·alias·승인 모드·라벨을 하나씩 물어본다. 답은 명령행 인자로 바뀌어 기존 경로로 들어가므로 이후 동작은 인자를 직접 준 것과 같다. 이미 등록된 alias는 재질문하며 `--force`를 대신 적용하지 않는다.
- `setup` 완료 안내와 `doctor` 표 출력 끝에 `install` 안내 한 줄. `doctor --json`은 변경 없음.
- `ssh-mcp host` 그룹. 하위 명령 없이 실행하면 `add`/`list` 사용법을 stderr에 내고 종료 코드 2.
- `ssh-mcp host add` — `setup`의 새 이름. 무엇을 설정하는지 이름에 드러내기 위한 것이며 **`ssh-mcp setup`은 별칭으로 계속 동작합니다**(경고도 출력하지 않습니다). 하위 명령 없이 `ssh-mcp host`만 치면 그룹 사용법을 출력하고 종료 코드 2.
- `ssh-mcp host list` — 등록된 호스트를 alias·접속 대상·승인 모드·승인 폴백·지문 접두 16자·라벨 표로 stdout에 출력한다. 개인키 경로와 지문 전문은 `list_hosts` 도구와 마찬가지로 출력하지 않는다. `--json`은 그 도구와 같은 필드 구성이며 **빈 레지스트리에서도 `{"hosts": [], "count": 0}`** 을 내므로 스크립트가 분기 없이 파싱할 수 있다. 표 모드에서만 빈 레지스트리를 안내 한 줄로 대신한다. 두 경우 모두 종료 0, 깨진 `hosts.json`은 `config_invalid`와 종료 1. `--help`는 사용법을 stdout에 내고 종료 0, 모르는 옵션은 stderr와 종료 2.
- 이 CHANGELOG.

### Changed

- 승인 창(elicitation) 메시지 마지막 줄과 체크박스 제목에 "스페이스로 체크(☑)한 뒤 Accept" 안내를 넣었다. Claude Code는 필수 boolean 필드를 체크되지 않은 체크박스로 그리고 체크 없이 Accept를 누르면 "This field is required"로 제출을 막기 때문에, 안내가 없으면 승인이 안 되는 것처럼 보였다. `confirm: true` 요구 자체는 그대로다.
- README 설치 절을 `install → setup → doctor` 빠른 시작으로 재구성했다. 인자 없는 `npx -y @get-bot/ssh-mcp`는 클라이언트가 띄우는 서버 기동 명령임을 명시했다. 빠른 시작은 이제 인자 없는 `install`·`setup`을 보여주고, 인자를 주는 형태는 스크립트용으로 함께 적었다.
- `install`의 usage가 클라이언트를 선택 인자로 표시한다(`install [claude-code|claude-desktop]`). **인자를 준 호출의 동작은 바뀌지 않았다.**
- 사용자에게 보이는 문자열에서 실행할 명령으로서의 `setup`을 `host add`로 바꿨다(usage, 오류 메시지, `doctor`의 "등록된 호스트가 없습니다" 안내 등). 내부 식별자와 `src/setup/` 디렉터리 이름은 그대로다.
- WSL(리눅스)과 Windows 네이티브에서 같은 동작을 보장한다. 메뉴는 `readline`이 정규화한 키 이름만 쓰고, `TERM=dumb`이거나 stderr가 터미널이 아니면 같은 질문을 텍스트로 묻는다. WSL에서는 `process.platform`이 `linux`라 감싸지 않은 `npx`로 등록하며, Claude Desktop은 "감지되지 않음(WSL에서는 Windows의 설정에 접근하지 않습니다)"으로 표시하되 선택은 막지 않는다.
- README의 Windows `cmd /c` 요구를 "셸 없이 서버를 스폰하는 호스트(Claude Desktop 등)"로 한정했다. Claude Code 2.1.270(Windows 11)에서는 감싸지 않은 `npx`로도 연결됨을 실측했다.
- `package.json`의 `bin` 경로를 npm 정규형(`dist/index.js`)으로 맞춰 publish 시 경고를 없앴다. 동작 변화는 없다.

### Fixed

- `host add`가 존재하지 않는 호스트에도 비밀번호를 받고 Windows ACL을 적용하고 키 쌍까지 만든 뒤에야 실패하던 문제. 이제 **비밀번호를 묻기 전에** 해당 host:port로 TCP 연결을 5초 안에 확인하고, 실패하면 사유("호스트 이름을 찾을 수 없습니다" 등)와 함께 아무것도 만들지 않고 끝냅니다. 위저드에서는 주소를 다시 묻고 3회 연속 실패하면 중단합니다. 이 확인은 TCP까지만 하며 지문 확인·비밀번호 전송 순서는 그대로입니다.
- 라벨에 제어 문자를 넣으면 `host list` 출력으로 그대로 나가던 문제. 위저드와 `--label` 양쪽에서 거부하고, 표를 그릴 때도 남아 있는 제어 문자를 `?`로 바꿔 출력합니다(예전 파일에 든 값 대비).
- 메뉴가 끝난 뒤 텍스트 질문에 입력한 내용이 다음 메뉴에서 재생돼 아무 키도 누르지 않았는데 확정되던 문제. 듣는 프롬프트가 없을 때 쌓인 키의 만료 예약이 구독 해제 시점에만 걸려 있었습니다.
- 위저드의 호스트 주소·사용자명 질문이 제어 문자를 그대로 받아들이던 문제. 텍스트 질문에서 방향키를 누르면 `\x1b[B`가 호스트 이름으로 통과해 화면이 흐트러진 채 연결 확인까지 갔습니다. 이제 제어 문자와 공백을 거르고 호스트명/IPv4/IPv6 형식인지도 확인합니다.
- 좁은 창에서 메뉴가 한 줄씩 밀리며 제목이 누적되던 문제. 한글 제목은 표시 폭이 80칸을 넘어 두 물리 줄로 접히는데 커서는 논리 줄 수만큼만 올라갔습니다. 이제 모든 행을 창 너비에 맞춰 자르고(넘치면 `…`), 조작 안내는 제목에서 분리해 별도 줄로 내렸으며, 감지된 경로는 `~`로 줄여 보여줍니다.
- 메뉴가 연달아 뜰 때 두 번째 메뉴가 키를 받지 못하고 멈추던 문제(`install`의 클라이언트 메뉴 → scope 메뉴). 터미널이 키 여러 개를 한 덩어리로 보내면 `readline`이 그것을 한 번에 여러 이벤트로 바꾸는데, 첫 메뉴가 자기 키에 확정하면서 구독을 끊어 나머지 키가 사라졌다. 이제 듣는 프롬프트가 없는 동안 들어온 키를 버퍼에 담아 다음 프롬프트에 넘긴다. WSL pty에서 재현·수정 확인.
- 0.1.0의 도구 7개와 승인·분류·감사 동작은 그대로다.

## [0.1.0] - 2026-09-14

첫 공개 릴리스. npm `@get-bot/ssh-mcp@0.1.0`.

### Added

- 도구 7개: `list_hosts`, `exec`, `upload`, `download`, `open_session`, `run_in_session`, `close_session`.
- 명령 3등급 분류(safe / privileged / destructive, 정규식 68개 + argv 규칙 13개, 2-pass)와 호스트별 `patternOverrides`.
- 호스트별 승인 모드 `auto` / `ask-destructive` / `ask-all` / `deny`. elicitation 지원 클라이언트에는 확인창, 미지원 클라이언트에는 `setup`에서 기본값 없이 강제 선택하는 `approvalFallback`(`token` | `fail-closed`).
- `exec`·`run_in_session`의 `_meta.anthropic/requiresUserInteraction`으로 Claude Code의 always-allow 무력화. `SSH_MCP_REQUIRE_USER_INTERACTION=0`으로 해제 가능.
- `ssh-mcp setup`: 비밀번호 1회 입력으로 ed25519 키 생성·설치·키 전용 재접속 검증·호스트 키 지문 핀 고정. Windows에서는 키 디렉터리 `icacls` 하드닝.
- `ssh-mcp doctor`: 15개 항목 진단, `--json`, `--patterns`.
- 대화형 프로그램 조기 거부(무조건 21종, 조건부 13종), `~/.ssh-mcp` 경로 하드 블록, 출력 발췌(head/tail), 바이너리 base64, `sudo_password_required` 번역, 백그라운드 작업 경고.
- append-only JSONL 감사 로그(호출당 1줄, 10 MiB × 4 회전, 출력 본문 미기록).
- 원격 셸 지원: `bash`, `zsh`, `sh`/`dash`, busybox `ash`. `fish`·`cmd`·PowerShell은 `open_session` 미지원(`exec`는 동작).

[Unreleased]: https://github.com/Get-bot/claude-toolkit/compare/ssh-mcp-v0.2.0...HEAD
[0.2.0]: https://github.com/Get-bot/claude-toolkit/compare/ssh-mcp-v0.1.0...ssh-mcp-v0.2.0
[0.1.0]: https://github.com/Get-bot/claude-toolkit/releases/tag/ssh-mcp-v0.1.0
