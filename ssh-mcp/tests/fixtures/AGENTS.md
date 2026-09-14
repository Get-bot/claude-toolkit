<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# fixtures

## Purpose

세 테스트 레그가 공유하는 하네스입니다. 실제 SSH 프로토콜을 말하는 인프로세스 서버, 우리 서버에 연결된 진짜 MCP SDK 클라이언트, 런타임 키 생성기, 임시 홈 격리, 엔드포인트 파라미터화, 그리고 자식 프로세스로 서버를 띄우는 stdio 드라이버가 여기 있습니다. 테스트 파일이 각자 하네스 사본을 갖지 않게 하는 것이 목적이며, 실제로 `package.test.ts`와 `realHost.test.ts`가 stdio 드라이버 사본을 따로 갖고 있다가 서로 어긋난 사건이 `stdioServer.ts`가 생긴 계기입니다.

## Key Files

| File             | Description                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sshServer.ts`   | 인프로세스 ssh2 서버. `startSshFixture(options)` → `SshFixture`. `exec`/`shell` 채널을 실제 셸 자식 프로세스에 연결하고, 서버만 알 수 있는 사실(시도된 인증 방법, 지문 불일치 후 명령 미전송)을 `FixtureEvent`로 관측하게 해 줍니다. `resolveShellPath()`, `ScriptedResponse`, `ShellEmulation`. |
| `endpoints.ts`   | 엔드포인트 파라미터화. `startEndpoint()`, `currentEndpointKind()`(`ENDPOINT` 환경변수 → `fixture` \| `sshd`), `shellUnderTest()`/`shellAvailable()`(`SHELL_UNDER_TEST`), `hostEntryFor()`, `authorizeKey()`, `FIXTURE_USER`/`FIXTURE_PASSWORD`.                                                  |
| `mcpClient.ts`   | `InMemoryTransport`로 우리 서버에 연결된 SDK 클라이언트. `startMcpTestClient(options)` → `McpTestClient`, `writeRegistry()`. elicitation은 `ElicitationMode`/`ElicitAnswer`로 스크립팅하고 `ElicitRequestSeen`으로 관측합니다. `ToolCallOutcome`.                                                |
| `hostKeys.ts`    | 런타임 키 생성. `generateHostKey()`, `generateClientKey()` → `FixtureKeyPair`. **키를 저장소에 커밋하지 않습니다** — 시크릿 스캐너에 걸리고 §8.6의 "트리에 PEM 헤더 0개" 기대가 깨지기 때문이며, ed25519 생성은 즉시 끝나므로 얻는 것도 없습니다.                                                |
| `tmpHome.ts`     | 홈 디렉터리 격리. `createTmpHome(prefix)` → `TmpHome`이 `HOME`·`USERPROFILE`·`SSH_MCP_HOME`을 임시 디렉터리로 돌립니다. `assertNoWritesOutside(home)`, `inTmpHome(home, ...segments)`.                                                                                                           |
| `stdioServer.ts` | 자식 프로세스로 서버를 띄우는 stdio 드라이버. `launchStdioServer(launch)`, `npxLaunch()`, `sendFrame()`, `waitForResponse()`, `describeFate()`, `MCP_PROTOCOL_VERSION`, `RESPONSE_TIMEOUT_MS`.                                                                                                   |

## Usage patterns

| 사용처                                    | 쓰는 픽스처                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/**`                    | `startEndpoint()`, `startMcpTestClient()`, `writeRegistry()`, `createTmpHome()`, `hostEntryFor()`, `authorizeKey()`, `generateHostKey()`/`generateClientKey()` |
| `tests/integration/session.test.ts`       | 추가로 `shellUnderTest()`, `shellAvailable()`, `resolveShellPath()`                                                                                            |
| `tests/e2e/**`                            | `launchStdioServer()`, `npxLaunch()`, `sendFrame()`, `waitForResponse()`, `describeFate()`                                                                     |
| `tests/unit/hostKeys.test.ts`             | `generateHostKey()`/`generateClientKey()`의 검증 루프 자체가 검사 대상                                                                                         |
| `tests/unit/{audit,store,keygen}.test.ts` | `createTmpHome()`, `inTmpHome()`, `assertNoWritesOutside()`                                                                                                    |

## Invariants & gotchas for AI agents

