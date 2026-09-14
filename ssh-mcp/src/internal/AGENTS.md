<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# internal

## Purpose

의존성 그래프의 최하단에 있는, 의존성이 전혀 없는 원시 유틸리티 모듈입니다. `log.ts`, `config/store.ts`, `config/state.ts`, `audit.ts` 같은 기반 모듈들이 순환 참조를 만들지 않고 공통 헬퍼를 쓸 수 있게 하는 것이 존재 이유입니다.

## Key Files

| File      | Description                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `util.ts` | `byteLength`(UTF-8 바이트 길이), `isErrnoCode`(Node 시스템 오류의 `code` 판별), `isEnoent`(ENOENT 단축), `errorMessage`(unknown throwable의 메시지 추출) |

## For AI Agents

### Working In This Directory

- **이 모듈은 `src/` 안의 어떤 것도 import 해서는 안 됩니다.** 파일 상단 주석이 명시하는 규칙이며, 이를 어기면 `log.ts`·`config/*`·`audit.ts` 사이에 순환 참조가 생깁니다. Node 빌트인만 허용됩니다.
- `errorMessage`는 절대 throw 하지 않고, `Error`에 대해 `[object Object]`를 반환하지 않는다는 계약을 지킵니다.
- `byteLength`, `isEnoent`, `errorMessage`의 정식 위치는 여기입니다. `ssh/error.ts`와 `setup/cli.ts`에 남아 있는 사본은 이쪽으로 수렴시키는 것이 원래 의도입니다(파일 주석의 CR-9 메모).
- 이곳에 무엇이든 추가하기 전에 "정말 3개 이상의 레이어가 공유하는가, 그리고 의존성이 0인가"를 먼저 확인하세요. 도메인 지식이 들어간 헬퍼는 해당 레이어에 두는 편이 맞습니다.

### Testing Requirements

전용 테스트 파일은 없습니다. 이 헬퍼들은 이를 사용하는 모듈의 테스트(`tests/unit/audit.test.ts`, `tests/unit/store.test.ts`, `tests/unit/redact.test.ts` 등)를 통해 간접적으로 검증됩니다.

## Dependencies

### Internal

없음 (의도된 설계).

### External

Node 빌트인 `Buffer`만 사용합니다.

<!-- MANUAL: -->
