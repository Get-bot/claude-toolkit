# ssh-mcp

Claude가 원격 서버에 SSH로 접속해 명령을 실행하고, 파일을 주고받고, 상태가 유지되는 셸 세션을 쓸 수 있게 하는 MCP(Model Context Protocol) 서버입니다.

네이티브 `ssh`/`scp` 바이너리에 의존하지 않는 순수 JavaScript SSH 클라이언트(`ssh2`)를 쓰므로, Windows에 OpenSSH가 설치돼 있지 않아도 동작합니다. 전송 방식은 stdio 하나뿐입니다.

> 이 문서는 한국어로 작성됐습니다. 명령어, 파일명, 코드 식별자는 원문 그대로 영문입니다.

## 목차

- [설치](#설치)
- [setup — 호스트 등록](#setup--호스트-등록)
- [도구 7개 레퍼런스](#도구-7개-레퍼런스)
- [승인 모드](#승인-모드)
- [hosts.json 스키마](#hostsjson-스키마)
- [Claude Desktop / Claude Code 연결](#claude-desktop--claude-code-연결)
- [Windows](#windows)
- [대화형 프로그램은 지원하지 않습니다](#대화형-프로그램은-지원하지-않습니다)
- [백그라운드(`&`) 작업](#백그라운드-작업)
- [sudo](#sudo)
- [바이너리 출력](#바이너리-출력)
- [보안 모델](#보안-모델)
- [감사 로그](#감사-로그)
- [진단 (`ssh-mcp doctor`)](#진단-ssh-mcp-doctor)
- [원격 셸 지원 범위](#원격-셸-지원-범위)
- [설계 결정](#설계-결정)
- [v1 범위 밖 / v1.1 후보](#v1-범위-밖--v11-후보)

## 설치

npx로 별도 설치 없이 바로 실행할 수 있습니다.

```bash
npx -y @get-bot/ssh-mcp
```

Windows에서 Claude Desktop처럼 `npx`를 직접 `command`로 지정하는 호스트에 등록할 때는 `cmd /c` 로 감싸야 합니다(이유는 [Windows](#windows) 절 참고).

```bat
cmd /c npx -y @get-bot/ssh-mcp
```

인자 없이 실행하면 stdio MCP 서버로 기동합니다. 호스트를 하나도 등록하지 않은 상태에서도 서버는 정상 기동하며, `list_hosts`가 빈 목록을 반환할 뿐입니다.

## setup — 호스트 등록

```bash
npx @get-bot/ssh-mcp setup <alias> <user@host[:port]> \
  [--approval-fallback token|fail-closed] \
  [--approval-mode auto|ask-destructive|ask-all|deny] \
  [--label "사람이 읽을 이름"] \
  [--force]
```

Windows에서는 `cmd /c` 로 감쌉니다.

```bat
cmd /c npx @get-bot/ssh-mcp setup myhost deploy@web01.example.com
```

**`setup`은 언제나 TTY를 요구합니다.** 비밀번호를 화면에 보이지 않게 입력받는 단계가 있기 때문이며, 아래 어떤 플래그를 줘도 이 요구는 면제되지 않습니다. `stdin`이 TTY가 아니면 비밀번호 단계에서 즉시 실패하고 `hosts.json`·키 파일 어느 것도 남기지 않습니다. 즉, `setup`을 CI나 스크립트에서 비대화형으로 완주시킬 방법은 없습니다 — 이것은 의도된 제약입니다.

진행 순서:

1. alias(`/^[a-z0-9][a-z0-9._-]{0,63}$/i` 형식)와 `user@host[:port]`를 파싱합니다.
2. 터미널에서 비밀번호를 화면에 표시하지 않고 입력받습니다. 사용 직후 메모리에서 지웁니다.
3. ed25519 키 쌍을 생성합니다(패스프레이즈 없음). 개인키는 `0600`, 공개키는 `0644`로 저장합니다.
4. 비밀번호로 1차 접속해 호스트 키 지문을 계산하고 화면에 표시한 뒤 `yes` 입력을 요구합니다. 거절하면 아무것도 쓰지 않고 종료합니다.
5. 원격 `~/.ssh/authorized_keys`에 공개키를 등록합니다(멱등 — 같은 alias로 다시 실행해도 중복 추가되지 않습니다).
6. 비밀번호 없이 새 개인키만으로 재접속을 검증합니다. **이 검증에 성공했을 때만** 다음 단계로 진행합니다.
7. **승인 폴백을 강제로 묻습니다.** 아래 참고.
8. (Windows만) `icacls`로 키 디렉터리를 하드닝합니다. 실패하면 생성한 키를 삭제하고 `hosts.json`에 아무것도 기록하지 않은 채 중단합니다.
9. 여기까지 전부 통과했을 때만 `hosts.json`에 항목을 원자적으로 기록합니다.
10. 성공하면 Claude Desktop/Claude Code 등록 스니펫을 stderr에 출력합니다.

### 승인 폴백 — 강제 선택이며 기본값이 없습니다

Claude Desktop은 elicitation(사람에게 되묻는 프로토콜 기능)을 지원하지 않습니다. 그래서 Desktop에 연결된 호스트는 파괴적/관리자 명령을 만나면 전부 "2단계 토큰" 경로를 탑니다. **이 경로에서는 토큰을 모델이 직접 받아 스스로 재호출할 수 있으므로, 서버 혼자서는 실제로 사람이 승인했음을 보장하지 못합니다.**

이 트레이드오프 때문에 `approvalFallback`에는 조용한 기본값을 두지 않기로 결정했습니다.

- `setup`은 6단계(키 전용 재접속 검증) 성공 직후, 위 트레이드오프를 설명하는 고정 문안을 출력하고 `token` 또는 `fail-closed` 중 하나를 **직접 선택**하게 합니다. 미리 골라둔 기본값이 없고, 빈 입력(Enter만)은 다시 묻습니다. 3회 연속 빈 입력이면 `setup` 자체가 중단되고 `hosts.json`은 생성되지 않습니다.
- `--approval-fallback token|fail-closed` 플래그는 **이 프롬프트만** 건너뜁니다. 비밀번호 입력 단계의 TTY 요구는 그대로입니다.
- 손으로 `hosts.json`을 편집해 이 필드를 지우면 서버는 **`fail-closed`로 간주**합니다. 어디에도 조용한 fail-open 경로는 없습니다. 이때 서버 기동 로그(stderr)에 경고가 1회 출력됩니다.
- `token`을 고른 호스트에는 아래 [보안 모델](#보안-모델)의 완화책이 전부 적용됩니다.

두 값의 실제 차이는 [승인 모드](#승인-모드) 표를 참고하세요.

### `--force` — 기존 alias 재설정

기존 alias에 대해 `setup`을 다시 실행하려면 `--force`가 필요합니다.

- `--force` 없이 기존 alias면 `alias_exists` 오류로 즉시 중단합니다.
- `--force`가 있으면: (1) 기존 지문과 새로 계산된 지문을 **나란히** 출력하고, (2) 두 지문이 다르면 "서버가 교체됐거나 중간자 공격일 수 있다"는 경고를 덧붙이며, (3) `yes`를 직접 타이핑해야 진행합니다. **어떤 경우에도 조용히 재핀하지 않습니다.**
- `stdin`이 TTY가 아니면 `--force` 자체가 거부됩니다. 지문 재핀은 사람의 확인이 반드시 있어야 하는 동작이기 때문입니다.

### `--approval-mode`, `--label`

- `--approval-mode <auto|ask-destructive|ask-all|deny>`: 호스트의 초기 승인 모드를 지정합니다. 생략 시 기본값은 `ask-destructive`입니다.
- `--label "<텍스트>"`: `list_hosts` 응답과 사람이 읽는 안내에 쓰이는 표시 이름입니다. 생략 가능합니다.

## 도구 7개 레퍼런스

모델이 실제로 읽는 안내문과 동일한 문구입니다.

| 도구 | 설명 | 주요 인자 |
|------|------|-----------|
| `list_hosts` | 등록된 SSH 호스트의 alias, 접속 정보, 승인 모드, 승인 폴백을 반환한다. 다른 도구에 넘길 `host` 값을 여기서 확인한다. 비밀키 경로와 호스트 키 지문 전문은 반환하지 않는다. | (없음) |
| `exec` | 등록된 호스트에서 셸 명령을 한 번 실행하고 stdout, stderr, exit code를 분리해 반환한다. 명령은 서버가 안전/파괴적/관리자로 분류하며 호스트의 승인 모드에 따라 확인을 요구할 수 있다. **응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.** 대화형 프로그램(vim, top, less 등)은 지원하지 않는다. 작업 디렉터리와 환경변수는 호출 간에 유지되지 않는다 — 유지가 필요하면 `open_session`을 쓴다. | `host`, `command`, `timeout_sec?`, `confirmation_token?` |
| `upload` | 로컬 파일을 원격 경로로 SFTP 전송한다. 원격에 같은 경로가 있으면 덮어쓴다. | `host`, `local_path`, `remote_path` |
| `download` | 원격 파일을 로컬 경로로 SFTP 전송한다. 로컬에 같은 경로가 있으면 기본적으로 실패하며, 덮어쓰려면 `overwrite: true`를 넘긴다. | `host`, `remote_path`, `local_path`, `overwrite?` |
| `open_session` | 상태가 유지되는 원격 셸 세션을 열고 `session_id`를 반환한다. 이후 `run_in_session` 호출들이 작업 디렉터리, 환경변수, 활성화한 가상환경을 공유한다. 호스트당 최대 5개이며 30분간 쓰지 않으면 자동으로 닫힌다. 다 쓰면 `close_session`으로 닫는다. | `host` |
| `run_in_session` | 열린 세션 안에서 명령을 실행한다. `cd`, `export`, `source venv/bin/activate`의 효과가 다음 호출까지 유지된다. 분류와 승인은 `exec`와 완전히 동일하다. **`confirmation_required`를 받으면 사용자에게 명령 전문을 보여주고 명시적 승인을 받은 뒤에만 `confirmation_token`과 함께 재호출할 것.** 대화형 프로그램은 지원하지 않는다. | `session_id`, `command`, `timeout_sec?`, `confirmation_token?` |
| `close_session` | 세션을 닫고 원격 셸을 종료한다. 이미 닫힌 세션에 호출해도 오류가 아니다. | `session_id` |

`exec`, `run_in_session` 두 도구에만 `_meta: { "anthropic/requiresUserInteraction": true }`가 붙어 있습니다. Claude Code에서 always-allow·bypassPermissions 설정을 무력화하고 매 호출마다 사람에게 확인을 강제하는 비표준 Anthropic 확장입니다. 필요하면 `SSH_MCP_REQUIRE_USER_INTERACTION=0`으로 끌 수 있습니다.

## 승인 모드

명령은 내장 정규식 패턴으로 **안전(safe) / 관리자(privileged) / 파괴적(destructive)** 셋 중 하나로 분류됩니다. 어느 패턴에도 걸리지 않으면 `safe`입니다. 호스트별 `patternOverrides`로 패턴을 추가하거나(모든 범위) 내장 패턴을 개별 해제할 수 있습니다(`destructive`/`privileged`만, 임의 안전 선언은 불가).

승인 모드는 호스트마다 `auto` / `ask-destructive`(기본값) / `ask-all` / `deny` 중 하나이고, 실제 동작은 클라이언트가 elicitation을 지원하는지와 그 호스트의 `approvalFallback` 값에 따라 갈립니다.

| 클라이언트 | 모드 | 등급 | 동작 |
|-----------|------|------|------|
| Claude Code (elicitation 지원) | `ask-destructive` | safe | 즉시 실행 |
| Claude Code | `ask-destructive` | destructive / privileged | elicitation 확인창 1회 → 사람이 결정 |
| Claude Code | `ask-all` | 전부 | elicitation 확인창 1회 |
| Claude Desktop (elicitation 미지원) | `ask-destructive` | safe | 즉시 실행 |
| Claude Desktop, `approvalFallback: token` | `ask-destructive` | destructive / privileged | `confirmation_required` + 토큰 반환 → 모델이 사용자 승인을 받은 뒤 재호출. **사람 개입은 Desktop의 도구 승인 대화상자에만 의존한다** |
| Claude Desktop, `approvalFallback: fail-closed` | `ask-destructive` / `ask-all` | destructive / privileged | `approval_unavailable`로 거부. 토큰 미발급 |
| Claude Desktop, `approvalFallback: fail-closed` | `ask-all` | safe | 토큰 경로(안전 등급도 확인을 요구하는 모드이므로) |
| **`approvalFallback` 필드가 없음(손편집 등)** | `ask-*` | destructive / privileged | `fail-closed`와 동일하게 처리. 기동 시 경고 1회 |
| 아무 클라이언트 | `deny` | destructive / privileged | `command_denied`. 토큰 미발급 |
| 아무 클라이언트 | `auto` | 전부 | 즉시 실행. 기동 시 경고 1회 |

**서버가 실제로 강제할 수 있는 것은 `fail-closed`와 Claude Code의 `requiresUserInteraction`뿐입니다.** 그 외에는 클라이언트 쪽 UI(대화상자, elicitation 창)를 신뢰해야 합니다. 자세한 내용은 [보안 모델](#보안-모델)을 보세요.

## `hosts.json` 스키마

경로: `~/.ssh-mcp/hosts.json` (Windows: `%USERPROFILE%\.ssh-mcp\hosts.json`).

```jsonc
{
  "schemaVersion": 1,
  "hosts": {
    "prod-web": {
      "hostname": "web01.example.com",
      "port": 22,
      "user": "deploy",
      "privateKeyPath": "C:\\Users\\me\\.ssh-mcp\\keys\\prod-web",
      "hostKey": { "algo": "ssh-ed25519", "sha256": "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" },
      "approvalMode": "ask-destructive",
      "approvalFallback": "fail-closed",
      "auditMode": "full",
      "patternOverrides": {
        "destructive": { "add": ["^helm\\s+uninstall\\b"], "remove": ["^git\\s+push\\b.*\\s--force\\b"] },
        "privileged":  { "add": [], "remove": [] }
      },
      "defaultTimeoutSec": 60,
      "maxOutputBytes": 1048576,
      "label": "프로덕션 웹",
      "createdAt": "2026-09-11T12:00:00.000Z"
    }
  }
}
```

| 필드 | 타입 / 제약 | 기본값 |
|------|------------|--------|
| `schemaVersion` | `1` 고정. 다른 값이면 로드 거부 | 필수 |
| alias(키) | `/^[a-z0-9][a-z0-9._-]{0,63}$/i` | 필수 |
| `hostname` | 문자열, 1~253자 | 필수 |
| `port` | 정수, 1~65535 | `22` |
| `user` | 문자열, 공백/콜론 불가 | 필수 |
| `privateKeyPath` | 문자열 | 필수 |
| `hostKey.algo` | 문자열 | 필수 |
| `hostKey.sha256` | `SHA256:` + base64 43자 | 필수 |
| `approvalMode` | `auto` \| `ask-destructive` \| `ask-all` \| `deny` | `ask-destructive` |
| `approvalFallback` | `token` \| `fail-closed` — **명시적으로 optional이며 zod 기본값이 없다.** `setup`이 쓰는 항목에는 항상 값이 들어간다. 손편집으로 누락되면 로드 시 `fail-closed`로 정규화되고 `warn` 1회를 남긴다 | (기본값 없음. 누락 시 동작은 `fail-closed`와 동일) |
| `auditMode` | `full` \| `metadata-only` — 감사 줄에 명령 문자열을 남길지 | `full` |
| `patternOverrides.destructive.add/remove`, `patternOverrides.privileged.add/remove` | 정규식 문자열 배열, 각 512자 이하 | `[]` |
| `defaultTimeoutSec` | 정수, 1~3600 | `60` |
| `maxOutputBytes` | 정수, 1024~4194304(4 MiB) | `1048576` |
| `label` | 문자열, 128자 이하, optional | — |
| `createdAt` | ISO 8601 datetime | 필수 |

모든 객체는 `.strict()`로 검증됩니다. 정의되지 않은 키(예: 과거 계획에 있던 `patternOverrides.allow`)가 남아 있으면 **조용히 무시되지 않고 검증에서 거부**됩니다. `allow`류 임의 안전 선언 필드는 v1에 없습니다 — 내장 파괴적/관리자 패턴을 개별적으로 끄는 것(`remove`)은 허용하지만, 임의 정규식을 "안전하다"고 선언하는 길은 의도적으로 열어두지 않았습니다.

## Claude Desktop / Claude Code 연결

### Claude Desktop

`claude_desktop_config.json`에 추가합니다.

macOS/Linux:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": ["-y", "@get-bot/ssh-mcp"]
    }
  }
}
```

Windows (반드시 `cmd /c` 형태를 쓰세요 — [Windows](#windows) 절 참고):

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@get-bot/ssh-mcp"]
    }
  }
}
```

설정 후 Claude Desktop을 재시작하면 도구 목록에 정확히 7개가 나타나야 합니다.

### Claude Code

```bash
claude mcp add ssh-mcp -- npx -y @get-bot/ssh-mcp
```

Windows:

```bash
claude mcp add ssh-mcp -- cmd /c npx -y @get-bot/ssh-mcp
```

`/mcp`에서 같은 7개 도구가 보이는지 확인하세요.

## Windows

- **네이티브 빌드 도구가 없어도 됩니다.** `npm install --omit=optional`(또는 `npm ci --omit=optional`)로 선택적 네이티브 의존성 설치를 건너뛸 수 있습니다. `ssh2`는 순수 JS이므로 필수 기능에 영향이 없습니다.
- **`npx`를 MCP 호스트의 `command`로 직접 지정하지 마세요.** Windows에서 `npx`는 실제로 `npx.cmd` 배치 파일입니다. MCP 호스트 대부분은 `child_process.spawn(cmd, args, { shell: false })`로 서버를 띄우는데, `shell: false`에서는 `.cmd` 셸 확장자 연결이 적용되지 않아 스폰이 `ENOENT`로 실패합니다. `cmd /c npx ...`로 감싸면 `cmd.exe`가 `.cmd` 확장자를 직접 해석하므로 문제가 사라집니다. 이 사실은 CI의 `windows-spawn` 잡이 두 가지 스폰을 모두 재현해 검증합니다.
- 연결이 안 될 때는 가장 먼저 `node dist/index.js doctor`(또는 `npx @get-bot/ssh-mcp doctor`)를 실행하세요. 15개 항목을 점검합니다.
- 키 디렉터리는 `icacls`로 하드닝됩니다. `setup` 중 하드닝이 실패하면 생성된 키를 정리하고 등록을 중단합니다.
- 원격 셸이 `cmd`나 `powershell`로 감지되면(즉 원격도 Windows OpenSSH인 경우) 상태 유지 세션(`open_session`)을 지원하지 않습니다. [원격 셸 지원 범위](#원격-셸-지원-범위)를 보세요.

## 대화형 프로그램은 지원하지 않습니다

v1은 PTY(가상 터미널)를 할당하지 않습니다. 그래서 화면을 다시 그리거나 실시간 키 입력을 기다리는 프로그램은 동작하지 않습니다.

명령이 대화형 프로그램으로 감지되면 `isError: true`, 오류 코드 `interactive_program_refused`와 함께 대안이 함께 반환됩니다.

| 감지된 프로그램 | 대안 |
|-----------------|------|
| `less`, `more` | `sed -n '1,200p' <file>` |
| `top` | `ps aux --sort=-%cpu \| head -20` |
| `vim`, `nano` | `download`로 받아 로컬에서 편집한 뒤 `upload` |
| `watch` | `run_in_session`을 반복 호출 |
| `man` | `<명령> --help` |

**이 감지는 위험도 판정이 아닙니다.** 파괴적/관리자 분류와는 완전히 별개의 검사이며, 대화형 프로그램이 아니라는 이유로 명령이 "안전"으로 승격되지는 않습니다.

## 백그라운드(`&`) 작업

최상위 세그먼트가 `&`로 끝나는 명령(예: `npm run dev &`)은 **거부하지 않고 실행**하지만, 응답에 `background_job: true`와 함께 다음 경고가 붙습니다.

> 이 명령은 백그라운드로 분리됐다. 이후 출력은 어느 호출에도 귀속되지 않으며 세션 종료 시 정리되지 않을 수 있다.

**출력 귀속은 v1에서 정의되지 않습니다.** 백그라운드로 넘어간 프로세스의 이후 stdout/stderr를 어떤 도구 호출과도 연결해 회수할 방법이 없습니다. 거부하지 않는 이유는 `&`가 정당한 운영 작업에 흔히 쓰이고, 거부하면 사용자가 `nohup ... &`처럼 서버가 알아채기 더 어려운 형태로 우회할 뿐이기 때문입니다.

## sudo

`sudo`는 **NOPASSWD가 설정된 서버에서만** 동작합니다. ssh-mcp는 sudo 비밀번호를 저장하지도, 입력받지도 않습니다(v1 비목표).

내부적으로 모든 실행 채널은 stdin을 항상 닫습니다. stdin이 닫힌 상태에서 `sudo`가 비밀번호를 요구하면 `sudo: no tty present and no askpass program specified` 류의 메시지와 함께 즉시 실패합니다. ssh-mcp는 이 실패 패턴을 감지해 원래 오류 대신 `sudo_password_required`를 반환합니다.

**명령 문자열은 어떤 경우에도 한 바이트도 변형하지 않습니다.** `sudo`에 `-n`을 자동으로 끼워 넣는 등의 재작성을 하지 않습니다 — 그런 재작성은 분류·승인의 대상과 실제 실행 대상을 어긋나게 만들 수 있기 때문입니다. `sudo -S`(stdin에서 비밀번호를 읽는 옵션)는 stdin이 닫혀 있어 반드시 실패할 것이 확실하므로 분류 단계에서 미리 `sudo_password_required`로 거부합니다.

## 바이너리 출력

stdout/stderr가 유효한 UTF-8이 아니면 해당 스트림을 base64로 인코딩해 반환하고, 응답에 `encoding: "base64"`를 포함합니다. UTF-8이면 `encoding: "utf8"`입니다. 비-UTF-8 출력에서는 줄 기반 발췌가 의미가 없으므로 앞·뒤를 **바이트** 단위로 보존하며 `omitted_lines: null`, `omitted_bytes`는 정확한 값을 반환합니다.

## 보안 모델

- **서버가 실제로 강제할 수 있는 것은 두 가지뿐입니다.** 호스트의 `approvalFallback: "fail-closed"`, 그리고 Claude Code에서만 동작하는 `_meta`의 `anthropic/requiresUserInteraction`. 그 외의 모든 승인 전달은 클라이언트 쪽 UI를 신뢰하는 구조입니다. [승인 모드](#승인-모드) 표를 참고하세요.
- **Claude Desktop 사용자는 `exec`와 `run_in_session`에 "항상 허용(always allow)"을 설정하지 마세요.** 이 두 도구는 서버가 강제로 확인을 요구하도록 설계됐고, Desktop에서 always-allow를 걸면 그 설계 의도가 무력화됩니다.
- **프로덕션 호스트에는 `"approvalFallback": "fail-closed"`를 권장합니다.** `token` 모드는 Desktop처럼 elicitation을 지원하지 않는 클라이언트에서 파괴적/관리자 명령을 계속 쓸 수 있게 하는 완화책이지만, 그 경로에서는 서버가 사람의 승인을 검증할 수 없습니다(응답의 `server_cannot_verify_human_approval: true` 필드가 이 사실을 명시합니다). 사람 개입은 전적으로 Desktop 자체의 도구 승인 대화상자에 의존합니다.
- **토큰은 프로세스 메모리에만 있습니다.** 서버를 재시작하면 발급된 모든 `confirmation_token`이 무효가 됩니다. 토큰은 명령 문자열과 호스트에 바인딩된 1회용입니다.
- **도구 어노테이션(`readOnlyHint`, `destructiveHint` 등)은 힌트일 뿐 보안 경계가 아닙니다.** MCP SDK 자체가 "신뢰할 수 없는 서버의 어노테이션을 클라이언트가 신뢰해서는 안 된다"고 명시합니다. 차단은 전적으로 서버 내부의 분류·승인 로직이 담당합니다. 예외적으로 `_meta`의 `requiresUserInteraction`은 Claude Code에서는 실제 강제력이 있지만, 이것도 Claude Code 한정이며 다른 호스트는 무시합니다.
- **감사 파일은 명령 문자열을 담으며 모드 `0600`입니다.** `auditMode: "metadata-only"`로 바꾸면 명령 문자열 자체는 기록하지 않지만 등급·승인 결과·바이트 수 등 나머지 필드는 그대로 남습니다.
- **감사 쓰기 실패는 도구 호출을 막지 않습니다.** 감사 파일에 쓰지 못해도(디스크 가득 참 등) `warn` 로그만 남기고 원래 도구 호출은 계속 성공 처리됩니다. 감사가 가용성보다 우선하지 않는다는 트레이드오프입니다.
- **Windows 원격 셸에서는 분류 커버리지가 축소됩니다.** 내장 파괴적/관리자 패턴은 POSIX 셸 문법을 전제로 만들어졌으므로, 원격 로그인 셸이 `cmd`나 `powershell`로 감지되면 `del /s /q`, `Remove-Item -Recurse -Force` 같은 명령이 `safe`로 판정될 수 있습니다. 이런 호스트에서는 `exec`/`run_in_session` 응답과 `doctor` 진단에 `classification_coverage: "reduced"` 표시가 붙습니다.

## 감사 로그

경로: `~/.ssh-mcp/audit.jsonl` (Windows: `%USERPROFILE%\.ssh-mcp\audit.jsonl`). 생성 시 모드 `0600`(Windows는 `icacls` 하드닝 대상).

한 도구 호출마다 성공·실패·거부와 무관하게 정확히 한 줄이 추가됩니다. 2단계 토큰 승인(요청 → 재호출)은 두 줄로 남습니다.

| 필드 | 설명 |
|------|------|
| `schemaVersion` | 항상 `1`. 향후 `history` 도구가 v1/v1.1 혼재 파일을 읽을 수 있게 한다 |
| `ts` | ISO 8601 UTC, 밀리초 |
| `tool` | 7개 도구 이름 중 하나 |
| `host` | alias 또는 `null` (`run_in_session`/`close_session`은 `session_id`로 역조회) |
| `session_id` | 문자열 또는 `null` |
| `command` | 리댁션 통과 문자열, 2 KiB 절단. `auditMode: "metadata-only"`면 `null` |
| `command_grade` | `safe` / `privileged` / `destructive` / `null` |
| `reasons` | 매칭된 패턴 id 배열 |
| `approval_mode` | 호출 시점 호스트의 `approvalMode` |
| `approval_outcome` | 아래 8개 값 중 하나 |
| `approval_fallback` | `token` / `fail-closed` / `null` |
| `server_cannot_verify_human_approval` | `approval_outcome === "token-approved"`일 때 `true` |
| `exit_code` | 숫자 또는 `null` |
| `error_code` | 오류 코드 또는 `null` |
| `exec_duration_ms` | 실제 원격 실행 시간(ms) |
| `approval_wait_ms` | 승인 대기 시간(ms). 느린 실행과 사람의 긴 고민 시간을 구분하기 위해 별도 필드로 둔다 |
| `stdout_bytes` / `stderr_bytes` | 발췌 전 원본 총 바이트 |
| `truncated` | 발췌 여부 |
| `normalized_command` / `segments` | 분류기가 실제로 매칭에 쓴 정규화 문자열·세그먼트. `metadata-only`면 `null` |
| `client` | `{name, version}` 또는 `null` |
| `audit_mode` | 이 줄이 기록된 모드(`full`/`metadata-only`) |

**`approval_outcome`의 8개 값**: `not-required`, `auto`, `elicitation-approved`, `token-approved`, `pending-confirmation`, `declined`, `denied`, `approval_unavailable`.

**출력 본문은 기록하지 않습니다.** 바이트 수만 남습니다.

**회전.** 10 MiB를 넘으면 회전합니다(`.3` 삭제 → `.2`를 `.3`으로 → `.1`을 `.2`로 → 본체를 `.1`로). 총 4개 파일, 최대 약 40 MiB. 한 줄은 16 KiB로 제한되며, 넘치면 `command` → `segments` → `normalized_command` → `reasons` 순으로 잘립니다.

**조회 도구는 v1에 없습니다.** `jq` 등으로 직접 읽어야 합니다.

```bash
# 최근 20개 호출의 도구/승인 결과
jq -r '.tool + " " + .approval_outcome' ~/.ssh-mcp/audit.jsonl | tail -20

# 파괴적으로 분류된 호출만
jq -c 'select(.command_grade == "destructive")' ~/.ssh-mcp/audit.jsonl

# 승인 결과별 집계
jq -r '.approval_outcome' ~/.ssh-mcp/audit.jsonl | sort | uniq -c | sort -rn
```

v1.1에서 이 로그를 필터·페이지 조회하는 `history` 도구를 추가하는 것이 로드맵 후보입니다.

## 진단 (`ssh-mcp doctor`)

```bash
npx @get-bot/ssh-mcp doctor
npx @get-bot/ssh-mcp doctor --json
npx @get-bot/ssh-mcp doctor --patterns
```

**연결이 안 되면 가장 먼저 이 명령을 돌리세요.** 결과는 stdout에 출력됩니다(서버 모드가 아니므로 stdout을 JSON-RPC 전용으로 쓸 필요가 없습니다).

| # | 항목 | 비고 |
|---|------|------|
| 1 | Node 버전 ≥ 20 | 미만이면 FAIL |
| 2 | `ssh2` 로드 | 네이티브 `cpu-features` 바인딩 유무는 정보로만 표시 |
| 3 | `~/.ssh-mcp/` 레이아웃 | 없지만 생성 가능하면 PASS(신규 설치). 생성도 불가할 때만 FAIL |
| 4 | 디렉터리·키 파일 권한 | POSIX `0700`/`0600` 또는 Windows `icacls` 확인 |
| 5 | `hosts.json` 스키마 | 파싱/zod 검증 실패 시 FAIL, issue 경로 표시 |
| 6 | `audit.jsonl` 쓰기 가능 | 현재 크기·회전 파일 수 함께 표시 |
| 7 | 호스트별 키 파일 존재·권한 | 파일 없으면 FAIL |
| 8 | 호스트별 TCP 연결(5초) | 실패 시 FAIL |
| 9 | 호스트별 호스트 키 지문 일치 | 불일치 시 FAIL |
| 10 | 호스트별 키 전용 인증 | 인증 실패 시 FAIL. **명령은 실행하지 않는다** |
| 11 | 호스트별 승인 설정 | FAIL 없음. `auto`/`token`/필드 누락은 WARN |
| 12 | 마지막 클라이언트의 elicitation 지원 여부 | FAIL 없음. 기록 없으면 "미기록" |
| 13 | 원격 셸 분류 커버리지 | FAIL 없음. `cmd`/`powershell`로 관측된 호스트는 WARN, 미관측은 "미확인" 정보 행 |
| 14 | 분류 패턴 목록 | 항상 PASS(정보 행). `--patterns`로 단독 출력 가능 |
| 15 | 호스트 설정 스니펫 출력 | 항상 PASS. Windows에서는 `cmd /c` 변형도 함께 출력 |

**종료 코드.** FAIL이 하나라도 있으면 `1`, 없으면 `0`. WARN은 종료 코드에 영향을 주지 않습니다.

`--json`은 `{ ok, checks: [{ id, name, status, detail }], snippets }` 형태로 같은 결과를 stdout에 출력합니다.

## 원격 셸 지원 범위

`open_session`은 접속 직후 짧은 프로브로 원격 로그인 셸을 자동 감지합니다.

| 분류 | 셸 | 상태 유지 세션(`open_session`) |
|------|-----|-------------------------------|
| 지원 | `bash`, `zsh`, `sh`/`dash`, busybox `ash` | 지원 |
| 미지원 | `fish` | `unsupported_shell` 오류. `exec` 도구는 셸과 무관하게 계속 동작함 |
| 미지원 | Windows `cmd`, PowerShell | `unsupported_shell` 오류. `classification_coverage: "reduced"`가 함께 표시됨 |

미지원 셸에서는 다음 대안이 오류 응답에 함께 담깁니다.

- `exec` 도구로 단발 명령을 실행한다. `exec`는 모든 셸에서 동작한다.
- 작업 디렉터리 유지가 필요하면 명령을 `cd /path && <명령>` 형태로 합친다.
- 원격 사용자의 로그인 셸을 바꿀 수 있다면 `chsh -s /bin/bash`로 지원 셸로 전환한다(fish 등 POSIX 계열 유닉스에 한함. Windows OpenSSH에는 해당하지 않는다).

**출력 발췌 규칙(AC12).** `exec`/`run_in_session`의 stdout·stderr가 호스트의 `maxOutputBytes`(기본 1 MiB)를 넘으면, 단순 절단 대신 앞부분(head)과 뒷부분(tail)을 보존하고 가운데를 한 줄로 대체합니다.

- head 예산: 전체 상한의 **40%** 바이트 또는 **최소 20줄** 중 늦게 채워지는 쪽까지.
- tail 예산: 전체 상한의 **60%** 바이트 또는 **최소 20줄**(20줄이 전부 최대 길이여도 담기도록 160 KiB 하한).
- 다만 **하드 실링이 최소 줄 수 보장보다 우선**합니다 — 메모리 사용량이 무한정 늘어나는 것을 막기 위해, 최소 줄 수를 채우려는 확장이 하드 실링을 넘기면 그 시점에서 멈춥니다.
- 생략 표시 줄은 고정 형식입니다: `[ssh-mcp] ──── 중간 12,345줄 / 9,876,543바이트 생략 ────` (정규식으로 파싱 가능, 천 단위 구분자는 표시용).
- 응답의 `stdout_meta`/`stderr_meta`에 `truncated`, `total_bytes`, `total_lines`, `head_bytes`, `tail_bytes`, `omitted_lines`, `omitted_bytes`, `returned_bytes`가 정확한 값으로 담깁니다.

## 설계 결정

아래 ADR(Architecture Decision Record)은 `.omc/plans/ssh-mcp-plan.md`에 전문이 있습니다. 여기서는 제목만 남깁니다.

- **ADR-001.** 세션 명령 완료를 양방향 UUID 마커 + base64 + `eval` + stdin 차단으로 감지한다
- **ADR-002.** 통합 테스트를 두 엔드포인트로 파라미터화한다 — 인프로세스 픽스처(양 OS) + 실제 sshd 컨테이너(ubuntu)
- **ADR-003.** elicitation을 우선하고, 미지원 호스트에는 기본값 없는 호스트별 `approvalFallback`을 강제 선택시킨다
- **ADR-004.** MCP 도구 어노테이션은 UX 힌트로만 쓰고 보안 경계로 삼지 않는다
- **ADR-005.** 명령 분류를 2-pass로 수행한다(전체 문자열 + 세그먼트)
- **ADR-006.** 발췌로 잘린 중간 출력을 v1에서는 보관하지 않는다
- **ADR-007.** 감사 로그는 append-only JSONL이고, 쓰기 실패는 서비스를 막지 않는다
- **ADR-008.** 출력 상한 초과 시 앞·뒤를 보존하고 가운데를 한 줄로 대체한다
- **ADR-009.** 원격 셸 지원 경계를 POSIX 계열 4종으로 두고 나머지는 조기 거부한다

## v1 범위 밖 / v1.1 후보

v1에는 없지만 설계가 이들을 막지 않도록 만들었습니다.

- `history` 도구 — `audit.jsonl`을 호스트·기간·등급으로 필터해 페이지 단위로 반환
- 페이지 커서 출력 조회 — 발췌로 잘린 나머지를 커서로 가져오는 도구
- 구조화 JSON 파서 — `df`, `ps`, `docker ps`, `systemctl status`, `journalctl` 등을 `format: "json"`으로 구조화 반환
- SQLite 감사 저장소 — JSONL을 대체 또는 보강
- `.mcpb` 원클릭 번들 패키징
- `setup`의 `~/.ssh/config` 가져오기(기존 키·설정 재사용)

다음은 v1에서 명시적으로 제외되었고 로드맵에도 없습니다.

- 원격 MCP 서버로의 프로토콜 터널링 프록시
- 원격 파일 읽기·부분 편집·검색 도구
- sudo 비밀번호 입력
- 동반 SKILL.md 스킬, npm 자동 배포
- 특정 운영 작업(서비스 재시작, 로그 분석 등)에 특화된 큐레이션 도구 — 범용 셸이 목표
