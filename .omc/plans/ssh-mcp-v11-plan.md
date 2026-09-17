# 실행 계획: ssh-mcp v1.1 (패키지 0.3.0) — 합의본 (iteration 4)

**Status: pending approval** — 실행 없음. 승인 전까지 소스·테스트·CI·문서를 수정하지 않는다.

**합의 이력(2026-09-16).** iteration 1: Architect 조건부 승인(blocking 8) / Critic REVISE(blocking 6) → iteration 2: Architect 조건부 승인(blocking 3) / Critic REVISE(blocking 2) → iteration 3: Architect 조건부 승인(blocking 1) / Critic REVISE(blocking 2) → iteration 4: **Critic APPROVED**(신규 blocking 0). iteration 4의 Architect 검토는 사용자 결정으로 생략(iteration 3의 Architect 유일 blocking이 Critic N3과 동일 항목이었음). 리뷰 전문은 `.omc/state/plan-reviews/`, 회차별 스냅샷은 `.omc/state/plan-snapshots/`.

**승인 시 함께 확인할 항목**: 부록 B-1(CLI 한정 시스템 `ssh` 이탈 — 스펙 Round 9에서 이미 승인), B-2(AC-J7 축소 2건: 파싱 상한 4 MiB, 응답 탑재 상한 `min(2×, 4 MiB)`), Q3(보관 상한 `4 × maxOutputBytes`, 절대 상한 16 MiB), Q4(타임아웃·오류 경로 출력은 0.3.0에서 보관 제외 — 반대안은 §1 말미).

- 스펙(권위): `ssh-mcp/.omc/specs/deep-interview-ssh-mcp-v11.md` (AC **51개**, D1–D11, Non-Goals). 2026-09-16 개정으로 AC-O1 술어가 `truncated === true`로, AC-O7이 `maskPemBlocks` 적용으로 바뀌었다.
- 선행 계획: `.omc/plans/ssh-mcp-plan.md` — §5.8(발췌), §5.10(감사), ADR-002/006/007/008, R24, §v1.1 로드맵을 **참조**하며 다시 적지 않는다.
- 리뷰 대응: iteration 1은 §11, iteration 2는 §12, iteration 3은 §13, 최종 정리는 §14.
- 대상 저장소: `D:/workspace/claude-toolkit/ssh-mcp` (현재 `0.2.1`, 브랜치 `feat/ssh-mcp-help`)

---

## 1. Requirements Summary

### 고정 결정 (스펙 Constraints — 재논의 대상 아님)

| # | 결정 | 근거 |
|---|------|------|
| D1 | 단일 릴리스 `0.3.0`. `engines` 유지(`^20.17.0 \|\| ^22.13.0 \|\| >=23.5.0`, `package.json:8-10`) | 0.x 규칙 |
| D2 | 호환성 영향 항목은 CHANGELOG에 **굵게**: 도구 7→9, 응답 필드 추가(`parsed`, non-null `output_ref`), 승인 스키마 변경, `setup` 경고 시작, `host list --json` 스키마 변경(F12) | `CHANGELOG.md:3` |
| D3 | 네이티브 의존성 0 유지. **새 런타임 의존성 없음** | `scripts/assert-no-native-addons.mjs`, `scripts/assert-bundle-imports.mjs` |
| D4 | 잘린 출력 보관은 **서버 프로세스 메모리에만**. TTL 10분, 총량 64 MiB, 오래된 것부터 폐기, 만료 후 `output_expired` | ADR-006 승계 |
| D5 | `--from-ssh-config`는 메타데이터만. 기존 키·ssh-agent 재사용 없음, TTY 요구 유지 | 보안 모델 불변 |
| D6 | `connect`/`exec` CLI는 시스템 `ssh`에 위임하며 분류·승인·감사·발췌를 **거치지 않는다** | 사람이 직접 치는 경로 |
| D7 | `format:"json"` 재작성은 화이트리스트 단일 명령만 | AC-J3 |
| D8 | **재작성된 명령이 분류·승인·감사의 대상** | AC-J5 |
| D9 | `real-sshd`는 PR 차단 필수 게이트. `continue-on-error` 금지 | bd8f53b의 교훈, R20 |
| D10 | 승인 스키마는 probe 실측 후 결정. enum 우선 | AC-E3 |
| D11 | `setup` 별칭은 0.3.0에서 stderr 경고 1줄, 제거는 0.4.0. **stdout 바이트는 동일** | AC-A1 |

### 보류 (로드맵 유지)

SQLite 감사 저장소 · `.mcpb` 번들 · 분류기 AST 파서 교체 · fish 세션 프레임. 추가 Non-Goals: `IdentityFile` 재사용, ssh-agent 경유, `known_hosts` 가져오기, `connect`의 지문 강제, ssh_config 와일드카드/`Match`/`ProxyJump`/`Include` 2단계, df·ps 이외 텍스트 파서, 잘린 출력의 디스크 보관, Node 20 지원 종료.

### v1 스펙 기술 스택 제약으로부터의 이탈 (승인 필요)

v1 제약은 "순수 JS `ssh2`만, 시스템 `ssh`/`scp` 미사용"이었고 탐색 보고가 `src/`에 해당 코드 0건임을 확인했다. D6은 의도적 예외이며 v1.1 스펙 Constraints가 승인했다. **예외는 CLI 경로에만 적용되고 MCP 서버 기동과 도구 호출은 시스템 `ssh` 유무에 의존하지 않는다.** 격리 장치 4개(G-1~G-4)는 OP-5에, 이탈 등재는 부록 B-1에 있다.

### 계획이 스스로 해소한 스펙 모호성 (승인 필요)

| # | 스펙/전제 | 저장소 실측 | 계획의 해소 |
|---|-----------|-------------|-------------|
| Q1 | AC-H7 "**기존** 테스트(R24)" | `src/`·`tests/`에 `R24` 문자열 0건. `tests/unit/audit.test.ts`의 describe 8곳(98/148/190/199/279/337/373/397)에 동시 쓰기 항목 없음 | R24 테스트를 **신규 작성**(Step **A3**)한 뒤 그 관측이 AC-H7의 판정 근거가 된다 |
| Q2 | AC-E1 "**다시** 존재하고" | `git log --all -- '*elicit-probe*'` 0건 | 복원이 아니라 신규 작성 |
| Q3 | 항목별 보관 상한 미정 | `maxOutputBytes`는 1024–4194304(`src/config/schema.ts:144-149`) | **보관 상한 = `4 × host.maxOutputBytes`.** 초과 스트림은 보관하지 않아 `output_ref`가 `null`. **파싱 상한은 별도 상수**(Q9) |
| Q4 | 타임아웃·오류 경로의 보관 | 타임아웃은 `SshOperationError`(`src/ssh/error.ts:12`, `CodedError` 상속)의 `details`로 나가고 `commandResultBody`를 지나지 않는다(`src/ssh/exec.ts:166-180`, `src/ssh/session.ts:925-940`) | 0.3.0 기본은 **보관 제외**. 사용자 결정 항목으로 아래 별도 문단에 채택 시 변경 내역을 적어 둔다 |
| Q5 | AC-R3 "CI 6잡" | 현재 잡 정확히 5개(`:40`, `:95`, `:135`, `:186`, `:221`). matrix 때문에 노출되는 검사 이름은 8개 | 잡 6개로 읽는다. A9를 **한 잡 안 3스텝**으로 고정했으므로(결정 10) 브랜치 보호에 추가되는 검사 이름은 `real-sshd (ubuntu-latest)` **하나**. 가드 잡 분리는 하지 않고 `build-test` 스텝으로 넣으므로 이름이 늘지 않는다 |
| Q6 | AC-C6 예약어에 `help`·`version` | `COMMANDS`는 4개(`src/commands.ts:25-33`), `help`·`version`은 토큰 테이블(`:47`, `:50`) | `RESERVED_ALIASES = [...COMMAND_NAMES, 'help', 'version']`. `-h`/`--help` 형태는 `AliasSchema`(`src/config/schema.ts:58`)가 이미 거부하므로 추가 불필요 |
| **Q7** | AC-O1 원안 `omitted_lines > 0` | `buildBinaryExcerpt`는 `truncated: true`(`src/ssh/excerpt.ts:422`)와 함께 `omitted_lines: null`(`:430`)을 쓴다. `null > 0`은 false이므로 **비UTF-8 잘림은 영원히 보관되지 않는다**. `buildFull`도 비UTF-8이면 `omitted_lines: null`(`:406`) | 술어를 **`meta.truncated === true`** 로 교체. 스펙 AC-O1이 2026-09-16 개정으로 같은 술어를 채택했다 |
| **Q8** | AC-O7 원안 "응답과 동일한 노출 범위" | `commandResultBody`는 stdout/stderr에 `redact(v, {maxStringBytes: null})`(`src/tools/gated.ts:191-196`)를 걸고, `maxStringBytes: null`은 **길이 절단만** 끈다. `redactString`(`src/log.ts:116-118`)이 `maskPemBlocks`(`:102-105`)를 무조건 먼저 부르므로 PEM 블록은 이미 치환돼 나간다 | `fetch_output`의 chunk에 **`maskPemBlocks`만** 적용(길이 제한 없음, `exec`와 동일 정책, AC19.2 유지). 스펙 AC-O7이 같은 내용으로 개정됐다. **보안 모델 이탈 아님** |
| **Q9** | AC-J7 "발췌 상한의 4배" | 상한 4 MiB 호스트에서 16 MiB 문자열의 `JSON.parse`는 SSH 스트림을 펌프하는 메인 스레드를 동기 정지시킨다 | **파싱 상한 = `Math.min(4 × maxOutputBytes, 4 MiB)`.** AC-J7은 "4배를 넘으면 포기"를 요구하므로 4배 **이하**의 임계는 전부 AC를 만족한다. 두 상수는 `src/output/limits.ts` 한 파일에 둔다 |

**사용자 결정 항목 — Q4의 반대안.** 60초 타임아웃에 걸린 `journalctl`은 사용자가 나머지를 가장 원하는 순간이기도 하다. "구조상 제외된다"는 구현 편의이지 제품 판단이 아니다. 부분 출력도 보관하기로 하면 필요한 변경은 셋이다. (1) `execOnce`의 타임아웃 분기(`src/ssh/exec.ts:154-181`)와 세션의 대응 분기(`src/ssh/session.ts:925-940`)에서 보관 버퍼를 flush해 스토어에 넣는다. (2) `details.stdout_meta`/`stderr_meta`에 `output_ref`를 채운다. (3) `applyErrorDetailsToAudit`(`src/tools/wrap.ts:137-147`)는 `total_bytes`·`truncated`만 읽으므로 감사에는 영향이 없다. 0.3.0 기본값은 제외이며, 채택하면 위 3점만 바뀐다.

---

## 2. RALPLAN-DR Summary

### 2.1 Principles

1. **하나의 경로.** 보안 경계를 지나는 기능에 두 번째 코드 경로를 만들지 않는다. 지킬 수 없으면 **테스트가 아니라 타입으로** 닫는다 — 이번 iteration에서 OP-3에 적용했다.
2. **분류·승인·감사는 실제 실행되는 바이트에 건다.**
3. **메모리는 유계.** 보관·조회·파싱 모두 스트림 길이·파일 크기와 무관한 상한을 갖고, 상한은 **용도별로 따로** 둔다(Q9).
4. **게이트는 약화시키지 않는다.** 그리고 게이트를 지키는 가드는 자기가 감시하는 잡 **밖**에 둔다.
5. **추측 대신 실측.** 클라이언트 렌더링처럼 우리 테스트가 못 보는 것은 probe로 재고 결과를 문서에 남긴다.

### 2.2 Decision Drivers (상위 3)

1. **D9 필수 게이트** — `real-sshd`가 늦으면 AC-T4·AC-C7·AC-J4가 인프로세스 픽스처로만 증명된 채 릴리스된다.
2. **D10 승인 스키마 미결** — `interpretElicitResult`(`src/safety/approval.ts:140-146`)와 `buildElicitRequestFor`(`:390-421`)의 시그니처가 probe 결과에 달려 있다.
3. **D3 의존성 0 / 번들 불변식** — `scripts/assert-bundle-imports.mjs` 헤더가 못박듯 **번들러는 번들된 코드의 모든 정적 import를 엔트리로 호이스트한다.** 따라서 동적 import는 평가 시점만 늦출 뿐이고, builtin named import의 실제 방어선은 `ALLOWED` 표(`:63-69`)뿐이다.

### 2.3 Viable Options

#### OP-1. 원문 보관 지점과 OutputStore

발췌 누산기 `createExcerptAccumulator()`(`src/ssh/excerpt.ts:334-579`)는 `push`에서 가운데를 버린다. `buildFull`(`:386-413`)·`buildTextExcerpt`(`:439-549`)·`buildBinaryExcerpt`(`:415-437`) 중 어디에서도 되찾을 수 없다.

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| A (iter1 기각) | 누산기가 전역 스토어에 직접 등록 | 접점 1곳 | 순수 모듈이 전역 상태에 의존. `tests/unit/excerpt.test.ts`가 스토어를 타게 됨 |
| B (iter1 선택) | 별도 보관 버퍼를 같은 chunk에 물리고 `commandResultBody`에서 등록 | 누산기 무수정 | **배선 지점이 4곳** — `src/ssh/exec.ts:137-142`의 두 핸들러와 `src/ssh/session.ts:890-891`의 두 콜백. 하나를 빠뜨리면 조용히 `output_ref: null`이고 타입이 못 잡는다. 두 버퍼의 총 바이트가 어긋나 `fetch_output`의 `total_bytes`가 거짓말할 수 있다 |
| **A′ (채택)** | 누산기에 **옵트인 옵션** `retain?: { cap: number }`를 주고 `finish()`가 `retained: Buffer \| null`을 함께 돌려준다. 전역 스토어는 개입하지 않는다. 등록은 그대로 `commandResultBody()`(`src/tools/gated.ts:174-199`) | 배선 1곳. 기본값 off라 기존 발췌 테스트가 한 줄도 안 바뀐다. `isUtf8`·`truncated`를 아는 유일한 지점에서 판단하므로 Q7의 base64 구멍이 구조적으로 닫힌다. 두 버퍼 불일치 상태가 애초에 없다 | 누산기 시그니처가 넓어진다 |

**선택: A′.** iteration 1은 B를 골랐고 Architect 2-1이 그것을 뒤집었다. 반론의 핵심을 그대로 받는다 — **ADR-008이 확립한 것은 "발췌기는 유계"이지 "발췌기는 옵션이 없다"가 아니다.** 유계 보장은 `cap + 320 KiB`에서 `cap + 320 KiB + retainCap`이 될 뿐, 여전히 스트림 길이와 무관하다. 등록 지점을 `commandResultBody`에 남기는 것은 B의 좋은 부분이므로 유지한다 — 그 함수가 `truncated`와 응답 필드를 동시에 아는 유일한 곳이고, 타임아웃 경로가 그곳을 지나지 않아 Q4가 코드 구조로 보장된다.

**보관 술어(Q7): `meta.truncated === true`.** `omitted_lines > 0`은 비UTF-8 잘림과 `MAX_LINE_BYTES`(8192, `src/ssh/excerpt.ts:40`) 절단만 일어난 경우를 놓친다.

**스토어 구조** (`src/output/store.ts`):
- `Map<string, { bytes: Buffer; encoding: ExcerptEncoding; createdAt: number }>` — JS `Map`의 삽입 순서 보존이 곧 "오래된 것부터".
- `put(bytes, encoding): string | null` — `crypto.randomBytes(16).toString('base64url')`(128비트, AC-O5). 만료 청소 → 총량 초과분 선두 폐기 → 삽입.
- **PEM 마스킹은 `put` 시점에 버퍼 전체에 1회**(Q8). 페이지 슬라이스에 걸면 안 된다 — `maskPemBlocks`는 `if (!value.includes('-----BEGIN ')) return value`로 시작하므로(`src/log.ts:103`), BEGIN 마커 뒤에서 시작하는 슬라이스에는 마커가 없어 **원문이 그대로 나간다.** 64 KiB 기본 페이지에 4 KiB 개인키가 경계를 걸치면 첫 페이지는 `PEM_OPEN_PATTERN`(`src/log.ts:99`)이 끝까지 가려 주지만 **둘째 페이지가 나머지를 평문으로 돌려준다.** 단일 청크 테스트는 통과하고 페이징만 샌다.
- `put` 마스킹은 세 가지를 한꺼번에 해결한다. (a) 경계가 존재하지 않는다. (b) `total_bytes`·`offset`·`next_cursor`가 전부 **마스킹 후 버퍼**라는 단일 좌표계 위에 선다 — 마스킹은 길이를 바꾸므로(`REDACTED_PEM`은 고정 문자열, 원본 블록은 수 KiB) 좌표계가 둘이면 AC-O2의 "처음부터 순서대로"가 검증 불가능해진다. (c) 비용이 스트림당 1회로 고정된다.
- **비UTF-8(`encoding: 'base64'`) 항목도 같은 처리를 받는다.** 누산기가 UTF-8이 아니라고 판정한 스트림도(`isUtf8 = utf8.done()` `src/ssh/excerpt.ts:558`, 거짓이면 `buildBinaryExcerpt` `:568`) PEM 블록은 ASCII이므로 보관 버퍼에 그대로 나타난다. 마스킹은 base64 인코딩 **전** 원시 바이트 버퍼에 적용된다.
- **왕복 인코딩을 못박는다.** `maskPemBlocks`는 `(value: string) => string`(`src/log.ts:102`)이므로 Buffer를 문자열로 바꿨다 되돌려야 한다. `put`은 먼저 `buf.indexOf('-----BEGIN ')`로 훑어 **마커가 없으면 버퍼를 그대로 저장한다(왕복 0회).** 마커가 있을 때만 `buf.toString('latin1')` → `maskPemBlocks` → `Buffer.from(masked, 'latin1')`로 왕복한다. **`utf8`이 아니라 `latin1`인 이유는 바이너리 바이트 보존이다** — `utf8` 왕복은 부정 시퀀스를 U+FFFD로 치환해 길이와 내용을 모두 바꾼다(실측: 7바이트 `00 ff fe 80 41 42 90`이 utf8 왕복에서 15바이트가 되고 `equals`가 거짓, latin1 왕복은 7바이트 그대로 참). PEM 마커와 `REDACTED_PEM`이 전부 ASCII이므로 `latin1`에서 정규식은 동일하게 동작한다. 저장소 관행(`src/ssh/excerpt.ts`는 `toString('utf8')`과 `toString('base64')`만 쓰고 `latin1` 사용처가 없다)이 틀린 쪽을 유도하므로 명시가 필요하다.
- `get(ref, offset, maxBytes)` — 없거나 만료면 `output_expired`. 이미 마스킹된 버퍼를 슬라이스만 한다.
- TTL 청소는 타이머 없이 `put`/`get` 진입 시 지연 수행. `resetOutputStore()`는 테스트용.

