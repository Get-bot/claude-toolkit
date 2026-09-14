<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# e2e

## Purpose

소스가 아니라 **배포 산출물**을 검증하는 레그입니다. `npm pack`이 만든 타르볼을 `npx`로, 최종 사용자가 실행하는 방식 그대로 자식 프로세스로 띄우고 stdio 위에서 JSON-RPC를 주고받습니다. 소스 테스트가 전부 통과해도 번들링·`bin` 매핑·`files` 목록·shebang이 잘못되면 사용자에게 도달하는 것은 동작하지 않는 패키지이므로, 이 레그만이 "설치하면 실제로 돌아간다"를 증명합니다.

## Key Files

| File               | Description                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `package.test.ts`  | 패키징된 서버가 stdio로 MCP를 올바르게 말하는지 — `initialize` + `tools/list`에서 도구 7개 확인. CI의 `package-smoke` 잡이 씁니다.       |
| `realHost.test.ts` | 이미 `ssh-mcp setup`으로 등록된 **실제 호스트**에 대한 선택적 스모크. `SSH_MCP_E2E_HOST`가 없으면 CI 포함 어디서든 깨끗하게 skip 합니다. |

## How it runs

- **진입점 해석** (`package.test.ts`의 `resolveEntrypoint()`, 위에서부터 순서대로):
  1. `SSH_MCP_TGZ`가 설정돼 있으면 그 타르볼을 `npxLaunch()`로 npx 경유 실행 — 실사용자의 실행 방식을 재현합니다.
  2. 없으면 `dist/index.js`를 node로 직접 spawn — `npm run build`만 해도 로컬에서 돌아가게 하기 위함입니다.
  3. 그것도 없으면 패키지 루트에 남은 `*.tgz`를 탐색합니다.
  4. 셋 다 없으면 에러를 던집니다.
- **게이팅 환경변수**
  - `SSH_MCP_TGZ` — `npm pack` 산출물의 절대 경로. CI에서는 `scripts/resolve-tarball-path.mjs`가 채웁니다.
  - `SSH_MCP_E2E_HOST` — 실제 호스트 alias. 없으면 `realHost.test.ts` 전체가 `describe.skipIf`로 건너뛰어져 실제 호스트를 절대 건드리지 않습니다.
- **홈 격리** — `package.test.ts`는 `createTmpHome()`으로 `SSH_MCP_HOME`/`HOME`/`USERPROFILE`을 샌드박스로 돌린 뒤 서버를 spawn 합니다(`initialize` 시 `state.json`을 쓰기 때문). 반대로 `realHost.test.ts`는 **의도적으로 리다이렉트하지 않습니다** — 사람이 등록해 둔 실제 `~/.ssh-mcp/hosts.json`의 alias를 써야 하기 때문입니다.
- **실행** — `npm run test:e2e` (설정: `vitest.e2e.config.ts`). 기본 `npm test`에는 포함되지 않습니다.

## Invariants & gotchas for AI agents

- **설정이 분리돼 있습니다.** `vitest.e2e.config.ts`는 타임아웃 120초, `fileParallelism: false`, `bail: 1`입니다. 패킹과 스폰은 동시에 돌리는 것이 안전하지 않고, 스폰된 서버를 공유하기 때문에 한 번 60초 예산을 태운 대기는 남은 대기도 똑같이 태웁니다 — `bail: 1`이 그 비용을 테스트마다 반복해 내지 않게 합니다. 이 값들을 낮추거나 병렬을 켜지 마세요.
- **`tests/e2e`를 `vitest.config.ts`에 넣지 마세요.** 기본 설정에서 의도적으로 제외돼 있습니다.
- **`realHost.test.ts`는 기본적으로 아무것도 하지 않아야 합니다.** 게이트가 풀리는 순간 실제 서버에 접속하므로, `describe.skipIf(!REAL_HOST_ALIAS)` 밖으로 코드를 옮기지 마세요. vitest가 파일당 최소 한 개의 테스트를 요구하기 때문에 파일 끝에 보고용 테스트가 하나 있습니다.
- **릴리스 체크리스트 항목입니다.** 실제 호스트 상대로 이 테스트를 돌리고 결과를 기록하는 것은 릴리스 전 필수 수동 단계이지만 자동 CI의 일부는 아닙니다(계획 §8.7 #3).
- **stdout에 JSON-RPC 프레임 외의 것이 없는지도 검증합니다.** `nonJsonStdoutLines`가 AC2.3의 근거이며, 도구는 정확히 7개여야 합니다.
- **`assertNoWritesOutside(home)`는 `home.cleanup()`보다 먼저 호출해야 합니다.** cleanup이 환경변수를 복원해 버리기 때문입니다.
- 자식이 응답 전에 죽으면 타임아웃을 기다리지 말고 즉시 실패해야 합니다. `stdioServer.ts`의 `describeFate()`가 종료 코드와 stderr 꼬리를 붙여 주며, 이 진단이 없으면 0.6초 만에 죽은 자식을 30초 동안 기다리게 됩니다.

## Running

```bash
npm run build
npm pack
SSH_MCP_TGZ=$(pwd)/get-bot-ssh-mcp-<package.json의 version>.tgz npm run test:e2e
SSH_MCP_E2E_HOST=myhost npm run test:e2e     # 실제 호스트 레그까지
```

CI 잡: `package-smoke` (ubuntu + windows 매트릭스), 스텝 `package smoke test (initialize + tools/list, expect 7 tools)`.

## Dependencies

### Internal

`tests/fixtures/stdioServer.ts` (`launchStdioServer`, `npxLaunch`, `sendFrame`, `waitForResponse`, `describeFate`, `MCP_PROTOCOL_VERSION`).

### External

`vitest`, Node `node:child_process`.

<!-- MANUAL: -->
