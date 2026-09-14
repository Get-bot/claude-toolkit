<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# tests

## Purpose

vitest 기반 테스트 전체가 있는 디렉터리입니다. 세 개의 레그로 나뉘며 각각 다른 것을 증명합니다 — `unit/`은 순수 함수(정규화, 분류, 발췌, redaction, 스키마)를, `integration/`은 인프로세스 SSH 서버와 인메모리 MCP 클라이언트를 띄워 도구 호출 경로 전체를, `e2e/`는 `npm pack`으로 만든 실제 타르볼을 `npx`로 스폰해 배포 산출물 자체를 검증합니다. `fixtures/`는 세 레그가 공유하는 테스트 하네스이고, `manual/`은 자동화할 수 없어 사람이 직접 돌려야 하는 절차입니다.

## Subdirectories

| Directory      | Purpose                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `unit/`        | 순수 함수 단위 테스트 (see `unit/AGENTS.md`)                                   |
| `integration/` | 인프로세스 SSH 서버 + MCP 클라이언트 통합 테스트 (see `integration/AGENTS.md`) |
| `e2e/`         | 패키지 타르볼 스모크와 실호스트 테스트 (see `e2e/AGENTS.md`)                   |
| `fixtures/`    | 공용 테스트 하네스 (see `fixtures/AGENTS.md`)                                  |
| `manual/`      | 사람이 직접 수행하는 검증 절차 (see `manual/AGENTS.md`)                        |

## For AI Agents

### Working In This Directory

- **레그마다 설정 파일이 다릅니다.** `vitest.config.ts`는 `tests/unit/**`와 `tests/integration/**`만 포함하고(타임아웃 30초), `tests/e2e/**`는 `vitest.e2e.config.ts`가 담당합니다(타임아웃 120초, `fileParallelism: false`, `bail: 1`). e2e를 기본 설정에 끌어들이지 마세요 — 의도적인 분리입니다.
- 새 테스트를 어느 레그에 둘지는 "무엇을 증명하는가"로 결정합니다. 네트워크·파일시스템 없이 입력→출력만 검증하면 `unit/`, 도구 호출 경로나 승인 흐름을 검증하면 `integration/`, 배포 산출물의 형태를 검증하면 `e2e/`입니다.
- **테스트는 `~/.ssh-mcp`를 건드리면 안 됩니다.** 실제 사용자 홈에 쓰는 순간 개발자의 실제 레지스트리·키·감사 로그를 오염시킵니다. `fixtures/tmpHome.ts`로 격리된 홈을 쓰세요.
- 통합 테스트는 `ENDPOINT` 환경변수로 파라미터화돼 있습니다(ADR-002). 기본값은 인프로세스 픽스처이며, 실제 sshd 컨테이너 티어는 v1.1 후보입니다.
- 픽스처가 띄운 서버·세션·임시 디렉터리는 반드시 `afterEach`/`afterAll`에서 정리하세요. 남은 리스너나 열린 소켓은 vitest 프로세스를 종료되지 않게 만듭니다.

### Testing Requirements

```bash
npm test                 # unit + integration
npm run test:unit
npm run test:integration
npm run test:e2e         # 느림, 직렬 실행
npm run test:fp-gate     # 분류기 오탐 게이트
```

## Dependencies

### Internal

`src/` 전체. 테스트는 빌드 산출물이 아니라 소스를 직접 import 합니다(단, `e2e/`는 패킹된 타르볼을 대상으로 합니다).

### External

`vitest` 5, `ssh2`(픽스처 서버), `@modelcontextprotocol/sdk`(인메모리 클라이언트), `zod`.

<!-- MANUAL: -->