**실행 중(in-flight) 메모리 회계.** 보관 버퍼는 잘릴지 미리 알 수 없으므로 **모든** 명령에서 실행 내내 살아 있다. 피크는 `64 MiB 스토어 + 2 × retainCap × 동시 실행 명령 수`이고, 세션은 호스트당 5개까지 열린다. **`retainCapFor(host) = min(4 × maxOutputBytes, 16 MiB)`로 절대 상한을 둔다** — 현재 스키마 상한 4 MiB 호스트에서 `4 × 4 = 16 MiB`이므로 동작은 바뀌지 않지만, 호스트 설정과 무관하게 유계임이 문서와 코드 양쪽에 남는다(`parseCapFor`가 `min(…, 4 MiB)`로 같은 형태를 쓰는 것과 대칭). 그 상한에서 명령 1건당 `2 × 16 MiB = 32 MiB`이므로 5개 동시 실행이면 스토어와 별도로 160 MiB가 더 든다. 이것이 Q3의 상한을 총량 캡과 **따로** 두어야 하는 두 번째 이유다.

마스킹 왕복의 일시 메모리는 여기에 더해지지 않는다. `buf.indexOf` 사전 검사가 PEM 없는 절대다수 경로를 **왕복 0회**로 만들기 때문이다. 마커가 실제로 있는 드문 경로에서만 순간적으로 최대 `3 × retainCap`을 더 쓴다.

#### OP-2. `history`의 역방향 읽기와 커서

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| A | 파일 전체 읽고 역순 | 30줄, 경계 처리 없음 | 회전 임계가 10 MiB(`src/audit.ts:119`)라 한 페이지에 최대 10 MiB를 힙에 올린다 |
| A′ | 4개 파일의 끝 N 바이트만 읽어 합치고 정렬 | 커서-파일 동일성 문제가 없어짐 | "N 너머로 페이징 불가"가 AC-H2의 "회전 파일까지 이어 읽는다"를 만족하지 못한다 |
| **B (유지)** | fd를 열고 뒤에서부터 64 KiB씩 읽어 `\n`으로 나누고 선두 잔여를 이월 | 메모리가 chunk + 한 줄(16 KiB 상한, `:118`)로 고정. 페이지 비용이 파일 크기와 무관 | 경계 처리 ~120줄 + 전용 단위 테스트 |
| C | 오프셋 인덱스 캐시 | 2페이지부터 빠름 | 다른 프로세스가 같은 파일에 append한다(R24 전제) → 무효화 불가 |

**선택: B 유지.** Architect 2-2가 A′를 제시했고 "삭제 예정 코드에 비용을 쓰는 것이 조기 최적화"라는 지적은 타당하다. 그러나 A′는 AC-H2의 문구를 만족하지 못하고, 스펙이 커서를 `(파일 인덱스, 바이트 오프셋)`으로 **명시**했다. 스펙을 못 지키는 단순함은 단순함이 아니다. 대신 B의 실제 결함(아래 승계 규칙)을 고친다.

**커서 인코딩.** `base64url(JSON.stringify({ f, o, s, h }))` — `f`=파일 인덱스(0=live), `o`=다음에 읽을 더 과거 줄의 시작 바이트 오프셋, `s`=페이지를 끊은 시점의 파일 크기, `h`=아래에 정의한 줄 해시.

**회전 승계 (결정 4 — iteration 1의 규칙은 틀렸다).** `s`는 페이지를 끊은 시점의 크기이고 회전은 10 MiB에 닿아야 일어나므로(`src/audit.ts:119`, 판정 `:254`, 수행 `:227-243`), 페이지와 회전 사이에 반드시 append가 있다. iteration 1의 `.{f+1}.size === s`는 **정상 회전을 100% 거부**했다.

- `f === 0`이고 현재 크기 `>= s`: append만 일어났다. 증가분은 전부 `o`보다 뒤이므로 역방향 읽기에 무영향 → 그대로 진행.
- `f === 0`이고 현재 크기 `< s` 또는 파일 부재: 회전. `.1`은 append-only였던 파일이 rename된 것이므로 **`.1.size >= s`** 와 **`o < s`** 를 함께 확인하고 `f+1`로 옮겨 이어 읽는다.
- `f > 0`: 회전 파일은 불변이므로 **`=== s`** 를 요구한다.
- **`f > 0`에서 회전이 일어나면 승계하지 않는다.** 회전은 `.1`→`.2`로 인덱스를 밀어 올리므로 `.1`을 읽던 커서는 회전 후 `.1`의 크기가 달라져 `=== s` 검사에 실패한다. 이것은 의도한 동작이다 — 회전 파일을 따라 인덱스를 옮겨 가며 추적하는 것보다 `history_cursor_stale`을 주고 다시 조회하게 하는 편이 안전하다.
- 어느 확인도 통과하지 못하면 조용히 틀린 페이지를 주지 않고 `history_cursor_stale`로 끝낸다. 2회 이상 회전(`f+2`)도 여기로 간다.

동일 파일 확인을 한 겹 더 두기 위해 커서에 `h`를 넣는다. **`h` = 오프셋 `o`가 가리키는 줄, 즉 다음에 읽을 더 과거 줄의 sha256 앞 8바이트다.** 승계 시 `o` 위치의 줄을 읽어 해시가 `h`와 같은지 본다. 불일치면 `history_cursor_stale`. (생산 규칙과 소비 규칙이 같은 줄을 가리켜야 하므로 "마지막으로 돌려준 줄"이 아니라 "다음에 읽을 줄"로 정의한다.)

#### OP-3. `format:"json"` 재작성의 위치 — B를 타입으로 닫는다

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| A | `approveCommand`(`src/tools/gated.ts:71-141`) 안에서 재작성하고 실효 명령을 돌려준다 | 승인된 것 ≠ 실행된 것이 **표현 불가능**해진다 | 안전 게이트가 명령을 변형하는 계층이 된다. `format`은 안전 개념이 아니다 |
| **B + 브랜드 타입 (채택)** | 각 핸들러가 `approveCommand` 직전에 공용 헬퍼로 재작성하되, **재작성 단계만 만들 수 있는 branded 타입**을 게이트와 실행 함수의 입력으로 요구한다 | 게이트는 순수한 게이트로 남고, 재작성 누락이 **컴파일 오류**가 된다 | 브랜드 타입이 `execOnce`의 기존 호출부 3곳에 파급된다 |
| C | SSH 계층에서 재작성 | 도구 계층 무변경 | 승인된 것 ≠ 실행된 것 → AC-J5 정면 위반, 기각 |

**종합 (결정 14).** Architect 2-3의 반론을 받아들인다 — 계획 iteration 1은 "E4가 구현자에게 `execOnce`에도 재작성된 문자열을 넘기라고 상기시켜야 한다"는 사실 자체로 B의 구조가 그 버그를 허용함을 자백했다. AC-J5는 이 계획의 최상위 보안 요구이므로 관례가 아니라 시그니처로 지켜야 한다. 다만 A는 `gated.ts`를 변형 계층으로 만드는 대가가 있으므로, **B의 배치를 유지하면서 A의 보증을 타입으로 가져온다.**

```
// src/output/resolve.ts
declare const resolved: unique symbol;
export type ResolvedCommand = string & { readonly [resolved]: true };
export function resolveCommand(raw: string, format: OutputFormat): ResolveResult;  // 유일한 생산자
export function internalCommand(raw: string): ResolvedCommand;                      // 서버 내부·테스트 전용
```

`ResolvedCommand`를 요구하는 지점은 **셋**이다.

| 지점 | 인용 | 비고 |
|------|------|------|
| `ApproveCommandInput.command` | `src/tools/gated.ts:50-58`(`command: string`은 `:53`) | 호출자는 `src/tools/exec.ts:67`과 `src/tools/runInSession.ts:103` 둘뿐 |
| `execOnce`의 command | `src/ssh/exec.ts:76` | |
| **`runInSession`의 command** | **공개 `src/ssh/session.ts:968-972`(`command` 파라미터는 `:970`)** 와 **비공개 `runCommand`의 `:871`** 둘 다 | 유일 호출자는 `src/tools/runInSession.ts:117`. 공개 함수가 `:980`에서 `runCommand`로 그대로 넘긴다 |

`GateInput.command`(`src/safety/approval.ts:160`)는 `string`으로 둔다 — `ResolvedCommand`는 `string & {...}`이라 `string`에 대입 가능하므로 하류(`hasTrailingBackground`·`buildCommandFrame`·`maskCommandSecrets`)가 전부 무변경으로 컴파일된다.

**프로덕션 파급 (실측).** `execOnce` 호출부는 3곳뿐이다 — `src/ssh/session.ts:853`·`:862`의 내부 `pkill`과 `src/tools/exec.ts:82`. 앞의 둘은 `internalCommand()`로 감싼다(서버가 만든 고정 문자열이므로 분류 대상이 아니다).

**탈출구는 ESLint로 잠근다.** `internalCommand`는 `string → ResolvedCommand` 캐스트이므로, 열어 두면 `src/tools/exec.ts`에서 한 줄로 모델 입력을 세탁해 게이트를 무력화할 수 있다 — 브랜드 타입이 사는 보증의 정확히 그 부분이다. 원칙 1("지킬 수 없으면 테스트가 아니라 타입으로 닫는다")을 여기서만 낮출 이유가 없고, grep 가능한 이름은 CI에서 아무것도 실패시키지 않으므로 테스트보다도 약하다. `eslint.config.js`에 `no-restricted-imports`(또는 `no-restricted-syntax`) 규칙을 추가해 `internalCommand`의 import를 **`src/ssh/session.ts`와 `tests/**`로만** 허용한다. 이 파일은 이미 `files:`로 범위를 나눈 블록 구조를 쓰므로(`eslint.config.js:36-43`, `:46-47`, `:53-55`) G-1의 경로 기반 제한과 같은 블록에 넣는다. 함수 주석에는 "모델 입력에는 절대 쓰지 말 것"과 이유를 적는다.

**재작성 가능 판정 (AC-J3a, Architect imp4 / Critic I7 반영).** `NormalizeResult.segments`(`src/safety/normalize.ts:98`)는 주석대로 **모든 깊이**의 세그먼트다(`:97`). 따라서 술어는:

1. `segments.length === 1` — 전 깊이 합이 1이어야 서브셸·`$()`·`sh -c` 중첩이 배제된다. `depth === 0` 필터만 쓰면 `docker ps --format $(x)`가 통과한다.
2. `segments[0].terminator === ''`(`:25`, `:57`) — 파이프·`;`·`&&`·`||`·`&`를 배제.
3. **리다이렉션 토큰 없음** — `>`·`<`는 세그먼트를 끝내지 않고 `pushOperator`로 토큰이 될 뿐이다(`:1034-1038`). 즉 `docker ps > out.txt`는 1·2를 모두 만족하므로, **이 조건만이 유일하게 그것을 막는다.**
4. `unparseable === false`(`:99`), `hereDocs === 0`(`:101`).

#### OP-4. `--from-ssh-config` 파서 범위와 인자 우선순위

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| **A + 프리필 (채택)** | 파서가 **플래그 토큰**을 만들고 사용자 argv를 그 뒤에 붙여 `parseSetupArgs`가 재파싱. 값은 `runSetupWizard()`(`src/setup/wizard.ts:149-268`)의 기본 답으로 들어간다 | 두 번째 경로가 물리적으로 없다. 위저드가 이미 쓰는 메커니즘 그대로(`src/setup/cli.ts:506-516`) | 새 플래그 2개와 위치 인자 요구의 상호작용을 명시해야 한다 |
| B | `HostEntry` 초안을 만들어 위저드에 넘긴다 | 확인 단계가 자연스럽다 | `AliasSchema`·포트 검증이 두 곳이 된다 |

**선택: A + 프리필.**

**우선순위 (결정 6): 명시 CLI 플래그 > 위저드 확인 답(기본값 = ssh_config seed).**

iteration 2의 "명시 CLI > ssh_config > 위저드"는 토큰 순서와 뒤집혀 있었다. 위저드 산출 토큰은 `parseSetupArgs([...argv, ...extra])`(`src/setup/cli.ts:516`)에서 **맨 뒤**에 붙으므로 last-wins로 seed를 이기고, **그것이 AC-S5가 요구하는 동작이다** — seed는 위저드가 보여 주는 기본 답이고 사람의 확인이 최종값이다.

**seed는 `given`(`src/setup/cli.ts:287`)에 넣지 않는다.** `given`에 들어간 항목은 위저드가 질문을 건너뛰므로, seed를 넣으면 AC-S5의 확인 단계가 사라진다. `given`에 들어가는 것은 **사용자가 실제로 타이핑한 플래그뿐**이다.

**파서의 last-wins 실측.** `parseSetupArgs`(`src/setup/cli.ts:210-328`)의 루프는 각 플래그를 지역 변수에 **덮어쓴다**(`--approval-fallback` `:236`, `--approval-mode` `:249`, `--label` `:268`). 따라서 같은 플래그가 두 번 오면 **뒤가 이긴다.** 반면 **위치 인자는 last-wins가 아니다** — 배열에 push되고 3개째는 즉시 오류다(`:292-294`). 그러므로 **config seed는 플래그 토큰만 만들고 위치 인자는 만들지 않는다.**

**위치 인자 요구와의 상호작용.**

| 사용자 입력 | `missingPositionals`(`:284-289`) | 위저드(`:499`) | ssh_config 값의 역할 |
|-------------|----------------------------------|----------------|----------------------|
| 위치 인자 0개 + `--from-ssh-config foo` | true | 열림 | 위저드 기본 답. 사용자가 함께 준 `--alias`/`--port`는 seed보다 뒤에 놓여 last-wins로 이긴다. **seed 자체는 `given`에 넣지 않으므로 질문은 전부 그대로 나온다** |
| 위치 인자 2개 + `--from-ssh-config foo` | false | 안 열림 | AC-S3 거부 검사만 수행하고 값은 쓰지 않는다. stderr 1줄로 그 사실을 알린다 |
| 위치 인자 1개 | false | 안 열림 | 기존 사용법 오류(`:280-291`), 종료 코드 2. 변화 없음 |
| 위치 인자 0개 + 비-TTY | true지만 `canPrompt()`(`src/setup/ask.ts:90`) false | 안 열림 | 범용 메시지 대신 "`--from-ssh-config`는 TTY에서만 동작합니다" 1줄 후 종료 코드 2 |

**파서 범위** (`src/setup/sshConfig.ts`):
- 주석(`#`) 제거, 키워드 대소문자 무시, `key value`·`key=value` 모두 허용.
- `Host` 블록의 패턴 목록에 **요청 이름과 정확히 일치하는 리터럴**이 있을 때만 대상(AC-S1).
- `Include`는 깊이 0에서만 전개. **glob은 `fs.readdirSync` + 자체 매처**로 구현한다(결정 7) — `fs.globSync`는 Node 22 추가이고 `engines`가 `^20.17.0`을 허용하므로 Node 20에서 `TypeError`가 난다. `assert-bundle-imports`는 named import만 보므로 빌드가 이것을 못 잡는다. `~` 확장, 상대 경로는 `~/.ssh/` 기준. 포함된 파일 안의 `Include`는 무시 + stderr 1줄(AC-S2).
- 와일드카드 `Host`(`*`/`?`), 적용되는 `Match`, 블록의 `ProxyJump`/`ProxyCommand` → `config_unsupported` + 종료 코드 2, 부분 가져오기 없음(AC-S3). CLI 종료 사유이므로 `ERROR_CODES`(`src/errors.ts:11-67`)에 추가하지 않는다.
- `IdentityFile`·`IdentityAgent`는 읽고 버린다 + 위저드 요약 1줄(AC-S4).
- 경로 재지정: `SSH_MCP_SSH_CONFIG`.

#### OP-5. `connect`/`exec` CLI의 spawn 전략과 서버 격리

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| A | `spawn('ssh', ...)` 후 ENOENT를 잡아 안내 | 10줄 | AC-C3이 오류 핸들러 추측이 된다 |
| **B (채택)** | `resolveSshBinary()`로 `PATH`(×Windows `PATHEXT`)를 먼저 훑어 절대 경로를 얻고, 없으면 OS별 안내 후 종료 1. 있으면 절대 경로로 `spawn(..., { stdio:'inherit', shell:false })` | 사전 점검이 순수 함수라 테스트 가능. AC-C3이 추측이 아니라 판정 | PATH 스캔 ~30줄 |
| C | `shell: true` | 인용 고민 없음 | `--` 뒤 명령이 `cmd.exe` 인용 규칙을 타 원문 보존(AC-C2)이 깨지고 주입면이 생긴다 → 기각 |

- argv: `['-i', privateKeyPath, '-p', String(port), '-o', 'IdentitiesOnly=yes', `${user}@${hostname}`]`. `exec`는 뒤에 `--` 이후 토큰을 **개별 원소로** 붙인다(OpenSSH 클라이언트가 공백으로 합쳐 보낸다).
- `shell:false`이므로 Node가 MSVCRT 규칙으로 인용하고 Win32 OpenSSH가 같은 규칙으로 파싱한다.
- 종료 코드는 `close`의 `code`를 그대로, 시그널 종료는 `1`.

