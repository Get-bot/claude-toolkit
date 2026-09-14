<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# safety

## Purpose

이 프로젝트의 보안 경계 전체가 여기 있습니다. 원격에서 실행될 셸 명령 문자열을 받아 **정규화 → 대화형 프로그램 차단 → 분류(safe/privileged/destructive) → 승인 게이트** 순으로 통과시키고, 승인이 필요한데 클라이언트가 elicitation을 지원하지 않으면 1회용 확인 토큰을 발급합니다. MCP 도구 어노테이션은 힌트일 뿐이고 실제 차단은 전부 이 디렉터리가 담당합니다(ADR-004). 여기서 내린 판정이 감사 로그의 `grade`·`approval_outcome` 필드가 되고, 사용자에게 보여줄 명령 문자열의 비밀정보 마스킹도 이곳이 책임집니다.

## Key Files

| File             | Description                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize.ts`   | 셸 명령 스캐너/정규화기. `normalize(command)`가 dequote된 `normalized` 문자열, 따옴표·이스케이프에서 온 메타문자를 NUL로 바꾼 `matchTarget`, 그리고 최상위 `; && \|\| \| & \n`으로만 쪼갠 `Segment[]`를 만듭니다. `MAX_SUBSTITUTION_DEPTH` 초과·따옴표 불균형·미종료 here-doc은 `unparseable`. |
| `patterns.ts`    | 분류 패턴 표. `PATTERNS`, `compilePatterns(overrides)`, `attachCommandPrefix()`, `CORE_PATTERN_IDS`, `missingCorePatterns()`. 패턴마다 `scope: 'whole' \| 'segment'`를 갖습니다.                                                                                                               |
| `classify.ts`    | 2-pass 분류기(ADR-005). `classify()`가 whole 패스 + segment 패스 + `ARGV_RULES`의 최댓값을 등급으로, 이유의 합집합을 `reasons`로 반환합니다. `MAX_COMMAND_LENGTH = 8192`.                                                                                                                      |
| `interactive.ts` | 대화형 프로그램 게이트(OPT-1). `checkInteractive()` / `checkInteractiveScan()`이 `UNCONDITIONAL_PROGRAMS`(vim, less, htop, tmux … 21개, 무조건 거부)와 `CONDITIONAL_PROGRAMS`(top, mysql, psql, git, python … 인자 형태에 따라 조건부)를 판정하고 `ALTERNATIVES`에서 대체 명령을 제안합니다.   |
| `approval.ts`    | 승인 게이트. `gateCommand()`(셸 명령)와 `gateFileOperation()`(업로드/다운로드)이 하나의 결정 코어를 공유합니다. `buildElicitRequest()`, `interpretElicitResult()`, `auditView()`, `ELICITATION_TIMEOUT_MS`.                                                                                    |
| `tokens.ts`      | 확인 토큰 저장소. `issueToken(binding)` / `consumeToken(token, binding)` / `startSweep()` / `stopSweep()`. TTL 300초, 최대 100개, 32바이트 base64url.                                                                                                                                          |
| `secrets.ts`     | 값 단위 비밀정보 마스킹(F11). `maskCommandSecrets()`, `containsSecret()`, `SECRET_PLACEHOLDER`. `log.ts`의 키 이름 기반 redaction으로는 잡을 수 없는 `mysql -pHUNTER2` 같은 경우를 담당합니다.                                                                                                 |

## Data flow

`gateCommand()` 안에서 순서가 고정돼 있고, 그 순서 자체가 설계 결정입니다.

- **1. 길이 제한** — 8 KiB를 넘는 명령은 분류가 불가능하므로 `command_too_long`으로 먼저 거부합니다(OPT-6).
- **2. 대화형 게이트** — 분류보다 **먼저** 돕니다. "터미널이 필요한가"는 "위험한가"와 다른 질문이기 때문입니다(OPT-1).
- **3. 분류** — `normalize()` → `compilePatterns()` → `classify()`. whole 패스와 segment 패스를 모두 돌리고 `ARGV_RULES`를 적용해 최댓값을 취합니다. `su -c`·`docker run`·인라인 인터프리터 코드 같은 중첩 페이로드는 `mergeNested`로 재귀 분류합니다(깊이 상한 `MAX_NESTED_CLASSIFY_DEPTH = 3`).
- **4. `sudo -S`** — stdin이 항상 닫혀 있어 실패가 확정이므로, 실행하지 않고 그렇다고 말합니다.
- **5. 승인** — 호스트의 `approvalMode`와 클라이언트의 elicitation 지원 여부로 Branch A(elicitation)와 Branch B(토큰/거부)가 갈립니다.
- 결과는 `GateResult` 유니온(`GateAllow` / `GateDeny` / `GateConfirmationRequired` / `GateRefusedInteractive` / `GateSudoPasswordRequired` / `GateCommandTooLong`) 하나로 반환되고, 호출자(`tools/gated.ts`)가 이를 응답과 감사 줄로 번역합니다.
- `gateFileOperation()`은 1~4단계를 건너뛰고 호출자가 준 등급(upload=privileged, overwrite download=destructive)으로 5단계만 수행합니다.

## Invariants & gotchas for AI agents

- **분류기는 원본 바이트를 봐야 합니다.** `maskCommandSecrets()`는 절대 분류보다 먼저 실행되면 안 됩니다 — 마스킹된 문자열은 패턴 매칭 결과를 바꿉니다. 확인 토큰의 바인딩 해시도 마스킹 전 원본으로 계산돼야 재호출 검증(AC17.2)이 성립합니다.
- **"안전하다고 선언하는" 수단은 존재하지 않습니다.** 호스트는 `patternOverrides`로 패턴을 추가하거나 내장 패턴을 끌 수 있을 뿐이고, `HostsFileSchema.strict()`가 임의 안전 선언을 막습니다(F8). 새 기능에 "이 명령은 안전함"을 표시하는 필드를 추가하면 이 원칙이 깨집니다.
- **`CORE_PATTERN_IDS`(rm-recursive, mkfs, fork-bomb, pipe-to-shell 등 17개)는 호스트가 끌 수 없습니다**(F7). 이들을 지목한 `remove`는 **거부가 아니라 경고 후 무시**됩니다 — 파일 전체를 거부하면 그 호스트뿐 아니라 나머지 모든 호스트까지 함께 죽기 때문입니다. `doctor`의 `host-approval`·`patterns` 체크가 이를 다시 FAIL로 드러냅니다.
- **`ARGV_RULES`는 호스트가 끌 수 없습니다.** 정규식은 인자의 **위치**를 판단할 수 없기 때문에 존재하는 규칙입니다 — `rm -- /etc/passwd`는 `^rm\s+(?!-)` 가드를 무력화하고, `cp /tmp/x /etc/nginx.conf`와 `cp /etc/nginx.conf /tmp/x`는 같은 토큰으로 정반대 판정이어야 합니다(F4).
- **`scope`를 잘못 고르면 조용히 뚫립니다.** `curl … | sh`는 세그먼트로 쪼갠 뒤에는 보이지 않으므로 반드시 `scope: 'whole'`이어야 합니다. 반대로 세그먼트 단위로 봐야 할 패턴을 whole로 두면 오탐이 늘어납니다.
- **명령 경로 접두사는 컴파일 시점에 붙습니다.** `^` 앵커 뒤에 `COMMAND_PATH_PREFIX`가 삽입되어 `/bin/rm -rf`가 `^rm`을 우회하지 못합니다. `PatternDef.source`에 저장되는 것은 접두사가 붙기 **전** 문자열이며, 이것이 `doctor`가 출력하고 `patternOverrides.<grade>.remove`가 참조하는 정확한 문자열입니다(AC21.9).
- **`matchTarget`의 NUL 치환을 무력화하지 마세요.** 따옴표 안이나 백슬래시 이스케이프에서 온 메타문자를 NUL로 바꾸기 때문에 `echo "a | xargs rm -rf"`가 파이프라인 패턴에 걸리지 않습니다.
- **파싱 불가는 곧 destructive입니다.** 스캐너가 이해하지 못한 입력을 safe로 흘려보내지 마세요 — `unparseable`은 의도적으로 최고 등급으로 승격됩니다.
- **대화형 게이트는 위험 판정이 아닙니다.** `mysql -e "DROP DATABASE prod"`는 이 게이트를 통과하고 그 뒤 분류기가 잡습니다(C14). "게이트를 통과했으니 안전하다"는 추론을 코드에 넣지 마세요.
- **토큰은 원문을 저장하지 않습니다.** SHA-256만 보관하고 로그에는 해시의 앞 8자리만 남깁니다(AC19.3). 소비된 토큰은 TTL이 끝날 때까지 tombstone으로 남아 `used`와 `invalid`를 구분합니다(AC17.3). 비교는 `timingSafeEqual`로 합니다.
- **`fail-closed`는 elicitation 호출이 실패해도 완화되면 안 됩니다**(AC17.13, P2). elicit이 예외를 던져도 그 호스트는 토큰을 발급하지 않고 `approval_unavailable`을 반환해야 합니다 — "물어보려다 실패했으니 그냥 통과"는 fail-closed의 정의에 반합니다.
- **`ask-all` + `fail-closed`에서는 `grade === 'safe'`도 예외가 아닙니다**(F9). 안전 등급에 자가 상환 가능한 토큰을 발급하면 그것이 가장 필요한 클라이언트에서 `ask-all`을 조용히 `ask-destructive`로 되돌려 놓습니다. `runApproval`의 fail-closed 분기에 safe 예외를 다시 넣지 마세요.
- **깊이 상한을 늘리지 마세요.** `MAX_SUBSTITUTION_DEPTH`(6)와 `MAX_NESTED_CLASSIFY_DEPTH`(3)는 ReDoS·무한 재귀 방어이며, 초과분은 `unparseable` → destructive로 처리됩니다. `findMatching`의 따옴표 인지 괄호 매칭도 `$(echo ")")` 같은 입력에서 조기 종료를 막기 위한 것이라 단순화하면 깨집니다.
- **서버는 사람의 승인을 검증할 수 없습니다.** 토큰 경로는 설계상 그렇고, 응답 본문이 이 사실을 명시합니다(M1/M7/PM-4). 이를 "검증한다"고 바꿔 쓰는 문구 변경은 사실과 다릅니다.
- 로그 필드 이름은 `confirmation_hash8`처럼 **`/token/i`에 걸리지 않게** 지었습니다. `redact()`가 키 이름으로 마스킹하기 때문에, 토큰 해시 프리픽스를 남기려면 이름이 그 패턴을 피해야 합니다.
- **오탐률 목표는 0%입니다.** "대체로 맞음"은 통과가 아닙니다 — 안전 코퍼스 한 줄이라도 destructive로 판정되면 게이트가 실패합니다.

## Testing

| Suite                                                                     | 대상                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tests/unit/classify.test.ts`                                             | 표 기반 분류 코퍼스(safe/privileged/destructive/bypass) + 오탐 게이트 |
| `tests/unit/normalize.test.ts`                                            | 스캐너/정규화기                                                       |
| `tests/unit/interactive.test.ts`                                          | 대화형 프로그램 게이트                                                |
| `tests/unit/approval.test.ts`                                             | 승인 게이트 분기 전체                                                 |
| `tests/unit/tokens.test.ts`                                               | 토큰 발급·소비·만료·tombstone                                         |
| `tests/unit/secrets.test.ts`                                              | 값 단위 마스킹                                                        |
| `tests/integration/approval.test.ts`, `tests/integration/secrets.test.ts` | 도구 호출 경로에서의 승인/마스킹                                      |

```bash
npm run test:unit
npm run test:fp-gate     # vitest run tests/unit/classify.test.ts — 오탐 게이트
```

**코퍼스가 곧 계약입니다.** 분류기보다 먼저 작성됐으며, 패턴을 바꿀 때는 코퍼스를 먼저 고치고 구현을 맞추세요. 안전 코퍼스는 최소 60행을 유지해야 합니다(§6.1).

## Dependencies

### Internal

- `approval.ts` → `../audit.js`, `../config/schema.js`, `../config/store.js`, `../errors.js`, `../log.js`, `./classify.js`, `./interactive.js`, `./normalize.js`, `./secrets.js`, `./tokens.js`
- `classify.ts` → `../config/schema.js`, `./normalize.js`, `./patterns.js`
- `patterns.ts` → `../config/schema.js`, `../log.js`
- `interactive.ts` → `./normalize.js`
- `normalize.ts`, `secrets.ts` → 없음 (의존성 0)
- `tokens.ts` → `node:crypto`만

### External

npm 패키지 의존성 없음. `node:crypto`만 사용합니다.

<!-- MANUAL: -->
