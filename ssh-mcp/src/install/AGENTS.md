<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# install

## Purpose

`ssh-mcp install [claude-code|claude-desktop]` 명령 전체입니다(클라이언트를 생략하면 터미널에서 묻습니다). `doctor`가 이미 등록 스니펫을 출력하고 사람이 그것을 붙여넣어도 결과는 같지만, 그러려면 SSH와 무관한 플랫폼 세부를 알아야 합니다 — Windows에서는 서버 명령을 `cmd /c`로 감싸야 하고, 두 클라이언트는 등록 정보를 서로 다른 곳에 서로 다른 형식으로 둡니다. 이 명령은 그 부분을 대신해서 "왜 ENOENT가 나느냐"는 가장 흔한 문의를 없애는 것이 목적입니다. 서버 동작이나 도구 표면은 전혀 건드리지 않습니다.

**계획서(`.omc/plans/ssh-mcp-plan.md`)에 없던 2026-09-14 추가분입니다.** plan row나 AC 번호를 인용하지 마세요 — 인접한 row 5b.5 / AC21.7은 `doctor`의 스니펫 **출력** 근거이지 이 명령의 근거가 아닙니다.

## Key Files

| File            | Description                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`        | 인자 파싱과 오케스트레이션. `runInstall(argv, deps)`, `parseInstallArgs()`, `USAGE`, `INSTALL_CLIENTS`, `DEFAULT_SERVER_NAME`. 종료 코드 `EXIT_OK=0` / `EXIT_FAILED=1` / `EXIT_USAGE=2`.             |
| `claudeCode.ts` | `claude mcp add`/`remove` 실행. `installClaudeCode()`, `buildAddArgs()`/`buildRemoveArgs()`, `defaultSpawner`, `Spawner`/`SpawnOutcome` 타입. scope는 이미 정해진 값을 받으며 여기서 묻지 않습니다.  |
| `desktop.ts`    | `claude_desktop_config.json` 편집. `installClaudeDesktop()`, `desktopConfigPath()`, `backupPath()`, `DESKTOP_CONFIG_FILE_NAME`.                                                                      |
| `detect.ts`     | 메뉴 힌트용 감지. `detectClaudeCode()`(PATH + Windows `PATHEXT`), `detectClaudeDesktop()`(설정 **폴더** 존재), `Detection`/`ClientDetector`. **프로세스를 띄우지 않습니다.**                         |
| `scope.ts`      | Claude Code scope 어휘와 대화형 선택. `CLAUDE_CODE_SCOPES`, `ClaudeCodeScope`, `DEFAULT_CLAUDE_CODE_SCOPE`, `resolveScope()`, `buildScopePrompt()`, `nonInteractiveScopeNotice()`, `scopeMeaning()`. |

등록되는 **서버 명령 형태 자체**는 여기가 아니라 `../config/registration.ts`에 있습니다(`buildServerCommand()`, `buildDesktopEntry()`, `formatServerCommand()`, `PACKAGE_NAME`). `doctor`의 스니펫과 같은 출처를 쓰기 위해서입니다.

## Invariants & gotchas for AI agents

- **모든 출력은 stderr입니다.** `setup`과 같은 원칙이고 `doctor`와는 반대입니다 — 이 명령은 파이프로 넘길 데이터가 아니라 진행 상황과 실패를 보고합니다. 출력은 `write` 콜백으로 주입되므로 이 디렉터리에는 ESLint `no-console` 예외가 필요 없습니다. `console`을 직접 쓰지 마세요.
- **Windows에서는 두 클라이언트 모두 `cmd /c`로 감쌉니다.** Claude Code 2.1.270은 bare `npx`로도 연결되지만(2026-09-14 실측), 구버전 호환과 Desktop과의 일관성을 위해 자동 경로는 한 형태만 씁니다. 이 판단을 바꾸려면 README의 `install` 절과 `config/registration.ts`의 주석을 함께 고쳐야 합니다.
- **`spawn`은 반드시 주입 가능해야 합니다.** 유닛 테스트가 개발자의 진짜 `claude`를 실행하면 그 사람의 실제 MCP 레지스트리가 바뀝니다. `Spawner`를 없애거나 `spawnSync`를 직접 부르는 코드를 추가하지 마세요.
- **Claude Code의 레지스트리 파일을 직접 편집하지 않습니다.** `~/.claude.json`과 그 주변 스코프 파일의 형식은 공개된 계약이 아니므로 `claude mcp add`에 위임합니다. argv만 우리 것입니다.
- **`claude_desktop_config.json`은 이해하지 못하면 건드리지 않습니다.** 파싱 실패, 최상위가 객체가 아님, `mcpServers`가 객체가 아님 — 셋 다 **아무것도 쓰지 않고** 경로·사유를 출력한 뒤 종료 코드 1입니다. 그 파일에는 사용자의 다른 MCP 서버 설정이 들어 있고, 그것을 날리는 것이 이 명령이 만들 수 있는 최악의 결과입니다.
- **이름 충돌은 `--force` 없이 덮어쓰지 않습니다.** 두 클라이언트 모두 동일합니다. Desktop 쪽은 덮어쓰기 전에 `<파일명>.bak-<YYYYMMDD-HHmmss>` 백업을 만들고, 쓰기는 임시 파일 + `renameSync`로 원자적으로 교체합니다(`config/store.ts`의 `save()`와 같은 절차). 임시 파일 이름에는 pid와 난수를 붙여 동시 실행이 서로의 반쪽 파일을 rename 하지 못하게 합니다.
- **백업은 절대 덮어쓰지 않습니다.** 타임스탬프가 초 단위라 같은 초의 두 번째 실행이 첫 백업을 지우는 것이 재현됐습니다. `writeBackup()`이 `wx` 플래그로 쓰고 `EEXIST`면 `-1`, `-2`… 를 붙입니다. 존재 확인 후 쓰기(`existsSync` + `writeFileSync`)로 "단순화"하면 경쟁 구간이 다시 생깁니다.
- **존재 확인은 `Object.hasOwn()`으로** 합니다. `servers[name] !== undefined`는 `--name constructor` 같은 값을 충돌로 오판합니다.
- **재직렬화는 2칸 들여쓰기 + 끝 줄바꿈으로 통일합니다.** JSON 포맷을 보존하려면 별도 파서가 필요해 의존성이 늘어나므로 받아들인 트레이드오프이며, 성공 안내에 그 사실을 한 줄 밝힙니다. 이 문구를 지우지 마세요.
- **클라이언트 전용 플래그는 무시하지 말고 거부합니다.** `--scope`는 `claude-code` 전용, `--config`는 `claude-desktop` 전용이며 반대쪽에 주면 종료 코드 2입니다. 조용히 무시하면 사용자가 user 스코프에 등록했다고 믿는 상태가 생깁니다.
- **값을 받는 플래그는 전부 `optionValue()`를 거칩니다.** `-`로 시작하는 토큰을 값으로 삼키면 안 됩니다 — `--home --dry-run`이 `SSH_MCP_HOME=--dry-run`을 등록하면서 **실제로 파일을 쓰는** 결함이 실행으로 재현됐습니다. 새 플래그를 추가할 때 이 헬퍼를 쓰지 않으면 같은 결함이 되돌아옵니다.
- **`--home`과 `--config`는 파싱 시점에 `path.resolve()`합니다.** 서버는 MCP 호스트가 정한 cwd에서 실행되므로 상대 경로는 사용자가 의도한 곳을 가리키지 않습니다.
- **scope는 `claude-code`에서만, `--scope`가 없을 때만 묻습니다.** `local`은 "명령을 친 그 디렉터리에서만 보임"이라 홈 디렉터리에서 설치한 사용자가 정작 일하는 프로젝트에서 도구를 못 보는 함정이 됩니다(`scope.ts` 헤더 참조). `--scope`가 주어지면 절대 묻지 않습니다 — 문서의 한 줄 명령과 스크립트가 비대화형으로 남아야 합니다. `canPrompt()`가 false면(stdin 또는 stderr가 터미널이 아니거나 `TERM=dumb`) 묻지 않고 `local` + 안내 한 줄입니다. **매달리는 프롬프트는 잘못된 기본값보다 나쁩니다.**
- **클라이언트를 생략한 비대화형 실행은 추측하지 않습니다.** 터미널이면 메뉴로 묻고, 아니면 사용법 오류(2)와 두 명령 안내로 끝냅니다. 어느 쪽을 원했는지 짐작해서 등록하면 정확히 이 명령이 없애려는 "엉뚱한 곳에 등록됨" 문제가 돌아옵니다.
- **감지 결과는 힌트일 뿐 선택을 막지 않습니다.** 방금 설치했거나 비표준 경로에 둔 사용자가 막히면 안 됩니다. `detect.ts`는 프로세스를 띄우지 않고 `PATH`와 폴더 존재만 봅니다 — 메뉴 하나 그리려고 `PATH`의 미지 바이너리를 실행할 이유가 없습니다.
- **"둘 다"는 Claude Code가 실패해도 Desktop을 계속 실행합니다.** 두 등록은 독립이고, 절반만 끝난 상태보다 둘 다 시도하고 결과를 요약하는 편이 낫습니다. 종료 코드는 둘 다 성공했을 때만 0입니다.
- **`claude-desktop` 경로에서는 prompter를 건드리지 않습니다.** Desktop에는 scope 개념이 없습니다. `runInstall`이 desktop 분기를 먼저 처리하고 그 안에서 반환하는 구조가 이것을 보장하며, 테스트가 prompter 출력이 빈 문자열임을 단언합니다.
- **기본값이 있는 질문만 목록으로 물어봅니다.** 클라이언트 선택과 scope 선택은 `../setup/ask.js`의 `select`로 가고, 기본값이 **없어야 하는** 세 질문(비밀번호·지문 `yes`·승인 폴백)은 `../setup/prompt.js`에 그대로 둡니다. 목록은 항상 한 줄을 미리 강조하므로 D3(사전 선택값 없음)와 양립하지 않습니다.
- **`--name`은 `SERVER_NAME_PATTERN`으로 검증합니다.** 이 값은 Windows 재시도 경로에서 `cmd.exe`에 닿고 Desktop 설정의 키가 되므로, `AliasSchema`와 같은 모양으로 제한합니다. 검증을 느슨하게 만들지 마세요.
- **`cmd /c` 재시도는 이스케이프하지 말고 거부합니다.** libuv는 공백이 있는 인자만 인용하므로 `&` `|` `<` `>` `^` `%` `!` `"`는 `cmd.exe`에 그대로 닿습니다(`--home "C:\R&D\ssh-mcp"`로 두 번째 명령이 실행되는 것이 확인됐습니다). `CMD_METACHARACTERS`에 걸리면 재시도하지 않고 수동 명령을 출력한 뒤 종료 코드 1입니다. `cmd.exe`용 인용을 "제대로" 구현하려는 시도로 이 가드를 대체하지 마세요. 직접 스폰 경로는 argv를 그대로 넘기므로 안전합니다.
- **거부 판정은 `--force` 시퀀스 전체를 한 번에 내립니다.** `runClaude(options, argv, guard)`의 `guard`가 그 통로입니다 — remove argv에는 메타문자가 들어갈 수 없고 add argv에만 `-e SSH_MCP_HOME=...`이 붙으므로, 각 명령을 따로 검사하면 remove만 실행되고 add가 거부되어 **기존 등록이 삭제된 채 아무것도 복구되지 않습니다**(가짜 `claude.cmd`로 재현됨). remove를 호출할 때 add argv를 `guard`로 함께 넘기는 것을 빼지 마세요.
- **`commandLine()`은 사람이 붙여넣을 문자열입니다.** 공백이나 메타문자가 든 인자는 `quoteForDisplay()`가 큰따옴표로 감쌉니다 — `-e SSH_MCP_HOME=C:\Program Files\ssh-mcp`를 그냥 이어 붙이면 붙여넣는 순간 두 인자로 쪼개집니다. 이 문자열은 실행되지 않으므로 완벽한 셸별 인용이 목표가 아니라 PowerShell·cmd 양쪽에서 한 인자로 붙으면 충분합니다.
- **remove의 실패 사유를 구분합니다.** 스폰 자체가 실패한 경우(`error !== undefined`)는 아무 말도 하지 않습니다 — 뒤따르는 add가 같은 실패를 만나 전체 진단을 출력하므로, 여기서 말하면 진짜 원인 앞에 잡음이 붙습니다. "등록된 적 없음"(`status !== 0`)일 때만 건너뛴다는 한 줄을 남깁니다.
- **`-s <scope>`는 기본값일 때도 항상 넘깁니다.** `--dry-run`이 출력하는 줄이 사람이 그대로 붙여넣을 수 있는 명령이어야 하고, 로그를 읽는 사람이 암묵적 기본값을 확인할 방법이 없기 때문입니다.
- **새 `ERROR_CODES`를 만들지 마세요.** 그 코드들은 MCP 도구 응답을 설명하는 것이고, CLI에는 종료 코드와 메시지가 있습니다.
- **`claude`를 못 찾았을 때 조용히 끝내지 마세요.** `ENOENT`면 win32에서 `cmd /c claude ...`로 한 번 재시도하고(구버전 `claude.cmd` 대비), 그래도 실패하면 사람이 **그대로 붙여넣을 수 있는 명령 한 줄**을 출력해야 합니다.

