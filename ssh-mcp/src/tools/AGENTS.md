<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# tools

## Purpose

MCP 도구 표면(수는 `audit.ts`의 `TOOL_NAMES`에서 파생)과 그들이 공유하는 래퍼가 있는 디렉터리입니다. **한 도구 = 한 파일**이 원칙이고, `server.ts`는 등록 순서만 결정합니다. 모든 도구 호출은 `wrap.ts`의 `runTool()`을 통과하므로 거부·확인요청·예외를 포함해 어떤 경로에서도 감사 줄이 정확히 하나 남고, 셸 명령을 다루는 두 도구(`exec`, `run_in_session`)는 `gated.ts`의 단일 구현을 공유해 동일 동작(AC18)을 보장합니다.

## Key Files

| File              | Description                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `define.ts`       | `ToolDefinition` 인터페이스(name / description / inputSchema / handler). 도구 하나가 파일 하나로 완결되게 만드는 계약입니다.                                                                  |
| `context.ts`      | 모든 도구가 공유하는 조회. `createToolContext()`, `requireConfig()`, `requireHost()`, `connectHost()`, `requireLocalPathAllowed()`, `observedCoverage()`, `realResolve()`/`isInside()`.       |
| `wrap.ts`         | 감사 래퍼. `runTool()`, `newAuditDraft()`, `applyHostToAudit()`, `applyGateToAudit()`, `applyOutputToAudit()`.                                                                                |
| `gated.ts`        | `exec`/`run_in_session`/전송이 공유하는 안전 경로. `approveCommand()`, `approveFileOperation()`, `commandResultBody()`, `sudoAskedForPassword()`, `timeoutMsFor()`, `BACKGROUND_JOB_WARNING`. |
| `annotations.ts`  | `TOOL_ANNOTATIONS`(§5.6)와 `toolMeta()`. `REQUIRE_USER_INTERACTION_ENV = 'SSH_MCP_REQUIRE_USER_INTERACTION'`, `INTERACTION_META_TOOLS = ['exec', 'run_in_session']`.                          |
| `listHosts.ts`    | `list_hosts`. `fingerprintPrefix()`가 지문을 앞 16자만 남깁니다.                                                                                                                              |
| `exec.ts`         | `exec`. 분류·승인을 먼저 하고 그다음 접속합니다.                                                                                                                                              |
| `upload.ts`       | `upload`. SFTP 전용이라 분류할 명령이 없고 항상 privileged 등급입니다.                                                                                                                        |
| `download.ts`     | `download`. `overwrite: true`면 destructive, 아니면 privileged.                                                                                                                               |
| `openSession.ts`  | `open_session`. 핸드셰이크에서 비지원 셸이면 슬롯을 소비하지 않고 `unsupported_shell`로 끝납니다.                                                                                             |
| `runInSession.ts` | `run_in_session`. `exec`와 같은 `gated.ts` 헬퍼를 씁니다. 토큰이 세션 id에도 바인딩됩니다.                                                                                                    |
| `closeSession.ts` | `close_session`. 이미 닫힌 세션은 오류가 아니지만, 발급된 적 없는 id는 오류입니다.                                                                                                            |
| `history.ts`      | `history`. 감사 로그를 최신순으로 페이징 조회(`../audit/reader.ts`, `../audit/cursor.ts`). 승인도 호스트도 필요 없는 read-only 도구입니다.                                                    |
| `fetchOutput.ts`  | `fetch_output`. `exec`/`run_in_session`가 발췌로 잘라낸 스트림 전문을 `../output/store.ts`에서 처음부터 순서대로 페이징. 마찬가지로 read-only입니다.                                          |

## Tool catalog

| MCP tool         | File              | What it does                                          | 승인 게이트                                        |
| ---------------- | ----------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `list_hosts`     | `listHosts.ts`    | 등록된 호스트 alias·접속정보·승인모드·폴백 반환       | 없음 (read-only)                                   |
| `exec`           | `exec.ts`         | 명령 1회 실행, stdout/stderr/exit code 분리 반환      | `approveCommand()` — 분류 후 등급에 따라           |
| `upload`         | `upload.ts`       | 로컬 → 원격 SFTP 전송 (원격 덮어쓰기)                 | `approveFileOperation()` — privileged              |
| `download`       | `download.ts`     | 원격 → 로컬 SFTP 전송 (기본 덮어쓰기 금지)            | `approveFileOperation()` — overwrite면 destructive |
| `open_session`   | `openSession.ts`  | 상태 유지 셸 세션 열기, 호스트당 5개·유휴 30분        | 없음                                               |
| `run_in_session` | `runInSession.ts` | 열린 세션 안에서 명령 실행                            | `approveCommand()` — `exec`와 동일                 |
| `close_session`  | `closeSession.ts` | 세션 닫기 (멱등)                                      | 없음                                               |
| `history`        | `history.ts`      | 감사 로그를 최신순·페이지 단위로 조회                 | 없음 (read-only)                                   |
| `fetch_output`   | `fetchOutput.ts`  | 발췌로 잘린 출력의 전문을 처음부터 페이지 단위로 조회 | 없음 (read-only)                                   |

