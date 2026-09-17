# Changelog

사용자에게 보이는 변경만 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [SemVer](https://semver.org/lang/ko/)를 따릅니다. **0.x 동안은 minor 올림이 호환성을 깰 수 있습니다.** `npx -y @get-bot/ssh-mcp`처럼 버전을 지정하지 않고 등록한 클라이언트는 다음 세션부터 자동으로 새 버전을 받으므로, 호환성에 영향이 있는 항목은 아래에서 **굵게** 표시합니다.

## [0.3.0] - 2026-09-17

### Added

- **`history` 도구.** 감사 로그를 최신순으로 읽습니다. `host`·`since`·`until`·`grade`·`tool`·`outcome`으로 거르고, `limit`은 기본 50·최대 200이며, `cursor`로 페이지를 넘깁니다. 페이지가 끝났는지는 `next_cursor === null`로 판단합니다 — 한 번의 호출이 훑는 줄 수에 상한이 있어, 조건에 맞는 줄이 없는 빈 페이지가 아직 non-null인 커서와 함께 올 수 있기 때문입니다. 승인은 필요 없고 읽기 전용입니다. 감사 로그가 회전해 커서가 가리키던 자리를 승계할 수 없으면 `history_cursor_stale`로 알리며, 이때는 `cursor` 없이 다시 조회합니다.
- **`fetch_output` 도구.** 발췌에서 잘려 나간 출력 전문을 페이지 단위로 읽습니다. 입력은 `{output_ref, cursor?, max_bytes?}`(기본 64 KiB, 최소 1 KiB, 최대 1 MiB), 출력은 `{chunk, encoding, offset, next_cursor, total_bytes}`입니다. 보관은 **서버 메모리에만** 하고 디스크에 쓰지 않으며, 수명은 10분, 전체 상한은 64 MiB(초과 시 오래된 것부터 폐기), 스트림 하나당 상한은 호스트 `maxOutputBytes`의 4배(절대 상한 16 MiB)입니다. 돌려주는 조각에도 `exec` 응답과 같은 개인키 블록 마스킹이 걸립니다. 만료·폐기·서버 재시작 뒤의 조회는 `output_expired`이며, 그때는 명령을 다시 실행해야 합니다. `close_session`이나 세션 만료는 보관 출력을 폐기하지 않습니다 — 수명은 TTL만 따릅니다.
- `exec`와 `run_in_session`의 `format: "json"`. stdout을 파싱해 `parsed` 필드로 함께 돌려줍니다. 화이트리스트에 있는 단일 명령(`docker ps`·`docker images`·`docker container ls`·`docker inspect`, `systemctl list-units`·`list-timers`·`list-sockets`, `journalctl`, `lsblk`, `ip addr`·`link`·`route`)은 그 도구의 JSON 출력 플래그를 붙여 실행하고, JSON 모드가 없는 `df`와 `ps`는 고정 컬럼 형태로 정규화해 실행한 뒤 표를 갈라 냅니다. **정규화는 인자에도 미칩니다** — `df -h /var`는 `df -P /var`로(경로는 유지), `ps aux`와 `ps -p 123`은 둘 다 전체 프로세스 목록으로 실행됩니다. 명령에 파이프·리다이렉트·`;`·`&&`·서브셸이 있으면 재작성하지 않고 원문을 실행합니다. 어느 경우든 **분류·승인·감사·실행 대상은 모두 실제로 실행되는 그 문자열**이며, 승인 창에도 그것이 보입니다. 기본값은 `"text"`이고 이때는 응답에 `parsed`·`parse_error` 필드가 추가되지 않습니다.
- `ssh-mcp connect <alias>` — 등록된 호스트로 대화형 셸을 엽니다. `ssh-mcp exec <alias> -- <command...>`는 같은 접속으로 명령 하나를 실행하며 `--` 뒤는 그대로 전달합니다. 둘 다 시스템의 `ssh`에 위임하므로 **이 경로는 분류·승인·감사·발췌를 거치지 않고**, 호스트 키 확인도 OpenSSH의 `known_hosts` 기준이라 `ssh-mcp`가 등록할 때 확인한 지문과 다를 수 있습니다. `ssh`가 `PATH`에 없으면 운영체제별 설치 안내를 내고 종료 코드 1입니다.
- `ssh-mcp host add --from-ssh-config <Host>` — `~/.ssh/config`(`SSH_MCP_SSH_CONFIG`로 재지정 가능)에서 이름이 정확히 일치하는 `Host` 블록의 `HostName`·`Port`·`User`만 읽어 위저드 기본값으로 채웁니다. 값은 확인 단계에서 사람이 보고 고칠 수 있고, 키는 기존 것을 재사용하지 않고 전용 키를 새로 만듭니다. 와일드카드 `Host`·`Match`·`ProxyJump`/`ProxyCommand`가 걸린 블록은 부분 가져오기 없이 종료 코드 2이며, `Include`는 1단계까지만 따릅니다.
- `host add --alias <name>`과 `--port <n>`. 우선순위는 위저드 확인 답 > 명시한 플래그 > ssh_config에서 읽은 값입니다.
- `ssh-mcp help` — 명령어 목록. `--help`, `-h`도 같습니다. 사용할 수 있는 명령(`install`, `host add`, `host list`, `doctor`, `connect`, `exec`, `help`)과 인자 없이 실행하면 MCP 서버가 뜬다는 사실, 그리고 빠른 시작을 stdout에 내고 종료 코드 0으로 끝납니다. 빠른 시작은 `npm i -g @get-bot/ssh-mcp`로 시작합니다 — 한 번 설치하면 `npx -y @get-bot/ssh-mcp` 대신 `ssh-mcp`로 칩니다. README 설치 절도 같은 순서로 바꿨습니다(전역 설치 먼저, npx는 설치 없이 쓰는 대안). 클라이언트에 등록되는 서버 기동 명령은 그대로 npx 형태입니다.
- `ssh-mcp help <command> ...` — 해당 명령의 사용법으로 넘깁니다. `ssh-mcp help doctor`는 `ssh-mcp doctor --help`와 같은 출력이고, 뒤에 붙인 단어도 그대로 넘어가므로 `ssh-mcp help host add`는 `host` 그룹이 아니라 `host add`의 사용법입니다. 명령별 플래그는 각자의 usage 한 곳에만 있고 목록이 복사해 두지 않습니다. `help version`·`help help`는 목록을 냅니다. 없는 명령은 stderr 한 줄 + 목록 + 종료 코드 2.

### Changed

- **`exec`와 `run_in_session`의 응답에 필드가 늘었습니다.** `format: "json"`으로 부르면 `parsed`와 `parse_error`가 붙고, 출력이 잘린 호출에서는 `stdout_meta.output_ref`/`stderr_meta.output_ref`가 더 이상 항상 `null`이 아니라 `fetch_output`에 넘길 수 있는 값이 됩니다. `format`을 주지 않으면 `parsed`·`parse_error`는 붙지 않지만, `output_ref`는 이 릴리스에서 별도로 바뀌므로 0.2.1과 바이트 단위로 같지는 않습니다.
- **도구가 7개에서 9개로 늘었습니다**(`history`, `fetch_output` 추가). 기동 시 등록된 도구 수를 검증하는 단언도 그에 맞춰 바뀌었습니다. 기존 7개의 이름·입력·동작은 위 항목 외에는 그대로입니다.
- **`ssh-mcp setup`이 이제 경고를 냅니다** — `host add`로 이름이 바뀐 별칭이며 0.4.0에서 제거된다는 안내입니다. 동작 자체는 그대로이고, 경고는 stderr로 나가므로 stdout을 파이프로 받는 스크립트에는 섞이지 않습니다.
- **`host list --json`에 `reserved_alias` 필드가 생겼습니다.** 예약어(`install`·`host`·`doctor`·`setup`·`connect`·`exec`·`help`·`version`)와 같은 alias인 항목에만 `true`로 붙고, 그 외 JSON 구성은 `list_hosts` 도구의 응답과 같습니다. 표 모드에서는 같은 항목에 표시가 붙습니다. `host add`는 이제 이 이름들을 alias로 거부하지만, 이미 등록된 항목은 그대로 동작합니다.
- 승인 창의 체크박스가 `default: false`를 달고 나갑니다. 체크하지 않은 채 Accept를 누르면 전에는 "This field is required"로 제출이 막혀 Accept가 먹통 키처럼 보였는데, 이제는 창이 닫히면서 `confirm: false`가 와서 실행되지 않습니다 — 손대지 않는 것이 "실행하지 않겠다"는 답이 됩니다. 실행하려면 스페이스로 체크한 뒤 Accept를 눌러야 한다는 점은 그대로입니다(`confirm: true`만 승인). 체크박스 `description`도 그에 맞춰 "체크하지 않고 Accept를 누르면 실행하지 않습니다."로 바뀌었습니다.

- 감사 로그는 계속 한 파일에 씁니다. 프로세스를 분리해 쓰면 줄이 섞일 수 있다는 우려를 측정으로 확인했는데 — 자식 프로세스 2개가 각각 1000줄을 동시에 쓰는 시나리오를 Windows에서 11회 반복 — 섞인 줄이 0건이라, 파일을 `audit-<pid>`로 나누는 변경은 넣지 않았습니다.

### Fixed

- **타임아웃된 `exec`가 원격에 프로세스를 남기던 문제.** 지금까지는 시간이 다 되면 SSH 채널에 signal을 보내고 채널을 닫았는데, 실제 OpenSSH 서버는 세션 채널의 signal 요청을 무시하고 pty 없는 exec 채널이 닫혀도 자식 프로세스를 죽이지 않습니다. `sleep 37`에 1.5초 예산을 준 호출이 6초 넘게 살아 있었습니다. 이제 POSIX 원격에서는 명령을 감싸 원격 셸의 pid를 stdout 첫 줄로 받아 두고(그 줄은 응답에 닿기 전에 걷어내므로 바이트·줄 수 계산은 그대로입니다), 타임아웃 시 **별도 채널**에서 그 pid를 상대로 `pkill -P`와 `kill`을 TERM → 유예 → KILL 순으로 보냅니다. `pkill`이 없는 호스트에서는 `kill`만으로 축소하고 연결당 한 번 알립니다. `nohup`이나 `setsid`로 떼어 낸 프로세스는 여전히 살아남습니다. **이 결함은 v1을 인프로세스 픽스처로만 검증해서 놓친 것입니다** — 픽스처는 채널을 닫으면 자식도 죽는 것처럼 굴었고, 실제 `sshd`를 띄우는 테스트 티어를 붙이고 나서야 드러났습니다. Windows(`cmd`/`powershell`) 원격은 이 정리를 받지 않고 기존 동작 그대로입니다.
- **`ssh-mcp --help`가 도움말 대신 서버를 띄우던 문제.** `help`·`--help`·`-h` 셋 다 라우터를 그냥 통과해 서버 모드로 떨어졌습니다. 터미널에서 치면 아무것도 출력하지 않고 stdin을 기다리며 멈춰 있었습니다 — 프로그램에 무엇을 할 수 있냐고 물었을 때 침묵과 멈춘 터미널이 돌아온 셈입니다. 하위 명령들은 이미 각자 `--help`를 갖고 있었고 최상위에만 없었습니다.
- `ssh-mcp install --help`와 `ssh-mcp host add --help`(`setup --help`)가 사용법을 stderr에 쓰던 문제. 종료 코드는 0이었지만 `| less`나 `> 파일`로 받으면 비어 있었습니다. `host`·`host list`·`doctor`가 이미 따르는 규약("요청한 출력은 오류가 아니므로 stdout")대로 옮겼습니다. 그 밖의 출력 — 진행 메시지, 오류, 사용법 오류 — 은 그대로 stderr입니다.

## [0.2.1] - 2026-09-15

### Fixed

- **승인 창이 정작 승인 대상인 명령을 보여주지 않던 문제.** Claude Code는 elicitation 메시지의 첫 세 줄만 그리고 나머지를 `… (+N more lines)`로 접는데, 이 접힌 부분은 펼칠 수 없습니다. 메시지가 아홉 줄이었고 명령 전문이 일곱째 줄이라, 사람이 보는 것은 호스트와 도구뿐이었습니다. 즉 "이 명령을 실행할까요"라고 물으면서 "이 명령"을 가리고 있었습니다. 이제 메시지는 세 줄이며 첫 줄이 명령 전문, 둘째 줄이 호스트와 도구, 셋째 줄이 등급과 사유입니다. 분류 사유가 길면 셋째 줄이 접히지 않도록 `외 N개`로 세어 줄입니다(전체 목록은 감사 로그의 `reasons`에 그대로 남습니다).
- 체크박스 제목이 잘려 정작 눌러야 할 `Accept`가 사라지던 문제. 0.2.0에서 넣은 안내 `이 명령을 실행합니다 (스페이스로 체크한 뒤 Accept)`는 50칸이라 46칸 근처에서 잘렸고, 같은 안내를 담은 메시지 마지막 줄은 위의 접힘에 가려 아무도 읽을 수 없었습니다. 제목을 `스페이스로 체크 후 Accept`(25칸)로 줄여 눌러야 할 키를 앞에 두었고, 자세한 설명은 스펙이 그 용도로 둔 `description` 필드로 옮겼습니다. **0.2.0의 같은 항목을 대체합니다.**

### Changed

- elicitation 요청에 `mode: "form"`을 명시합니다. 선택 필드이고 form이 기본값이라 동작은 같지만, 이 게이트가 쓸 수 있는 모드는 form뿐이라는 것(URL 모드는 사람이 브라우저에서 답하므로 도구 호출이 기다릴 수 없습니다)과 폼으로 비밀번호 같은 비밀을 받지 않는다는 규칙을 코드에 남겨 둡니다.
- 승인 창의 체크박스에 `description`을 붙였습니다. 제목이 짧아야 잘리지 않으므로, 체크 없이 Accept를 누르면 제출되지 않는다는 설명은 이쪽으로 옮겼습니다. 클라이언트가 이 필드를 그리지 않을 수도 있어 제목만으로도 뜻이 통하게 두었습니다.
- `confirm: true` 요구, 승인 판정, 토큰 발급, 감사 기록은 전부 그대로입니다. 바뀐 것은 사람이 보는 화면뿐입니다.

## [0.2.0] - 2026-09-14

### Added

- `ssh-mcp install <claude-code|claude-desktop>` — 클라이언트 등록을 대신 해 주는 서브커맨드. 운영체제와 클라이언트에 맞는 명령 형태(Windows의 `cmd /c` 감싸기 포함)를 고르고, Claude Code는 `claude mcp add`에 위임하며, Claude Desktop은 설정 파일을 백업한 뒤 원자적으로 병합한다. 옵션: `--name`, `--scope local|user|project`, `--home`, `--config`, `--force`, `--dry-run`. 종료 코드 0/1/2, 출력은 stderr.
- `install claude-code`에서 `--scope`를 생략하고 터미널에서 실행하면 현재 디렉터리를 보여주며 local(이 프로젝트만)과 user(모든 프로젝트) 중 하나를 고르게 한다. 터미널이 아니면 Claude Code 기본값 local로 진행하고 안내 한 줄을 남긴다.
- 방향키로 고르는 질문. `↑`/`↓`로 이동하고 `Enter`로 확정하며, 강조된 항목의 설명이 목록 아래에 보인다. 렌더링은 [`@inquirer/select`](https://www.npmjs.com/package/@inquirer/select)·[`@inquirer/input`](https://www.npmjs.com/package/@inquirer/input)이 맡는다 — **런타임 의존성 두 개가 늘었다**(둘 다 순수 JS, 정확한 버전 고정). 직접 만든 메뉴가 Windows Terminal에서 화면을 망가뜨렸는데 Windows TTY 렌더링은 이 저장소의 테스트로 검증할 수 없어, 검증된 구현으로 옮기는 편이 맞다고 판단했다. 질문은 stdin과 stderr가 모두 터미널이고 `TERM`이 `dumb`가 아닐 때만 뜨고, 아니면 기존 비대화형 규칙(사용법 오류 또는 기본값 + 안내)을 그대로 따른다. 라이브러리는 질문을 실제로 할 때만 동적으로 불러오므로 서버 모드 기동에는 얹히지 않는다.
- **필요한 Node 버전이 20.17 이상(또는 22.13+, 23.5+)으로 올라갔다.** `@inquirer`의 요구사항이며 `engines`에 반영했다. 서버 자체는 Node 20에서도 동작한다.
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
- WSL(리눅스)과 Windows 네이티브에서 같은 동작을 보장한다. WSL에서는 `process.platform`이 `linux`라 감싸지 않은 `npx`로 등록하며, Claude Desktop은 "감지되지 않음(WSL에서는 Windows의 설정에 접근하지 않습니다)"으로 표시하되 선택은 막지 않는다.
- README의 Windows `cmd /c` 요구를 "셸 없이 서버를 스폰하는 호스트(Claude Desktop 등)"로 한정했다. Claude Code 2.1.270(Windows 11)에서는 감싸지 않은 `npx`로도 연결됨을 실측했다.
- `package.json`의 `bin` 경로를 npm 정규형(`dist/index.js`)으로 맞춰 publish 시 경고를 없앴다. 동작 변화는 없다.

### Fixed

- `host add`가 존재하지 않는 호스트에도 비밀번호를 받고 Windows ACL을 적용하고 키 쌍까지 만든 뒤에야 실패하던 문제. 이제 **비밀번호를 묻기 전에** 해당 host:port로 TCP 연결을 5초 안에 확인하고, 실패하면 사유("호스트 이름을 찾을 수 없습니다" 등)와 함께 아무것도 만들지 않고 끝냅니다. 위저드에서는 주소를 다시 묻고 3회 연속 실패하면 중단합니다. 이 확인은 TCP까지만 하며 지문 확인·비밀번호 전송 순서는 그대로입니다.
- 라벨에 제어 문자를 넣으면 `host list` 출력으로 그대로 나가던 문제. 위저드와 `--label` 양쪽에서 거부하고, 표를 그릴 때도 남아 있는 제어 문자를 `?`로 바꿔 출력합니다(예전 파일에 든 값 대비).
- 위저드의 호스트 주소·사용자명 질문이 제어 문자를 그대로 받아들이던 문제. 텍스트 질문에서 방향키를 누르면 `\x1b[B`가 호스트 이름으로 통과해 화면이 흐트러진 채 연결 확인까지 갔습니다. 이제 제어 문자와 공백을 거르고 호스트명/IPv4/IPv6 형식인지도 확인합니다.
- **0.1.0부터 있던 문제**: `setup`의 값을 받는 플래그가 바로 뒤 토큰을 무조건 값으로 삼아, `setup prod user@host --label --approval-mode`가 라벨을 `--approval-mode`로 저장하고 승인 모드는 기본값으로 남겼습니다. 이제 값 자리에 플래그 이름이 오면 사용법 오류로 거부합니다. `install`이 쓰던 가드를 두 파서가 공유합니다.
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

[0.3.0]: https://github.com/Get-bot/claude-toolkit/compare/ssh-mcp-v0.2.1...ssh-mcp-v0.3.0
[0.2.1]: https://github.com/Get-bot/claude-toolkit/compare/ssh-mcp-v0.2.0...ssh-mcp-v0.2.1
[0.2.0]: https://github.com/Get-bot/claude-toolkit/compare/ssh-mcp-v0.1.0...ssh-mcp-v0.2.0
[0.1.0]: https://github.com/Get-bot/claude-toolkit/releases/tag/ssh-mcp-v0.1.0