**서버 경로 격리 4장치.**

| # | 장치 | 실패 시 |
|---|------|---------|
| G-1 | `ssh` 탐색·spawn 코드는 `src/connect/` CLI 전용 모듈에만. `src/server.ts`·`src/tools/`·`src/ssh/`에서 import 금지 | 서버가 `ssh` 유무에 의존 |
| G-2 | 진입은 `COMMANDS` 썽크의 동적 import뿐(`src/commands.ts:25-33`, 라우터 `src/index.ts:43-79`). **단 이것은 평가 시점만 늦춘다** — 스크립트 헤더가 "번들러는 번들된 코드의 모든 정적 import를 엔트리로 호이스트한다"고 못박았다 | 서버 기동 때마다 CLI 코드가 평가된다 |
| G-3 | **실제 방어선.** 신규 CLI 모듈의 builtin 접근은 전부 **네임스페이스 import**로 한다 — `src/connect/ssh.ts`의 `child_process`(`ALLOWED`에는 `spawnSync`만, `scripts/assert-bundle-imports.mjs:63-69`), `src/setup/sshConfig.ts`의 `fs`, `src/audit/reader.ts`의 `fs`(**`ALLOWED`에 `fs` 키 자체가 없다**) | 2026-09-14 `util.styleText` 사고 재현 — `--version`조차 안 나온다 |
| G-4 | `doctor`는 `ssh` 존재를 **INFO로만** 보고한다. 선례: `cpu-features` 부재를 "information, never a failure"로 처리하는 항목 2(`src/doctor/checks.ts:60-61`) | 깨끗한 러너에서 `doctor`가 exit 1 → AC21.10과 `no-build-tools` 잡이 깨진다 |

#### OP-6. `real-sshd` 잡 설계

| 옵션 | 내용 | 장점 | 단점 |
|------|------|------|------|
| A | `services:` + 공개 이미지 | 빌드 0초 | Actions의 `services:`는 이미지만 받고 로컬 Dockerfile을 빌드하지 못한다 → 사용자·sftp·`StrictModes` 고정 불가 |
| **B (채택, D7 사용자 결정)** | 저장소 안 `tests/sshd/Dockerfile`을 잡에서 빌드 | AC-T2를 문자 그대로 만족. sshd 설정이 저장소에서 리뷰된다 | YAML +30줄, 빌드 ~60초. 레지스트리·레이어 캐시·이미지 내부 apt가 비결정성의 출처 |
| C | 러너에 `openssh-server` 직접 설치 + 체크인된 `sshd_config`·셋업 스크립트 | 비결정성 출처 3개 제거. `useradd -m sshmcp`가 만드는 `/home/sshmcp`(0755, 소유자 sshmcp)는 `StrictModes yes`가 원하는 상태이므로 iteration 1의 "권한 충돌" 기각 사유는 추측이었다 | AC-T2의 문면과 어긋난다 |

**선택: B.** Architect 2-4는 C가 더 낫고 AC-T2를 "완화 가치가 있는 스펙 항목"으로 사용자에게 올려야 한다고 지적했으며, 그 논증 자체는 옳다. **사용자가 D7로 Dockerfile 유지를 결정했으므로 B를 확정한다.** iteration 1이 C를 "권한 충돌"로 기각한 것은 근거가 틀렸으므로 ADR-015 Alternatives에 정정해 기록한다 — 실제 기각 사유는 "AC-T2가 명시했고 사용자가 재확인했다"뿐이다.

**bd8f53b의 차단 사유는 이미 해소돼 있다.** 원격 홈은 `probeRealSshd`(`tests/fixtures/endpoints.ts:114-160`)가 첫 비밀번호 접속에서 `echo $HOME`으로 얻어 `remoteHomeDir`(`:60`, `:190`)로 노출한다. 잡이 넘길 것은 env 4개뿐(`:172-175`).

**컨테이너 패키지 (결정 8).** `openssh-server`, **`procps`**(`pgrep`/`pkill` — `src/ssh/session.ts:853,862`가 `pkill`을, `tests/integration/exec.test.ts:170`이 `pgrep -f 'sleep 37'`을 쓰고 AC-T4가 이를 명시적으로 요구한다. `ubuntu:24.04`에 기본 포함되지 않는다), **`gawk`**(`tests/integration/session.test.ts:47`의 `TWO_MIB_COMMAND`), `zsh`·`dash`(AC-T5). `sudo`는 **설치하지 않는다** — 테스트가 쓰지 않고, 없는 편이 컨테이너를 좁게 유지한다.

**skipIf 축소 (결정 9).** 6곳 중 **2곳만** 해제한다.

| 행 | describe | 판정 |
|----|----------|------|
| `:101` | session state on ${SHELL} | **유지.** 첫 테스트가 `connect({ shell: SHELL })`로 시작하는데(`:103`) `shell`은 fixture 전용이고 sshd 분기(`tests/fixtures/endpoints.ts:171-199`)는 조용히 무시한다. 게다가 `SHELL === 'bash'`면 `detected_shell`이 `'bash'`임을 단언하므로(`:107-109`) A9의 chsh 매트릭스와 정면 충돌한다 |
| `:321` | inherited shell options (F5) | 유지 — `shellArgs`(fixture only, `endpoints.ts:73`) |
| `:349` | dash preamble (AC14.4) | 유지 — `shell`(fixture only, `:71`) |
| `:373` | unsupported shells | 유지 — `shellEmulation`(fixture only, `:77`) |
| `:414` | lifecycle (AC15) | **해제** |
| `:546` | command timeout (AC11.4) | **해제** |

해제된 2곳은 공유 헬퍼 `connect()`(`tests/integration/session.test.ts:72-86`)를 쓰고, 그 헬퍼가 `:78`에서 `authorizeKey`를 무조건 부르는데 그 함수는 sshd 티어에서 즉시 throw한다(`tests/fixtures/endpoints.ts:300-308`). 따라서 **교체 지점은 세 군데가 아니라 헬퍼 한 곳**이다.

**셸 매트릭스 (결정 10).** **한 잡 안 3스텝.** matrix로 하면 검사 이름이 `real-sshd (bash)`·`(dash)`·`(zsh)` 셋이 되어 Q5와 §8.4가 어긋난다. 잡은 `name: real-sshd (ubuntu-latest)`를 명시한다(선례 `.github/workflows/ssh-mcp-ci.yml:41`).

**20분 예산 (AC-T6).** docker build ~60초 + 컨테이너 기동 대기 최대 30초 + `ENDPOINT=sshd npm run test:integration` 1회(현재 fixture 티어 통합 스위트가 CI에서 3~4분) + 셸 3스텝은 `session.test.ts` 한 파일만 돌리므로 레그당 ~1분 = 약 **9~10분**. 여유 2배. 초과하면 셸 3스텝을 `session.test.ts`의 해제된 2개 describe로 좁힌다.

#### OP-7. probe 실행과 `setup` 경고

**probe.** `ssh-mcp/.omc/artifacts/elicit-probe.mjs`를 의존성 0 stdio MCP 서버로 쓴다. 도구 1개(`probe`)에 `variant: "empty"|"boolean"|"enum"`을 두어 한 세션에서 3안을 차례로 띄운다.

**측정 4항목.** (1) 그려진 위젯 종류, (2) 아무것도 건드리지 않고 Accept를 눌렀을 때 제출되는가, (3) 제출되면 `content`가 무엇인가, (4) Decline과 Cancel이 구분되는가.

**판정 규칙.** 아무 조작 없이 Accept가 승인으로 이어지지 **않는** 경우에만 enum 채택. 채택 시 스키마는 `{ choice: enum["run","cancel"] }`, 승인은 `action === 'accept' && content.choice === 'run'`만.

**대안: probe 없이 enum 채택.** 무효화 근거 — `CHANGELOG.md`의 0.2.0/0.2.1 항목이 Claude Code 렌더링에 대한 추측이 **연속 2회** 틀렸음을 기록한다.

**`setup` 경고 위치.** `src/commands.ts:29-32`의 로더가 `runSetup`을 감싸 stderr 1줄을 먼저 쓴다. `runHost(['add', ...])`는 `runSetup`을 직접 부르므로(`src/host/cli.ts:46`) 경고가 나가지 않는다 — 요구가 정확히 그것이다. **같은 약속이 세 곳에 더 있다**: `src/commands.ts:29-31` 주석("keeps working with no warning … nagging here would break a working setup for no benefit"), `src/help.ts:71`, `src/setup/cli.ts:115`. D11이 그 결정을 뒤집으므로 넷 다 같이 고친다.

#### OP-8. 단계 순서

**선택: Phase A(probe · R24 · real-sshd) 우선.** Phase A의 산출물은 코드가 아니라 **결정과 검증 능력**이고 둘 다 미룰수록 비싸진다.

**긴장 해소 (결정 12).** AC-T1의 브랜치 보호 등록은 **Phase A 산출물이 아니라 릴리스 게이트**다. Phase A는 "잡이 존재하고 녹색"까지만 책임진다. 등록이 이르면 Phase B~G의 모든 PR이 검증되지 않은 신생 잡에 막히기 때문이다. 등록 조건은 "연속 5회 녹색 관측 후"이며 §8.4에 있다.

---

## 3. Pre-mortem

### PM-5. `real-sshd`가 불안정해 팀이 게이트를 껐다

**시나리오.** 컨테이너 기동 경합이나 apt 실패로 잡이 가끔 빨갛다. 급한 PR이 막히자 `continue-on-error: true`가 붙고, 3개월 뒤 아무도 그 잡의 실패를 보지 않는다 — bd8f53b 재현.
**탐지 (결정 5 — iteration 1의 배치는 자기무력화였다).** 가드 스텝을 `real-sshd` 잡 안에 두면, 누군가 그 잡에 `continue-on-error: true`를 붙이는 순간 가드의 exit 1도 함께 삼켜진다. 따라서 가드는 **`build-test` 잡의 스텝**으로 둔다. CI에 `defaults.run.working-directory: ssh-mcp`가 있으므로(`.github/workflows/ssh-mcp-ci.yml:26-28`) 그 스텝은 `working-directory: .`를 지정하거나 `../.github/workflows/ssh-mcp-ci.yml` 경로를 쓴다.
**완화.** (a) 베이스 이미지 태그 고정(`ubuntu:24.04`). (b) 기동 대기는 sleep이 아니라 TCP 연결 재시도(0.5초 간격, 최대 30초, AC-T6). (c) 실패 시 `docker logs`를 항상 업로드.
**잔여 위험 (인정만).** 가드가 `build-test` 안에 있으므로 `build-test` **자신**에 `continue-on-error`를 붙이면 같은 일이 한 단계 멀어진 채 반복된다. 주 테스트 잡을 통째로 비활성화하는 것은 눈에 띄므로 수용 가능한 잔여 위험으로 둔다(R39). 이 가드는 절대 뚫리지 않는 장치가 아니다. `build-test`가 4레그 매트릭스이므로 가드가 4회 도는 것은 무해하며 의도한 것이다.

### PM-6. 보관·파싱이 메모리와 이벤트 루프를 동시에 먹었다

**시나리오.** 사용자가 `journalctl -n 100000`을 `format:"json"`으로 몇 번 돌린다. 스토어가 64 MiB를 채운 채 10분을 버티고, 동시에 한 번의 `JSON.parse`가 SSH 스트림을 펌프하는 메인 스레드를 수백 ms 멈춘다. 환경변수 덤프가 대화 종료 후에도 10분간 메모리에 남는다.
**탐지.** (a) 통합 테스트가 잘린 출력 20건 후 `heapUsed` 증가분이 상한 + 8 MiB 이내인지 단언. (b) **단일 `format:"json"` 호출의 이벤트 루프 블록 시간**을 측정해 상한을 건다. (c) **응답 본문 바이트**가 `emitCapFor(host) + stdout 발췌 상한 + 여유` 이내인지 단언한다 — 2 KiB 절단 해제가 `parsed`의 크기를 묶던 유일한 장치를 없앴기 때문이다. (d) AC-O3 테스트(`SSH_MCP_HOME` 아래 새 파일 0개)가 디스크 유출을 따로 막는다.
**완화.** (a) 상한 **세 개**를 용도별로 분리해 전부 `src/output/limits.ts`에 둔다 — 보관 `min(4 × maxOutputBytes, 16 MiB)`(Q3), 파싱 입력 `min(4 × maxOutputBytes, 4 MiB)`(Q9, 부록 B-2), 응답 탑재 `min(2 × maxOutputBytes, 4 MiB)`(AC-J6b, 부록 B-2). (b) TTL 청소를 `put`과 `get` 양쪽에서 돌린다. (c) README 보안 모델에 "10분 · 메모리 전용 · 디스크 미기록 · PEM 마스킹 적용"을 명시. (d) in-flight 피크(`64 MiB + 2 × retainCap × 동시 실행 수`)를 Q3 근거에 회계로 남긴다.

### PM-7. 재작성된 명령을 사람이 읽지 않고 승인했다

**시나리오.** 모델이 `format:"json"`으로 `docker container ls`를 부르고 승인 창에는 `docker container ls --format json`이 뜬다. 사용자는 자기가 시키지 않은 꼬리표를 보고 넘긴다. 나중에 표에 위험한 플래그가 섞이면 같은 습관으로 통과한다.
**탐지.** 단위 테스트가 표의 **모든** 항목에 대해 (a) 재작성 전후 `classify()` 등급과 `reasons`가 같고 (b) 추가되는 토큰이 표의 리터럴과 정확히 일치함을 단언한다.
**완화.** (a) 표의 `flag`는 리터럴만, 사용자 입력을 끼워 넣지 않는다. (b) 승인 창 첫 줄은 `ctx.promptText`이고 이는 `maskCommandSecrets(input.command)`다(`src/safety/approval.ts:401`, `:434`) — 즉 **비밀만 가려진 실행 대상 명령**이며, 재작성 결과가 그 자리에 온다. (c) 감사 줄 `command`도 같은 마스킹 뷰(`auditView`, `:445`)라 사후 대조가 된다.

---

## 4. Acceptance Criteria

스펙의 AC id를 그대로 승계한다 — AC-H1~H7(7) · AC-O1~O8(8) · AC-J1~J7(7) · AC-S1~S6(6) · AC-C1~C7(7) · AC-T1~T6(6) · AC-E1~E4(4) · AC-A1~A2(2) · AC-R1~R4(4) = **51개**. 아래는 테스트 가능성을 위해 추가하는 하위 기준이다.

- **AC-H2a** 커서는 `{f,o,s,h}`를 담고, `f===0`에 append만 일어난 경우(현재 크기 `>= s`) 페이지가 끊기지 않는다.
- **AC-H2b** 회전 시 `f===0`은 `.1.size >= s` **그리고** `o < s`로 승계한다. `f>0`은 같은 인덱스에 대해 `=== s`만 확인하며, **회전으로 인덱스가 밀려 올라간 경우는 승계하지 않고 항상 `history_cursor_stale`**이다. 오프셋 `o`가 가리키는 줄(다음에 읽을 줄)의 해시가 `h`와 다르면 `history_cursor_stale`. 2회 이상 회전도 `history_cursor_stale`.
- **AC-H2c** `history` 한 번의 힙 증가분이 파일 크기와 무관하다(64 KiB chunk + 한 줄 이내).
- **AC-O1a** 보관 술어는 `meta.truncated === true`다. 비UTF-8 잘림(`encoding: 'base64'`)에서도 `output_ref`가 non-null이다.
- **AC-O1b** 타임아웃·오류 응답의 `output_ref`는 `null`이다(Q4).
- **AC-O4a** 항목별 보관 상한은 `4 × host.maxOutputBytes`. 초과 스트림은 보관되지 않아 `truncated === true`인데도 `output_ref`가 `null`이다.
- **AC-O2a** `fetch_output`의 `total_bytes`·`offset`·`next_cursor`는 전부 **마스킹 후 버퍼**의 **바이트** 기준 단일 좌표계다. 비교는 항상 바이트 단위 Buffer 길이로 한다 — 응답의 `chunk`는 `encoding`에 따라 utf8 문자열이거나 base64 문자열이므로 문자열 길이로 재면 base64 항목에서 어긋난다. 모든 chunk를 디코드해 이어 붙인 **바이트** 길이가 `total_bytes`와 정확히 일치한다. **이 `total_bytes`는 `stdout_meta.total_bytes`와 다른 양이다** — 후자는 와이어 바이트 수(`src/ssh/excerpt.ts:86-87` "Bytes seen on the wire")이고 전자는 마스킹 후 보관 길이라, PEM이 마스킹된 스트림에서는 전자가 작다.
- **AC-O7a** 보관 버퍼는 **`put` 시점에 버퍼 전체에 `maskPemBlocks`를 1회** 적용한 결과다. 페이지 슬라이스에는 마스킹을 걸지 않는다. 길이 절단·키 마스킹·깊이 제한은 적용하지 않는다. `encoding: 'base64'` 항목도 같은 처리를 받으며, **왕복은 `latin1`으로 한다** — `buf.indexOf('-----BEGIN ')`로 먼저 훑어 마커가 없으면 왕복 없이 원본 Buffer를 저장하고, 있을 때만 `toString('latin1')` → 마스킹 → `Buffer.from(masked, 'latin1')`로 되돌린다. `utf8` 왕복은 부정 시퀀스를 U+FFFD로 치환해 바이트를 파괴한다.
- **AC-J6b** `JSON.stringify(parsed)`의 바이트 길이가 **`emitCapFor(host)` = `min(2 × host.maxOutputBytes, 4 MiB)`** 를 넘으면 `parsed`를 싣지 않고 `parse_error: "parsed_too_large"`로 끝낸다. AC-J7의 `too_large`는 **입력 stdout 크기**를 재고 이것은 **출력 크기**를 재므로 둘은 다른 기준이다. 이 상한은 AC-J7 축소이므로 부록 B-2에 승인 항목으로 등재한다.
- **AC-J2a** 표의 모든 항목에서 재작성 전후 `classify()` 등급과 `reasons`가 동일하다.
- **AC-J3a** 재작성 가능 술어는 `segments.length === 1`(전 깊이) ∧ `terminator === ''` ∧ 리다이렉션 연산자 토큰 없음 ∧ `unparseable === false` ∧ `hereDocs === 0`이다.
- **AC-J5a** `resolveCommand`를 거치지 않은 문자열은 `approveCommand`(`src/tools/gated.ts:53`)·`execOnce`(`src/ssh/exec.ts:76`)·`runInSession`(**공개 `src/ssh/session.ts:970`**) 셋 **전부**에 컴파일되지 않는다. `internalCommand`의 import는 ESLint가 `src/ssh/session.ts`와 `tests/**` 밖에서 거부한다.
- **AC-J6a** `parsed`는 응답 조립부의 기본 `redact()`를 타지 않는다. 전용 `redactParsed()`가 민감 키 마스킹(`SENSITIVE_KEY_PATTERN`, `src/log.ts:25`)과 문자열 내 PEM 마스킹만 적용하고, 2 KiB 문자열 절단은 하지 않으며 깊이 상한은 **64**다(초과 시 `[depth-exceeded]`).
- **AC-J7a** 파싱 상한은 `Math.min(4 × maxOutputBytes, 4 MiB)`이고 초과 시 `parse_error: "too_large"`.
- **AC-S1a** `--alias`·`--port`가 새로 파싱되고 기존 검증(`AliasSchema`, 포트 1–65535)을 그대로 탄다. config seed는 플래그 토큰만 만들고 위치 인자는 만들지 않는다.
- **AC-S6a** OP-4 상호작용 표의 4행이 각각 테스트로 고정된다.
- **AC-C6a** 예약어 목록은 `src/commands.ts` 한 곳에서 `COMMAND_NAMES`로부터 파생된다.
- **AC-T3a** 해제된 2개 describe는 공유 헬퍼 `connect()` 한 곳의 분기로 sshd 티어에서 키를 설치한다.
- **AC-H7a** R24 테스트가 먼저 **존재해야** 한다(Q1). `windows-latest`에서 자식 2개 × 1000줄 → 전 줄 유효 JSON, 총 2000줄.

