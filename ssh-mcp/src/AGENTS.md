<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# src

## Purpose

ssh-mcp 서버 구현 전체가 있는 디렉터리입니다. 최상위 파일들은 진입점(`index.ts`)과 서버 부트스트랩(`server.ts`), 그리고 모든 레이어가 공유하는 횡단 관심사 — 로깅·비밀정보 마스킹(`log.ts`), 감사 로그(`audit.ts`), 오류 코드 분류체계(`errors.ts`), 버전 조회(`version.ts`) — 를 담당합니다. 실제 기능은 하위 디렉터리로 나뉩니다: 설정 저장소(`config/`), 명령 분류와 승인(`safety/`), SSH/SFTP 전송(`ssh/`), MCP 도구 표면(`tools/`), 호스트 등록 CLI(`setup/`), 진단 CLI(`doctor/`).

## Key Files

| File         | Description                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | bin 진입점. Node 20 이상 가드 후 argv 라우팅(`setup` / `doctor` / `--version`·`-v`·`version` / 그 외는 서버). `run(argv)`, `MIN_NODE_MAJOR` export. 서브커맨드 모듈은 **동적 import**입니다.                                 |
| `server.ts`  | `createServer()`가 정확히 7개 도구를 등록하고 `assertSevenTools()`로 기동 시 검증합니다. `startServer()`는 stdio 전송을 연결하고, `supportsFormElicitation()`이 클라이언트의 elicitation 지원 여부(Branch A/B)를 판정합니다. |
| `audit.ts`   | `~/.ssh-mcp/audit.jsonl`에 도구 호출당 정확히 한 줄. `TOOL_NAMES`(7개 도구의 정식 목록), `APPROVAL_OUTCOMES`(8가지), `AUDIT_SCHEMA_VERSION`의 출처.                                                                          |
| `log.ts`     | stderr 전용 구조화 로거 + 공유 redaction. `logger`, `redact`/`redactRecord`, `truncateUtf8`, `installStdoutGuard`/`captureProcessStdout`/`protocolStdoutStream`.                                                             |
| `errors.ts`  | `ERROR_CODES` 상수와 도구 응답 봉투. 계획서 §5.3 표를 그대로 옮긴 것이며, 같은 상황에 새 코드를 만들어 쓰면 안 됩니다.                                                                                                       |
| `version.ts` | `readPackageVersion()` — `dist/index.js`와 `src/*.ts` 양쪽 위치에서 `package.json`을 찾습니다. 실패 시 `UNKNOWN_VERSION`을 반환하고 절대 throw 하지 않습니다.                                                                |

## Subdirectories

| Directory   | Purpose                                                            |
| ----------- | ------------------------------------------------------------------ |
| `config/`   | `hosts.json`·`state.json` 스키마와 영속화 (see `config/AGENTS.md`) |
| `doctor/`   | `ssh-mcp doctor` 진단 CLI (see `doctor/AGENTS.md`)                 |
| `internal/` | 의존성 0인 최하단 유틸리티 (see `internal/AGENTS.md`)              |
| `safety/`   | 명령 정규화·분류·승인 게이트·토큰 (see `safety/AGENTS.md`)         |
| `setup/`    | `ssh-mcp setup` 호스트 등록 CLI (see `setup/AGENTS.md`)            |
| `ssh/`      | SSH/SFTP 전송, 연결 풀, 세션 (see `ssh/AGENTS.md`)                 |
| `tools/`    | MCP 도구 7종과 공용 래퍼 (see `tools/AGENTS.md`)                   |

## Architecture

요청 한 건이 지나가는 경로입니다.

```
MCP client
  └─ server.ts (registerTool)
       └─ tools/wrap.ts  runTool()        ← 감사 1줄 보장 + 오류 봉투
            └─ tools/<tool>.ts handler
                 ├─ tools/context.ts      ← config/state/pool 조회
                 ├─ tools/gated.ts        ← safety/approval 게이트 통과
                 │    └─ safety: normalize → classify → approval(→ tokens)
                 └─ ssh/: pool → exec | session | sftp → excerpt → error 매핑
```

- **레이어 규칙.** `internal/`은 아무것도 import 하지 않고, `log.ts`/`config/`/`audit.ts`는 `internal/`만 바라봅니다. `tools/`는 `safety/`와 `ssh/`를 쓰지만 그 반대는 없습니다. 이 방향을 뒤집으면 순환 참조가 생깁니다.
- **도구 개수는 7로 고정.** `assertSevenTools()`가 기동 시 실패시킵니다 — "아무도 합의하지 않은 도구 표면"이 조용히 노출되는 것보다 기동 실패가 낫다는 판단입니다.

## For AI Agents

### Working In This Directory