`exec`와 `run_in_session`에만 `_meta: { 'anthropic/requiresUserInteraction': true }`가 붙습니다. `upload`/`download`의 `local_path`가 `~/.ssh-mcp` 안으로 해석되면 승인 절차와 **무관하게** `local_path_forbidden`으로 즉시 거부됩니다.

## How to add a new tool

도구 목록은 `audit.ts`의 `TOOL_NAMES`에서 파생되고, `server.ts`의 `assertRegisteredTools()`가 등록된 도구 집합이 그것과 정확히 일치하는지 기동 시 확인합니다. 따라서 도구를 추가하려면 먼저 `TOOL_NAMES`에 이름을 넣어야 등록이 통과합니다 — 개수를 손으로 어딘가에 갱신할 필요는 없습니다.

1. `src/tools/<name>.ts`를 만들고 `DESCRIPTION` 상수, zod `shape`(모든 필드에 `.describe()`), `handler`를 정의한 뒤 `ToolDefinition`으로 export 합니다.
2. 승인이 필요하면 `gated.ts`의 `approveCommand()`(명령형) 또는 `approveFileOperation()`(파일형)을 쓰세요 — 새 승인 로직을 직접 작성하면 AC18의 "동일 동작"이 깨집니다. 타입이 통과하려면 `safety/approval.ts`의 `GatedToolName` / `FileToolName` 유니온에 새 이름을 추가해야 합니다.
3. 로컬 경로를 받는다면 반드시 `requireLocalPathAllowed()`를 통과시킵니다.
4. `audit.ts`의 `TOOL_NAMES`에 이름을 추가합니다(정식 출처).
5. `annotations.ts`의 `TOOL_ANNOTATIONS`에 항목을 추가하고, 사람의 확인이 매번 필요하면 `INTERACTION_META_TOOLS`에도 넣습니다.
6. `server.ts`에서 `register(...)`로 등록합니다. 기대 집합은 `TOOL_NAMES`에서 자동으로 파생되므로 `assertRegisteredTools()`의 기대 개수를 따로 갱신할 필요가 없습니다 — 4번을 빠뜨리면 이 단언이 기동 시 실패로 잡아냅니다.
7. `README.md`의 도구 레퍼런스 표와 `tests/unit/toolsList.test.ts`를 갱신합니다.

## Invariants & gotchas for AI agents

