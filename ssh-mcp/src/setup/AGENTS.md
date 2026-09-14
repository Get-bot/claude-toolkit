<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# setup

## Purpose

`ssh-mcp host add <alias> <user@host[:port]>` 명령 전체입니다(`ssh-mcp setup`은 같은 핸들러의 **무경고 별칭**이며, 그 이유는 `../host/AGENTS.md`에 있습니다. 디렉터리와 내부 식별자는 `setup` 이름을 유지합니다). 이 명령이 존재하는 이유는 **비밀번호를 사람이 터미널에서 한 번만 입력하고 다시는 입력하지 않게** 하기 위해서입니다 — 한 번의 비밀번호 인증으로 접속해 새로 만든 ed25519 공개키를 원격 `authorized_keys`에 설치하고, 호스트 키 지문을 핀으로 저장한 뒤, 이후에는 키 인증만 씁니다. 비대화형 실행은 불가능하며, 키 생성 이후의 모든 실패는 이전 키 쌍을 복원하고 `hosts.json`을 손대지 않은 채로 끝납니다.

## Key Files

| File         | Description                                                                                                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`     | 명령 오케스트레이션. `runSetup(argv, deps)`, `parseSetupArgs()`, `parseTarget()`, `defaultConnector`, `readKeyAlgo()`. 종료 코드 `EXIT_OK=0` / `EXIT_FAILED=1` / `EXIT_NOT_INTERACTIVE=2`. 검증 명령은 `VERIFY_COMMAND = 'echo ssh-mcp-ok'`.                                                                      |
| `keygen.ts`  | ed25519 키 생성과 백업/복원. `generateKeyPair()`, `backupKeyPair()`/`restoreKeyPair()`/`removeKeyPair()`, `describePublicKey()`, `MAX_GENERATION_ATTEMPTS = 12`.                                                                                                                                                  |
| `install.ts` | 원격 `authorized_keys` 설치. `installAuthorizedKey()`, `AUTHORIZED_KEYS_SCRIPT`, 마커 `SSHMCP_INSTALLED` / `SSHMCP_ALREADY_PRESENT`, `RemoteInstallError`.                                                                                                                                                        |
| `prompt.ts`  | 대화형 프롬프트. `Prompter` 클래스와 `promptPassword()`/`promptYes()`/`promptChoice()`, `createPrompter()`, `NonInteractiveError`, `PromptAbortedError`. 기본값이 **없어야 하는** 세 질문(비밀번호·지문 `yes`·승인 폴백) 전용입니다.                                                                              |
| `ask.ts`     | 기본값이 있는 질문의 얇은 어댑터. `createAsker`/`inquirerAsker`, `canPrompt`, `PromptUnavailableError`, `Asker`/`AskStreams`/`SelectQuestion`/`TextQuestion`. `@inquirer/*`는 **질문할 때 동적으로** 불러와 서버 기동에 얹히지 않게 하고, `output`은 stderr, `ExitPromptError`는 `PromptAbortedError`로 바꿉니다. |
| `wizard.ts`  | 인자 없는 `host add`의 질문 흐름. `runSetupWizard()`, `suggestAlias()`, `formatTarget()`, `isUsableHostname()`, `MAX_REACH_ATTEMPTS`. **argv 토큰만 만들고** 파일이나 연결은 건드리지 않습니다.                                                                                                                   |
| `winacl.ts`  | Windows ACL 하드닝. `hardenWindowsAcl()`, `inspectWindowsAcl()`, `parseIcaclsPrincipals()`, `currentWindowsPrincipal()`, `ALLOWED_FOREIGN_PRINCIPALS = ['NT AUTHORITY\\SYSTEM']`.                                                                                                                                 |

## Setup flow

0. **위저드(선택)** — positional이 **하나도** 없고 `canPrompt()`가 true면(stdin·stderr 모두 터미널, `TERM≠dumb`) `runSetupWizard()`가 호스트 주소·사용자명·포트·alias·승인 모드·라벨을 차례로 묻고 **argv 토큰을 만들어 반환**합니다. `runSetup`은 그것을 원래 argv 뒤에 붙여 `parseSetupArgs()`를 다시 호출하므로, 이후 1~13단계는 사용자가 인자를 직접 친 경우와 완전히 같습니다. positional이 하나만 있으면(오타로 판단) 위저드는 뜨지 않습니다.
   0.5. **연결 확인** — `ssh/reach.ts`의 `probeTcp()`로 host:port에 TCP 연결을 시도합니다(5초). 실패하면 `connection_failed`와 사람이 읽을 사유를 내고 **비밀번호·ACL·키 생성 이전에** 종료합니다. 위저드는 여기서 호스트 주소와 포트를 다시 묻고 3회 연속 실패하면 중단합니다. 위저드가 이미 확인했으면 인자 경로에서 다시 연결하지 않습니다(`addressVerified`).
1. **argv 파싱** — `parseSetupArgs()`가 alias와 `user@host[:port]`를 해석하고 `--force`, `--approval-mode`, `--approval-fallback`, `--label` 플래그를 읽습니다. alias는 `AliasSchema`로 검증합니다.
2. **기존 alias 확인** — 이미 등록된 alias에 `--force` 없이 실행하면 `alias_exists`로 끝납니다.
3. **TTY 확인** — `prompter.interactive`가 false면 아무것도 쓰지 않고 `EXIT_NOT_INTERACTIVE`로 끝납니다(D5). `--force`도 지문을 다시 고정하는 작업이므로 TTY를 요구합니다.
4. **비밀번호 입력** — `promptPassword()`로 raw 모드 무에코 읽기. 빈 비밀번호는 거부합니다. 답은 `Buffer`로 돌아옵니다.
5. **Windows ACL 하드닝 (키 생성 이전)** — `ensureKeysDir()` 후 `homePath()`와 `keysDirPath()` 각각에 `hardenWindowsAcl()`을 적용합니다. 실패하면 키를 만들지 않고 중단합니다.
6. **키 백업 + 생성** — `backupKeyPair(alias)`로 기존 쌍을 메모리에 백업한 뒤 `generateKeyPair(alias)`가 `~/.ssh-mcp/keys/<alias>`에 ed25519 쌍을 만듭니다. 개인키 `0600`, 공개키 `0644`.
7. **1차 접속(비밀번호 인증) + 지문 확인** — `defaultConnector`가 접속하고, `hostVerifier` 콜백 안에서 `sha256Fingerprint()`로 계산한 지문을 사람에게 보여줍니다(`confirmHostKey`). **`yes`를 정확히 입력해 승인한 뒤에야 비밀번호가 전송됩니다.**
8. **원격 설치** — `installAuthorizedKey()`가 `AUTHORIZED_KEYS_SCRIPT` 한 벌을 `exec`하고 공개키는 명령에 끼워 넣는 대신 **채널 stdin으로** 전달합니다.
9. **비밀번호 폐기** — `password.fill(0)`. 이후 재접속에는 비밀번호를 전혀 쓰지 않습니다.
10. **키 전용 재접속 검증** — 새 개인키만으로 다시 접속해 `VERIFY_COMMAND`를 실행하고 출력에 `ssh-mcp-ok`가 있고 종료 코드가 0인지 확인합니다.
11. **승인 폴백 선택** — `approvalFallback`에는 기본값이 없으므로 `promptChoice()`로 `token` / `fail-closed` 중 하나를 **사전 선택값 없이** 고르게 합니다(D3, `--approval-fallback`으로 미리 줄 수 있음).
12. **레지스트리 기록** — `store.save()`로 `hosts.json`에 항목을 추가합니다. 이것이 레지스트리에 쓰는 **처음이자 유일한** 지점이며, 이 단계 이전의 어떤 실패도 레지스트리를 건드리지 않습니다.
13. **완료 안내** — `doctor`의 `formatSnippets()`가 만든 클라이언트 등록 스니펫과, 그 뒤에 `config/registration.ts`의 `INSTALL_HINT`(`ssh-mcp install`로 자동 등록하라는 한 줄)를 출력합니다. `INSTALL_HINT`는 `formatSnippets()` **밖에** 있습니다 — 그 함수의 반환 문자열은 `tests/integration/doctor.test.ts`와 `doctor --json`이 고정하고 있기 때문입니다.

## Invariants & gotchas for AI agents

- **모든 출력은 stderr입니다.** `setup`은 서버가 아니지만 같은 습관을 공유해 stdout에 JSON-RPC 프레임 외에는 아무것도 남기지 않습니다(원칙 3). `doctor`가 stdout을 쓰는 것과 대비됩니다 — `setup`은 프롬프트와 보고가 뒤섞이기 때문입니다.
- **ACL 하드닝은 반드시 키 생성보다 먼저입니다.** 순서를 뒤집으면 두 번의 네트워크 왕복과 사람의 프롬프트가 진행되는 동안 상속된 NTFS ACL 아래에 암호화되지 않은 개인키가 놓입니다.
- **절반만 쓰인 상태를 남기지 마세요.** 키 생성 이후의 모든 실패 경로는 `finally`에서 `restoreKeyPair(backup)`으로 이전 키 상태를 정확히 되돌리고(원래 없던 파일은 삭제) `hosts.json`을 건드리지 않습니다. `succeeded` 플래그가 서는 시점은 마지막 `store.save()` 직후입니다(AC7.5, AC7.7).
- **`generateKeyPair()`는 새 쌍을 쓰기 전에 기존 파일을 `fs.rmSync`로 먼저 지웁니다.** `writeFileSync`가 기존 파일의 모드를 유지하기 때문에, 이전 실행에서 world-readable로 남은 파일이 그대로 재사용되는 것을 막기 위함입니다.
- **연결 확인은 보안 단계가 아니며 어떤 보안 단계도 대체하지 않습니다.** TCP 핸드셰이크에서 멈추고 SSH 배너·키 교환·지문을 보지 않습니다. 지문을 보여주고 `yes`를 받는 것, 그 뒤에야 비밀번호를 보내는 것은 전과 같은 자리에 그대로 있습니다. 앞에 "닿기는 하는가"가 하나 붙었을 뿐입니다.
- **대화형 질문은 기본값이 있는 것에만 씁니다.** `ask.ts`는 비밀번호, 지문 `yes` 확인, 승인 폴백 선택에 쓰지 않습니다 — 그 셋은 잘못 누른 Enter가 답이 되어서는 안 되는 결정이고, `@inquirer/select`는 항상 첫 항목을 강조하므로 D3(기본값 없음)에 애초에 맞지 않습니다. 그 셋은 `prompt.ts`가 계속 담당합니다.
- **위저드는 argv만 만듭니다.** 검증·기본값·이후 흐름을 복제하지 마세요. `runSetupWizard()`가 토큰을 돌려주고 `parseSetupArgs()`가 그것을 평소처럼 해석하는 구조라서, 인자를 친 경우와 답한 경우의 동작이 갈라질 수 없습니다.
- **위저드는 `--force`를 대신 적용하지 않습니다.** 이미 등록된 alias를 입력하면 재질문할 뿐입니다. 지문 재핀은 사람이 플래그를 직접 붙여야 하는 동작입니다.
- **`promptChoice`는 D3 그대로입니다 — 기본값 없음, 빈 입력은 재질문, 3회 실패하면 중단.** 옵션도 완화 장치도 없습니다. 기본값이 있는 질문은 전부 `ask.ts`의 목록으로 가므로 여기에 기본값을 끼워 넣을 이유가 없습니다. `tests/unit/setupPrompt.test.ts`가 이 동작을 고정합니다.
- **비대화형 실행은 지원하지 않습니다.** 비밀번호 프롬프트가 non-TTY stdin을 거부하며, `--approval-fallback`은 승인 질문만 건너뛸 뿐 이 요구를 해제하지 않습니다(D4, D5).
- **비밀번호는 `Buffer`로 다룹니다.** JavaScript 문자열은 지울 수 없기 때문입니다. 다만 `ssh2` 1.17.0의 `ConnectConfig.password`가 문자열만 받아 접속 시점에 문자열 복사본이 한 번 생기며, 이는 README의 "알려진 한계"에 명시된 잔여 위험입니다. 프롬프트 쪽 `Buffer` 처리를 문자열로 "단순화"하지 마세요.
- **muted read는 raw 모드를 씁니다.** raw 모드가 아니면 터미널 자체가 키 입력을 에코하며, 우리 쪽에서 아무리 조심해도 숨길 수 없습니다.
- **공개키는 stdin으로 전달합니다.** 명령 문자열에 보간하면 comment 필드·키 blob·적대적 alias가 셸 따옴표를 탈출할 수 있습니다. 멱등성은 `grep -qxF`(고정 문자열, 전체 줄 일치)가 보장하며, AC7.3이 `setup`을 두 번 돌려 줄 수를 세는 방식으로 검증합니다.
- **`AUTHORIZED_KEYS_SCRIPT`의 각 줄이 의미를 갖습니다.** `umask 077`, `~/.ssh` 700, `authorized_keys` 600, 그리고 `tail -c 1 | wc -l` 검사로 기존 파일이 줄바꿈으로 끝나지 않을 때 줄바꿈을 덧붙여 새 키가 옛 키 마지막 줄에 붙어버리는 일을 막습니다.
- **키에는 passphrase가 없습니다(의도적).** 서버가 무인으로 접속해야 하므로, 보호 경계는 POSIX에서는 파일 모드, Windows에서는 ACL입니다.
- **Windows ACL 실패는 `setup`을 중단시킵니다.** 초기 구현은 경고만 했는데 그것은 fail-open이었습니다 — 사용자는 동작하는 호스트 항목과 함께 기계의 누구나 읽을 수 있는 키를 갖게 됩니다. 적용 후 **다시 읽어서** 확인하며, `ALLOWED_FOREIGN_PRINCIPALS` 외의 주체가 남아 있으면 성공 보고가 있었어도 실패로 처리합니다.
- **키 쌍 건전성 검증은 계획에 없던 추가분입니다.** `ssh2` 1.17.0의 결함 때문에 생성 결과를 재파싱해 지문 일치를 확인하고 최대 `MAX_GENERATION_ATTEMPTS`(12)회 재시도합니다. 이 루프를 "불필요한 방어"로 제거하지 마세요.
- `Connector`, `KeyPairGenerator`, `IcaclsRunner`는 모두 주입 가능합니다. 테스트가 네트워크·실제 `icacls` 없이 실패 경로를 검증하는 통로이므로 주입 지점을 없애지 마세요.

## Testing

| Suite                            | 대상                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `tests/unit/keygen.test.ts`      | 키 생성·백업/복원·건전성 재시도                                  |
| `tests/unit/setupPrompt.test.ts` | 프롬프트(비-TTY 거부, raw 모드, Buffer 반환)                     |
| `tests/unit/setupWizard.test.ts` | 위저드가 답을 argv로 바꾸는 규칙, 재질문 조건, 플래그로 건너뛰기 |
| `tests/integration/auth.test.ts` | 키 설치와 인증 왕복                                              |

```bash
npm run test:unit
npm run test:integration
```

## Dependencies

### Internal

`../config/paths.js`, `../config/registration.js`, `../config/schema.js`, `../config/store.js`, `../doctor/checks.js`, `../errors.js`, `../log.js`, `../ssh/fingerprint.js`, `../ssh/reach.js`

### External

`ssh2`(`Client`, `utils.generateKeyPairSync`, `ClientChannel`, `ConnectConfig`), Node `node:fs`·`node:os`·`node:child_process`.

> **레이어 주의:** `config/paths.ts`가 `setup/winacl.ts`를 import 합니다. `winacl.ts`는 Node 빌트인 외에 아무것도 의존하지 않아야 순환이 생기지 않으므로, 여기에 `src/` 의존성을 추가하지 마세요.

<!-- MANUAL: -->