## Testing

| Suite                               | 대상                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/installCommand.test.ts` | 인자 파싱·플랫폼별 명령 형태·claude-code argv와 실패 경로·클라이언트/scope 선택 분기·Desktop 병합/거부/백업·스니펫 고정 |
| `tests/unit/setupPrompt.test.ts`    | `promptChoice`의 D3 동작(기본값 없음, 빈 입력 재질문, 시도 예산) 불변                                                   |

```bash
npm run test:unit
```

플랫폼은 `deps.platform`으로 주입하므로 한 대의 기계에서 win32 분기와 그 외 분기를 모두 검증합니다. Desktop 테스트는 `fs.mkdtempSync`로 만든 임시 디렉터리와 `--config`를 쓰며 실제 사용자 설정에는 절대 접근하지 않습니다. prompter는 `deps.prompter`로, 질문은 `deps.ask`(스크립트된 `Asker`)와 `deps.canAsk`로 주입하며 기본값은 모두 **비대화형**(비-TTY 프롬프터, `canAsk: false`)입니다 — 그래야 어떤 테스트도 실제 stdin이나 터미널에 닿지 않고, 질문은 그것을 요구한 테스트에서만 나타납니다. `canAsk`는 `isTTY`와 따로 줄 수 있어서, stdin은 터미널인데 목록을 그릴 수 없는 경우(리다이렉트된 stderr, `TERM=dumb`)도 터미널 없이 검증합니다.

## Dependencies

### Internal

`../config/registration.js`, `../internal/util.js`, `../setup/prompt.js`(`PromptAbortedError`), `../setup/ask.js`(클라이언트·scope 질문)

### External

Node `node:child_process`(`spawnSync`)·`node:crypto`·`node:fs`·`node:os`·`node:path`. 런타임 의존성은 늘리지 않습니다.

<!-- MANUAL: -->