- **감사는 `wrap.ts`에서만 기록합니다.** 도구가 각자 감사 줄을 쓰면, 정작 중요한 경로(거부·거절·`confirmation_required`·예기치 못한 throw)가 나중 수정에서 빠지게 됩니다. `AuditDraft`는 핸들러가 알게 된 것을 **그때그때 채우는 가변 객체**이며, 중간에 throw 되어도 호스트·명령·승인 결정은 기록에 남습니다.
- **분류·승인이 접속보다 먼저입니다.** `deny` 호스트는 채널이 열리는 것조차 보지 못해야 합니다. 이 순서를 바꾸면 거부된 명령이 네트워크에 도달합니다.
- **`exec`와 `run_in_session`은 구현을 공유해야 합니다.** 두 벌 구현은 AC18을 지킬 수 없습니다. 한쪽만 고치는 변경을 하지 마세요.
- **레지스트리는 매 호출 디스크에서 다시 읽습니다.** 캐시하지 않는 것이 의도입니다 — `hosts.json` 편집(특히 `approvalMode`를 **조이는** 편집)이 재시작 없이 즉시 반영돼야 하기 때문입니다.
- **`requireLocalPathAllowed()`는 우회 불가능한 하드 블록입니다.** `~/.ssh-mcp` 안으로 내려받으면 `hosts.json`을 전부 `approvalMode: auto`로 바꿔 이후 모든 승인을 무력화할 수 있습니다(F1). 경로 비교는 심볼릭 링크를 해소한 뒤(`realResolve`) `isInside`로 합니다.
- **어노테이션은 보안 경계가 아닙니다.** SDK 문서 자체가 클라이언트는 신뢰할 수 없는 서버의 어노테이션을 믿어선 안 된다고 명시합니다. 유일한 예외가 `requiresUserInteraction`이며, Claude Code에서만 강제력이 있습니다.
- **`requiresUserInteraction`을 읽기 전용 도구에 붙이지 마세요.** 모든 호출에 확인창이 뜨면 사람이 무조건 클릭하는 습관이 들고, 그것이 정작 중요한 두 도구의 방어를 무너뜨립니다.
- **`list_hosts`는 비밀키 경로와 지문 전문을 반환하지 않습니다.** 모델에게 쓸모가 없고, 지문은 앞 16자면 사람이 알아볼 수 있습니다.
- **`upload`/`download`의 덮어쓰기 비대칭은 의도된 것**입니다. 원격은 작업 사본이고 로컬은 실수를 되돌릴 수 없는 쪽입니다. 두 도구의 설명문에 모두 명시돼 있습니다.
- **`close_session`의 멱등성에는 경계가 있습니다.** 이미 닫힌 세션(`session_expired`/`session_terminated`)은 오류가 아니라 `already_closed: true`로 응답하지만, **발급된 적 없는 id는 오류**입니다 — 오타에 "닫았다"고 답하면 모델에게 존재하지 않던 세션이 있었다고 알려주는 셈입니다.
- **`download` 응답의 `overwritten`은 호출자가 넘긴 플래그가 아니라 실측값입니다**(CR-4). 존재하지 않던 경로로 받으면 `overwrite: true`를 넘겼어도 `overwritten: false`입니다. 이 필드를 입력 플래그로 되돌리면 "무엇이 실제로 교체됐는가"를 감사에서 알 수 없게 됩니다.
- **`commandResultBody()`는 stdout/stderr에 `redact(value, { maxStringBytes: null })`를 씁니다.** 마스킹만 하고 길이는 자르지 않습니다 — 일반 `toToolResult`의 2 KiB 상한을 여기에 적용하면 §5.8이 만든 발췌를 마지막 단계에서 통째로 버리게 됩니다(F17, AC12 위반).
- **`classification_coverage`는 `exec`/`run_in_session` 응답에만 붙습니다.** `open_session` 성공 응답에는 없습니다.
- 핸들러는 SDK가 이미 검증한 shape를 `z.object(shape)`로 다시 파싱합니다. 중복처럼 보이지만 `registerTool` 콜백 타입이 shape에 대한 조건부 타입이라, 이 재진술이 등록 헬퍼를 제네릭 없이 유지하게 해 줍니다.

## Testing

| Suite                                                          | 대상                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `tests/unit/toolsList.test.ts`                                 | `TOOL_NAMES` 전체의 등록·이름·어노테이션·설명문       |
| `tests/unit/audit.test.ts`                                     | 감사 레코드 형태                                      |
| `tests/integration/approval.test.ts`                           | 승인 분기 전체                                        |
| `tests/integration/audit.test.ts`                              | 호출 경로별 감사 1줄 보장                             |
| `tests/integration/transfer.test.ts`, `sftp.test.ts`           | `upload`/`download` 및 경로 차단                      |
| `tests/integration/exec.test.ts`, `session.test.ts`            | `exec` / 세션 도구                                    |
| `tests/unit/history.test.ts`, `tests/unit/fetchOutput.test.ts` | `history` / `fetch_output` 핸들러                     |
| `tests/integration/output.test.ts`                             | `output_ref` 왕복 (excerpt → 스토어 → `fetch_output`) |

```bash
npm run test:unit
npm run test:integration
```

## Dependencies

### Internal

`../audit.js`, `../audit/{cursor,reader}.js`, `../config/{paths,schema,state,store}.js`, `../errors.js`, `../log.js`, `../output/store.js`, `../safety/approval.js`, `../ssh/{exec,excerpt,pool,session,sftp,shellDetect}.js`

### External

`zod`, `@modelcontextprotocol/sdk/types.js`(`ToolAnnotations`), `ssh2`(타입), Node `node:fs`·`node:path`.

<!-- MANUAL: -->
