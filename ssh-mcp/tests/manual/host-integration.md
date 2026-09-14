# 수동 호스트 통합 체크리스트 (AC3–AC6)

이 문서는 자동화 테스트가 커버하지 못하는, **실제 Claude Desktop / Claude Code 클라이언트**와의 통합을 사람이 확인하기 위한 체크리스트입니다. `.omc/plans/ssh-mcp-plan.md` §8.5의 검증 절차를 따릅니다.

전제:

- Windows 11 머신 (1차 검증 대상).
- `ssh-mcp`가 빌드되어 있거나(`npm run build`), 패키지가 배포되어 `npx @get-bot/ssh-mcp`로 실행 가능한 상태.
- 비밀번호 로그인이 가능한 테스트용 원격 리눅스 호스트(SSH) 1대.

각 항목은 `[ ]` 체크박스로 표시되어 있습니다. 리뷰어는 항목별로 결과(PASS/FAIL)와 관측 내용을 기록하세요.

## AC3 — 저장소 문서

- [ ] 루트 `README.md:3`이 "스킬 + 도구"라는 표현을 포함한다.
- [ ] 루트 `README.md`에 `## 도구 목록` 절이 있고 `ssh-mcp` 행이 있다.
- [ ] `## 도구 목록`의 `./ssh-mcp` 링크가 유효한 상대 경로다(실제로 `ssh-mcp/` 디렉터리가 존재한다).
- [ ] `ssh-mcp/README.md`가 존재하고 설치·설정·도구 레퍼런스를 담고 있다.

## AC4 — Claude Desktop 등록 (Windows)

1. `%APPDATA%\Claude\claude_desktop_config.json`을 열고 아래를 추가한다.

   ```json
   {
     "mcpServers": {
       "ssh-mcp": { "command": "cmd", "args": ["/c", "npx", "-y", "@get-bot/ssh-mcp"] }
     }
   }
   ```

2. Claude Desktop을 완전히 재시작한다.

- [ ] 도구 목록에 **정확히 7개**(`list_hosts`, `exec`, `upload`, `download`, `open_session`, `run_in_session`, `close_session`)가 보인다.
- [ ] (참고용) `command: "npx"` 형태(감싸지 않은 버전)도 한 번 시도해 실제로 실패/성공 여부를 기록한다. README의 `cmd /c` 권고가 실제로 필요한지 재확인하는 목적이다.

### AC4 추가 항목(계획 외) — `install claude-desktop` 자동 경로

> `install`은 계획서 §8.5에 없는 2026-09-14 추가분이라 AC 번호가 없습니다. AC4의 하위 항목으로 함께 확인하세요.

손으로 편집하는 대신 아래 명령으로 등록한다. **패키지 디렉터리 밖**에서 실행한다(`ssh-mcp/` 안에서는 npx가 같은 이름의 로컬 프로젝트를 집는다).

```bash
npx @get-bot/ssh-mcp install claude-desktop
```

- [ ] `%APPDATA%\Claude\claude_desktop_config.json`에 `"command": "cmd"`, `"args": ["/c", "npx", "-y", "@get-bot/ssh-mcp"]` 항목이 생긴다.
- [ ] 기존에 다른 MCP 서버가 등록돼 있었다면 그 항목과 `mcpServers` 밖의 다른 키가 모두 그대로 남아 있다.
- [ ] 기존 파일이 있었다면 같은 디렉터리에 `claude_desktop_config.json.bak-<YYYYMMDD-HHmmss>` 백업이 생긴다.
- [ ] 같은 명령을 한 번 더 실행하면 종료 코드 1로 거부하고 파일이 바뀌지 않는다. `--force`를 주면 교체되고 백업이 하나 더 생긴다. 같은 초 안에 `--force`를 두 번 실행해도 첫 백업이 남고 `-1` 접미사가 붙은 백업이 추가된다.
- [ ] Claude Desktop을 완전히 재시작하면 도구 목록에 **정확히 7개**가 보인다.

## AC5 — Claude Code 등록

```bash
claude mcp add ssh-mcp -- cmd /c npx -y @get-bot/ssh-mcp
```

- [ ] `/mcp` 명령에서 같은 7개 도구가 보인다.
- [ ] 감싸지 않은 `claude mcp add ssh-mcp -- npx -y @get-bot/ssh-mcp` 형태도 연결된다(2.1.270 / Windows 11에서 2026-09-14 실측). 사용한 Claude Code 버전과 결과를 기록한다.

### AC5 추가 항목(계획 외) — `install claude-code` 자동 경로