- **픽스처 사본을 만들지 마세요.** 테스트 파일에 하네스를 복제하면 반드시 갈라집니다 — `stdioServer.ts`가 존재하는 이유가 정확히 그 사고입니다. 필요한 기능이 없으면 픽스처를 확장하세요.
- **키는 런타임 생성이고 커밋 대상이 아닙니다.** 저장소에 PEM이 들어가면 시크릿 스캐너가 반응하고 §8.6 기대가 깨집니다.
- **ssh2 1.17.0은 약 130회에 1번꼴로 불량 ed25519 쌍을 반환합니다**(측정: 2000회 중 14회). `hostKeys.ts`의 검증 루프가 이를 걸러내며, 이 루프를 제거하면 전체 스위트가 이따금 이유 없이 붉어집니다.
- **`createTmpHome()`은 세 환경변수를 모두 돌려야 합니다.** `HOME`만 바꾸면 Windows에서 새고, `SSH_MCP_HOME`만 바꾸면 `os.homedir()`를 직접 쓰는 코드 경로가 샙니다. 테스트 후 `assertNoWritesOutside()`로 실제로 새지 않았음을 증명하세요.
- **포트를 하드코딩하지 마세요.** 픽스처는 `server.listen(0, '127.0.0.1')`으로 임의 포트를 바인딩한 뒤 실제 할당 포트를 읽습니다. `startSshFixture()`가 준 포트를 받아 쓰세요.
- **`sshServer.ts`에는 `connection.on('error', ...)` 핸들러가 필수입니다.** 클라이언트가 호스트 키를 거부하면 ssh2가 서버 쪽에서 `error`를 emit 하는데, 리스너가 없으면 EventEmitter가 이를 uncaught exception으로 승격시켜 테스트 파일 전체가 죽습니다 — 그런데 그 거부 상황 자체가 AC7.5/AC9/AC21.4의 검증 대상입니다.
- **`homeDir`는 레거시 별칭입니다.** 로컬 파일 조작에는 `localSandboxDir`, 원격 경로에는 `remoteHomeDir`을 쓰세요. fixture 티어에서는 셋이 같은 디렉터리지만 sshd 티어에서는 물리적으로 다른 머신을 가리킵니다(CR-2 회귀 가드).
- **`authorizeKey()`는 `kind === 'sshd'`에서 명시적으로 throw 합니다.** 실제 sshd 티어에서는 키를 반드시 실제 SSH 경로로 심어야 합니다.
- fixture 티어는 `ownsHomeDir`일 때(옵션으로 넘겨받은 디렉터리가 아닐 때)만 `close()`에서 정리하고, sshd 티어는 `localSandboxDir`만 지우며 원격 `$HOME`은 절대 건드리지 않습니다.
- **정리는 반드시 수행합니다.** `SshFixture`와 `McpTestClient`, `StdioServer`는 모두 닫아야 합니다. 남은 자식 프로세스나 소켓은 vitest를 매달아 둡니다.
- **자식 프로세스의 죽음은 타임아웃보다 먼저 보고돼야 합니다.** `describeFate()`가 종료 코드·시그널·stderr 꼬리를 붙입니다. `close` 이벤트를 쓰는 이유는 `exit`이 stdio 파이프가 비워지기 전에 발생해 정작 원인을 설명하는 stderr가 빠지기 때문입니다.
- **`ENDPOINT=sshd`는 인프로세스 픽스처만 관측 가능한 단언을 통과시키지 못합니다.** 엔드포인트별로 어떤 단언이 유효한지 구분해 두세요.

## Running

픽스처 자체는 테스트가 아닙니다. `vitest.config.ts`의 `include`는 `tests/unit/**/*.test.ts`와 `tests/integration/**/*.test.ts`뿐이므로 이 디렉터리의 파일은 직접 실행되지 않고 import 될 뿐입니다.

## Dependencies

### Internal

`src/server.js`, `src/config/*`(레지스트리 작성), `src/ssh/fingerprint.js` 등 — 검증 대상 모듈을 직접 import 합니다.

### External

`ssh2`(`Server`, `utils`), `@modelcontextprotocol/sdk`(`Client`, `InMemoryTransport`), `vitest`(타입), Node `node:child_process`·`node:fs`·`node:os`·`node:path`·`node:crypto`.

<!-- MANUAL: -->
