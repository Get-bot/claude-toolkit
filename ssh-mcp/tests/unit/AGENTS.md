<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# unit

## Purpose

네트워크나 실제 홈 디렉터리 없이 순수 함수와 단일 모듈의 동작을 검증하는 레그입니다. 분류기 코퍼스, 출력 발췌 산술, 마커 프레임 스캐너, 지문 계산, redaction, 스키마 기본값처럼 "입력 → 출력"이 명확한 것들이 여기 있습니다. 파일시스템을 건드리는 소수의 테스트(`audit.test.ts`, `store.test.ts`, `keygen.test.ts`)는 `tests/fixtures/tmpHome.ts`로 격리된 임시 홈을 씁니다.

## Key Files

| File                    | Description                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `classify.test.ts`      | 표 기반 분류 코퍼스(safe / privileged / destructive / bypass) + **오탐 게이트**. 코퍼스가 계약이며 분류기보다 먼저 작성됐습니다. |
| `normalize.test.ts`     | `normalize()`의 dequote, `matchTarget` NUL 치환, 세그먼트 분할, `MAX_SUBSTITUTION_DEPTH`                                         |
| `interactive.test.ts`   | `UNCONDITIONAL_PROGRAMS`/`CONDITIONAL_PROGRAMS` 판정과, 게이트를 통과한 명령이 분류기에 걸리는지                                 |
| `approval.test.ts`      | §5.5 승인 표 전체(호스트 × 모드 × 등급 × elicitation × 폴백) + 표로 표현할 수 없는 규칙들                                        |
| `tokens.test.ts`        | 토큰 발급·소비·만료·tombstone·`MAX_TOKENS` 축출                                                                                  |
| `secrets.test.ts`       | `maskCommandSecrets()`와, 마스킹이 분류 결과를 바꾸지 않는다는 것                                                                |
| `excerpt.test.ts`       | §5.8 발췌(AC12.1~AC12.9). 줄 수는 **생성기에서** 가져옵니다                                                                      |
| `markerFraming.test.ts` | 세션 완료 프레임 감지. 프레임이 TCP 바이트 경계에서 임의로 쪼개지는 모든 경우를 재현                                             |
| `shellDetect.test.ts`   | 셸 감지 표와 프리앰블. `set +o pipefail` 회귀 가드                                                                               |
| `fingerprint.test.ts`   | `SHA256:` 지문. 고정 벡터는 `ssh-keygen -lf`가 만든 값                                                                           |
| `hostKeys.test.ts`      | 픽스처 키 생성기의 검증 루프(ssh2 1.17.0의 불량 ed25519 쌍 대응)                                                                 |
| `keygen.test.ts`        | 키 생성. POSIX 모드 단언은 Windows에서 의도적으로 skip                                                                           |
| `setupPrompt.test.ts`   | 프롬프트 규칙(에코 금지, 비-TTY 거부, `yes` 정확 일치, 3회 후 포기)                                                              |
| `redact.test.ts`        | 키 이름 기반 redaction, PEM 마스킹, 2 KiB 필드 상한                                                                              |
| `schema.test.ts`        | `hosts.json` 스키마 기본값과 `.strict()` 거부                                                                                    |
| `store.test.ts`         | 레지스트리 로드/저장, 폴백 정규화, 손상 파일 처리                                                                                |
| `audit.test.ts`         | 감사 레코드 형태, 줄 길이 상한, 로테이션                                                                                         |
| `errors.test.ts`        | `ERROR_CODES` 목록과 `isErrorCode()`                                                                                             |
| `toolsList.test.ts`     | 실제 클라이언트–서버 쌍으로 `tools/list` 검증. 스냅샷이 아니라 **필드 단위**로 단언                                              |

## Conventions

- 테스트 파일 상단에 **무엇을 왜 증명하는지**를 블록 주석으로 적습니다. 기존 파일들의 주석은 회귀의 배경(어떤 버그가 있었고 왜 이 단언이 생겼는지)을 담고 있으니 새 파일도 같은 밀도를 유지하세요.
- 자기 자신으로 자신을 검증하지 않습니다. 발췌 테스트의 줄 수는 생성기에서 가져오고(`head + omitted + tail === total`은 정의상 항진명제라 무의미), 지문 테스트의 기대값은 OpenSSH `ssh-keygen -lf` 출력입니다.
- 스냅샷 비교를 피합니다. `toolsList.test.ts`는 SDK 패치 릴리스가 우리가 설정하지 않은 필드(`execution: { taskSupport: 'forbidden' }`)를 추가해도 깨지지 않도록 필드 단위로 단언합니다.
- 플랫폼 차이는 숨기지 말고 명시적으로 skip 합니다(예: POSIX 모드 단언은 Windows에서 skip, 실제 증명은 ubuntu CI 레그가 담당).
- 파일시스템을 건드리면 `createTmpHome()`으로 격리하고 `assertNoWritesOutside()`로 벗어난 쓰기가 없음을 증명합니다.

## Notable gates

**오탐 게이트** (`classify.test.ts`의 `false-positive gate` 블록, `npm run test:fp-gate`)

- 목표는 안전 코퍼스에 대한 **오탐률 0%** 입니다. "대체로 맞음"은 통과가 아닙니다.
- 세 가지를 단언합니다: 안전 코퍼스의 어떤 행도 destructive로 판정되지 않을 것, 모든 안전 코퍼스 행이 코퍼스가 명시한 등급과 **정확히** 일치할 것, 호스트가 추가 패턴을 넣어도 안전 코퍼스 행이 privileged를 넘지 않을 것.
- 코퍼스 크기 하한도 검사합니다(§6.1) — BYPASS 최소 60행(전부 destructive여야 함), SAFE 최소 60행, PRIVILEGED 최소 12행.
- 모든 `ARGV_RULES` 항목이 코퍼스의 최소 한 행에서 도달되는지도 검사합니다.

## Running

```bash
npm run test:unit        # vitest run tests/unit
npm run test:fp-gate     # vitest run tests/unit/classify.test.ts
```

설정은 `vitest.config.ts`(타임아웃 30초, `environment: 'node'`)가 관장합니다.

## Dependencies

### Internal

`src/` 모듈을 소스에서 직접 import 합니다(`../../src/...`). 일부는 `tests/fixtures/`의 `tmpHome`, `hostKeys`, `mcpClient`를 씁니다.

### External

`vitest`(`describe`/`it`/`expect`/`vi`/`beforeEach`/`afterEach`), Node 빌트인.

<!-- MANUAL: -->