51 + 17 = **68개**. 사람 확인이 필요한 것은 AC-E2(렌더링 관찰), AC-R4(배포 전 수동), AC-T1의 브랜치 보호 등록 3개 → **자동 검증 가능 65/68 ≈ 96%**.

---

## 5. Implementation Steps

### Phase A — 선행 (probe · R24 · sshd 티어)

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| A1 | `elicit-probe.mjs`: 의존성 0 stdio MCP 서버, 도구 `probe(variant)`, 3안. 등록 스니펫을 파일 상단 주석에 | 신규 `ssh-mcp/.omc/artifacts/elicit-probe.mjs` | AC-E1 |
| A2 | **사용자 실행 + 결과 기록**: 측정 4항목을 표로 | 신규 `ssh-mcp/.omc/artifacts/elicit-probe-result.md` | AC-E2 |
| A3 | R24 테스트 신규 작성(Q1): 임시 `SSH_MCP_HOME`에 자식 2개를 `fork`해 각 1000줄 `appendAudit` → 전 줄 `JSON.parse` 성공 + 총 2000줄 | 신규 `tests/unit/auditConcurrency.test.ts`, 신규 `tests/fixtures/auditWriter.mjs` | AC-H7a |
| A4 | sshd 이미지: `ubuntu:24.04` + `openssh-server` + **`procps`** + **`gawk`** + `zsh` + `dash`. 테스트 사용자, 비밀번호 인증, `Subsystem sftp /usr/lib/openssh/sftp-server`, `StrictModes yes`. `sudo`는 설치하지 않는다 | 신규 `ssh-mcp/tests/sshd/Dockerfile`, 신규 `ssh-mcp/tests/sshd/sshd_config` | AC-T2, AC-T4 |
| A5 | `real-sshd` 잡, **`name: real-sshd (ubuntu-latest)` 명시**: `docker build` → `docker run -d -p 2222:22` → TCP 재시도(0.5초 × 60) → `ENDPOINT=sshd npm run test:integration`. env 4개는 `tests/fixtures/endpoints.ts:172-175`가 요구하는 이름 그대로. `continue-on-error` 없음, `timeout-minutes: 20`, 실패 시 `docker logs` 업로드 | `.github/workflows/ssh-mcp-ci.yml` | AC-T1, T2, T6 |
| A6 | **`continue-on-error` 금지 가드를 `build-test` 잡의 스텝으로**(결정 5). `working-directory: .` 지정 또는 `../.github/...` 경로 | `.github/workflows/ssh-mcp-ci.yml:40` 잡 내부 | PM-5 |
| A7 | `authorizeKeyOverSsh` 추가: `installAuthorizedKey`(`src/setup/install.ts:87`) 재사용. 그 스크립트는 이미 멱등(`MARKER_ALREADY_PRESENT`, `src/setup/install.ts:15`)이므로 sshd 티어의 계정 재사용에도 중복 줄이 생기지 않는다 | `tests/fixtures/endpoints.ts` | AC-T3a |
| A8 | 공유 헬퍼 `connect()`의 `authorizeKey` 호출을 `endpoint.kind`로 분기 — **여기 한 곳만 고치면 6개 describe 전부가 따라온다** | `tests/integration/session.test.ts:72-86` (호출 `:78`) | AC-T3a |
| A9 | skipIf 축소: **`:414`·`:546` 2곳만** `!onFixture` 제거. `:101`·`:321`·`:349`·`:373`은 유지하고 어떤 fixture-only 옵션 때문인지 주석에 남긴다 | `tests/integration/session.test.ts:101,321,349,373,414,546` | AC-T3 |
| A10 | 셸 매트릭스: **한 잡 안 3스텝**. 컨테이너 안에서 `chsh`로 테스트 사용자 셸을 bash/dash/zsh로 바꿔 `session.test.ts`를 3회. `SHELL_UNDER_TEST`는 `:101` 유지 결정으로 결합이 사라졌으나, 혼동을 막기 위해 각 스텝에서 chsh한 셸과 같은 값으로 설정한다 | `.github/workflows/ssh-mcp-ci.yml`, `ssh-mcp/tests/sshd/Dockerfile` | AC-T5 |
| A11 | AC-T4 4항목이 sshd 티어에서 실제로 도는지 `it.runIf(onSshd)` 배치를 점검·보강(선례 `tests/integration/exec.test.ts:165`) | `tests/integration/{auth,exec,sftp}.test.ts` | AC-T4 |

### Phase B — 승인 스키마 확정 (A2 결과에 따름)

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| B1 | `ElicitRequest.requestedSchema.properties` 타입을 boolean/enum 유니온으로 확장 | `src/safety/approval.ts:124-128` | AC-E3 |
| B2 | `buildElicitRequestFor`의 `requestedSchema`를 `{ choice: enum["run","cancel"] }`로. 메시지 3줄 규칙(`:400-404`)은 유지 | `src/safety/approval.ts:406-420` | AC-E3 |
| B3 | `interpretElicitResult`를 `action==='accept' && content.choice==='run'`만 accept로 | `src/safety/approval.ts:140-146` | AC-E3 |
| B4 | `ELICIT_CONFIRM_FIELD`(`:60`)·`_TITLE`(`:80`)·`_DESCRIPTION`(`:93`) 제거 및 참조 정리 | `src/safety/approval.ts`, `tests/unit/approval.test.ts`, `tests/integration/approval.test.ts` | AC-E3, E4 |
| B5 | enum 불가 시: 실측 표에서 사람 개입이 가장 확실한 안을 택하고 근거를 CHANGELOG에 | 위와 동일 | AC-E4 |

### Phase C — `history` 도구

> **감사는 공짜다.** `runTool()`(`src/tools/wrap.ts:158-198`)이 모든 핸들러를 감싸며 호출당 정확히 1회 `appendAudit()`(`src/audit.ts:278-323`)를 부르고 예외·거부 경로도 포함한다. 명령 없는 도구는 `approveCommand`(`src/tools/gated.ts:71-141`)를 부르지 않으므로 `command`가 `newAuditDraft()`(`src/tools/wrap.ts:53-75`)의 기본값 `null`로 남는다. **AC-H5·AC-O6에 별도 코드가 필요 없고** 남는 일은 회귀 테스트뿐이다.

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| C1 | `TOOL_NAMES`에 `'history'`, `'fetch_output'` 추가 | `src/audit.ts:40-48` | AC-H5 |
| C2 | `assertSevenTools` → `assertRegisteredTools`, 개수를 `TOOL_NAMES.length`에서 파생. 호출부 `src/server.ts:213`, `TOOL_NAMES` import는 `src/server.ts:20`(정의는 같은 파일 `:250`이라 import 없음). 테스트는 import(`tests/unit/toolsList.test.ts:17`)와 **`.toThrow(/exactly 7 tools/)` 정규식 2곳(`:70`, `:73`)** 까지 | `src/server.ts:250-259`, `tests/unit/toolsList.test.ts` | AC-H6 |
| C3 | 역방향 청크 리더 `readNewestFirst(fileIndex, offset, chunkBytes)`. 경로는 **`auditRotatedFilePath()`(`src/config/paths.ts:100-105`)를 재사용**한다(`index === 0`이면 live 파일). `fs`는 네임스페이스 import(G-3) | 신규 `src/audit/reader.ts` | AC-H2, H2c |
| C4 | 커서 `{f,o,s,h}` 인코딩·검증 + 회전 승계(OP-2 규칙) | 신규 `src/audit/cursor.ts` | AC-H2a, H2b |
| C5 | `ERROR_CODES`에 `history_cursor_stale` 추가. **근거 주석 필수** — `src/AGENTS.md:60` 규약. 기존 추가분 3개(`connection_failed`·`local_path_forbidden`·`internal_error`)가 같은 형식 | `src/errors.ts:11-67` | AC-H2b |
| C6 | `history` 도구: 입력 `host/since/until/grade/tool/outcome/limit(기본 50, 최대 200)/cursor`, 출력 `{entries, next_cursor, skipped:{invalid_json, unknown_schema}}`. 깨진 줄·`schemaVersion!==1`은 건너뛰고 원문 미포함 | 신규 `src/tools/history.ts` | AC-H1, AC-H3 |
| C7 | 어노테이션 `{ readOnlyHint: true, openWorldHint: false }`. `INTERACTION_META_TOOLS`(`src/tools/annotations.ts:64`)에는 넣지 않는다 | `src/tools/annotations.ts:20-58` | AC-H4 |
| C8 | `register(historyTool)` | `src/server.ts:205-213` | AC-H1, AC-H6 |
| C9 | AC-H7 판정: A3이 실패면 `audit-<pid>.jsonl` 분리 + `history` 병합 읽기(커서에 pid 축 추가), 성공이면 코드 변경 없이 결과만 CHANGELOG 1줄 | `src/audit.ts:257-268`, `src/config/paths.ts:92-105` (조건부) | AC-H7 |

### Phase D — `fetch_output`과 OutputStore

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| D1 | `ExcerptMeta.output_ref` 타입을 `null` → `string \| null`. "always null in v1" 주석 교체 | `src/ssh/excerpt.ts:103-104` | AC-O1 |
| D2 | **누산기에 옵트인 `retain?: { cap: number }` 추가**(OP-1 A′). `finish()`가 `retained: Buffer \| null`을 함께 반환. `cap` 초과 시 즉시 포기하고 `null`. 기본값 off라 기존 호출부·테스트는 무변경 — 실측 확인: `tests/unit/excerpt.test.ts`는 meta를 리터럴과 비교하지 않고 두 결과를 서로 `toEqual`할 뿐이다(`:160`, `:363`) | **`ExcerptResult` `src/ssh/excerpt.ts:107-110`**(`retained`가 들어갈 자리), `ExcerptOptions` `:112-117`, `ExcerptAccumulator` `:119-125`, 본체 `:334-579`. 일회용 헬퍼 `excerpt()`(`:582-586`)는 누산기에 위임만 하므로 `retained: null`이 자동 전파된다 | AC-O4a, O7 |
| D3 | OutputStore: `put`/`get`/`resetOutputStore`, TTL 10분, 총량 64 MiB, 삽입 순서 폐기, `randomBytes(16)` ref. **`put`이 버퍼 전체에 `maskPemBlocks`를 1회 적용**하고 그 결과를 저장한다(Q8). 왕복은 **`latin1`**: `buf.indexOf('-----BEGIN ')`로 훑어 마커가 없으면 원본 Buffer를 그대로 저장(왕복 0회), 있을 때만 `toString('latin1')` → 마스킹 → `Buffer.from(masked, 'latin1')`. `utf8`은 부정 시퀀스를 U+FFFD로 바꿔 바이너리를 파괴하므로 쓰지 않는다. `get`은 이미 마스킹된 버퍼를 슬라이스만 한다. 좌표계는 마스킹 후 버퍼의 바이트 기준 | 신규 `src/output/store.ts` | AC-O2a, O4, O5, O7a |
| D4 | 상한 상수 **3개**를 한 파일에, 전부 절대 상한을 동반한다(원칙 3): `retainCapFor(host)` = `min(4 × maxOutputBytes, 16 MiB)`(보관), `parseCapFor(host)` = `min(4 × maxOutputBytes, 4 MiB)`(파싱 입력), **`emitCapFor(host)` = `min(2 × maxOutputBytes, 4 MiB)`(응답 탑재)**. 세 값의 호스트별 실측은 부록 B-2 표 | 신규 `src/output/limits.ts` | AC-O4a, AC-J7a, AC-J6b |
| D5 | `CommandOutput`/`SessionRunResult`에 `stdout_retained`/`stderr_retained` 추가하고 누산기 생성 시 `retain`을 넘긴다. **배선은 생성 지점 2곳뿐**(`src/ssh/exec.ts:82-83`, `src/ssh/session.ts:875-876`) — A′ 덕분에 `:137-142`·`:890-891`의 push 콜백은 건드리지 않는다 | `src/ssh/exec.ts:76-185`, `src/ssh/session.ts:869-955` | AC-O7 |
| D6 | `CommandResultInput`(`src/tools/gated.ts:143-156`)에 보관 바이트 2개를 **추가**하고, `commandResultBody`에서 `meta.truncated === true`인 스트림만 `put` 후 `{...meta, output_ref}`로 조립. 타임아웃 경로는 이 함수를 지나지 않으므로 Q4가 자동 보장 | `src/tools/gated.ts:143-156`, `:174-199` | AC-O1, O1a, O1b |
| D7 | `fetch_output` 도구: `{output_ref, cursor?, max_bytes?}`(기본 64 KiB, 최대 1 MiB) → `{chunk, encoding, next_cursor, total_bytes}`. **도구 description에 "`total_bytes`는 마스킹 후 보관 길이이며 `stdout_meta.total_bytes`(와이어 바이트)와 다를 수 있다. 페이징 종료 판정은 `next_cursor === null`로 한다"를 한 줄 넣는다.** `output_expired` 오류 코드 추가 시 **근거 주석**(`src/AGENTS.md:60` 규약) | 신규 `src/tools/fetchOutput.ts`, `src/errors.ts:11-67` | AC-O2, AC-O4 |
| D8 | 어노테이션 `readOnlyHint: true` + `register(fetchOutputTool)` | `src/tools/annotations.ts:20-58`, `src/server.ts:205-213` | AC-O6 |
| D9 | 감사 줄에 `output_ref`가 없음을 회귀 테스트로 고정(스키마가 `.strict()`, `src/audit.ts:100`이라 추가되면 즉시 실패) | `tests/integration/audit.test.ts` | AC-O5 |
| D10 | `close_session`이 보관 출력을 폐기하지 **않음**을 테스트 + README 명시 | `tests/integration/output.test.ts`, `README.md` | AC-O8 |

