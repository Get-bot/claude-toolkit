<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# scripts

## Purpose

CI와 빌드에서 쓰는 Node ESM 헬퍼 스크립트들입니다. 셸로 쓰면 Windows(pwsh)와 Linux(bash) 사이에서 동작이 갈리는 작업 — 타르볼 경로 해석, 네이티브 애드온 부재 검증, 번들 import 검사, Windows `npx` 스폰 동작 확인 — 을 양쪽 러너에서 동일하게 수행하기 위해 Node로 작성됐습니다. `package.json`의 `files`가 `dist`/`README.md`/`LICENSE`뿐이므로 **이 디렉터리는 배포 패키지에 포함되지 않습니다.**

## Key Files

| File                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-tarball-path.mjs`    | `npm pack`이 만든 `.tgz`의 절대 경로를 찾아 `GITHUB_ENV`에 `SSH_MCP_TGZ=`로 기록합니다. 셸 글로빙 대신 `fs.readdirSync`를 쓰는 이유는 git-bash와 pwsh가 글로브·`pwd` 해석에서 갈리기 때문입니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `assert-no-native-addons.mjs` | `npm install --omit=optional` 후 네이티브 애드온이 정말 하나도 없는지 두 가지로 검증합니다: (1) `node_modules` 전체에 `.node` 파일이 없을 것, (2) 설치된 `ssh2`가 선언한 `optionalDependencies`가 하나도 설치되지 않았을 것. 목록은 하드코딩이 아니라 설치된 ssh2에서 읽으며, 목록이 비면 검사가 무의미해지므로 그것도 실패로 처리합니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `assert-bundle-imports.mjs`   | `dist/index.js`의 **최상위** import를 두 가지로 검사합니다: (1) 빌트인에서 가져오는 named import를 허용 목록과 대조 — named import는 코드 실행 전에 링크되므로, 그 Node에 없는 이름 하나가 CLI 전체를 `SyntaxError`로 죽입니다, `MIN_NODE_MAJOR` 안내까지 포함해서요. (2) `@inquirer/`로 시작하는 CLI 전용 패키지의 정적 import 여부 — 정적 import는 항상 평가되므로 있으면 MCP 서버 기동만으로도 CLI 코드를 로드하게 됩니다. 허용 목록의 이름이 현재 Node에 실제로 있는지도 함께 확인해 목록 자체의 오타·삭제를 잡습니다. 번들 경로는 cwd가 아니라 이 스크립트 자신의 위치 기준으로 찾으므로 모노레포 루트에서 돌려도 동작합니다. `node scripts/assert-bundle-imports.mjs --self-test`는 이 두 회귀를 합성 번들에 주입해 실제로 종료 코드 1이 나오는지 자체 검증합니다. `npm run build`가 tsup 뒤에 자동으로 실행합니다. |
| `windows-spawn-check.mjs`     | Windows에서 `spawn('npx', …, { shell: false })`가 ENOENT로 실패하고 `cmd /c npx …`는 `initialize` 응답을 반환함을 증명합니다. README의 "`cmd /c npx`로 감싸라" 안내를 매 PR마다 실제 러너로 검증하는 증거입니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## For AI Agents

### Working In This Directory

- **이 스크립트들은 실패해야 할 때 반드시 비영 종료 코드로 실패해야 합니다.** 조용히 통과하면 CI가 아무것도 증명하지 못합니다.
- `assert-no-native-addons.mjs`의 두 검사는 서로를 대체하지 않습니다. 빌드가 실패한 네이티브 패키지는 `.node`를 남기지 않으므로 검사 1만으로는 통과해 버립니다 — 둘 중 하나를 지우지 마세요.
- **`assert-bundle-imports.mjs`의 허용 목록에 이름을 추가할 때는 Node 문서의 "Added in:"을 먼저 확인하세요.** 기준은 `MIN_NODE_MAJOR`(현재 20)의 최초 릴리스인 20.0.0입니다. 그 뒤에 들어온 API라면 목록에 넣을 게 아니라 호출부를 네임스페이스 접근으로 바꿔야 합니다. 단, 이 확인은 **지금 실행 중인 Node**에 이름이 있는지만 보므로 "20.0.0에 있었다"는 증명이 아닙니다 — 문서를 직접 확인하는 것을 대신하지 않습니다.
- **CI의 `node: "20"`은 20.x 최신으로 해석되므로 이 결함을 잡지 못합니다.** `util.styleText`는 20.12에 들어왔고 러너의 20.x는 그보다 새로워서 번들 스모크가 통과했습니다. 구버전 구간을 지키는 것은 이 정적 검사이지 매트릭스가 아닙니다.
- **`assert-bundle-imports.mjs`의 `@inquirer/` 정적 import 검사는 한 차례 무력화된 적이 있습니다.** 빌트인이 아닌 지정자를 전부 건너뛰는 `if (builtin === null) continue`가 이 검사보다 먼저 있어서, 사본에 `import select from '@inquirer/select'`를 넣어도 종료 0으로 통과했습니다. 이 검사를 다시 손볼 때는 `--self-test`가 통과하는지부터 확인하세요.
- `windows-spawn-check.mjs`의 `[1/2]` 레그가 `cmd /c` 없이 스폰하는 것은 **의도된 것**입니다. 그 실패를 보여주는 것이 이 스크립트의 목적입니다.
- argv는 `['-y', '--package=<tgz>', 'ssh-mcp']` 형태를 씁니다. 맨 `npx -y <tgz>`를 쓰면 안 되는 이유는 `tests/fixtures/stdioServer.ts`의 `npxLaunch` 주석에 있습니다 — 같은 argv 모양을 유지하세요.
- 이 디렉터리는 `.ts`가 아니라 `.mjs`입니다. ESLint 설정에 `scripts/**/*.mjs` 전용 블록이 있어 Node 전역과 `console` 사용이 허용됩니다.

### Testing Requirements

로컬에서 직접 실행할 수 있지만 `SSH_MCP_TGZ`와 `GITHUB_ENV` 같은 CI 환경변수가 필요합니다. 실제 검증은 CI 잡에서 이루어집니다.

| Script                        | 실행 잡                                            | 스텝 이름                                                        |
| ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `resolve-tarball-path.mjs`    | `no-build-tools`, `package-smoke`, `windows-spawn` | `resolve packed tarball path`                                    |
| `assert-no-native-addons.mjs` | `no-build-tools` (windows-latest)                  | `install tarball with --omit=optional into a fresh consumer dir` |
| `assert-bundle-imports.mjs`   | 모든 잡 (`npm run build`에 포함)                   | `build`                                                          |
| `windows-spawn-check.mjs`     | `windows-spawn` (windows-latest)                   | `assert npx spawn(shell:false) fails, cmd /c npx succeeds`       |

워크플로 파일: `.github/workflows/ssh-mcp-ci.yml` (저장소 루트 기준, 즉 `ssh-mcp/`의 상위).

## Dependencies

### Internal

없음. 스크립트들은 `src/`를 import 하지 않고 설치 결과물과 프로세스만 관찰합니다.

### External

Node 빌트인만 사용합니다: `node:fs`, `node:path`, `node:os`, `node:child_process`, `node:module`, `node:url`.

<!-- MANUAL: -->
