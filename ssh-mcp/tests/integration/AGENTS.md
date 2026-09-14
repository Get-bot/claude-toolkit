<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# integration

## Purpose

실제 SSH 프로토콜을 말하는 인프로세스 ssh2 서버와, `InMemoryTransport`로 우리 서버에 연결된 진짜 MCP SDK 클라이언트를 띄워 **호출 경로 전체**를 검증하는 레그입니다. 핸들러를 직접 부르는 대신 `tools/list`·`tools/call`·`elicitation/create`를 통과시키는 이유는, 가장 검증할 가치가 있는 부분(`_meta` 왕복, Branch A/B를 결정하는 capability 선언, 호출당 감사 1줄)이 요청이 프로토콜을 거친 뒤에야 존재하기 때문입니다. 픽스처 서버의 `exec`/`shell` 채널은 실제 셸 자식 프로세스에 연결돼 있어 `cd`·`export` 같은 상태 단언이 의미를 갖습니다.

## Key Files

| File                      | Description                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval.test.ts`        | §5.5 표를 **실행**합니다. 모드 × 등급 × elicitation 지원 × 폴백의 모든 조합을 `exec`와 `run_in_session` 양쪽으로 돌리고, 각 칸의 기대값은 `expectedOutcome()`이 계산합니다. |
| `audit.test.ts`           | 모든 도구 호출이 모든 결과에서 정확히 한 줄을 남기고, 2단계 승인은 두 줄을 순서대로 남긴다는 것                                                                             |
| `auth.test.ts`            | 살아 있는 엔드포인트 상대의 `setup` 전 과정 — 키 생성, 원격 `authorized_keys` 설치, 키 전용 재접속, 원자적 레지스트리 기록                                                  |
| `doctor.test.ts`          | `doctor`의 종료 코드 규칙(호스트 없는 깨끗한 기계는 0, WARN은 실패 아님, 깨진 레지스트리·도달 불가 호스트는 1)                                                              |
| `exec.test.ts`            | 1회 실행(AC10~AC12). 서버 쪽을 관측해야 하는 단언은 `runIf(fixture)`, 실제 프로세스 정리가 필요한 단언은 `runIf(sshd)`                                                      |
| `session.test.ts`         | 실제 셸 상대의 상태 유지 세션. `SHELL_UNDER_TEST`로 bash/dash/zsh를 고르고, 설치되지 않은 셸의 레그는 **가짜로 통과시키지 않고 skip**                                       |
| `sftp.test.ts`            | 전송 왕복. 크기가 아니라 **SHA-256**으로 바이트 정확성을 확인                                                                                                               |
| `transfer.test.ts`        | 전송 경로 봉쇄와 승인(F1, F15). `~/.ssh-mcp` 하위는 `local_path_forbidden`으로 즉시 거부                                                                                    |
| `output.test.ts`          | 발췌된 출력이 도구 경계를 넘어 그대로 살아남는지(F17). 응답 본문이 2 KiB 로그 상한에 걸려 잘리던 회귀의 가드                                                                |
| `secrets.test.ts`         | 센티넬 비밀번호로 `setup`을 돌린 뒤 도구 응답·stderr·`audit.jsonl` 세 싱크 어디에도 비밀이 남지 않음을 확인(AC19)                                                           |
| `startupWarnings.test.ts` | 서버가 자기 약점에 대해 내는 경고(R12, M6, D2, F10)가 **정확히 한 번씩** 나오고, 해당 호스트를 지목하며, 해당 없을 땐 나오지 않는지                                         |

## Conventions & setup

- **엔드포인트 파라미터화** — `tests/fixtures/endpoints.ts`의 `startEndpoint()`로 서버를 얻습니다. `currentEndpointKind()`가 `ENDPOINT` 환경변수를 읽어 `fixture`(기본) 또는 `sshd`를 고릅니다(ADR-002, OPT-3). 인프로세스 픽스처만이 프로토콜 수준 사실(시도된 인증 방법, 지문 불일치 후 명령 미전송)을 관측할 수 있습니다.
- **MCP 클라이언트** — `tests/fixtures/mcpClient.ts`의 `startMcpTestClient()`가 `InMemoryTransport`로 연결된 SDK 클라이언트를 주고, `writeRegistry()`가 테스트용 `hosts.json`을 씁니다. elicitation 응답은 `ElicitationMode`/`ElicitAnswer`로 스크립팅합니다.
- **홈 격리** — `tests/fixtures/tmpHome.ts`의 `createTmpHome()`이 `HOME`·`USERPROFILE`·`SSH_MCP_HOME`을 임시 디렉터리로 돌리고, `assertNoWritesOutside()`가 벗어난 쓰기가 없음을 증명합니다. `inTmpHome()`으로 경로를 만듭니다.
- **키 재료** — `tests/fixtures/hostKeys.ts`의 `generateHostKey()`/`generateClientKey()`가 런타임에 생성합니다. 저장소에 키를 커밋하지 않습니다.
- **호스트 항목** — `hostEntryFor()`로 레지스트리 항목을 만들고 `authorizeKey()`로 픽스처 서버에 공개키를 등록합니다.
- 타임아웃은 `vitest.config.ts`의 30초(`testTimeout`/`hookTimeout`)입니다.

## Invariants & gotchas for AI agents

- **정리 순서가 고정입니다.** `afterAll`에서 `resetSessions()` → `closeAll()` → `endpoint.close()` → `assertNoWritesOutside()` → `home.cleanup()`. 세션이 풀에 의존하므로 `resetSessions()`가 `closeAll()`보다 **먼저**여야 하고, `assertNoWritesOutside()`는 환경변수를 복원하는 `cleanup()`보다 먼저여야 합니다. `afterEach`에서는 `clearTokens()`로 토큰 저장소를 비웁니다. 순서가 어긋나면 다음 테스트에 유령 프로세스나 유령 연결이 남습니다.
- **절대 실제 `~/.ssh-mcp`를 건드리지 마세요.** 개발자의 실제 키·레지스트리를 망가뜨립니다. 새 테스트도 반드시 `createTmpHome()`을 통과시키세요.
- **설치되지 않은 셸은 skip 하되 가짜로 통과시키지 마세요.** `shellAvailable()`로 확인하고 없으면 skip 합니다. "통과한 것처럼" 보이게 만들면 `shell-matrix` CI 잡이 아무것도 증명하지 못합니다.
- **엔드포인트별 단언을 뒤섞지 마세요.** `runIf(fixture)`/`runIf(sshd)` 표시는 그 단언이 해당 티어에서만 의미가 있다는 뜻입니다.
- **승인 테이블은 코드로 계산합니다.** `expectedOutcome()`을 우회해 각 칸에 하드코딩된 기대값을 적으면 표와 구현이 조용히 갈라집니다.
- **`exec`와 `run_in_session`은 항상 둘 다 돌려야 합니다.** AC18이 요구하는 동일 동작은 한쪽만 검증해서는 증명되지 않습니다.
- **플랫폼 차이는 실패가 아니라 skip입니다.** 심볼릭 링크 테스트(`sftp.test.ts`, `transfer.test.ts`)는 개발자 모드가 없는 Windows에서 동작하지 않으므로 `SYMLINKS_SUPPORTED`를 실행 시점에 프로브해 `it.runIf`로 건너뜁니다. Windows ACL(icacls) 테스트는 `skipIf(platform !== 'win32')`, POSIX 모드(0600/0700) 테스트는 그 반대입니다.
- **`localSandboxDir`와 `remoteHomeDir`을 구분하세요.** fixture 티어에서는 같은 디렉터리지만 sshd 티어에서는 다른 머신입니다 — 로컬 파일 조작에는 항상 `localSandboxDir`을 씁니다(CR-2 회귀 가드).
- **스크립트된 프롬프트는 순서에 민감합니다.** `auth.test.ts`/`secrets.test.ts`는 `scripted()` 헬퍼로 PassThrough에 답변을 미리 채웁니다 — 비밀번호 → 호스트 키 `yes` → 승인 폴백 선택 순서가 어긋나면 전혀 엉뚱한 곳에서 실패합니다.
- 포트는 픽스처가 할당합니다. 고정 포트를 하드코딩하면 병렬 실행과 CI에서 충돌합니다.
- 비밀정보 테스트는 **센티넬 문자열 탐색** 방식입니다. 새 출력 경로(새 로그 필드, 새 응답 필드)를 추가하면 `secrets.test.ts`의 싱크 목록도 함께 늘려야 합니다.

## Running

```bash
npm run test:integration            # ENDPOINT=fixture (기본)
ENDPOINT=sshd npm run test:integration
SHELL_UNDER_TEST=dash ENDPOINT=fixture npx vitest run tests/integration/session.test.ts
```

CI에서는 `build-test` 잡이 `ENDPOINT=fixture`로 전체를 돌리고, `shell-matrix` 잡(ubuntu)이 zsh·busybox를 설치한 뒤 `session.test.ts`를 셸별로 반복합니다.

## Dependencies

### Internal

`src/` 전체와 `tests/fixtures/{endpoints,hostKeys,mcpClient,sshServer,tmpHome}.ts`.

### External

`vitest`, `ssh2`, `@modelcontextprotocol/sdk`(`InMemoryTransport`, `Client`), Node `node:crypto`·`node:fs`·`node:path`.

<!-- MANUAL: -->