### Phase E — `format: "json"`

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| E1 | **브랜드 타입 + 재작성 헬퍼**: `ResolvedCommand`, `resolveCommand(raw, format)`, `internalCommand(raw)`(주석에 "모델 입력에는 쓰지 말 것"과 이유). 이 파일은 **브랜드 타입 전용**이고 리댁션은 두지 않는다 | 신규 `src/output/resolve.ts` | AC-J5a |
| E1b | **ESLint 잠금**: `no-restricted-imports`에 **`importNames: ['internalCommand']`를 반드시 명시**한다 — 모듈 경로 단위로 막으면 같은 파일의 `resolveCommand`까지 막혀 `src/tools/exec.ts`·`src/tools/runInSession.ts`가 컴파일되지 않는다(두 도구가 반드시 import해야 하는 함수다). 형태는 `paths: [{ name: '…/output/resolve.js', importNames: ['internalCommand'], message: '…' }]`. **G-1과는 별도 블록 2개**다 — G-1의 범위는 `src/server.ts`·`src/tools/`·`src/ssh/`이고 E1b의 범위는 "`src/ssh/session.ts`와 `tests/**`를 제외한 전부"라 `files:`/`ignores:`가 다르다. 기존 블록 구조(`eslint.config.js:36-43`, `:46-47`, `:53-55`)를 따른다 | `eslint.config.js` | AC-J5a |
| E2 | 시그니처 교체 3곳: `ApproveCommandInput.command`(`src/tools/gated.ts:53`), `execOnce`(`src/ssh/exec.ts:76`), **`runInSession` 공개 시그니처(`src/ssh/session.ts:970`)와 비공개 `runCommand`(`:871`) 둘 다**. `GateInput.command`(`src/safety/approval.ts:160`)는 `string`으로 둔다. **프로덕션 `execOnce` 호출부는 3곳** — `src/ssh/session.ts:853`·`:862`는 `internalCommand()`로 감싼다 | 위 파일들 | AC-J5a |
| E2b | **테스트 일괄 치환.** 실측 파급: `execOnce` 22곳(전부 `tests/integration/exec.test.ts`) + `runInSession` 35곳 = **57곳 이상**. 매 호출부에서 판단하지 않도록 `tests/fixtures/`에 브랜드 생성기 `resolved(cmd)` **하나**를 두고 기계적으로 감싼다. 이 계획에서 가장 큰 단일 단계이므로 별도 실행자에게 준다 | 신규 `tests/fixtures/resolved.ts`, `tests/integration/exec.test.ts`, `tests/integration/session.test.ts` | AC-J5a |
| E3 | 화이트리스트 표 + 재작성 판정(AC-J3a 술어). `normalize()`(`src/safety/normalize.ts:1099`)만 사용 | 신규 `src/output/jsonCommands.ts` | AC-J2, J3, J3a |
| E4 | `parseDf`·`parsePs` 고정 컬럼 파서 | 신규 `src/output/tables.ts` | AC-J4 |
| E5 | 코퍼스 고정: ubuntu·alpine(busybox)·macOS의 `df -P`·`ps -eo ...` 각 1벌 | 신규 `tests/fixtures/output/{df,ps}-{ubuntu,alpine,macos}.txt` | AC-J4 |
| E6 | `exec`에 `format?: "text"\|"json"` 추가, `approveCommand` 직전에 `resolveCommand`. **`command`의 `.describe()`(`src/tools/exec.ts:40`)** 를 "format:json일 때 표에 있는 단일 명령은 도구 자체 JSON 플래그가 덧붙는다"로 정정 | `src/tools/exec.ts:35-55`, `:64-85` | AC-J1, J5 |
| E7 | `run_in_session`에 동일 적용. **`src/tools/runInSession.ts:42`의 `.describe()`("서버는 이 문자열을 한 바이트도 변형하지 않는다")도 같이 고친다** | `src/tools/runInSession.ts:38-56`, `:97-120` | AC-J1, J5 |
| E8 | `parsed`/`parse_error`를 응답 본문에 추가. **전용 `redactParsed()`** 를 쓴다 — `commandResultBody`의 기본 `redact()`는 `STREAM_FIELDS`(`src/tools/gated.ts:162`)가 아닌 모든 필드에 2 KiB 절단(`src/log.ts:35`)과 깊이 8 제한(`:38`)을 걸어 `docker inspect` JSON을 깨뜨린다. `redactParsed`는 민감 키 마스킹과 문자열 내 PEM 마스킹만 유지하고 깊이 상한을 64로 둔다. **집은 `src/log.ts`** — 이미 `SENSITIVE_KEY_PATTERN`(`:25`)·`maskPemBlocks`(`:102-105`)·`redactValue`를 소유한다. `src/output/resolve.ts`에 두면 무관한 두 관심사가 섞이고 R38이 걱정하는 "두 번째 리댁션 경로"가 물리적으로도 두 집이 된다. **`format:"text"`면 두 필드가 추가되지 않는다**(단 `output_ref`는 이 릴리스에서 별도로 바뀌므로 "0.2.1과 바이트 동일"이 아니다 — D2의 굵게 항목) | `src/tools/gated.ts:143-199`, 신규 `redactParsed` in `src/log.ts` | AC-J1, AC-J6, AC-J6a |
| E8b | **응답 크기 상한**(A-N1): `JSON.stringify(parsed)` 바이트가 `emitCapFor(host)`를 넘으면 `parsed`를 싣지 않고 `parse_error: "parsed_too_large"`. 2 KiB 절단을 푼 것이 `parsed`의 직렬화 크기를 묶던 유일한 장치를 없앴다 — 기본 호스트에서 응답 본문이 약 1.3 MiB에서 5.3 MiB로 커질 수 있고, 5 MiB 툴 결과가 모델 컨텍스트에 들어가면 `format:"json"`의 가치가 스스로 무너진다. `commandResultBody`의 주석(`src/tools/gated.ts:166-172`)이 같은 종류의 우려를 이미 적어 두었다 | `src/tools/gated.ts:174-199`, `src/output/limits.ts` | AC-J6b |
| E9 | 파싱 입력은 **마스킹 전** 버퍼(`CommandOutput.stdout_retained`)의 전체 stdout이다. 보관 버퍼가 둘이므로("마스킹 전" = 누산기 산출, "마스킹 후" = 스토어에 들어간 것) 하나를 골라 적어야 `parseCapFor` 비교 대상과 테스트가 결정적이 된다. `put`은 응답 조립 순서상 뒤이고, `parsed` 안의 개인키는 `redactParsed`의 문자열 내 PEM 마스킹이 받는다. `parseCapFor(host)` 초과면 `parse_error:"too_large"`, JSON 아니면 `"invalid_json"` | `src/output/jsonCommands.ts`, `src/tools/gated.ts:174-199` | AC-J7, J7a, J6 |
| E10 | 등급 불변 테스트(PM-7): 표 전 항목 재작성 전후 `classify()` 결과 동일 | `tests/unit/jsonCommands.test.ts` | AC-J2a |

### Phase F — CLI

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| F1 | ssh_config 파서. **glob은 `fs.readdirSync` + 자체 매처**(Node 20에 `fs.globSync` 없음). `fs`는 네임스페이스 import(G-3) | 신규 `src/setup/sshConfig.ts` | AC-S1, S2, S3 |
| F2 | `parseSetupArgs`에 `--from-ssh-config <Host>`·`--alias <name>`·`--port <n>` 추가. `optionValue`(`src/internal/argv.ts:31`) 사용. **`given`(`src/setup/cli.ts:287`)에는 사용자가 실제로 타이핑한 플래그만 반영하고 config seed는 넣지 않는다**(결정 6) — 넣으면 위저드가 질문을 건너뛰어 AC-S5의 확인 단계가 사라진다. **비-TTY 전용 오류 문구 1줄** 추가(범용 "needs both …" 메시지는 이 플래그를 준 사용자에게 무의미) | `src/setup/cli.ts:210-328` | AC-S6, S1a |
| F3 | 위저드 분기(`src/setup/cli.ts:499-532`)보다 먼저 config를 읽어 **플래그 토큰만** seed로 만들고 사용자 argv를 그 뒤에 붙여 재파싱(last-wins). 같은 값을 위저드 **기본 답**으로 전달하되 `given`에는 넣지 않는다. 최종 우선순위는 "명시 CLI 플래그 > 위저드 확인 답(기본값 = seed)". OP-4 상호작용 표 4행을 그대로 구현 | `src/setup/cli.ts:482-532`, `src/setup/wizard.ts:71-88` | AC-S5, S6a |
| F4 | `IdentityFile`/`IdentityAgent` 무시 안내 1줄을 위저드 요약에 | `src/setup/wizard.ts` | AC-S4 |
| F5 | `USAGE`(`src/setup/cli.ts:110-125`)에 새 플래그 3개. **`:115`의 "`setup`은 이 명령의 별칭으로 계속 동작합니다"에 0.4.0 제거 예고 추가** | `src/setup/cli.ts:110-125` | AC-S6, AC-A2 |
| F6 | `resolveSshBinary()` + `spawn` 래퍼(주입 가능). **CLI 전용 모듈**(G-1), `child_process`는 네임스페이스 import(G-3) | 신규 `src/connect/ssh.ts` | AC-C1, C3, 부록 B-1 |
| F7 | `connect` CLI: `USAGE`, `--help`는 stdout, 없는 alias는 `host_not_found` + 종료 2, ssh 부재는 OS별 안내 + 종료 1 | 신규 `src/connect/cli.ts` | AC-C1, C3, C5 |
| F8 | `exec` CLI: `--` 뒤 토큰을 재작성·분류 없이 개별 원소로 전달 | 신규 `src/connect/execCli.ts` | AC-C2, C4 |
| F9 | `COMMANDS`에 `connect`·`exec`를 **동적 import 썽크로만**(G-2) + `RESERVED_ALIASES` 상수. 라우터(`src/index.ts:43-79`)는 표를 읽을 뿐이라 무변경 | `src/commands.ts:25-44` | AC-C5, C6a, 부록 B-1 |
| F10 | `help` USAGE(`src/help.ts:38-72`)에 `connect`·`exec` 두 줄. 폭 규칙(`USAGE_DESCRIPTION_COLUMN`=41, `USAGE_MAX_COLUMNS`=80) 준수. **`:71`의 "계속 동작합니다"에 0.4.0 제거 예고 추가** | `src/help.ts:38-72` | AC-C5, AC-A2 |
| F11 | 예약어 거부를 `AliasSchema` 검사 직후에(`src/setup/cli.ts:296-305`). `-h`/`--help` 형태는 `AliasSchema`(`src/config/schema.ts:58`)가 이미 거부하므로 추가 검사 불필요 | `src/setup/cli.ts:296-305` | AC-C6 |
| F12 | `host list`에 예약어 경고. **`HostRow`(`src/host/list.ts:51-59`)는 테이블(`renderTable`, `:76`)과 `--json`이 공유하는 모양이므로 행에 필드를 추가하면 `--json` 스키마가 바뀐다.** 결정: `HostRow`에 `reservedAlias: boolean`을 추가하고 `toRow`(`:61-74`)가 채우며 테이블은 alias 뒤에 `(예약어)`를 붙인다. D2의 굵게 목록에 등재 | `src/host/list.ts:51-76`, `CHANGELOG.md` | AC-C6, D2 |
| F13 | `setup` 별칭 stderr 경고 1줄. **`src/commands.ts:29-31`의 반대 취지 주석("keeps working with no warning … nagging here would break a working setup for no benefit")을 새 근거(0.4.0 제거 예고가 생겼다)로 교체** | `src/commands.ts:29-32` | AC-A1 |
| F14 | `doctor`에 16번째 점검 `ssh-binary`: **항상 `INFO`**, 절대 `FAIL` 없음(G-4). `CHECK_KINDS`(`src/doctor/checks.ts:77-93`) 15 → 16. 종료 코드는 FAIL 개수만 세므로(`src/doctor/cli.ts:141`) 깨끗한 러너에서 0 유지 | `src/doctor/checks.ts:77-93` + 신규 체크 함수 | 부록 B-1, AC21.10 유지 |
| F15 | 서버 무의존 회귀 테스트: `PATH`를 비운 환경에서 `node dist/index.js --version`·`doctor`가 종료 0이고 `initialize` + `tools/list`가 9개를 응답 | 신규 `tests/e2e/noSshBinary.test.ts` | 부록 B-1 |

### Phase G — 문서·릴리스

| # | 작업 | 파일 | AC |
|---|------|------|-----|
| G1 | `version` `0.3.0` | `package.json:3` | AC-R1 |
| G2 | CHANGELOG `[0.3.0]`. 굵게: 도구 7→9, 응답 필드 추가, `output_ref` non-null, 승인 스키마 변경, `setup` 경고 시작, `host list --json` 스키마. AC-H7 관측 결과 1줄 | `CHANGELOG.md:5` 이후 | AC-R1, A2, E4, H7 |
| G3 | README: 도구 9개, 감사 로그 절에 `history` 예(`README.md:698` 교체), 출력 절(`fetch_output`·`format`·메모리 10분·**PEM 마스킹**·**`fetch_output.total_bytes`가 마스킹 후 보관 길이라 `stdout_meta.total_bytes`와 다를 수 있다는 한 줄**), `host add --from-ssh-config`, 새 절 `connect`/`exec`, 로드맵(`:785-796`) | `README.md` | AC-R2, C4, O2a, O7, A2 |
| G4 | `setup` 제거 예정 버전(0.4.0)을 README·CHANGELOG에 | `README.md`, `CHANGELOG.md` | AC-A2 |
| G5 | `tests/AGENTS.md:27`의 "실제 sshd 컨테이너 티어는 v1.1 후보"와 CI 헤더 주석(`.github/workflows/ssh-mcp-ci.yml:5-6`, `:111-114`) 갱신 | `tests/AGENTS.md`, 워크플로 | AC-T1 |
| G6 | `README.md:538` "15개 항목" → 16개. 진단 절 표에 `ssh-binary` 행(INFO 전용) | `README.md:538` | F14 |
| G7 | README 보안 모델·`connect` 절에 기술 스택 경계 1문단 | `README.md` | 부록 B-1, AC-C4 |
| G8 | `src/AGENTS.md`에 규약 1줄: "`ssh` 탐색·spawn 코드는 `src/connect/`에만 두고 서버 경로에서 import하지 않는다" | `src/AGENTS.md` | 부록 B-1 |
| G9 | **`ssh-mcp/AGENTS.md:7`의 Purpose 문단 한정.** 현재 "네이티브 `ssh`/`scp` 바이너리에 의존하지 않고 순수 JavaScript SSH 클라이언트(`ssh2`)를 쓰므로 OpenSSH가 없는 Windows에서도 동작합니다"가 새 CLI와 어긋난다. "MCP 서버 경로는 그대로이며 `connect`/`exec` CLI만 시스템 `ssh`를 쓴다"를 덧붙인다 | `ssh-mcp/AGENTS.md:7` | 부록 B-1 |

---

## 6. Expanded Test Plan

### 6.1 Unit

| 파일 | 내용 | AC |
|------|------|-----|
| 신규 `tests/unit/auditConcurrency.test.ts` | 자식 2개 × 1000줄, 전 줄 유효 JSON, 총 2000줄. **`windows-latest` 필수** | AC-H7a |
| 신규 `tests/unit/auditReader.test.ts` | 줄 경계, 개행 없는 마지막 줄, 빈 파일, 16 KiB 줄, 힙 증가분이 파일 크기와 무관 | AC-H2, H2c |
| 신규 `tests/unit/auditCursor.test.ts` | `{f,o,s,h}` 왕복 / **"페이지 → append → 회전 → 다음 페이지"가 끊기지 않는다**(`f===0`, `.1.size > s`) / `f>0`은 같은 인덱스에 `=== s` / **`f>0`에서 회전이 나면 승계하지 않고 `history_cursor_stale`** / 오프셋 `o`가 가리키는 줄을 변조하면 해시 불일치로 `history_cursor_stale` / 2회 회전 → `history_cursor_stale` | AC-H2a, H2b |
| 신규 `tests/unit/outputStore.test.ts` | TTL 만료 → `output_expired` / 64 MiB 초과 시 선두 폐기 / ref 128비트·중복 없음 / 항목별 상한 초과 시 `null` / **PEM 블록이 페이지 경계를 걸치도록 `max_bytes`를 잘라도 어느 페이지에도 키 바이트가 없다** / **모든 chunk를 디코드해 이어 붙인 바이트 길이가 `total_bytes`와 정확히 일치** / base64 항목도 마스킹된다 / **PEM 없는 비UTF-8 스트림을 `put` 후 `get`으로 전량 이어 붙이면 원본 Buffer와 `equals`**(인코딩 왕복 실수를 전부 잡는 단언) / PEM 있는 비UTF-8 버퍼를 전량 회수하면 마스킹 구간을 뺀 모든 바이트가 원본과 일치 | AC-O2a, O4, O4a, O5, O7a |
| `tests/unit/excerpt.test.ts` (확장) | `retain` off일 때 기존 동작·기존 단언 불변 / on일 때 `retained`가 원문과 바이트 일치 / `cap` 초과 시 `null` / **base64 스트림에서 `truncated === true`이고 `retained`가 채워진다** | AC-O1a, O4a |
| 신규 `tests/unit/jsonCommands.test.ts` | 표 전 항목 재작성 / `docker ps > out.txt`가 **리다이렉션 토큰 때문에** 거부 / 서브셸 `$(…)`가 전 깊이 세그먼트 수로 거부 / here-doc 거부 / **등급 불변**(PM-7) | AC-J2, J2a, J3, J3a |
| 신규 `tests/unit/redactParsed.test.ts` | 깊이 10짜리 JSON 왕복 / 2 KiB 넘는 문자열 값 보존 / 민감 키 마스킹 / 문자열 내 PEM 마스킹 / 깊이 64 초과 시 `[depth-exceeded]` / **직렬화 바이트가 `emitCapFor(host)`를 넘으면 `parsed` 대신 `parse_error: "parsed_too_large"`** | AC-J6a, AC-J6b |
| 신규 `tests/unit/tables.test.ts` | ubuntu·alpine·macOS 코퍼스 × `df`·`ps`, 컬럼 깨짐 시 `parsed:null` | AC-J4 |
| 신규 `tests/unit/sshConfig.test.ts` | 정확 일치 / `Include` 1단계 + **Node 20에서 도는 glob 케이스** + `~` / 2단계 무시 + stderr 1줄 / 와일드카드·`Match`·`ProxyJump` → 종료 2 / `IdentityFile` 무시 | AC-S1, S2, S3, S4 |
| `tests/unit/setupArgs.test.ts` (확장) | OP-4 상호작용 표 4행 / 같은 플래그 중복 시 last-wins / seed가 위치 인자를 만들지 않음 | AC-S1a, S6a |
| 신규 `tests/unit/connectCommand.test.ts` | `spawn` 주입 후 argv 배열 단언 / `--` 뒤 원문 / 종료 코드 통과 / ssh 부재 → 1 / 없는 alias → 2 | AC-C1, C2, C3, C7 |
| `tests/unit/toolsList.test.ts:53-77` | 7 → **9**, import 이름과 `.toThrow(/exactly 7 tools/)` 정규식 2곳(`:70`, `:73`) 갱신 | AC-H6 |
| `tests/unit/approval.test.ts` | enum 판정: `accept`+`run`만 승인, 나머지 전부 거부 | AC-E3 |
| `tests/unit/hostCommand.test.ts` | 예약어 alias 거부 / `host list` 표와 `--json` 양쪽의 경고 표현 | AC-C6 |
| `tests/unit/helpCommand.test.ts` | `connect`·`exec` 목록·위임·폭 규칙 | AC-C5 |
| `tests/integration/doctor.test.ts` (확장) | `CHECK_KINDS` 16개 / `ssh-binary`가 `ssh` 유무와 무관하게 `INFO`이고 실패 개수에 안 잡힌다 | F14 (G-4) |
| **컴파일 테스트** | `resolveCommand`를 거치지 않은 `string`을 `approveCommand`·`execOnce`·**`runInSession`** 셋 다에 넘기는 코드가 `tsc --noEmit`에서 실패함을 `@ts-expect-error`로 고정. **`internalCommand`를 `src/tools/`에서 import하는 코드가 ESLint에서 실패한다**(R40의 `exec.ts` 세탁 시나리오를 직접 검사). 허용 범위는 `src/ssh/session.ts`와 `tests/**`이므로 그 둘의 정당한 import는 통과해야 한다 | AC-J5a |