> `install`은 계획서 §8.5에 없는 2026-09-14 추가분이라 AC 번호가 없습니다. AC5의 하위 항목으로 함께 확인하세요.

**패키지 디렉터리 밖**에서 실행한다.

```bash
npx @get-bot/ssh-mcp install claude-code --dry-run
npx @get-bot/ssh-mcp install claude-code
```

- [ ] `--dry-run`이 아래 두 줄만 출력하고 아무것도 바꾸지 않는다(Windows 기준).

  ```
  [dry-run] 아무것도 바꾸지 않았습니다. 실행할 명령:
    claude mcp add ssh-mcp -s local -- cmd /c npx -y @get-bot/ssh-mcp
  ```

- [ ] `--dry-run` 없이 실행하면 `claude mcp list`에 `ssh-mcp`가 나타나고 `/mcp`에서 7개 도구가 보인다.
- [ ] 같은 명령을 한 번 더 실행하면 `claude`가 중복 등록을 거부하고 종료 코드 1로 끝난다. `--force`를 주면 remove 후 add가 진행되어 성공한다.
- [ ] `install claude-desktop --config <임시경로> --home --dry-run`이 종료 코드 2로 끝나고 **파일을 만들지 않는다**(값 자리에 플래그가 오는 경우).
- [ ] `install claude-code --home "C:\R&D\ssh-mcp"`를 `claude`가 PATH에 없는 셸에서 실행하면 `cmd` 재시도 없이 수동 명령을 출력하고 종료 코드 1로 끝난다.

## AC6 — Windows 11 검증

- [ ] AC4가 Windows 11에서 통과했다.
- [ ] AC5가 Windows 11에서 통과했다.

## 실호스트 확인 (릴리스 전 필수)

이 절은 §8.5의 "실호스트 확인" 목록을 그대로 옮긴 것입니다. `myhost`는 테스트용 alias, `user@example.com`은 테스트용 원격 계정으로 대체하세요.

### setup 흐름

- [ ] `npx @get-bot/ssh-mcp setup myhost user@example.com` 실행 시 비밀번호 입력 중 화면에 문자가 보이지 않는다.
- [ ] 호스트 키 지문이 표시되고 `yes` 확인을 요구한다.
- [ ] 지문 확인 후 **승인 폴백 선택 프롬프트**가 뜬다. Enter만 누르면 다시 묻는다. 3회 연속 빈 입력 시 중단되고 `~/.ssh-mcp/hosts.json`이 생성되지 않는다.
- [ ] `--approval-fallback fail-closed`와 함께(그리고 기존 alias라면 `--force`도 함께) 다시 실행하면 승인 폴백 프롬프트 없이 진행된다. `hosts.json`에 값이 그대로 들어간다.
- [ ] `ssh-mcp setup other user@example.com < /dev/null`(TTY 아님, 플래그 없음)이 오류로 종료하고 키 파일·`hosts.json` 어느 것도 남기지 않는다.
- [ ] 기존 alias에 `--force` 없이 setup을 실행하면 `alias_exists`로 중단된다. `--force`를 주면 옛 지문과 새 지문이 나란히 표시되고 `yes` 타이핑을 요구한다.
- [ ] 원격에서 `grep -c "ssh-mcp:myhost" ~/.ssh/authorized_keys` → **1**. setup을 한 번 더 실행해도 여전히 **1**(멱등).
- [ ] 원격에서 `ls -l ~/.ssh` → `authorized_keys`가 `-rw-------`.
- [ ] 원격에서 `ls -ld ~/.ssh` → `drwx------`.

### 타임아웃·리소스 정리

- [ ] Claude에게 "myhost에서 `sleep 300` 실행"을 시켜 타임아웃을 유발한 뒤, 원격에서 `pgrep -f 'sleep 300'`이 아무것도 반환하지 않는다(프로세스가 정리됨).
- [ ] `exec`로 `cat`을 인자 없이 실행하면 즉시 exit 0으로 끝난다(타임아웃이 아니라 stdin 즉시 종료 때문).

### 승인 흐름 — 리뷰어가 특히 주의해서 관측할 세 가지

아래 세 항목은 승인 시점에 **화면에 실제로 무엇이 보이는지**를 확인하는 항목입니다. 자동화 테스트는 능력 선언 유무로만 분기를 검증하므로, 사람이 눈으로 보는 절차는 이 체크리스트에서만 확인됩니다.

