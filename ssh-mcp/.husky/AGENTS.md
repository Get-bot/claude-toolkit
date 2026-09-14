<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# .husky

## Purpose

Git 훅 디렉터리입니다. 커밋 시점에 스테이징된 파일만 포맷·린트해, 포맷 위반이나 기초적인 린트 오류가 저장소에 들어오지 않게 막습니다.

## Key Files

| File         | Description                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `pre-commit` | `cd ssh-mcp && npx lint-staged` — 모노레포 루트에서 훅이 실행되므로 먼저 패키지 디렉터리로 이동합니다. |
| `_/`         | husky가 생성·관리하는 내부 스크립트. 직접 수정하지 마세요.                                             |

## For AI Agents

### Working In This Directory

- 훅 설치는 `package.json`의 `prepare` 스크립트(`cd .. && husky ssh-mcp/.husky`)가 담당합니다. 이 저장소가 모노레포의 하위 디렉터리이기 때문에 상위 디렉터리에서 실행하며 훅 경로를 명시합니다.
- 실제로 실행되는 작업 목록은 `package.json`의 `lint-staged` 블록에 있습니다: `*.{ts,js,mjs,cjs}`는 `prettier --write` + `eslint --fix`, `*.{json,md,yml,yaml}`은 `prettier --write`.
- 훅에서 무거운 작업(전체 테스트, 빌드)을 돌리지 마세요. 그것은 CI의 역할이며, 훅은 빠르게 유지합니다.
- 훅 파일에 실행 권한이 필요합니다. Windows에서 새로 추가할 때 `git update-index --chmod=+x`를 확인하세요.

### Testing Requirements

`git commit`을 실제로 한 번 수행하거나 `npx lint-staged`를 직접 실행해 확인합니다.

## Dependencies

### External

- `husky` 9.1.7, `lint-staged` 16.4.0 (둘 다 devDependency)

<!-- MANUAL: -->