### 6.2 Integration

**fixture 티어**(양 OS, 기본): `history` 필터 6종·페이지네이션·깨진 줄 `skipped` 집계(AC-H1, H3) / `fetch_output` 왕복과 `SSH_MCP_HOME` 아래 새 파일 0개(AC-O2, O3) / **PEM을 포함한 잘린 출력의 `fetch_output` 결과가 마스킹돼 있다**(AC-O7a) / **비UTF-8 잘린 스트림에 `output_ref`가 채워진다**(AC-O1a) / `exec`와 **`run_in_session` 양쪽**에서 `format:"json"` 응답의 `parsed`·`parse_error`를 확인하고, **같은 입력에 두 도구가 같은 재작성 결과를 낸다**는 동등성을 단언한다(AC-J1, J6, AC18 계열) / 승인 창과 감사 줄의 `command`가 재작성 결과와 일치(AC-J5) / 보관 메모리 증가분·**이벤트 루프 블록 시간**·**응답 본문 바이트** 상한(PM-6).

`tests/integration/audit.test.ts:161`("writes exactly seven lines for the seven tools")은 **개명이 아니라 재작성**이다 — `fetch_output`을 호출하려면 유효한 `output_ref`가 필요하고, 그러려면 그 앞에서 잘린 출력을 만들어야 한다. 선행 단계를 포함해 9줄로 다시 쓴다.

**sshd 티어**(`ENDPOINT=sshd`, `real-sshd` 잡): AC-T4 4항목(authorized_keys `0700/0600` + `StrictModes`, 지문 고정·불일치 거부, 타임아웃 후 `pgrep -f` 5초 내 빈 결과, SFTP 업/다운/overwrite 거부) / 해제된 2개 describe(AC-T3) / 컨테이너 로그인 셸 bash·dash·zsh(AC-T5) / `df`·`ps` 파서를 실제 출력에 1회(AC-J4 보강).

### 6.3 E2E

`tests/e2e/package.test.ts:121-129`의 "exactly the 7 spec tools" → **9**. `real-sshd` 잡에서 `ssh-mcp exec <alias> -- echo ok` 1회(AC-C7). 신규 `tests/e2e/noSshBinary.test.ts`(부록 B-1).

### 6.4 관측성

`real-sshd` 실패 시 `docker logs` 아티팩트 업로드(PM-5). `history`·`fetch_output` 호출이 각각 감사 줄 1개를 남기고 `command`가 `null`임을 통합 테스트로 고정(AC-H5, AC-O6).

### 6.5 R24 결과 규칙 (AC-H7)

A3 테스트를 `windows-latest`의 `build-test` 매트릭스 레그에서 돌린다.
- **실패(줄 섞임 관측)** → `audit-<pid>.jsonl` 분리, `history`가 live·회전·pid별 파일을 병합해 최신순으로 읽는다. 커서 `{f,o,s,h}`를 `{p,f,o,s,h}`로 확장(C4·C9).
- **성공** → **코드 변경 없음**. 결과(러너 OS·Node 버전·시도 횟수)를 CHANGELOG에 한 줄, `README.md:645`의 "관측되면"을 "관측되지 않았다"로 갱신.

---

## 7. Risks and Mitigations

| # | 위험 | 영향 | 완화 |
|---|------|------|------|
| R27 | `real-sshd` 불안정 → 게이트 약화 | bd8f53b 재발 | PM-5. 태그 고정 + 헬스체크 재시도 + **가드를 `build-test`로 이동**(결정 5) |
| R28 | 보관 출력이 메모리·비밀 노출을 키운다 | OOM 또는 비밀 수명 연장 | PM-6. 항목별 상한(절대 상한 동반), 지연 TTL 청소, **`put` 시점의 PEM 마스킹**(페이지 경계 누출이 존재할 수 없게 함), README 명시 |
| R29 | 재작성된 명령을 사람이 읽지 않고 승인 | 승인 게이트 무력화 | PM-7. 등급 불변 테스트, 리터럴 플래그만, 승인 창 첫 줄 = 마스킹된 실행 대상 |
| R30 | probe 결과가 enum을 배제하면 Phase B가 통째로 바뀐다 | 일정 지연 | B5로 분기 정의. Phase B는 A2 없이 시작하지 않는다 |
| R31 | 새 CLI 모듈의 builtin named import가 번들 최상위로 호이스트된다 | `--version`조차 안 나오는 회귀 | **G-3이 유일한 방어선**(G-2는 평가 시점만 늦춘다). `fs`·`child_process` 전부 네임스페이스. `assert-bundle-imports`가 빌드마다, F15가 실행으로 재확인 |
| R32 | `output_ref` 타입 확장이 `isExcerptMeta`(`src/tools/wrap.ts:123-130`)·오류 details 경로를 조용히 통과 | 타임아웃 응답에 ref 유출 | AC-O1b 테스트로 고정 |
| R33 | `history`가 다른 프로세스의 회전과 경쟁해 잘못된 페이지를 준다 | 감사 신뢰성 손상 | OP-2의 `s` + `h`(줄 해시) 이중 확인. 틀린 데이터보다 `history_cursor_stale` |
| R34 | 도구 9개로 모델의 선택이 흐려진다 | `exec` 대신 `history` 오용 | 둘 다 `readOnlyHint: true`, `requiresUserInteraction` 없음. description에 용도 한정 명시 |
| R35 | ssh_config 파서가 OpenSSH 의미와 달라 엉뚱한 호스트를 가져온다 | 잘못된 대상에 키 설치 | 정확 일치만, 와일드카드·`Match` 거부(AC-S3). 값은 위저드 확인을 거친다(AC-S5) |
| R36 | `ssh` 위임 예외가 CLI 밖으로 번진다 | v1 기술 스택 제약의 실질 폐기 | 부록 B-1의 G-1~G-4. 특히 G-4 — `doctor`가 `FAIL`을 내면 "서버도 `ssh`가 필요하다"는 신호가 된다 |
| R37 | `ResolvedCommand` 브랜드가 테스트 호출부에 대량 파급 | 변경량 증가, 기계적 편집 중 누락 | 실측: 프로덕션 `execOnce` 3곳, **테스트는 `execOnce` 22곳 + `runInSession` 35곳 = 57곳 이상**. "한 줄"이 아니라 별도 단계(E2b)이며 `tests/fixtures/resolved.ts` 헬퍼 하나로 일괄 치환한다. 누락은 `tsc`가 잡는다 |
| R38 | `redactParsed`가 새 리댁션 경로를 만들어 비밀이 샌다 | 응답에 토큰 노출 | 민감 키 마스킹과 PEM 마스킹은 **유지**하고 길이·깊이 제한만 완화한다. 완화 범위를 단위 테스트로 고정(AC-J6a). 집을 `src/log.ts` 하나로 못박아 리댁션 코드가 두 파일로 갈라지지 않게 한다 |
| R39 | `continue-on-error` 가드가 `build-test` 자신에는 무력하다 | 한 단계 멀어진 자기무력화 | **추가 조치 없이 인정한다.** 주 테스트 잡을 통째로 비활성화하는 것은 눈에 띄므로 수용 가능한 잔여 위험이다. PM-5에 같은 내용을 적어 다음 사람이 이 가드를 절대적이라고 오해하지 않게 한다 |
| R40 | `internalCommand` 탈출구로 모델 입력이 세탁된다 | 게이트 무력화 — 브랜드 타입 도입 동기의 정면 부정 | ESLint로 import를 `src/ssh/session.ts`와 `tests/**`로 제한(E1b). grep 가능한 이름만으로는 CI에서 아무것도 실패시키지 못하므로 원칙 1의 기준을 여기서만 낮추지 않는다 |

---

## 8. Verification Steps

### 8.1 로컬 (`ssh-mcp/`에서)

```bash
npm run format:check
npm run lint
npm run typecheck      # ResolvedCommand 브랜드 위반이 여기서 잡힌다 (AC-J5a)
npm run build          # tsup + assert-bundle-imports --self-test + assert-bundle-imports
npm test               # unit + integration (ENDPOINT=fixture)
npm run test:e2e
npm run test:fp-gate
```

### 8.2 sshd 티어 로컬 재현

```bash
docker build -t ssh-mcp-sshd ./tests/sshd
docker run -d --name ssh-mcp-sshd -p 2222:22 ssh-mcp-sshd
SSH_MCP_SSHD_HOST=127.0.0.1 SSH_MCP_SSHD_PORT=2222 \
SSH_MCP_SSHD_USER=<user> SSH_MCP_SSHD_PASSWORD=<pw> \
ENDPOINT=sshd npm run test:integration
docker rm -f ssh-mcp-sshd
```

### 8.3 CI (전부 녹색)

`build-test (windows-latest, node 20/22)` · `build-test (ubuntu-latest, node 20/22)` · `shell-matrix (ubuntu-latest)` · `no-build-tools (windows-latest)` · `package-smoke (ubuntu-latest)` · `package-smoke (windows-latest)` · `windows-spawn (windows-latest)` · **`real-sshd (ubuntu-latest)`**. `assert-no-native-addons`·`assert-bundle-imports` 통과(AC-R3).

### 8.4 수동 (사람만 할 수 있는 것)

1. **브랜치 보호 등록 — 릴리스 게이트**(결정 12). `real-sshd (ubuntu-latest)`를 필수 검사에 추가하되 **연속 5회 녹색 관측 후**에 한다. Phase A의 책임은 "잡 존재 + 녹색"까지다. 등록 시 알아둘 것: 이 워크플로는 `ssh-mcp/**`와 자기 자신에만 반응하므로(`.github/workflows/ssh-mcp-ci.yml:16-19`) 모노레포의 다른 디렉터리만 건드린 PR에서는 잡이 실행되지 않아 필수 검사가 pending으로 남는다. 기존 5개도 같은 성질이다.
2. **probe 실행** — `elicit-probe.mjs`를 Claude Code에 로컬 MCP 서버로 등록하고 3안을 띄워 표를 채운다(AC-E1, E2).
3. **배포 전 체크리스트(AC-R4)** — Windows Terminal에서 `install --dry-run`, `host add --from-ssh-config <Host>` 1회, `connect <alias>` 1회, Claude Code에서 승인 창 1회.
4. **npm publish는 사용자가 별도 터미널에서** — 2FA. `npm run build`까지는 `prepublishOnly`(`package.json:47`)가 자동 실행한다.

---

## 9. ADR (초안)

v1의 ADR-001~009에 이어 번호를 매긴다.

### ADR-010. 발췌 누산기에 옵트인 보관 옵션을 두고 `output_ref`는 응답 조립부에서 발행한다

**Decision.** `createExcerptAccumulator()`에 `retain?: { cap: number }`를 추가해 `finish()`가 `retained: Buffer | null`을 함께 돌려준다(`ExcerptResult` `src/ssh/excerpt.ts:107-110`). 전역 스토어는 누산기에 개입하지 않는다. 등록과 `output_ref` 채우기는 `commandResultBody()`(`src/tools/gated.ts:174-199`)에서만, 술어는 `meta.truncated === true`. 항목별 상한은 `4 × host.maxOutputBytes`. **PEM 마스킹은 `put` 시점에 버퍼 전체에 1회** 적용하고 모든 좌표계를 마스킹 후 버퍼의 바이트 기준으로 통일한다. 왕복은 `latin1`이며 `buf.indexOf('-----BEGIN ')` 사전 검사로 마커가 없는 경로는 왕복하지 않는다.
**Drivers.** ADR-008의 유계 보장 / AC-O7의 발췌 전 원문 요구 / Q4(타임아웃 제외) / Q7(base64 구멍).
**Alternatives.** 누산기가 전역 스토어에 직접 등록 — 순수 모듈이 전역 상태를 탄다. **별도 보관 버퍼를 같은 chunk에 물리기(iteration 1의 선택)** — 배선 지점이 4곳(`src/ssh/exec.ts:137-142`, `src/ssh/session.ts:890-891`)이고 하나를 빠뜨리면 조용히 `output_ref: null`이며 타입이 못 잡는다. 두 버퍼의 총 바이트가 어긋나 `fetch_output`의 `total_bytes`가 거짓말할 수 있다.
**Why chosen.** ADR-008이 확립한 것은 "발췌기는 유계"이지 "발췌기는 옵션이 없다"가 아니다. 기본값 off이므로 유계 보장도 기존 테스트도 그대로다. `isUtf8`과 `truncated`를 아는 유일한 지점에서 판단하므로 Q7이 구조적으로 닫힌다. 등록 지점을 응답 조립부에 남긴 것은 그 함수가 `truncated`와 응답 필드를 동시에 아는 유일한 곳이고 타임아웃 경로가 그곳을 지나지 않기 때문이다.
**Consequences.** `ExcerptMeta.output_ref`가 `string | null`로 넓어져 `isExcerptMeta`(`src/tools/wrap.ts:123-130`) 경로를 다시 봐야 한다(R32). 보관 바이트가 `CommandResultInput`(`src/tools/gated.ts:143-156`)에 추가된다. 일회용 `excerpt()`(`src/ssh/excerpt.ts:582-586`)에도 `retained: null`이 자동으로 붙는다. `maskPemBlocks`가 `string`을 받으므로(`src/log.ts:102`) Buffer 왕복이 생기는데, 저장소 관행이 `utf8`을 유도하는 반면 그 선택은 비UTF-8 보관 출력을 파괴한다 — `latin1` 명시와 사전 검사가 그 결함과 일시 메모리를 함께 닫는다. Q4의 구조적 보장은 그대로다 — 타임아웃 오류의 `details`는 필드를 명시적으로 나열해 조립하고(`src/ssh/exec.ts:170-177`) 스프레드를 쓰지 않으므로 `retained`가 오류 본문으로 새지 않는다.
**Follow-ups.** 디스크 보관은 계속 Non-Goal. 타임아웃 부분 출력 보관은 §1의 사용자 결정 항목.

### ADR-011. `history`는 역방향 청크 읽기 + `(파일, 오프셋, 크기, 줄 해시)` 커서로 구현한다

**Decision.** 뒤에서부터 64 KiB씩 읽는다. 커서 `{f,o,s,h}`이고 **`h`는 오프셋 `o`가 가리키는 줄(다음에 읽을 더 과거 줄)의 sha256 앞 8바이트**다. 승계는 `f===0`이면 `.1.size >= s` ∧ `o < s`, `f>0`이면 같은 인덱스에 `=== s`이며 회전으로 인덱스가 밀린 경우는 승계하지 않는다. 양쪽 모두 `o` 위치 줄의 해시가 `h`와 일치해야 한다. 실패하면 `history_cursor_stale`.
**Drivers.** 10 MiB × 4를 힙에 올릴 수 없다 / 다른 프로세스가 같은 파일에 append한다 / AC-H2가 커서를 `(파일 인덱스, 바이트 오프셋)`으로 명시했다.
**Alternatives.** 전체 읽기 + 역순 — 조회 1회에 최대 10 MiB. **4개 파일의 끝 N 바이트만 읽기** — 커서-파일 동일성 문제를 아예 없애고 힙도 고정되지만, "N 너머로 페이징 불가"라서 AC-H2의 "회전 파일까지 이어 읽는다"를 만족하지 못한다. 오프셋 인덱스 캐시 — 다중 프로세스에서 무효화 불가.
**Why chosen.** 스펙이 커서 형태를 명시했고, 스펙을 못 지키는 단순함은 단순함이 아니다. iteration 1의 `=== s` 승계 규칙은 **정상 회전을 100% 거부**했으므로(회전은 10 MiB 도달 시에만 일어나고 그 전에 반드시 append가 있다) 방향별로 나눴다.
**Consequences.** 경계 처리 코드와 전용 단위 테스트 2개. 새 오류 코드 1개.
**Follow-ups.** SQLite(보류)가 들어오면 이 리더 전체가 사라진다 — 인터페이스를 `history` 도구 뒤에 숨겨 교체 가능하게 둔다. 삭제 예정 코드에 비용을 쓴다는 지적은 타당하며, 그 비용의 상한이 이 인터페이스 격리다.

### ADR-012. 재작성은 게이트 직전에 하되, 누락을 브랜드 타입으로 막는다