- [ ] **명령 전문이 승인 화면에 그대로 보이는가.** (Claude Code의 elicitation 창, Claude Desktop의 도구 승인 대화상자 양쪽 모두)
- [ ] **등급(destructive/privileged)과 매칭된 이유(reasons)가 모델의 발화 또는 승인 요청 문구에 반영되는가.** (`confirmation_required` 응답의 `reasons`/`grade` 필드를 모델이 실제로 인용하는지)
- [ ] **elicitation 창의 유무가 클라이언트별로 기대와 일치하는가.** (Claude Code = 뜬다, Claude Desktop = 뜨지 않는다 — 아래 참고)

구체적 절차:

- [ ] **Claude Code에서** "myhost에서 `rm -rf /tmp/sshmcp-test` 실행"을 시킬 때 **elicitation 확인 창**이 뜬다. 거절하면 실행되지 않는다.
- [ ] `/permissions`에서 `exec`를 always-allow로 설정한 뒤에도 같은 명령에 여전히 확인 창이 뜬다(`_meta`의 `requiresUserInteraction` 검증 — always-allow 무력화 확인).
- [ ] **Claude Desktop에서** 같은 명령을 시킬 때 `confirmation_required` 응답이 오고 모델이 사용자에게 승인을 요청한다. Desktop의 도구 승인 대화상자에 명령 전문이 보인다.
- [ ] **elicitation 창은 Desktop에서 뜨지 않는 것이 정상 동작이다.** (Desktop은 elicitation을 지원하지 않으므로 — 이것이 FAIL이 아니라 기대된 결과임을 리뷰어가 인지하고 있어야 한다)

### `approvalFallback` / `approvalMode` 동작

- [ ] `hosts.json`에 `"approvalFallback": "fail-closed"`를 넣고 Desktop에서 같은 명령을 시키면 `approval_unavailable`로 거부된다.
- [ ] `approvalFallback` 줄을 **삭제**한 뒤 Desktop에서 같은 명령이 여전히 `approval_unavailable`로 거부된다. 서버 기동 stderr에 "fail-closed로 간주" 경고가 있다.
- [ ] `hosts.json`의 `approvalMode`를 `deny`로 바꾼 뒤 같은 명령이 `command_denied`로 즉시 거부된다.
- [ ] `~/.ssh-mcp/hosts.json`의 `hostKey.sha256` 마지막 문자를 바꾼 뒤 `exec`가 `host_key_mismatch`로 거부된다.

### 출력·셸 감지

- [ ] `exec`로 `sudo whoami`를 실행했을 때 NOPASSWD가 아니면 `sudo_password_required`가 사유와 함께 온다.
- [ ] `exec`로 `seq 1 100000`을 실행하면 응답에 첫 줄 `1`과 마지막 줄 `100000`이 모두 있고, 가운데에 생략 표시 줄이 정확히 1개 있다. `stdout_meta.omitted_lines` 숫자가 표시 줄의 숫자와 같다.
- [ ] `open_session` 응답의 `detected_shell`이 실제 로그인 셸과 일치한다.
- [ ] 원격 사용자의 셸을 `chsh -s /usr/bin/fish`로 바꾼 뒤 `unsupported_shell`과 `detected_shell: "fish"`가 온다. 같은 호스트에서 `exec`는 여전히 동작한다. 확인 후 셸을 원래대로 되돌린다.

### 감사 로그

- [ ] `~/.ssh-mcp/audit.jsonl`에 위 호출들이 한 줄씩 쌓였다. `jq -r '.tool + " " + .approval_outcome' ~/.ssh-mcp/audit.jsonl | tail -20` 결과가 실제 수행 순서와 일치한다.
- [ ] 감사 파일 권한이 `-rw-------`다.
- [ ] 감사 파일에 명령 **출력 본문**이 들어 있지 않다. `grep -c '<출력에 있던 고유 문자열>' ~/.ssh-mcp/audit.jsonl` → **0**.

### 진단

- [ ] `ssh-mcp doctor`가 모든 항목 PASS로 종료 코드 0을 낸다.
- [ ] `hosts.json`의 지문 1자를 바꾼 뒤 해당 호스트 행이 FAIL이고 종료 코드가 0이 아니다.

## 기록란

| 항목          | 결과(PASS/FAIL) | 관측 내용 / 스크린샷 링크 | 확인자 | 날짜 |
| ------------- | --------------- | ------------------------- | ------ | ---- |
| AC3           |                 |                           |        |      |
| AC4           |                 |                           |        |      |
| AC4 추가 항목 |                 |                           |        |      |
| AC5           |                 |                           |        |      |
| AC5 추가 항목 |                 |                           |        |      |
| AC6           |                 |                           |        |      |
| 실호스트 확인 |                 |                           |        |      |
