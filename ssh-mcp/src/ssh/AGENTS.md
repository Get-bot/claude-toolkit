<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 | Updated: 2026-09-14 -->

# ssh

## Purpose

SSH/SFTP 전송 계층입니다. 호스트 alias별로 ssh2 `Client` 하나를 풀링해 재사용하고, 호스트 키 지문을 키 교환 단계에서 검증하며, 일회성 명령 실행(`exec.ts`)과 상태가 유지되는 셸 세션(`session.ts`), 파일 전송(`sftp.ts`)을 제공합니다. 출력은 스트리밍 누산기(`excerpt.ts`)가 받아 메모리 상한 안에서 머리/꼬리 발췌로 만들고, 이 계층의 모든 실패는 `CodedError`로 던져져 상위 래퍼가 §5.3 오류 코드와 감사 레코드로 번역합니다. PTY는 절대 할당하지 않습니다.

## Key Files

| File             | Description                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error.ts`       | `SshOperationError extends CodedError` — 이 계층의 오류 운반자. 상위 래퍼는 `CodedError`만 보면 되고 ssh2의 메시지를 문자열 매칭하지 않습니다.                                                        |
| `fingerprint.ts` | `sha256Fingerprint(blob)`가 `ssh-keygen -lf`와 동일한 `SHA256:` 표기를 만듭니다. `parseAuthorizedKeyLine()`, `publicKeyBlobFromOpenSsh()`, `fingerprintsMatch()`.                                     |
| `pool.ts`        | alias당 `Client` 1개. `getConnection(host, privateKey)`, `closeConnection()`, `closeAll()`, `configurePool()`. 유휴 10분 후 종료, 핸드셰이크 예산 15초. `hostVerifier`에서 지문 핀을 강제합니다.      |
| `exec.ts`        | `execOnce()` — `{ pty: false }`로 채널을 열고 stdin을 즉시 닫습니다. `hasTrailingBackground()`로 후행 `&`를 감지합니다.                                                                               |
| `session.ts`     | 상태 유지 셸 세션. `openSession()`, `runInSession()`, `closeSession()`, `lookupSession()`, `resetSessions()`. 마커 프레이밍(`deriveMarker`, `buildCommandFrame`, `createMarkerScanner`)이 핵심입니다. |
| `shellDetect.ts` | 원격 셸 감지와 프리앰블. `SHELL_PROBE_COMMAND`, `classifyShellProbe()`, `buildCapabilityProbe()`/`parseCapabilityProbe()`, `SHELL_PREAMBLE`, `unsupportedShellVerdict()`.                             |
| `excerpt.ts`     | 출력 발췌 누산기. `createExcerptAccumulator()`, `excerpt()`, `computeBudgets()`, `omissionMarkerLine()`. 비-UTF-8 스트림은 base64 바이트 슬라이스 경로를 탑니다.                                      |
| `sftp.ts`        | `upload()` / `download()`. `fastPut`/`fastGet` 기반. `assertNotSymlink()`로 로컬 심볼릭 링크 거부(F16), `MAX_DOWNLOAD_BYTES = 256 MiB`, 실측 `overwritten` 반환.                                      |

## Data flow

- **명령 1회 실행**: `tools/exec.ts` → `pool.getConnection()`(핸드셰이크 시 지문 검증) → `exec.execOnce()` → stdout/stderr 각각 `createExcerptAccumulator()`에 스트리밍 → `CommandOutput` 반환. 실패는 `SshOperationError`.
- **세션 열기**: `pool.getConnection()` → pty 없는 `shell` 채널 → `SHELL_PROBE_COMMAND`로 셸 감지(`classifyShellProbe`) → POSIX 계열이면 `buildCapabilityProbe()`로 base64 플래그(`-d`/`-D`) 확인 → `SHELL_PREAMBLE` 전송 → `session_id` 반환. 비-POSIX면 `unsupportedShellVerdict()`로 조기 거부.
- **세션 내 실행**: 명령을 base64로 감싼 고정 프레임을 보내고, 프레임마다 새로 회전시킨 마커(`deriveMarker(secret, counter)`)가 stdout·stderr 양쪽에 나타나는 것으로 완료를 감지합니다(`createMarkerScanner`). 조용해지는 시간(quiet period)으로 판정하지 않습니다.
- **파일 전송**: `pool.getConnection()` → `sftp()` → `fastPut`/`fastGet` → `TransferResult`.
- 모든 경로의 오류는 `error.ts`의 `CodedError`로 수렴하고 `tools/wrap.ts`가 응답 봉투와 감사 줄로 바꿉니다.

## Invariants & gotchas for AI agents

- **PTY를 할당하지 마세요.** PTY는 stdout과 stderr를 합쳐 AC10을 깨뜨리고 ANSI 이스케이프로 세션 마커 프로토콜을 망가뜨립니다. `{ pty: false }`는 협상 가능한 설정이 아닙니다.
- **stdin은 채널이 열리자마자 닫습니다.** `stream.end()`가 EOF를 보내기 때문에 인자 없는 `cat`이 즉시 끝나고, `sudo`가 비밀번호 프롬프트에서 블로킹하는 대신 "no tty present"로 빠르게 실패합니다.
- **세션 프레임의 모든 토큰이 의미를 갖습니다.** `eval`(현재 셸에서 실행 → `cd`/`export`/`source`가 유지되고 문법 오류가 셸을 죽이지 않음), `</dev/null`(stdin을 읽는 명령이 다음 프레임 텍스트를 먹어 세션이 조용히 desync되는 것을 방지 — F4/C3), base64 전송(줄바꿈·따옴표·`#`·here-doc이 전송 줄을 깨지 못하게), 마커를 **양쪽 스트림에** 앞뒤 줄바꿈과 함께 출력. 하나라도 빼면 알려진 실패 모드가 되살아납니다.
- **마커는 `\n<MARKER>(\d{1,3})\n`으로 매칭합니다.** 줄바꿈을 요구하는 것이 줄 중간에 마커를 출력하는 명령의 위조를 막고(F12/C4), 명령마다 마커를 회전시키는 것이 마커를 **학습한** 명령의 위조를 막습니다(F2).
- **`hostHash`는 의도적으로 설정하지 않습니다.** 설정하면 hex 문자열이 와서 사용자가 터미널에서 보는 `SHA256:` 표기와 맞지 않습니다. 콜백이 raw 키 blob을 받아야 `sha256Fingerprint()`가 양쪽에서 동일하게 동작합니다.
- **지문 불일치 시 `verify(false)`를 호출합니다.** 이것이 키 교환을 실패시키므로 인증도 채널 개설도 일어나지 않습니다 — "지문 불일치에서는 어떤 명령도 전송되지 않는다"(AC9.2)가 제어 흐름이 아니라 프로토콜의 성질이 되는 이유입니다. 이 검증을 나중 단계로 옮기지 마세요.
- **`SHELL_PREAMBLE`에 `pipefail`을 넣지 마세요.** `set`은 POSIX 특수 빌트인이라 인자 오류가 비대화형 셸을 **종료**시킵니다. dash와 busybox ash는 `set +o pipefail`을 거부하므로 세션이 즉사합니다. `2>/dev/null`이나 `|| true`로도 막을 수 없습니다(N4/N5, AC14.4).
- **셸 지원 경계는 POSIX 계열 4종**(`bash`/`zsh`/`dash`/`ash`)이고 나머지(`fish`/`cmd`/`powershell`/`unknown`)는 조기 거부합니다(ADR-009). `cmd`/PowerShell이 감지되면 분류 커버리지가 `reduced`로 표시됩니다.
- **발췌 카운터는 버려진 데이터까지 셉니다.** `total_lines`/`total_bytes`는 흘려보내는 도중에 누적되므로 `omitted_lines`가 실측값입니다(AC12.3). `head_bytes`/`tail_bytes`는 줄바꿈 트리밍과 줄당 8 KiB 컷 **이후** 값이고 마커 텍스트를 제외하므로 `omitted_bytes = total - head - tail`이 정확히 성립합니다.
- **발췌 메모리는 상한이 있습니다.** 양쪽이 `HARD_CEILING / 2`로 클램프되어 스트림 길이와 무관하게 방향당 약 `cap + 320 KiB`입니다. 버퍼가 보고 예산보다 큰 것은 `cap` 이하 스트림을 바이트 단위로 그대로 돌려주기 위한 의도된 설계입니다.
- **비-UTF-8 스트림은 줄 개념이 없습니다.** 모든 줄 수 필드가 `null`, 텍스트는 base64, 생략 마커 줄은 삽입하지 않습니다(AC10.2, AC12.9).
- **재핀(re-pin)된 호스트는 즉시 반영돼야 합니다**(F14). 풀에 캐시된 연결이라도 검증 당시 지문(`PoolConnection`에 기록됨)이 현재 핀과 다르면 재사용하지 않고 다시 연결합니다 — 그러지 않으면 운영자가 방금 신뢰를 거둔 바로 그 서버와 유휴 타임아웃까지 계속 대화하게 됩니다.
- **세션이 열릴 때 `touchConnection(alias)`로 풀 유휴 타이머를 리셋해야 합니다.** 빠뜨리면 활성 세션 아래의 연결이 회수됩니다.
- **세션 슬롯은 핸드셰이크 성공 이후에만 소비됩니다.** 거부된 셸이 5개 중 하나를 잠그면 잘못된 시도 5번으로 그 호스트를 영구히 못 쓰게 만들 수 있습니다(AC15.3).
- **원격 `/dev/null`을 읽을 수 없으면 stdin 가드가 비활성화되고 경고 로그가 남습니다.** 조용히 넘어가지 않습니다.
- **세션 타임아웃 정리는 fail-closed입니다.** `pkill -TERM -P <shellPid>` → `killGraceMs` 대기 → `pkill -KILL -P`. `pkill`이 없으면(종료 코드 127) 미지원으로 간주하고, 정리에 실패하면 세션 자체를 파괴합니다 — 정리되지 않은 자식이 남은 세션을 계속 쓰게 두지 않습니다.
- **`download`는 기본적으로 덮어쓰지 않고, 양쪽 다 부모 디렉터리를 만들지 않습니다.** 조용한 덮어쓰기는 복구 불가능하고, 경로 오타가 원격에 새 트리를 흩뿌리는 것을 막기 위한 의도된 거부입니다.
- **로컬 심볼릭 링크는 `lstat`으로 감지해 무조건 거부합니다**(F16). `statSync`/`existsSync`는 링크를 따라가므로 덮어쓰기 가드를 우회할 수 있습니다 — 이 검사를 `existsSync`로 "단순화"하면 보호가 사라집니다. 다운로드 상한은 전송 전에 SFTP `stat`으로 미리 검사합니다.
- **타임아웃 시 `signal('TERM')` 후 채널을 닫습니다.** 실제 정리는 OpenSSH가 채널 소멸 시 프로세스 그룹에 보내는 SIGHUP이 합니다. `nohup`/`setsid`로 분리된 프로세스는 살아남으며 README가 이를 명시합니다.

