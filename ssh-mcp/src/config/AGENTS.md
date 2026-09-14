<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# config

## Purpose

ssh-mcp의 디스크 상태를 담당합니다 — 상태 디렉터리의 경로 계산과 권한 하드닝(`paths.ts`), 호스트 레지스트리의 zod 스키마(`schema.ts`), 그 레지스트리의 원자적 로드/저장(`store.ts`), 그리고 관측값 캐시인 `state.json`(`state.ts`)입니다. 핵심 설계 원칙은 **깨진 레지스트리가 서버 기동을 막아서는 안 된다**는 것입니다: 로드 실패는 throw 되지 않고 데이터로 반환되어, 서버는 정상 기동한 뒤 모든 도구 호출에 `config_invalid`로 답합니다.

## Key Files

| File        | Description                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`  | `homePath()`, `hostsFilePath()`, `stateFilePath()`, `auditFilePath()`, `keysDirPath()`, `privateKeyPath()`, `ensureHome()`, `ensureKeysDir()`, `applyStateFileMode()`. 모드 상수 `HOME_DIR_MODE=0o700`, `STATE_FILE_MODE=0o600`, `PUBLIC_KEY_FILE_MODE=0o644`. |
| `schema.ts` | `HostsFileSchema` / `HostEntrySchema` / `HostKeySchema` / `PatternOverridesSchema`와 모든 기본값·한계 상수. 공용 어휘 `APPROVAL_MODES`, `APPROVAL_FALLBACKS`, `AUDIT_MODES`, `COMMAND_GRADES`도 여기서 나옵니다.                                               |
| `store.ts`  | `load()` → `ConfigLoadResult`(`ConfigValid \| ConfigInvalid`), `save()`, `getHost()`, `resolveApprovalFallback()`.                                                                                                                                             |
| `state.ts`  | `loadState()`, `saveState()`, `recordClient()`, `recordObservedShell()`, `emptyState()`. `STATE_SCHEMA_VERSION = 1`.                                                                                                                                           |

## Config model

**위치.** `SSH_MCP_HOME` 환경변수가 있으면 그 경로(절대 경로로 resolve), 없으면 `os.homedir()/.ssh-mcp`입니다. Windows에서는 `%USERPROFILE%\.ssh-mcp`가 됩니다.

```
~/.ssh-mcp/
  hosts.json        # 호스트 레지스트리 (0600)
  state.json        # 관측값 캐시 (0600)
  audit.jsonl       # 감사 로그 (0600)
  keys/             # 생성된 키 쌍 (개인키 0600, 공개키 0644)