- **stdout은 서버 모드에서만 JSON-RPC 전용입니다.** `startServer()`는 `installStdoutGuard()`를 가장 먼저 호출하고, 그 다음 `protocolStdoutStream()`으로 진짜 writer를 확보한 뒤 `captureProcessStdout()`으로 나머지를 stderr로 돌립니다. **이 순서를 바꾸면 서버 응답 자체가 stderr로 새어 나갑니다.** `setup`·`doctor`·`--version` 경로는 가드를 설치하지 않고 정상적으로 stdout에 씁니다.
- **오류 코드를 새로 만들지 마세요.** `ERROR_CODES`에 이미 있는 상황이면 그것을 쓰고, 정말 새 상황이면 왜 기존 코드로 부족한지를 주석에 남기세요(기존 추가분 `connection_failed`, `local_path_forbidden`, `internal_error`가 그 선례입니다).
- **`command_denied`를 남용하지 마세요.** 이 코드는 `deny` 모드이거나 사람이 명시적으로 거절한 경우 전용입니다. 토큰 검증 실패는 `confirmation_token_invalid`/`_used`/`_expired`/`_mismatch`로 구분해야 로그에서 "승인 절차가 실패했다"와 "사람이 거절했다"를 나눌 수 있습니다.
- **`TOOL_NAMES`는 `audit.ts`가 정식 출처**입니다. 도구 이름 배열을 다른 곳에 다시 타이핑하지 말고 import 하세요.
- **감사 쓰기 실패는 도구 호출을 막지 않습니다**(의도된 트레이드오프). 이 동작을 "고치는" 변경은 README의 "알려진 한계"와 충돌하므로 먼저 논의가 필요합니다.
- **`index.ts`를 import 하지 마세요.** import 하는 순간 CLI가 다시 실행됩니다. 버전이 필요하면 `version.ts`를 씁니다 — 이 모듈이 분리된 이유가 정확히 그것입니다.
- **감사 줄의 축소 순서는 고정입니다.** 16 KiB 상한을 넘으면 `TRUNCATION_ORDER = ['command', 'segments', 'normalized_command', 'reasons']` 순으로 줄이며, 이 순서를 바꾸면 AC20.9 위반입니다. 로테이션은 `DEFAULT_AUDIT_THRESHOLDS`(`rotateBytes` 10 MiB, `statIntervalBytes` 1 MiB, `keepFiles` 4)를 따라 `.1`~`.3`으로 순환하고, 매 append마다 stat하지 않습니다.
- **`server_cannot_verify_human_approval`은 `approval_outcome === 'token-approved'`일 때 `appendAudit`이 강제로 `true`로 덮어씁니다.** 호출자가 `false`를 넘겨도 무시됩니다(§5.10 설계 의도).
- 로그 필드는 `MAX_LOG_FIELD_BYTES`(2 KiB)로 잘리고 `SENSITIVE_KEY_PATTERN`에 걸리는 키는 통째로 `[redacted]`가 됩니다. 새 로그 필드를 추가할 때 그 이름이 이 패턴에 걸리는지 확인하세요. 레벨은 `SSH_MCP_LOG_LEVEL`(기본 `info`)로 제어하며 `setLogLevel()`이 이를 덮어씁니다.
- **`confirmation_token` 같은 값을 응답에 남기려면 `preserveKeys`가 필요합니다.** `redact()`는 `/token/i` 키를 자동 마스킹하므로 명시하지 않으면 값이 통째로 `[redacted]`가 됩니다. `preserveKeys`를 써도 PEM 마스킹과 `PRESERVED_VALUE_MAX_BYTES`(32 KiB) 상한은 그대로 적용됩니다.

### Testing Requirements

```bash
npm run typecheck
npm test                  # unit + integration
npm run test:unit
npm run test:integration
```

최상위 파일들을 직접 겨냥하는 테스트: `tests/unit/audit.test.ts`, `tests/unit/redact.test.ts`, `tests/unit/errors.test.ts`, `tests/unit/toolsList.test.ts`, `tests/integration/audit.test.ts`, `tests/integration/startupWarnings.test.ts`.

### Common Patterns

- 파일 상단 블록 주석에 **설계 근거와 계획서 참조(plan row, AC 번호, ADR, CR/F 번호)** 를 남깁니다. 새 파일도 같은 형식을 따르세요.
- 상대 import에는 `.js` 확장자를 붙입니다(`NodeNext`).
- 타입만 필요하면 `import type`.
- 입력 검증은 `zod`, 내부 불변식은 assert 함수(`assertSevenTools` 같은)로 기동 시 확인합니다.

## Dependencies

### External

- `@modelcontextprotocol/sdk` — `McpServer`, `StdioServerTransport`, `ClientCapabilities`, elicitation
- `ssh2` — SSH/SFTP 클라이언트 (`ssh/`, `setup/`, `doctor/`에서 사용)
- `zod` — `config/schema.ts`, 도구 입력 스키마, 감사 레코드 검증
- Node 빌트인: `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:url`, `node:stream`, `node:console`, `node:child_process`

<!-- MANUAL: -->
