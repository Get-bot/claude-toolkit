<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# doctor

## Purpose

`ssh-mcp doctor` 진단 CLI입니다. 15가지 점검을 독립적인 `{ id, name, run() }` 삼중항으로 정의하고 표 또는 `--json`으로 출력합니다. 렌더러가 각 점검의 내용을 알 필요가 없도록 분리돼 있어 `--json`이 목록을 그대로 직렬화할 수 있습니다(AC21.8). 이 패키지에서 **유일하게 stdout으로 출력하는 부분**입니다 — "stdout은 JSON-RPC 전용"이라는 원칙은 서버 모드에 적용되며 `doctor`는 전송을 연결하지 않고, 진단 표는 사용자가 파이프하고 리다이렉트하고 붙여넣는 것이기 때문입니다.

## Key Files

| File        | Description                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks.ts` | 점검 정의 전체. `CHECK_KINDS`(15종, 표 순서), `PER_HOST_KINDS`(6종), `buildChecks(options)`, `runChecks()`, `defaultHostProber`, `loadPatternRows()`, `buildSnippets()`/`formatSnippets()`. |
| `cli.ts`    | argv 파싱과 렌더링. `parseDoctorArgs()`, `runDoctor(argv, options)`, `USAGE`, 종료 코드 상수 `EXIT_OK=0` / `EXIT_CHECK_FAILED=1` / `EXIT_USAGE=2`.                                          |

## What checks exist

`CHECK_KINDS`는 §5.11의 표 순서 그대로입니다. `PER_HOST_KINDS`에 속한 6종은 등록된 alias마다 한 행씩 생성되며, 레지스트리가 비어 있어도 각 종류가 정보성 행 하나를 내므로 표에는 항상 15종이 모두 나타납니다(AC21.1).

| Check id             | 대상         | 확인 내용 / 실패 조건                                                                           |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `node-version`       | 환경         | Node 메이저 버전 ≥ `MIN_NODE_MAJOR`(20)                                                         |
| `ssh2-load`          | 환경         | `ssh2` 로드 가능 여부. 선택적 네이티브 가속(`cpu-features`) 부재는 **정보이지 실패가 아닙니다** |
| `home-layout`        | 파일시스템   | `~/.ssh-mcp` 레이아웃. 없으면 **생성**하며, 생성 자체가 실패할 때만 FAIL                        |
| `file-permissions`   | 파일시스템   | 상태 파일·키의 권한(POSIX 모드 / Windows ACL)                                                   |
| `hosts-schema`       | 설정         | `hosts.json` 파싱·스키마 검증                                                                   |
| `audit-log`          | 파일시스템   | `audit.jsonl` 존재·권한·쓰기 가능 여부                                                          |
| `host-key-file`      | **호스트별** | `privateKeyPath`의 존재와 읽기 가능 여부                                                        |
| `host-tcp`           | **호스트별** | TCP 접속 가능 여부 (예산 `HOST_PROBE_TIMEOUT_MS` = 5000ms)                                      |
| `host-fingerprint`   | **호스트별** | 서버 호스트 키 지문이 핀과 일치하는지                                                           |
| `host-auth`          | **호스트별** | 공개키 인증 성공 여부 — **인증에서 멈추고 연결을 즉시 닫습니다**                                |
| `host-approval`      | **호스트별** | `approvalMode`/`approvalFallback` 조합의 실질적 의미                                            |
| `client-elicitation` | 관측값       | `state.json`의 `lastClient`가 elicitation을 지원했는지                                          |
| `host-shell`         | **호스트별** | `state.json`의 `observedShells` 기준 분류 커버리지(`reduced` 여부)                              |
| `patterns`           | 분류기       | 컴파일된 패턴 표와 `ARGV_RULES` 목록, 핵심 패턴 무결성                                          |
| `snippets`           | 안내         | Claude Desktop / Claude Code 등록 스니펫 출력                                                   |

## Invariants & gotchas for AI agents

- **원격 명령을 절대 실행하지 않습니다.** 호스트 프로브는 인증까지만 진행하고 즉시 연결을 닫습니다(AC21.5). 진단이 부작용을 만들면 안 됩니다.
- **`~/.ssh-mcp`가 없는 것은 실패가 아닙니다.** 갓 설치한 기계에서 종료 코드 0이 나와야 하므로 `home-layout` 점검이 디렉터리를 **만들고**, 생성 자체가 실패할 때만 FAIL입니다(AC21.10).
- **WARN은 실패가 아닙니다.** 종료 코드 1은 FAIL이 하나라도 있을 때만입니다(§5.11, AC21.6).
- **네이티브 바인딩 부재는 정보입니다.** `cpu-features`가 없어도 순수 JS로 동작하는 것이 이 패키지의 핵심 가치이므로 FAIL로 만들지 마세요.
- **출력은 stdout입니다.** 이 디렉터리는 ESLint `no-console` 예외 목록에 포함돼 있습니다. `setup`은 반대로 stderr를 쓰는데, 프롬프트와 보고가 뒤섞이기 때문입니다.
- **점검은 서로 독립이어야 합니다.** 렌더러가 내용을 모르는 채로 직렬화할 수 있어야 `--json`(`{ ok, checks, snippets }` 한 객체)이 성립합니다. 점검 사이에 상태를 공유하지 마세요.
- **호스트당 연결은 하나뿐입니다.** `probe()`가 alias별 Promise를 `ctx.probes` Map에 캐시해 `host-tcp`·`host-fingerprint`·`host-auth` 셋이 같은 결과를 공유합니다. 세 번 연결하지 마세요. 가드 타이머는 `HOST_PROBE_TIMEOUT_MS`(5000ms)보다 2초 늦게 발동하며 `unref()`되어 있습니다.
- **호스트별 점검 id는 `<kind>:<alias>` 형태**입니다(예: `host-tcp:web1`). 호스트가 0개면 각 종류가 `emptyHostRow()`로 INFO 행 하나를 내어 표에 항상 15종이 보입니다(AC21.1).
- **핵심 패턴 회귀 가드가 두 곳입니다.** `host-approval`(호스트별)과 `patterns`(전역) 둘 다 `missingCorePatterns()`로 재확인합니다. `compilePatterns`가 이미 제거를 무시하지만, doctor는 그것을 눈에 띄는 FAIL로 다시 드러냅니다 — `rm -rf /`가 조용히 safe가 되는 것보다 FAIL 한 줄이 낫다는 판단입니다(F7).
- **`--patterns`는 점검 없이 단독 실행되며 항상 종료 코드 0입니다.** 정규식 표와 함께 `ARGV_RULES` 표를 따로 출력하고, argv 규칙은 "정규식이 아니며 해제할 수 없다"고 명시합니다.
- `patterns` 점검은 `safety/patterns.ts`의 `PatternDef.source`(명령 경로 접두사가 붙기 **전** 문자열)를 출력합니다 — 이 문자열이 곧 사용자가 `patternOverrides.<grade>.remove`에 적을 값입니다(AC21.9).
- `buildChecks(options)`는 `DoctorOptions`로 호스트 프로버를 주입받습니다. 테스트는 이것으로 네트워크 없이 호스트 점검을 검증하므로 주입 지점을 없애지 마세요.

## Testing

`tests/integration/doctor.test.ts`가 이 디렉터리의 주 검증입니다(553행). CI의 `no-build-tools` 잡에서는 소비자 설치본으로 `doctor`를 실행해 깨끗한 러너에서 종료 코드 0을 확인합니다(스텝: `doctor from the consumer install (expect exit 0 on a clean runner)`).

```bash
npm run test:integration
```

## Dependencies

### Internal

`../config/paths.js`, `../config/schema.js`, `../config/state.js`, `../config/store.js`, `../errors.js`, `../safety/classify.js`, `../safety/patterns.js`, `../setup/winacl.js`, `../ssh/fingerprint.js`

### External

`ssh2`(`Client`), Node `node:fs`·`node:path`.

<!-- MANUAL: -->