```

**`hosts.json`** — `{ schemaVersion: 1, hosts: { <alias>: HostEntry } }`. alias는 `/^[a-z0-9][a-z0-9._-]{0,63}$/i`.

| Field               | 기본값            | 비고                                                                               |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `hostname`          | (필수)            | 1~253자                                                                            |
| `port`              | `22`              | 1~65535                                                                            |
| `user`              | (필수)            | 공백과 `:` 불가                                                                    |
| `privateKeyPath`    | (필수)            |                                                                                    |
| `hostKey`           | (필수)            | `{ algo, sha256 }`, `sha256`은 `SHA256:` + base64 43자                             |
| `approvalMode`      | `ask-destructive` | `auto` / `ask-destructive` / `ask-all` / `deny`                                    |
| `approvalFallback`  | **없음(의도적)**  | `token` / `fail-closed`. 누락 시 `load()`가 경고 1회와 함께 `fail-closed`로 정규화 |
| `auditMode`         | `full`            | `full` / `metadata-only`                                                           |
| `patternOverrides`  | 빈 그룹           | `destructive`/`privileged` 각각 `add`/`remove`. `allow`는 스키마에 없음            |
| `defaultTimeoutSec` | `60`              | 1~3600                                                                             |
| `maxOutputBytes`    | `1048576`         | 1024~4194304                                                                       |
| `label`             | (선택)            | 최대 128자                                                                         |
| `createdAt`         | (필수)            | offset 포함 ISO datetime                                                           |

**`state.json`** — 설정이 아니라 **관측값**입니다. 마지막으로 접속한 클라이언트(`lastClient`)와 호스트별로 관측된 셸(`observedShells`)을 기록하며, `doctor`가 이를 읽습니다(§5.11 항목 12·13).

## Invariants & gotchas for AI agents

- **모든 스키마 객체가 `.strict()`입니다.** 오타 난 키가 조용히 안전 설정을 약화시키는 일이 없어야 하기 때문입니다. 특히 `patternOverrides.allow`는 v1 스키마에 **없으므로** 예전 초안에서 남은 allow 목록은 무시되는 대신 요란하게 거부됩니다(F8/C10).
- **`approvalFallback`에 zod 기본값을 주지 마세요.** 의도적으로 optional이며 기본값이 없습니다. `setup`은 항상 이 값을 씁니다(D1). 손편집으로 빠진 항목은 `store.load()`가 경고 1회와 함께 `fail-closed`로 정규화합니다(D2). 여기서 required로 만들면 그런 파일이 `config_invalid`가 되어 모든 도구가 막히는데, 그것이 정확히 D2가 배제한 결과입니다.
- **로드 실패는 throw가 아니라 데이터입니다.** `load()`는 읽기 실패·JSON 파싱 실패·스키마 검증 실패를 모두 `ConfigInvalid`로 반환하고 서버는 기동에 성공합니다(원칙 2). **반면 `save()`는 쓰기 전에 항상 재검증하고 실패 시 throw 합니다** — 무효한 설정을 디스크에 남기지 않기 위해 두 방향의 엄격함이 반대입니다.
- **패턴 오버라이드는 ReDoS 가드를 거칩니다.** `patternOverrides.*.add/remove`의 각 문자열은 `MAX_PATTERN_LENGTH`(512) 길이 제한을 받고, `new RegExp(...)`으로 컴파일 가능한지 `refine`으로 검증됩니다.
- **경로 헬퍼는 상수가 아니라 함수입니다.** 홈 디렉터리를 호출할 때마다 환경에서 다시 해석하므로 테스트의 `SSH_MCP_HOME` 오버라이드가 모듈 재로드 없이 적용됩니다. 이를 상수로 캐시하지 마세요.
- **Windows에서는 디렉터리 생성 시 `icacls`로 하드닝합니다.** `fs.chmod`는 NTFS ACL에 매핑되지 않아, 하드닝하지 않으면 `BUILTIN\Administrators`까지 접근 가능한 디렉터리에 개인키와 명령 문자열이 담긴 `audit.jsonl`이 놓입니다(F12). 새로 만든 디렉터리만 대상이며 프로세스당 `hardenedDirs` 셋으로 중복 실행을 막습니다. 실패는 throw 하고, 실패해도 진행해야 하는 호출자(감사 기록기)가 직접 삼킵니다.
- **`paths.ts`가 `../setup/winacl.js`를 import 하는 것은 순환이 아닙니다.** `winacl.ts`는 Node 빌트인 외에 아무것도 의존하지 않습니다. ACL은 파일시스템 관심사이므로 setup 흐름이 아니라 여기에 있는 것이 맞습니다.
- **`schemaVersion`은 `z.literal(1)`이고 마이그레이션이 없습니다.** `load()`는 raw JSON에서 `schemaVersion`을 먼저 꺼내 `CONFIG_SCHEMA_VERSION`(1)보다 크면 `unsupported_schema_version`으로 즉시 거부합니다 — 파일을 손보는 대신 ssh-mcp를 올리라는 뜻입니다.
- **`state.json`은 캐시이므로 손상 시 기본값으로 대체합니다.** `config_invalid`로 격상시키지 마세요 — 관측값이 없다고 도구가 막혀선 안 됩니다.
- 쓰기는 임시 파일(`hostsTmpFilePath()` / `stateTmpFilePath()`) 경유 후 rename하고 `applyStateFileMode()`로 `0600`을 적용합니다. 새 상태 파일을 추가할 때 같은 절차를 따르세요.

## Testing

| Suite                                       | 대상                                  |
| ------------------------------------------- | ------------------------------------- |
| `tests/unit/schema.test.ts`                 | 스키마 검증·기본값·strict 거부        |
| `tests/unit/store.test.ts`                  | 로드/저장, 정규화, 잘못된 파일 처리   |
| `tests/integration/startupWarnings.test.ts` | 폴백 정규화 경고와 auto 모드 경고     |
| `tests/fixtures/tmpHome.ts`                 | `SSH_MCP_HOME`을 임시 디렉터리로 격리 |

```bash
npm run test:unit
```

## Dependencies

### Internal

- `paths.ts` → `../setup/winacl.js`
- `state.ts`, `store.ts` → `../internal/util.js`, `../log.js`, `./paths.js` (+ `store.ts`는 `./schema.js`)
- `schema.ts` → 없음

### External

`zod`, Node `node:fs`·`node:os`·`node:path`.

<!-- MANUAL: -->