**Decision.** `resolveCommand`를 유일한 생산자로 하는 `ResolvedCommand` 브랜드 타입을 만들고, `approveCommand`(`src/tools/gated.ts:53`)·`execOnce`(`src/ssh/exec.ts:76`)·`runInSession`(**공개 `src/ssh/session.ts:970`** 과 비공개 `runCommand` `:871` 둘 다)의 command 인자를 그 타입으로 바꾼다. 재작성 호출은 각 핸들러가 `approveCommand` 직전에 한다. 서버 내부 고정 명령은 `internalCommand()`로 감싸고, **그 import는 ESLint가 `src/ssh/session.ts`와 `tests/**` 밖에서 거부한다.**
**Drivers.** AC-J5(재작성 결과가 분류·승인·감사 대상)가 이 계획의 최상위 보안 요구 / `gated.ts`를 변형 계층으로 만들지 않는다 / **테스트로 지키는 불변식은 구조로 지키는 것보다 엄격하게 약하다.**
**Alternatives considered.** `approveCommand` 안에서 재작성하고 실효 명령을 돌려주기 — 승인된 것 ≠ 실행된 것이 표현 불가능해지는 점은 우수하지만, 안전 게이트가 명령을 바꾸는 계층이 되고 `format`은 안전 개념이 아니다. SSH 계층 재작성 — AC-J5 정면 위반.
**Why chosen.** 종합이다. 배치는 게이트 바깥(관심사 분리)을, 보증은 게이트 안(시그니처)을 가져왔다. iteration 1이 "구현자에게 `execOnce`에도 재작성된 문자열을 넘기라고 상기시켜야 한다"고 적은 것 자체가 배치만으로는 부족하다는 증거였다.
**Consequences.** `exec.command`(`src/tools/exec.ts:40`)와 `run_in_session.command`(`src/tools/runInSession.ts:42`)의 `.describe()`가 "한 바이트도 변형하지 않는다"에서 조건부로 바뀐다 — 모델에게 하는 약속이므로 **둘 다** 고친다. `internalCommand()`라는 탈출구가 생기므로 ESLint로 import 범위를 잠그고(E1b, R40) 금지 용법을 주석에 적는다. 테스트 파급이 57곳 이상이라 E2b를 별도 단계로 뗀다(R37). `GateInput.command`(`src/safety/approval.ts:160`)는 `string`으로 남으므로 하류 함수들은 무변경이다.
**Follow-ups.** 표 확장 시 등급 불변 테스트(AC-J2a)가 새 항목을 자동으로 덮게 유지한다.

### ADR-013. ssh_config 가져오기는 위저드와 같은 "argv를 채운다" 경로를 쓰고, 플래그 토큰만 만든다

**Decision.** 파서는 alias·HostName·Port·User를 뽑아 **플래그 토큰**으로 만들고 사용자 argv를 그 뒤에 붙여 `parseSetupArgs`가 재파싱한다(last-wins). 위치 인자는 만들지 않는다. 같은 값이 위저드 **기본 답**으로도 들어가지만 `given`(`src/setup/cli.ts:287`)에는 넣지 않는다. 우선순위는 **명시 CLI 플래그 > 위저드 확인 답(기본값 = seed)**. 와일드카드·`Match`·`ProxyJump`·`Include` 2단계는 부분 가져오기 없이 종료 코드 2.
**Drivers.** AC-S5(코드 분기 없음) / TTY 요구 유지 / 파서의 실제 동작.
**Alternatives.** `HostEntry` 초안 직접 생성 — 검증이 두 곳이 된다. seed가 위치 인자까지 만들기 — `parseSetupArgs`는 위치 인자를 last-wins로 처리하지 않고 3개째를 즉시 오류로 만든다(`src/setup/cli.ts:292-294`).
**Why chosen.** `src/setup/wizard.ts:9-13`이 "위저드는 argv만 채운다"를 규약으로 못박았고 그 규약의 존재 이유가 정확히 이 상황이다. 플래그만 seed로 만들면 파서의 last-wins가 우선순위를 공짜로 준다. seed를 `given`에 넣지 않는 것이 핵심인데, 넣으면 위저드가 질문을 건너뛰어 AC-S5가 요구하는 사람의 확인 단계 자체가 사라지기 때문이다.
**Consequences.** `--alias`·`--port` 플래그가 생긴다. 파서가 위저드보다 먼저 도는 순서 의존이 생긴다. `Include` glob은 `fs.globSync`가 Node 20에 없으므로 `readdirSync` + 자체 매처다.
**Follow-ups.** `known_hosts` 가져오기와 `IdentityFile` 재사용은 계속 Non-Goal.

### ADR-014. `connect`/`exec`는 `ssh`를 먼저 찾고 `shell:false`로 spawn한다

**Decision.** `resolveSshBinary()`로 `PATH`(×`PATHEXT`)를 훑어 절대 경로를 얻고, 없으면 OS별 안내 후 종료 1. `stdio:'inherit'`, `shell:false`, 종료 코드 그대로. 분류·승인·감사·발췌 없음.
**Drivers.** AC-C3(사전 판정) / AC-C2(원문 보존) / D6.
**Alternatives.** ENOENT를 잡아 안내 — 다른 원인의 ENOENT를 오진단. `shell:true` — Windows 인용이 `--` 뒤를 훼손하고 주입면을 만든다.
**Why chosen.** 사전 판정은 순수 함수라 테스트되고, argv 배열 전달은 인용 문제를 만들지 않는다.
**Consequences.** 호스트 키 신뢰가 OpenSSH `known_hosts`로 넘어가 ssh-mcp 지문과 다를 수 있다(AC-C4). 예약어 규칙이 필요하다(AC-C6). **v1 기술 스택 제약으로부터의 이탈**이므로 부록 B-1에 등재하고 G-1~G-4로 가둔다. `doctor` 항목이 15 → 16이 되고 새 항목은 `INFO` 전용이다.
**Follow-ups.** `connect`에서 ssh-mcp 지문을 강제하려면 전체 공개키 저장이 필요한데 `HostEntry`는 지문만 담는다(`src/config/schema.ts:104-109`). 로드맵 후속 후보.

### ADR-015. `real-sshd`는 저장소 안 Dockerfile을 잡에서 빌드해 띄운다

**Decision.** `tests/sshd/Dockerfile`(`ubuntu:24.04` 태그 고정, `openssh-server`·`procps`·`gawk`·`zsh`·`dash`) → `docker build` → `docker run -d` → TCP 재시도 헬스체크 → `ENDPOINT=sshd npm run test:integration`. `continue-on-error` 없음. 셸 매트릭스는 한 잡 안 3스텝, 잡 이름은 `real-sshd (ubuntu-latest)`.
**Drivers.** AC-T2 / D9 / bd8f53b의 차단 사유가 `probeRealSshd`(`tests/fixtures/endpoints.ts:114-160`)로 이미 해소됐다는 사실.
**Alternatives considered.** `services:` + 공개 이미지 — Actions의 `services:`는 로컬 Dockerfile을 빌드하지 못해 사용자·sftp·`StrictModes` 고정이 불가. **러너에 직접 설치** — 레지스트리·레이어 캐시·이미지 내부 apt라는 비결정성 출처 3개를 제거하므로 D9("불안정의 원인을 고친다")와 오히려 잘 맞고, iteration 1이 든 "러너 홈 권한이 `StrictModes`와 충돌"은 **추측이었다** — `useradd -m sshmcp`가 만드는 `/home/sshmcp`는 0755·소유자 sshmcp로 `StrictModes yes`가 원하는 상태이고 러너 홈은 건드릴 필요가 없다. 기각 사유는 오직 "AC-T2가 저장소 안 Dockerfile을 명시했고 사용자가 D7로 재확인했다"이다.
**Why chosen.** 스펙 요구 + 사용자 결정. 요구의 실질(사용자·sftp·`StrictModes`를 우리가 고정하고 리뷰한다)은 Dockerfile이 충족한다.
**Consequences.** CI 잡 1개와 빌드 ~60초. 20분 예산 안 계산은 OP-6에 있다. `authorizeKey`가 sshd 티어에서 못 쓰이므로 공유 헬퍼 한 곳을 분기한다.
**Follow-ups.** 불안정하면 게이트가 아니라 원인을 고친다(R27). 원인이 컨테이너 자체로 판명되면 그때 러너 직접 설치안을 사용자에게 다시 올린다.

### ADR-016. 승인 elicitation 스키마는 probe 실측 후 enum을 우선 채택한다

**Decision.** 3안을 한 세션에서 실측하고, 아무 조작 없이 Accept가 승인으로 이어지지 않는 안만 채택한다. 조건을 만족하면 `{ choice: enum["run","cancel"] }` + `content.choice === 'run'`만 승인.
**Drivers.** AC-E3 / 0.2.0·0.2.1의 렌더링 추측이 연속 2회 틀렸다는 기록.
**Alternatives.** probe 없이 enum 채택 — 같은 실수의 3회차 위험. 현행 boolean 유지 — 체크박스 함정이 남는다.
**Why chosen.** 우리 테스트가 못 보는 표면에서 실측이 유일하게 싼 근거이고, 결과를 문서로 남기면 다음 사람이 다시 추측하지 않는다.
**Consequences.** `confirm` 필드 제거는 **호환성 변경**이다. Phase B가 A2 없이는 시작할 수 없어 직렬 구간이 생긴다.
**Follow-ups.** 실측 표를 다음 Claude Code 버전의 재측정 기준선으로 쓴다.

### ADR-017. 선행 단계를 앞에 두되 브랜치 보호 등록은 릴리스 게이트로 미룬다

**Decision.** Phase A(probe · R24 · real-sshd 잡 생성)를 먼저 완료하고 B~G를 그 위에 쌓는다. AC-T1의 브랜치 보호 등록은 Phase A 산출물이 아니라 **릴리스 게이트**이며 조건은 "연속 5회 녹색 관측 후"다.
**Drivers.** 승인 스키마가 늦으면 승인 테스트를 두 번 쓴다 / 새 기능이 인프로세스 픽스처로만 검증된 채 쌓인다 / A1·A2는 사람 개입이라 리드타임이 있다 / 등록이 이르면 Phase B~G의 모든 PR이 검증되지 않은 신생 잡에 막힌다.
**Alternatives.** 기능 우선·인프라 나중 — 두 선행 산출물이 이후 전부의 전제라 재작업을 만든다. 등록도 Phase A에 — 위 긴장이 실현된다.
**Why chosen.** Phase A의 산출물은 코드가 아니라 결정과 검증 능력이고, 등록은 그 능력이 안정적임을 관측한 뒤에 거는 것이 맞다.
**Consequences.** 초반에 눈에 보이는 기능 진척이 없다. AC-T1은 릴리스 직전까지 "잡은 녹색이지만 미등록" 상태로 남는다 — §8.4-1이 그것을 체크리스트로 관리한다.
**Follow-ups.** A2가 지연되면 Phase C·D·F는 B와 독립이므로 먼저 진행할 수 있다. B만 차단된다.

---

## 10. 부록 B. 계획이 스펙에서 **바꾼 것** (승인 필요 항목)

### B-1. v1 기술 스택 제약 이탈 — `connect`/`exec` CLI의 시스템 `ssh` 위임

| 항목 | 내용 |
|------|------|
| **v1의 제약** | "순수 JS `ssh2`만, 시스템 `ssh`/`scp` 미사용". `ssh-mcp/AGENTS.md:7`이 이를 제품 가치로 내세운다 |
| **현재 코드** | `src/` 전체에 시스템 `ssh`/`scp` spawn 0건, `~/.ssh/config` 읽기 0건 |
| **이번 이탈** | `ssh-mcp connect <alias>`·`ssh-mcp exec <alias> -- <cmd>`가 시스템 `ssh`를 spawn한다 |
| **승인 근거** | v1.1 스펙 Constraints가 명시 승인. ssh2 PTY 직접 구현안은 Round 9에서 기각 |
| **적용 범위** | CLI 경로에만. MCP 서버 기동과 9개 도구 호출은 시스템 `ssh`에 의존하지 않는다 |
| **격리 장치** | G-1 CLI 전용 모듈 · G-2 동적 import(평가 시점만) · **G-3 네임스페이스 import(실제 방어선)** · G-4 `doctor`는 `INFO`만 |
| **구현 단계** | F6(G-1·G-3), F9(G-2), F14(G-4), F15(실행 증명), G7·G8·G9(문서·규약) |
| **검증** | §8.1 `npm run build`가 G-3을, `tests/e2e/noSshBinary.test.ts`가 G-1·G-2를, doctor 테스트가 G-4를 본다 |
| **되돌리는 법** | ① `COMMANDS`에서 `connect`·`exec` 제거 ② `src/connect/` 삭제 ③ **F14가 만든 `CHECK_KINDS`(`src/doctor/checks.ts:77-93`)의 16번째 항목과 그 체크 함수 제거** ④ **`README.md:538`의 개수를 15로 환원** ⑤ **`tests/e2e/noSshBinary.test.ts` 삭제** ⑥ `ssh-mcp/AGENTS.md:7`·`src/AGENTS.md`의 한정 문구 환원. 가역성이 이 행의 존재 이유이므로 목록을 완전하게 유지한다. G-1의 금지 목록(`src/server.ts`·`src/tools/`·`src/ssh/`)에 `doctor/`가 없으므로 F14 자체는 규약 위반이 아니다 |

### B-2. AC-J7 축소 — 파싱 상한과 응답 탑재 상한 (승인 필요)

**둘 다 AC 축소다.** AC-J7의 첫 문장은 "`parsed`는 **발췌 상한과 무관하게** 전체 stdout을 파싱한다"이다. 두 상한이 각각 그 약속의 일부를 되돌린다.

- **`parseCapFor = min(4 × maxOutputBytes, 4 MiB)`** — `maxOutputBytes`를 올린 호스트(스키마 상한 4 MiB, `src/config/schema.ts:144-149`)에서 4 MiB~16 MiB 구간이 AC상 파싱 대상인데 포기한다. **기술적 근거**: 16 MiB 문자열의 동기 `JSON.parse`는 SSH 스트림을 펌프하는 메인 스레드를 정지시키고, 결과 객체는 `redactParsed`와 `JSON.stringify`를 각각 한 번 더 통과한다.
- **`emitCapFor = min(2 × maxOutputBytes, 4 MiB)`** — 파싱에 성공한 `parsed`를 크기 때문에 응답에서 뺀다. 이것이 AC-J7의 "발췌 상한과 무관하게"를 **더 직접 되돌린다.** iteration 3의 `emitCapFor = maxOutputBytes`는 발췌 상한과 **정확히 같은 값**이어서 "발췌 상한을 넘으면 `parsed`가 없다"는 결합을 만들었다 — AC-J7이 명시적으로 부정한 바로 그 결합이다. 2배로 올려 기본 호스트의 1~2 MiB JSON은 실리게 하되, 응답 피크는 유계로 남긴다. **기술적 근거**: 상한이 없으면 기본 호스트 응답 본문이 약 1.3 MiB에서 5.3 MiB로 커지고, 5 MiB 툴 결과는 `format:"json"`의 가치를 스스로 무너뜨린다(A-N1).

**호스트별 실측 영향.**

| `maxOutputBytes` | `retainCapFor` | `parseCapFor` | `emitCapFor` | `parsed`가 빠지는 구간 |
|---|---|---|---|---|
| 1 MiB (기본, `src/config/schema.ts:36`) | 4 MiB | 4 MiB | **2 MiB** | 직렬화 2~4 MiB |
| 2 MiB | 8 MiB | 4 MiB | **4 MiB** | 없음(파싱 상한이 먼저 걸림) |
| 4 MiB (스키마 최대) | 16 MiB | 4 MiB | **4 MiB** | 없음(파싱 상한이 먼저 걸림) |

즉 실질 영향은 기본 호스트의 "직렬화 2~4 MiB 구간"뿐이고, 그 경우에도 `parse_error: "parsed_too_large"`로 사유가 모델에 전달된다. 이것이 승인 대상이다.

### B-3. 계획이 스펙의 빈칸을 채운 값

§1의 Q1~Q9 중 값을 **발명한** 것은 Q3(보관 상한 `4 × maxOutputBytes`) 하나다. 근거: 스펙이 총량 64 MiB만 정하고 항목별 상한을 비워 두었는데, 단일 스트림이 스토어를 독식하면 "오래된 것부터 폐기"가 사실상 "직전 것만 남는다"가 된다. 실행 중 메모리 회계(`64 MiB + 2 × retainCap × 동시 실행 수`)는 OP-1에 있다.

나머지 Q는 스펙 문구와 저장소 현실의 불일치를 맞춘 것이다. Q7·Q8은 스펙이 2026-09-16 개정으로 같은 결론을 채택했으므로 이제 이탈이 아니다.

### B-4. 스펙이 계획 단계로 위임한 설계 결정

ADR-010~017. 각 ADR에 Alternatives와 무효화 근거가 있다.

---

## 11. 변경 이력 — iteration 2

### blocking 대응 (14건, 중복 병합 표시)

| 출처 | 요지 | 계획 반영 위치 |
|------|------|----------------|
| A5-1 = C-B1 | `omitted_lines > 0`이 base64 잘림·긴 줄 절단을 누락 | Q7, OP-1 술어, AC-O1a, D6, §6.1 `excerpt.test.ts`·§6.2, ADR-010 |
| A5-2 = C-B4 | 회전 승계 `=== s`가 정상 회전을 100% 거부 | 결정 4 반영. OP-2 승계 규칙, AC-H2b, C4, §6.1 `auditCursor.test.ts`, ADR-011, R33 |
| A5-3 = C-B2 | `fetch_output`이 `exec`가 마스킹한 PEM을 되돌려준다 | Q8, OP-1 스토어 `get`, AC-O7a, D3, §6.2, PM-6, G3. 스펙 개정으로 보안 모델 이탈 아님 |
| C-B3 | `parsed`가 기본 `redact()`의 2 KiB·깊이 8에 깨진다 | 결정 3 반영. AC-J6a, E8, 신규 `tests/unit/redactParsed.test.ts`, R38 |
| A5-4 | `Include` glob이 Node 20에 없는 `fs.globSync`를 가리킬 위험 + `ALLOWED`에 `fs` 키 없음 | 결정 7 반영. OP-4 파서 범위, G-3(`fs`까지 확장), F1, C3, §6.1 |
| A5-5 | 컨테이너에 `procps` 없으면 AC-T4 실행 불가 | 결정 8 반영. OP-6 패키지 목록, A4 |
| A5-6 | `:101` 해제가 A9의 chsh 매트릭스와 충돌 | 결정 9 반영(옵션 a). OP-6 skipIf 표에서 `:101` **유지**로 정정, A9는 `:414`·`:546`만 |
| A5-7 = C-B5 | `continue-on-error` 가드가 자기 잡 안에 있어 자기무력화 | 결정 5 반영. PM-5 탐지, A6을 `build-test` 스텝으로 이동, `working-directory` 명시 |
| A5-8 | 셸 매트릭스가 검사 이름 개수를 바꾼다 + 20분 예산 미계산 | 결정 10 반영. OP-6 "한 잡 안 3스텝" + `name:` 명시 + 예산 계산, A5·A10, Q5 |
| C-B6 | `--alias`/`--port`와 위치 인자 2개 요구의 상호작용 미정의 | 결정 6 반영. OP-4 last-wins 실측 + 상호작용 표 4행, AC-S1a·S6a, F2·F3, ADR-013 |
| A2-1 (반론) | OP-1은 옵션 A가 낫다 | **선택 변경.** OP-1을 A′(옵트인 누산기)로 바꿨다. 배선 4곳 → 1곳, Q7이 구조로 닫힘 |
| A2-3 (반론) | OP-3은 옵션 A가 낫다 — AC-J5를 테스트가 아니라 시그니처로 | 결정 14 반영. 브랜드 타입 `ResolvedCommand`, AC-J5a, E1·E2, ADR-012 |
| A3 긴장 A | 한 상수가 보관과 파싱을 겸한다 | 결정 11 반영. Q9, `src/output/limits.ts`, AC-J7a, PM-6 탐지에 이벤트 루프 블록 시간 |
| A3 긴장 B | 브랜치 보호 등록 시점이 자기 자신을 막는다 | 결정 12 반영. OP-8, §8.4-1("연속 5회 녹색 관측 후"), ADR-017 |

