<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# ssh-mcp

## Purpose

Claude가 원격 서버에 SSH로 접속해 명령을 실행하고(`exec`), 파일을 주고받고(`upload`/`download`), 상태가 유지되는 셸 세션을 쓸 수 있게(`open_session`/`run_in_session`/`close_session`) 하는 stdio 전용 MCP 서버입니다. 네이티브 `ssh`/`scp` 바이너리에 의존하지 않고 순수 JavaScript SSH 클라이언트(`ssh2`)를 쓰므로 OpenSSH가 없는 Windows에서도 동작합니다. 이 프로젝트의 핵심 가치는 편의가 아니라 **안전성**입니다 — 모든 명령은 정규식 기반으로 safe/privileged/destructive로 분류되고, 호스트별 승인 모드와 승인 폴백을 거쳐야 실행되며, 성공·실패·거부와 무관하게 감사 로그에 한 줄씩 남습니다. 배포 단위는 npm 패키지 `@get-bot/ssh-mcp`이며 `npx -y @get-bot/ssh-mcp`로 바로 실행됩니다.

## Key Files

| File                   | Description                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`         | 패키지 메타데이터, `bin: ssh-mcp → dist/index.js`, 전체 npm 스크립트. 런타임 의존성은 `@modelcontextprotocol/sdk`·`ssh2`·`zod`와 대화형 프롬프트용 `@inquirer/select`·`@inquirer/input` 다섯입니다. 모두 정확한 버전으로 고정합니다. |
| `tsconfig.json`        | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. `noEmit: true` — 빌드는 tsup이 담당하고 tsc는 타입 검사 전용입니다.                                                                                            |
| `tsup.config.ts`       | ESM 단일 파일 번들(`splitting: false`). `ssh2`/SDK/`zod`는 external, 나머지 동적 import는 인라인해 `dist/index.js` 하나로 실행 가능하게 만듭니다.                                                                                    |
| `vitest.config.ts`     | unit + integration 레그. `tests/e2e`는 의도적으로 제외됩니다. 타임아웃 30초.                                                                                                                                                         |
| `vitest.e2e.config.ts` | e2e 전용. 타임아웃 120초, `fileParallelism: false`, `bail: 1`(패킹/스폰은 동시 실행이 안전하지 않고 타임아웃 예산이 비싸기 때문).                                                                                                    |
| `eslint.config.js`     | 정확성·안전 규칙 전담(포맷은 Prettier). `no-console`이 기본 error이고 `src/log.ts`·CLI·테스트·`scripts/`에만 예외가 허용됩니다.                                                                                                      |
| `.prettierrc.json`     | `printWidth: 100`, single quote, `endOfLine: lf`.                                                                                                                                                                                    |
| `README.md`            | 한국어 사용자 문서 전문(도구 레퍼런스, 승인 모드 표, `hosts.json` 스키마, 보안 모델, 알려진 한계, ADR 목록). 동작을 바꿀 때 같이 갱신해야 합니다.                                                                                    |
| `.husky/pre-commit`    | `cd ssh-mcp && npx lint-staged` — 스테이징된 파일에 Prettier + ESLint `--fix`를 적용합니다.                                                                                                                                          |

## Subdirectories

| Directory  | Purpose                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `src/`     | 서버 구현 전체 (see `src/AGENTS.md`)                                          |
| `tests/`   | unit / integration / e2e 테스트와 픽스처 (see `tests/AGENTS.md`)              |
| `scripts/` | CI 전용 Node 헬퍼 스크립트 (패키지에 포함되지 않음) (see `scripts/AGENTS.md`) |
| `.husky/`  | Git 훅 (see `.husky/AGENTS.md`)                                               |

## For AI Agents

### Working In This Directory

- **stdout은 JSON-RPC 채널입니다.** 서버 모드에서 stdout에 무엇이든 쓰면 프로토콜이 깨집니다. 로그는 `src/log.ts`를 통해 stderr로만 나가고, ESLint `no-console` 규칙이 이를 강제합니다.
- 이 저장소는 모노레포 `claude-toolkit`의 하위 디렉터리입니다. npm 명령은 반드시 `ssh-mcp/`에서 실행하고, husky도 상위에서 `ssh-mcp/.husky`를 가리키도록 설정돼 있습니다.
- **런타임 의존성은 네이티브 애드온 없는 순수 JS만, 추가할 때는 근거를 남기세요.** 지킬 수 없는 것은 "의존성 0"이 아니라 "빌드 도구 없이 설치되는 패키지"이고, `scripts/assert-no-native-addons.mjs`가 CI에서 그것을 검증합니다. 지금까지의 근거: `ssh2`(순수 JS SSH), `@modelcontextprotocol/sdk`, `zod`, 그리고 `@inquirer/select`·`@inquirer/input` — 마지막 둘은 직접 만든 방향키 메뉴가 Windows Terminal에서 화면을 망가뜨렸는데 **Windows TTY 렌더링은 우리 테스트로 검증할 방법이 없어** 고칠 때마다 사람 확인에 의존해야 했기 때문입니다(2026-09-14).
- **버전이 갈리는 빌트인은 named import로 가져오지 마세요.** 번들은 한 덩어리 ESM이라 최상위 `import { x } from 'node:y'`는 코드가 한 줄도 돌기 전에 링크됩니다. 그 Node에 `x`가 없으면 `SyntaxError`로 프로세스가 죽고, `--version`도 `doctor`도 서버 모드도 `MIN_NODE_MAJOR` 안내조차도 나올 기회가 없습니다. 실제로 `util.styleText`(Node 20.12 도입)를 그렇게 가져와 Node 18과 20.0~20.11이 전부 깨졌습니다(2026-09-14). 네임스페이스로 받아 호출 시점에 `typeof`로 확인하세요. `scripts/assert-bundle-imports.mjs`가 빌드마다 이것을 검사합니다.
- **동작 변경은 README 변경을 동반합니다.** 도구 설명문, 승인 모드 표, 오류 코드 표, `hosts.json` 스키마는 README가 단일 출처입니다.
- 보안 경계에 손대는 변경(분류 패턴, 승인 게이트, 경로 차단, 감사)은 `README.md`의 "보안 모델"·"알려진 한계" 절과 `.omc/plans/ssh-mcp-plan.md`의 ADR을 먼저 읽고 진행하세요. 대부분은 이미 의도된 트레이드오프입니다.

### Testing Requirements

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm test               # unit + integration
npm run test:unit
npm run test:integration
npm run test:e2e       # npm pack → npx 왕복. 느리고 직렬 실행
npm run test:fp-gate   # 분류기 오탐 게이트
```

커밋 전 최소 기준은 `format:check` + `lint` + `typecheck` + `npm test` 전부 통과입니다.

### Common Patterns

- ESM 전용(`"type": "module"`), Node 20 이상, `NodeNext` 모듈 해석 — 상대 import에는 `.js` 확장자를 붙입니다.
- 타입 전용 import는 `import type`으로 씁니다(`consistent-type-imports` 규칙).
- 입력 검증은 전부 `zod`로 합니다.
- 주석은 "무엇"이 아니라 "왜"를 적습니다 — 기존 파일의 설명 주석들이 설계 근거를 담고 있으니 그 밀도와 어조를 따르세요.

## Dependencies

### External

- `@modelcontextprotocol/sdk` 1.30.0 — MCP 서버/stdio 전송, elicitation
- `ssh2` 1.17.0 — 순수 JS SSH/SFTP 클라이언트
- `zod` 4.6.2 — 스키마 검증
- 개발: `tsup`, `vitest` 5, `typescript` 5.9, `eslint` 10 + `typescript-eslint` 8, `prettier` 3, `husky` + `lint-staged`

<!-- MANUAL: 이 줄 아래에 수동으로 추가한 메모는 재생성 시에도 보존됩니다 -->
