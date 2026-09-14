<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# manual

## Purpose

자동화가 원리적으로 커버할 수 없는 검증 절차를 담은 디렉터리입니다. 실제 Claude Desktop / Claude Code 클라이언트와의 통합은 사람이 그 UI를 보고 클릭해야만 확인할 수 있고, 승인 대화상자가 실제로 떴는지·always-allow가 무력화되는지 같은 것은 프로그램이 관측할 수 없기 때문입니다. 여기 있는 문서는 코드가 아니라 **리뷰어가 따라 하고 결과를 기록하는 체크리스트**입니다.

## Key Files

| File                  | Description                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-integration.md` | AC3~AC6 수동 호스트 통합 체크리스트(+ `install`용 계획 외 추가 항목) + 릴리스 전 필수 실호스트 확인 절차. `.omc/plans/ssh-mcp-plan.md` §8.5를 따릅니다. |

## What the doc covers

- **AC3** — 저장소 문서 상태(루트 README의 도구 목록, 상대 경로 링크, `ssh-mcp/README.md` 존재).
- **AC4** — Claude Desktop(Windows) 등록. `%APPDATA%\Claude\claude_desktop_config.json`에 `cmd /c npx -y @get-bot/ssh-mcp` 형태로 등록하고 도구가 **정확히 7개** 보이는지 확인. 감싸지 않은 `command: "npx"` 형태도 한 번 시도해 README의 `cmd /c` 권고가 실제로 필요한지 재확인합니다.
- **AC4 추가 항목(계획 외)** — `npx @get-bot/ssh-mcp install claude-desktop` 자동 경로. 기존 서버 항목 보존, `.bak-` 백업 생성(같은 초에는 `-1` 접미사), 이름 충돌 시 `--force` 없이는 거부.
- **AC5** — Claude Code 등록(`claude mcp add ssh-mcp -- cmd /c npx -y @get-bot/ssh-mcp`)과 `/mcp`에서의 도구 목록. 감싸지 않은 `npx` 형태도 연결되는지(2.1.270에서 연결됨을 2026-09-14 실측) 버전과 함께 기록합니다.
- **AC5 추가 항목(계획 외)** — `npx @get-bot/ssh-mcp install claude-code` 자동 경로와 `--dry-run` 출력, 값 자리에 플래그가 온 경우의 거부, `cmd` 재시도 거부.
- **AC6** — Windows 11 검증.
- **릴리스 전 필수 실호스트 확인** — `setup` 흐름, 타임아웃·리소스 정리, 승인 흐름(리뷰어가 특히 주의해서 볼 세 가지), `approvalFallback`/`approvalMode` 동작, 출력·셸 감지, 감사 로그, 진단.
- **기록란** — 항목별 PASS/FAIL과 관측 내용을 적는 자리.

## When a human must run it

- **릴리스 전에는 필수입니다.** 실호스트 확인 절은 계획서의 릴리스 체크리스트 항목이며, `tests/e2e/realHost.test.ts`를 실제 호스트로 돌린 결과 기록도 여기에 포함됩니다.
- 승인 흐름, 클라이언트 등록 방식, 도구 설명문, `_meta`의 `requiresUserInteraction` 관련 코드를 바꿨을 때.
- Windows 관련 경로·ACL·`npx` 실행 방식을 바꿨을 때.

전제 조건: Windows 11 머신, 빌드되었거나 배포된 `ssh-mcp`, 비밀번호 로그인이 가능한 테스트용 원격 리눅스 호스트 1대.

## For AI Agents

### Working In This Directory

- **이 체크리스트를 "실행"하려 하지 마세요.** 자동화할 수 있었다면 `tests/integration/`이나 `tests/e2e/`에 있었을 것입니다. 에이전트가 할 일은 코드 변경에 맞춰 체크리스트 **항목을 갱신**하는 것입니다.
- 자동 검증으로 옮길 수 있게 된 항목이 생기면 여기서 지우고 해당 테스트 레그에 추가하세요 — 두 곳에 남겨 두면 어느 쪽이 진실인지 알 수 없게 됩니다.
- 체크박스는 `[ ]` 형식을 유지합니다. 리뷰어가 채우는 자리이므로 미리 체크된 상태로 커밋하지 마세요.
- 도구 개수(7), 등록 스니펫, 환경변수 이름을 바꿨다면 이 문서와 `README.md`, 그리고 등록 명령 형태의 출처인 `src/config/registration.ts`(이것을 `src/doctor/checks.ts`의 `buildSnippets()`와 `src/install/`이 함께 씁니다)를 갱신해야 합니다.

## Dependencies

### Internal

없음 (문서 전용). 내용상 `README.md`, `src/config/registration.ts`의 등록 명령 형태(와 그것을 렌더링하는 `src/doctor/checks.ts`·`src/install/`), `tests/e2e/realHost.test.ts`와 동기화돼야 합니다.

### External

Claude Desktop, Claude Code, 실제 원격 SSH 호스트.

<!-- MANUAL: -->
