<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# host

## Purpose

`ssh-mcp host` 명령 그룹입니다. `setup`이라는 이름은 무엇을 설정하는지 드러내지 않아서 `host add`로 바꿨고, 같은 자리에 `host list`를 두었습니다. 실제 등록 로직은 여기 없습니다 — `add`는 `../setup/cli.ts`의 `runSetup()`에 그대로 위임하고, 이 디렉터리는 라우팅과 목록 출력만 담당합니다.

**계획서(`.omc/plans/ssh-mcp-plan.md`)에 없던 2026-09-14 추가분입니다.**

## Key Files

| File      | Description                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`  | 하위 명령 라우팅. `runHost(argv, deps)`, `USAGE`, `HOST_SUBCOMMANDS`. `add` → `runSetup()`, `list` → `runHostList()`.                       |
| `list.ts` | `host list` 구현. `runHostList(argv, deps)`, `renderTable()`, `toRow()`, `USAGE`, 종료 코드 `EXIT_OK=0` / `EXIT_FAILED=1` / `EXIT_USAGE=2`. |

## Invariants & gotchas for AI agents

- **`setup` 별칭을 없애지 마세요.** `src/index.ts`가 `setup`을 `runSetup`으로 직접 라우팅하며 **경고를 출력하지 않습니다.** 0.1.0 사용자는 `npx -y`로 자동 업데이트되므로, 경고든 실패든 10분 전까지 잘 되던 설정을 깨뜨립니다. 아직 deprecate할 단계가 아닙니다. `tests/unit/hostCommand.test.ts`가 두 철자의 출력이 바이트 단위로 같음을 고정합니다.
- **내부 식별자는 개명하지 않았습니다.** `runSetup`, `parseSetupArgs`, `src/setup/` 디렉터리는 그대로입니다. 이름을 맞추려고 보안 관련 코드 전반에 diff를 내는 것은 CLI 사용자가 볼 수 없는 변화에 회귀 위험만 더하는 일입니다.
- **`host list`의 출력은 stdout입니다.** `doctor`와 같은 이유 — 목록은 사람이 파이프하고 grep하는 것입니다. 오류와 usage는 stderr로 갑니다.
- **`list_hosts` 도구와 같은 것만 보여줍니다.** 개인키 경로와 지문 전문은 출력하지 않고 지문은 `fingerprintPrefix()`로 접두 16자만 씁니다. 사람과 모델이 레지스트리의 서로 다른 그림을 보면 안 됩니다. `--json`의 필드 이름도 도구 응답과 동일하게 유지하세요.
- **`fail-closed(누락)` 표기를 지우지 마세요.** 파일에 `approvalFallback`이 없어 `load()`가 정규화한 항목과, 사용자가 실제로 `fail-closed`를 고른 항목은 보안상 의미가 다릅니다(D2). 표에서 구분되어야 합니다.
- **깨진 `hosts.json`은 추측하지 않습니다.** `store.load()`가 `ConfigInvalid`를 주면 사유를 출력하고 종료 코드 1이며, stdout에는 아무것도 쓰지 않습니다.

## Testing

| Suite                            | 대상                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `tests/unit/hostCommand.test.ts` | 그룹 라우팅·`setup` 별칭 동등성·`host list`의 표/JSON/빈 목록/깨진 파일/옵션 오류 |

```bash
npm run test:unit
```

`hosts.json`을 건드리므로 `tests/fixtures/tmpHome.ts`의 격리 홈을 쓰고 `assertNoWritesOutside()`로 벗어난 쓰기가 없음을 증명합니다.

## Dependencies

### Internal

`../config/schema.js`, `../config/store.js`, `../setup/cli.js`, `../tools/listHosts.js`(`fingerprintPrefix`)

### External

없음 (Node 빌트인도 직접 쓰지 않습니다).

<!-- MANUAL: -->