## Testing

| Suite                                                                                                                     | 대상                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `tests/unit/excerpt.test.ts`                                                                                              | 발췌 예산·카운터·마커 줄·base64 경로       |
| `tests/unit/markerFraming.test.ts`                                                                                        | 세션 프레임과 마커 스캐너                  |
| `tests/unit/shellDetect.test.ts`                                                                                          | 셸 감지와 capability 프로브                |
| `tests/unit/fingerprint.test.ts`                                                                                          | 지문 계산과 `authorized_keys` 파싱         |
| `tests/integration/exec.test.ts`, `session.test.ts`, `sftp.test.ts`, `transfer.test.ts`, `auth.test.ts`, `output.test.ts` | 인프로세스 ssh2 서버 픽스처 상대의 전 경로 |

```bash
npm run test:unit
npm run test:integration    # ENDPOINT=fixture 기본
```

`tests/integration/session.test.ts`는 CI의 `shell-matrix` 잡에서 `SHELL_UNDER_TEST`를 바꿔가며 bash/zsh/dash/busybox ash로 반복 실행됩니다(AC14.3, AC14.4).

## Dependencies

### Internal

- `error.ts` → `../errors.js`
- `pool.ts` → `../config/schema.js`, `../errors.js`, `../log.js`, `./error.js`, `./fingerprint.js`
- `exec.ts` → `../errors.js`, `./error.js`, `./excerpt.js`
- `session.ts` → `../config/state.js`, `../errors.js`, `../log.js`, `./error.js`, `./excerpt.js`, `./exec.js`, `./pool.js`, `./shellDetect.js`
- `sftp.ts` → `../errors.js`, `./error.js`
- `excerpt.ts`, `shellDetect.ts` → 없음 (의존성 0, 그래서 순수 단위 테스트가 가능합니다)

### External

- `ssh2` (`Client`, `ConnectConfig`, `SFTPWrapper`, `utils.parseKey`)
- Node 빌트인: `node:crypto`, `node:fs`, `node:path`

<!-- MANUAL: -->