### improvement 대응

| 출처 | 반영 위치 |
|------|-----------|
| C-I1 AC 총수 51 | §4 — 51 + 17 = 68, 자동 검증 96% |
| C-I2 = A-imp3 `runInSession.ts:42` | E7에 파일:행 명시, ADR-012 Consequences |
| C-I3 = A-imp1 공유 `connect()` 헬퍼 | A8 신설(`tests/integration/session.test.ts:72-86`, 호출 `:78`), A7에 멱등성 근거 |
| C-I4 Q1이 "Step A2"라고 부름 | Q1을 **A3**으로 정정 |
| C-I5 = A-imp(인용) `server.ts:17` + `/exactly 7 tools/` | C2에 `:20`·`:250`·`tests/unit/toolsList.test.ts:17,70,73` 명시 |
| C-I6 A5의 `name:` 키 | A5에 `name: real-sshd (ubuntu-latest)` 명시 |
| C-I7 = A-imp4 재작성 술어 | OP-3 AC-J3a 술어 4항목으로 구체화(리다이렉션이 유일한 차단 조건임을 명시) |
| C-I8 "0.2.1과 바이트 동일" | E8에서 `output_ref` 예외 명시 |
| C-I9 `CommandResultInput` 확장 | D6에 명시 |
| C-I10 = A-imp8 `host list --json` | F12에서 `reservedAlias` 필드 결정 + D2 굵게 목록 |
| C-I11 = A-imp2 `commands.ts:29-31` 주석 | F13에 주석 교체, F5(`setup/cli.ts:115`)·F10(`help.ts:71`)에 같은 약속 4곳 전부 |
| C-I12 `paths:` 필터와 pending | §8.4-1에 한 줄 |
| C-I13 G-2 서술 부정확 | G-2를 "평가 시점만 늦춘다"로, **G-3을 실제 방어선**으로 정정. R31·Drivers 3도 같이 |
| A-imp5 `auditRotatedFilePath` | C3에 재사용 명시 |
| A-imp6 `output_expired` 근거 주석 | D7에 `src/AGENTS.md:60` 규약 적용 |
| A-imp7 `audit.test.ts:161`은 재작성 | §6.2에 선행 조건 문단 |
| A-imp9 비-TTY 오류 문구 | F2, OP-4 상호작용 표 4행째 |
| A-imp10 이벤트 루프 탐지 | PM-6 탐지 (b) |
| A-imp11 되돌리기 목록 | 부록 B-1에 6항목 완전 목록 |
| A-imp12 `ssh-mcp/AGENTS.md:7` | **G9 신설** |
| A2-2 (반론) OP-2는 옵션 A′ | **반영하지 않음.** 끝 N 바이트 읽기는 AC-H2의 "회전 파일까지 이어 읽는다"를 만족하지 못한다. 지적의 타당한 부분(삭제 예정 코드의 비용)은 ADR-011 Follow-ups에 기록 |
| A2-4 (반론) OP-6은 옵션 C | **반영하지 않음 — D7 사용자 결정.** 다만 iteration 1의 기각 사유가 추측이었음을 ADR-015 Alternatives에 정정 기록 |

### 인용 교정

`endpoints.ts:70/72/76` → `:71/:73/:77` · `setup/cli.ts:110-130` → `:110-125` · `:210-329` → `:210-328` · `errors.ts:11-68` → `:11-67` · `index.ts:43-80` → `:43-79` · `session.ts:875-876`은 누산기 **생성** 지점이고 chunk 싱크는 `:890-891`(A′ 채택으로 싱크 배선 자체가 불필요해짐) · `server.ts:17` → `:20`(`TOOL_NAMES` import) · 타임아웃 오류 클래스는 `SshOperationError`(`src/ssh/error.ts:12`, `CodedError` 상속) · 승인 창 첫 줄은 `maskCommandSecrets`된 명령(`src/safety/approval.ts:401`, `:434`)이지 원시 전문이 아니다 · `host/list.ts:61-80` → `toRow` `:61-74`, `renderTable` `:76` · `log.ts`의 `maskPemBlocks`는 `:105-108`.

---

## 12. 변경 이력 — iteration 3

iteration 2 리뷰: Architect 조건부 승인([blocking] 3 / [improvement] 7), Critic REVISE([blocking] 2 / [improvement] 12). **iteration 1 항목은 양쪽 모두 전부 종결 확인.** 아래 13건은 전부 iteration 2 개정이 스스로 들여온 것이다.

| # | 출처 | 요지 | 계획 반영 위치 |
|---|------|------|----------------|
| 1 | A-N1 | 2 KiB 절단 해제가 `parsed`의 **유일한 크기 봉투**를 없앴다 — 기본 호스트 응답이 1.3 MiB → 5.3 MiB | **AC-J6b 신설**, D4에 `emitCapFor(host)`(세 번째 상한), **E8b 신설**, §6.1 `redactParsed.test.ts` 초과 케이스, PM-6 탐지 (c) 응답 바이트 단언 |
| 2 | A-N2 = C-J2 | 브랜드 타입이 `run_in_session` 도구 경계에 닿지 않는다 — `:873`은 비공개 `runCommand`의 반환 타입 줄 | OP-3에 3지점 표(공개 `src/ssh/session.ts:968-972`, `command`는 `:970` / 비공개 `:871`), E2, ADR-012 Decision, AC-J5a, §6.1 컴파일 테스트에 `runInSession` 추가 |
| 3 | A-N3 | `internalCommand` 탈출구가 grep으로만 관리돼 원칙 1의 기준을 여기서만 낮춘다 | OP-3 "탈출구는 ESLint로 잠근다", **E1b 신설**(`eslint.config.js:36-43`의 블록 구조 활용), **R40 신설**, ADR-012 Consequences. "grep 가능한 이름" 서술 삭제 |
| 4 | C-N1 | `get` 시점 PEM 마스킹이 페이지 경계에서 샌다 — `maskPemBlocks`의 조기 반환(`src/log.ts:103`) 때문에 둘째 페이지가 키 나머지를 평문으로 준다 | OP-1 스토어 구조를 **`put` 시점 전체 버퍼 1회 마스킹**으로 교체, **AC-O2a 신설**(마스킹 후 단일 좌표계), AC-O7a 개정, D3, ADR-010 Decision, §6.1 경계 케이스 2건. base64 항목도 동일 적용(PEM은 ASCII) |
| 5 | C-N2 | 커서 `h`의 생산 규칙(OP-2)과 소비 규칙(AC-H2b·ADR-011)이 서로 다른 줄을 가리킨다 | OP-2의 `h` 정의를 **"오프셋 `o`가 가리키는 줄"** 로 통일, ADR-011 Decision, AC-H2b. `f>0` 회전 시 승계 없음도 OP-2·AC-H2b·§6.1에 명시(C-J6) |
| 6 | A-imp4 | 우선순위 서술이 토큰 순서와 뒤집혀 있고 `given` 처리가 모호 | OP-4를 **"명시 CLI 플래그 > 위저드 확인 답(기본값 = seed)"** 로 정정 + **"seed는 `given`에 넣지 않는다"** 규칙, 상호작용 표 1행, F2·F3, ADR-013 |
| 7 | A-imp5 | `redactParsed`의 집이 미정 | E8에서 **`src/log.ts`** 로 확정(`SENSITIVE_KEY_PATTERN` `:25`·`maskPemBlocks` `:102-105`의 집). R38에 근거 추가 |
| 8 | C-J7 | Q9는 AC-J7 "만족"이 아니라 축소 | **부록 B-2를 "AC-J7 축소 — 승인 필요"로 승격**. 기본 호스트 무영향 실측(`src/config/schema.ts:36`, 기본 1 MiB → `min(4,4)=4 MiB`) 첨부. 기존 B-2/B-3은 B-3/B-4로 재번호 |
| 9 | C-J4 | E2 테스트 파급이 "한 줄"이 아니라 57곳 이상 | **E2b 신설**(`execOnce` 22곳 + `runInSession` 35곳 실측, `tests/fixtures/resolved.ts` 헬퍼 1개로 일괄 치환), R37 갱신 |
| 10 | C-J12 | `run_in_session` + `format:json` 통합 테스트 미명시 | §6.2 fixture 티어에 두 도구 동등성 단언 추가 |
| 11 | A-imp3 | 실행 중 보관 메모리가 회계에 없다 | OP-1 말미에 **in-flight 회계** 문단(`64 MiB + 2 × retainCap × 동시 실행 수`, 세션 호스트당 5), PM-6 완화 (d) |
| 12 | A-imp1·7 / C-J1·J3·J10·J11 | 인용 드리프트 6건 | `maskPemBlocks` → `src/log.ts:102-105` / `ExcerptResult` `:107-110` + `ExcerptOptions` `:112-117` + `ExcerptAccumulator` `:119-125`(D2) / 일회용 `excerpt()` `:582-586`도 `retained: null` 전파(D2) / `HostRow` `src/host/list.ts:51-59`(F12) / sshd 분기 `tests/fixtures/endpoints.ts:171-199`(OP-6) / `applyErrorDetailsToAudit` `src/tools/wrap.ts:137-147`(§12 교정 목록) |
| 13 | C-J9 | 가드는 `build-test` 자신에는 무력 | **R39 신설**(추가 조치 없이 인정), PM-5에 "잔여 위험" 문단. 4레그 매트릭스에서 4회 도는 것이 의도임도 명시 |

### 반영하지 않은 것

없다. iteration 2 리뷰의 blocking 5건과 improvement 19건(중복 병합 후)을 전부 반영했다.

### 인용 교정 (iteration 3)

`src/log.ts:105-108` → **`:102-105`**(`:105-108`은 `RedactOptions` 머리) · `src/ssh/session.ts:873` → **공개 `:968-972`(`command`는 `:970`) + 비공개 `runCommand`의 `:871`** · `src/ssh/excerpt.ts:112-125` → **`ExcerptResult` `:107-110` / `ExcerptOptions` `:112-117` / `ExcerptAccumulator` `:119-125`** · `src/host/list.ts:53-74` → **`HostRow` `:51-59` + `toRow` `:61-74`** · `tests/fixtures/endpoints.ts:171-200` → **`:171-199`** · `src/tools/wrap.ts:136-146` → **`:137-147`**.

Critic이 "규약으로 인정"한 3건(`src/errors.ts:11-67`·`src/index.ts:43-79`·`src/setup/cli.ts:210-328`)은 "본문 마지막 줄까지, 닫는 `}` 제외" 규약으로 일관되므로 그대로 둔다.

---

## 13. 변경 이력 — iteration 4

iteration 3 리뷰: Architect 조건부 승인([blocking] 1 / [improvement] 5), Critic REVISE([blocking] 2 / [improvement] 5). **iteration 2 항목은 양쪽 모두 전부 종결 확인**(Critic 인용 실측 17건 중 드리프트 0건). 아래 11건은 전부 iteration 3 개정이 스스로 들여온 것이다.

| # | 출처 | 요지 | 계획 반영 위치 |
|---|------|------|----------------|
| 1 | **A-N4 = C-N3** | `put` 마스킹의 Buffer↔string 인코딩 미지정. 저장소 관행(`utf8`)을 따르면 비UTF-8 보관 출력이 U+FFFD로 파괴되고, AC-O2가 **AC-O1a가 일부러 열어 둔 경로**에서만 조용히 깨진다 | OP-1 스토어 구조에 "왕복 인코딩을 못박는다" 불릿(사전 검사 + `latin1` + 실측 수치), AC-O7a, D3, ADR-010 Decision·Consequences. §6.1에 **"PEM 없는 비UTF-8 스트림 왕복이 원본과 `equals`"** 단언 추가 |
| 2 | **C-N4** | `emitCapFor = maxOutputBytes`가 발췌 상한과 같은 값이라 "발췌 상한을 넘으면 `parsed`가 없다"는, AC-J7이 부정한 결합을 만든다. 게다가 "AC 축소 아님"으로 단언 | 값을 **`min(2 × maxOutputBytes, 4 MiB)`** 로 상향(AC-J6b, D4), **부록 B-2를 `parseCapFor`와 `emitCapFor` 공동 등재로 재작성**하고 호스트별 실측 3행 표 첨부, B-3의 "축소가 아니다" 문단 삭제 |
| 3 | C-K1 | §6.1 컴파일 테스트 행의 ESLint 방향이 정반대 | `src/tools/`에서 import하면 실패로 정정. R40의 `exec.ts` 세탁 시나리오를 직접 검사한다고 명시 |
| 4 | A-imp4 | E1b에 `importNames` 누락 시 `resolveCommand`까지 막혀 두 도구가 컴파일 실패 | E1b에 `importNames: ['internalCommand']` 필수 명시 + `paths` 형태, **G-1과 `files:`/`ignores:`가 달라 별도 블록 2개**임을 적음 |
| 5 | A-imp3 | E9가 어느 보관 버퍼를 파싱하는지 모호(마스킹 전/후 길이가 다름) | E9에서 **마스킹 전 `CommandOutput.stdout_retained`** 로 확정. PEM은 `redactParsed`가 받고 `put`은 순서상 뒤라는 근거 |
| 6 | A-imp2 = C-K4 | `fetch_output.total_bytes`와 `stdout_meta.total_bytes`가 다른 양 | AC-O2a에 한 줄(`src/ssh/excerpt.ts:86-87` 인용), D7에 도구 description 문구, G3의 README 출력 절 |
| 7 | C-K3 | AC-O2a의 길이 비교가 base64 항목에서 모호 | 비교는 항상 **바이트 단위 Buffer 길이**, `chunk`는 `encoding`에 따라 utf8/base64 문자열, `next_cursor`는 바이트 오프셋임을 명시 |
| 8 | C-K2 | OP-2 커서 인코딩 줄이 아직 `{f,o,s}` | `{f, o, s, h}`로 갱신하고 `h`를 필드 설명에 포함 |
| 9 | C-K5 | R28 완화 문구가 아직 "`get`의 PEM 마스킹" | "`put` 시점의 PEM 마스킹(페이지 경계 누출이 존재할 수 없게 함)"으로 |
| 10 | A-imp5 | Q8 본문의 `maskPemBlocks` 인용이 마지막 남은 옛 값 | `src/log.ts:102-105`로 정정. 이제 본문·E8·교정 목록이 전부 같은 값 |
| 11 | C 관찰 | `retainCapFor`에 절대 상한 없음 | **`min(4 × maxOutputBytes, 16 MiB)`** 로 명시(현재 최대 호스트에서 동치이므로 동작 변화 없음). D4와 in-flight 회계 문단 갱신. 마스킹 왕복 일시 메모리가 사전 검사로 0회가 된다는 한 줄도 같이 |

### 반영하지 않은 것

없다. iteration 3 리뷰의 blocking 3건(병합 후 2건)과 improvement 10건(병합 후 9건)을 전부 반영했다.

### 이번 회차에 새로 검증한 사실

- `Buffer` 왕복 실측: 7바이트 `00 ff fe 80 41 42 90` → `utf8` 왕복 15바이트·`equals` 거짓, `latin1` 왕복 7바이트·`equals` 참. `Buffer.prototype.indexOf`가 문자열 인자를 받아 `-1`을 돌려주는 것도 확인.
- `src/ssh/excerpt.ts:558`(`const isUtf8 = utf8.done()`)과 `:568`(`buildBinaryExcerpt` 분기) — base64 항목이 "누산기가 UTF-8이 아니라고 판정한 스트림"이라는 근거.
- `src/ssh/excerpt.ts:86-87`(`total_bytes`의 "Bytes seen on the wire" 주석) — 두 `total_bytes`가 다른 양이라는 근거.
- 인용 드리프트 0건. iteration 3에서 교정한 6건은 전부 유지되고 있다.

## 14. 변경 이력 — 최종 정리 (Critic APPROVED 후, 오케스트레이터 적용)

| # | 출처 | 요지 | 반영 위치 |
|---|------|------|-----------|
| 1 | Critic iter4 improvement | PM-6 완화 (a)의 상한 값 두 개가 낡음(보관 절대 상한 누락, 응답 탑재가 `maxOutputBytes`) | PM-6 완화 (a)를 D4·부록 B-2 표와 일치시킴 |
| 2 | 정리 | 제목의 "iteration 2" 표기, 머리말의 리뷰 요약이 1회차 기준 | 제목을 합의본으로, 머리말에 합의 이력과 승인 시 확인 항목 4개 추가 |

**Status: pending approval.** 실행 승인은 별도 단계에서 받는다. 승인 후 실행 경로(team 또는 ralph)는 Phase A부터 순서대로 진행하되, Phase A의 세 선행 작업(probe · R24 테스트 · real-sshd 티어)은 서로 독립이므로 병렬 가능하다.
