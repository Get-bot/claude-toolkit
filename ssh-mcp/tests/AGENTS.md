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
- 통합 테스트는 `ENDPOINT` 환경변수로 파라미터화돼 있습니다(ADR-002). 기본값은 인프로세스 픽스처이고, `ENDPOINT=sshd`는 `tests/sshd/`의 Dockerfile로 띄운 실제 OpenSSH 서버를 씁니다 — `real-sshd` CI 잡이 그 티어를 돌립니다(ADR-015, AC-T1~T6). 로컬 재현 절차는 `.omc/plans/ssh-mcp-v11-plan.md` §8.2에 있습니다.
- **sshd 티어가 증명하는 것은 인프로세스 픽스처가 원리적으로 못 보는 넷입니다**(AC-T4): `StrictModes yes`가 받아들이는 권한으로 `authorized_keys`가 설치된다, 지문 고정이 실제 호스트 키를 상대로 강제된다, 타임아웃 뒤 원격 프로세스가 남지 않는다, SFTP 왕복이 실제 subsystem을 통과한다. 그 밖의 단언은 픽스처 티어에서 돌리는 것이 더 빠르고 더 많이 관측할 수 있습니다.
- **sshd 티어에서 키는 실제 SSH 경로로 심습니다.** `authorizeKey()`는 로컬 `fs`로 쓰기 때문에 그 티어에서 throw 하고, 대신 `authorizeKeyOverSsh()`(`tests/fixtures/endpoints.ts`)가 비밀번호 계정으로 붙어 `installAuthorizedKey`를 돌립니다. 양쪽 티어에서 다 동작하므로 테스트가 `endpoint.kind`로 직접 분기할 필요는 없습니다.
- **`remoteHomeDir`를 로컬 `fs`에 넘기지 마세요.** 픽스처 티어에서는 같은 디렉터리라 무해하지만 sshd 티어에서는 컨테이너 안의 경로이고, 로컬에서 그 경로를 읽으면 조용히 빈 결과가 나옵니다. 원격 파일을 만들거나 읽어야 하면 SFTP나 `exec`로 하고, 그럴 수 없으면 그 단언을 픽스처 전용으로 표시하세요.
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
