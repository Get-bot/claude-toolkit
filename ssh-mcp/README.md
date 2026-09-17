# ssh-mcp

Claude가 원격 서버에 SSH로 접속해 명령을 실행하고, 파일을 주고받고, 상태가 유지되는 셸 세션을 쓸 수 있게 하는 MCP(Model Context Protocol) 서버입니다.

네이티브 `ssh`/`scp` 바이너리에 의존하지 않는 순수 JavaScript SSH 클라이언트(`ssh2`)를 쓰므로, Windows에 OpenSSH가 설치돼 있지 않아도 동작합니다. 전송 방식은 stdio 하나뿐입니다.

> 이 문서는 한국어로 작성됐습니다. 명령어, 파일명, 코드 식별자는 원문 그대로 영문입니다.

## 목차

- [설치](#설치)
- [help — 명령어 목록](#help--명령어-목록)
- [host add — 호스트 등록](#host-add--호스트-등록)
- [host list — 등록된 호스트 보기](#host-list--등록된-호스트-보기)
- [install — 클라이언트 등록](#install--클라이언트-등록)
- [connect / exec — 터미널에서 직접 쓰기](#connect--exec--터미널에서-직접-쓰기)
- [도구 9개 레퍼런스](#도구-9개-레퍼런스)
- [승인 모드](#승인-모드)
- [hosts.json 스키마](#hostsjson-스키마)
- [Claude Desktop / Claude Code 연결](#claude-desktop--claude-code-연결)
- [Windows](#windows)
- [대화형 프로그램은 지원하지 않습니다](#대화형-프로그램은-지원하지-않습니다)
- [백그라운드(`&`) 작업](#백그라운드-작업)
- [sudo](#sudo)
- [바이너리 출력](#바이너리-출력)
- [format: "json" 구조화 출력](#format-json-구조화-출력)
- [출력 보관과 fetch_output](#출력-보관과-fetch_output)
- [오류 코드](#오류-코드)
- [보안 모델](#보안-모델)
- [알려진 한계](#알려진-한계)
- [감사 로그](#감사-로그)
- [진단 (`ssh-mcp doctor`)](#진단-ssh-mcp-doctor)
- [원격 셸 지원 범위](#원격-셸-지원-범위)
- [설계 결정](#설계-결정)
- [로드맵 / 범위 밖](#로드맵--범위-밖)

## 설치

**Node.js 20.17 이상**이 필요합니다(또는 22.13 이상, 23.5 이상). 서버 자체는 Node 20이면 돌지만 `install`·`host add`의 대화형 질문이 그 버전을 요구합니다.

전역으로 한 번 설치하면 `ssh-mcp`로 바로 실행됩니다. 세 명령이면 끝납니다.

```bash
npm i -g @get-bot/ssh-mcp

# 1. Claude에 등록한다. 어느 클라이언트에, 어느 범위에 등록할지 물어본다.
ssh-mcp install

# 2. 원격 호스트를 등록한다. 주소·사용자명·포트·alias·승인 모드를 하나씩 물어보고,
#    그다음 비밀번호를 한 번 입력받아 키를 심는다. 터미널 필수.
ssh-mcp host add

# 3. 점검한다
ssh-mcp doctor
```

설치하지 않고 쓰려면 `ssh-mcp` 자리에 `npx -y @get-bot/ssh-mcp`를 씁니다. 두 형태는 같은 명령이라 이 문서의 예시는 어느 쪽으로 읽어도 됩니다. 차이는 버전 관리뿐입니다 — 전역 설치는 버전이 고정되어 올릴 때 `npm i -g @get-bot/ssh-mcp@latest`를 직접 치고, npx는 실행할 때마다 최신 배포판을 받습니다.

**전역 설치로 짧아지는 것은 터미널에서 치는 명령뿐입니다.** `install`이 클라이언트에 등록하는 서버 기동 명령은 여전히 `npx -y @get-bot/ssh-mcp`입니다 — Claude가 띄우는 쪽은 바뀌지 않습니다.

인자를 주면 **그 항목은** 묻지 않습니다. 다만 `host add`의 비밀번호 입력, 호스트 키 지문 `yes` 확인, 승인 폴백 선택은 어떤 인자를 줘도 항상 터미널에서 진행합니다. 스크립트나 문서에서는 이렇게 씁니다.

```bash
npx @get-bot/ssh-mcp install claude-code --scope user
npx @get-bot/ssh-mcp install claude-desktop
npx @get-bot/ssh-mcp host add myhost deploy@web01.example.com
```

`install`은 운영체제와 클라이언트에 맞는 등록 형태를 알아서 고릅니다(Windows에서 필요한 `cmd /c` 감싸기 포함). 자세한 옵션은 [install — 클라이언트 등록](#install--클라이언트-등록), 손으로 등록하는 방법은 [Claude Desktop / Claude Code 연결](#claude-desktop--claude-code-연결)을 보세요. 등록 후 Claude Code에서는 `/mcp`에, Claude Desktop에서는 재시작 후 도구 목록에 도구 9개가 보여야 합니다.

**`npx -y @get-bot/ssh-mcp`를 인자 없이 실행하면 stdio MCP 서버로 기동합니다.** 이것은 Claude가 내부적으로 띄우는 명령이라, 터미널에서 직접 치면 `ssh-mcp server ready` 로그 한 줄을 남기고 클라이언트의 요청을 기다리며 조용히 멈춘 것처럼 보입니다. 정상이며 Ctrl+C로 빠져나오면 됩니다. 호스트를 하나도 등록하지 않은 상태에서도 서버는 정상 기동하며, `list_hosts`가 빈 목록을 반환할 뿐입니다.

### 개발

이 저장소를 직접 수정할 때 씁니다(최종 사용자에게는 해당하지 않습니다).

```bash
cd ssh-mcp
npm install
npm run format         # Prettier로 전체 포맷팅
npm run format:check   # 포맷 확인만 (CI가 씀)
npm run lint            # ESLint
npm run typecheck
npm run build
npm test
```

커밋 시 husky + lint-staged로 구성된 pre-commit 훅이 staged 파일을 자동으로 포맷합니다. `ssh-mcp/`가 저장소 루트가 아니라 하위 디렉터리이므로 `prepare` 스크립트는 husky의 서브디렉터리 설치 형태(`cd .. && husky ssh-mcp/.husky`)를 씁니다 — 훅 자체는 저장소 루트의 `.git`에 등록되지만 훅 스크립트는 `ssh-mcp/.husky`에 둡니다. CI나 그 밖의 비대화형 자동화 환경에서는 `npm ci`/`npm install`이 이 훅 설치를 시도하지 않도록 `HUSKY=0` 환경변수를 설정하세요 — `.github/workflows/ssh-mcp-ci.yml`의 모든 잡에 이미 적용되어 있습니다.

## help — 명령어 목록

`ssh-mcp help`, `ssh-mcp --help`, `ssh-mcp -h` 셋 다 명령어 목록을 stdout에 내고 종료 코드 0으로 끝납니다.

```
$ ssh-mcp --help
Usage: ssh-mcp [<command>] [options]
...
```

목록에는 사용할 수 있는 명령(`install`, `host add`, `host list`, `doctor`, `help`)과 인자 없이 실행하면 서버가 뜬다는 사실, 빠른 시작이 들어 있습니다. 명령별 플래그는 각 명령의 usage 한 곳에만 적혀 있고, 이 목록도 이 문서도 복사해 두지 않습니다 — 그래서 위 예시는 첫 줄까지만 보여 줍니다. 실제 목록은 명령을 직접 치면 나옵니다.

`help <command> ...`는 해당 명령의 사용법으로 넘깁니다. `ssh-mcp help doctor`와 `ssh-mcp doctor --help`는 같은 출력이고, 뒤에 붙인 단어도 그대로 넘어가므로 `ssh-mcp help host add`는 `host` 그룹이 아니라 `host add`의 사용법입니다. `help version`과 `help help`는 목록을 냅니다. 없는 명령을 물으면 stderr에 한 줄과 목록을 내고 종료 코드 2입니다.

**인자 없이 실행하면 서버가 뜹니다.** `ssh-mcp`만 치면 도움말이 아니라 stdio MCP 서버가 시작되어 stdin을 기다립니다 — 클라이언트가 이 형태로 실행하기 때문입니다. 터미널에서 뭘 할 수 있는지 보려면 `--help`를 붙이세요.

## host add — 호스트 등록

호스트 관련 명령은 `ssh-mcp host` 그룹 아래에 있습니다. 하위 명령 없이 `ssh-mcp host`만 실행하면 `add`와 `list`를 안내하는 사용법을 stderr에 출력하고 종료 코드 2로 끝냅니다. 반면 `ssh-mcp host --help`는 요청한 출력이므로 같은 사용법을 **stdout**에 내고 종료 코드 0입니다(`host list --help`, `doctor`와 같은 관례).

**`ssh-mcp setup`은 이 명령의 별칭이며 0.4.0에서 제거됩니다.** 0.1.0에서 쓰던 그 명령은 지금도 `host add`와 **바이트 단위로 같은 출력**을 내지만, 실행하면 stderr에 제거 예고 한 줄이 먼저 나옵니다. stdout은 건드리지 않으므로 `ssh-mcp setup ... > out.txt`의 결과는 0.2.x와 같습니다. 새 이름은 무엇을 설정하는지 이름에 드러내기 위한 것입니다.

```bash
npx @get-bot/ssh-mcp host add                       # 하나씩 물어봅니다
npx @get-bot/ssh-mcp host add <alias> <user@host[:port]> \
  [--approval-fallback token|fail-closed] \
  [--approval-mode auto|ask-destructive|ask-all|deny] \
  [--label "사람이 읽을 이름"] \
  [--from-ssh-config <Host>] \
  [--alias <name>] \
  [--port <1-65535>] \
  [--force]
```

**alias로 쓸 수 없는 이름이 있습니다.** `install`·`host`·`doctor`·`setup`·`connect`·`exec`·`help`·`version` — ssh-mcp 자신의 명령 이름 여덟 개는 예약어이며 `host add`가 거부합니다. `ssh-mcp connect`가 명령인지 alias인지 구분할 수 없게 되기 때문입니다. 0.3.0 이전에 등록해 둔 항목은 그대로 동작하지만, `host list` 표에서 `(예약어)` 표시가 붙고 `--json`에는 `reserved_alias: true` 필드가 추가됩니다.

### 위저드 — 인자 없이 실행하기

인자 없이 터미널에서 실행하면 필요한 값을 하나씩 물어봅니다. 순서와 기본값은 이렇습니다.

| 질문        | 기본값(Enter)                        | 검증                                                                                                                     |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 호스트 주소 | 없음(필수)                           | 비어 있거나, 공백·제어 문자가 있거나, 호스트명/IP 형식이 아니면 재질문                                                   |
| 사용자명    | 없음(필수)                           | 비어 있거나, 공백·콜론·제어 문자가 있거나, 64자를 넘으면 재질문                                                          |
| SSH 포트    | `22`                                 | 1~65535 정수가 아니면 재질문                                                                                             |
| (연결 확인) | —                                    | 위 주소로 TCP 연결을 시도합니다. 실패하면 사유를 보여주고 **호스트 주소와 포트를 다시** 묻습니다. 3회 연속 실패하면 중단 |
| alias       | 호스트명의 첫 라벨(IP·중복이면 없음) | alias 형식 위반이나 **이미 등록된 이름**이면 재질문(`--force`를 줬다면 허용)                                             |
| 승인 모드   | `ask-destructive`                    | 방향키로 고르는 목록. 각 모드에 한 줄 설명이 붙습니다                                                                    |
| 라벨        | 없음(Enter로 생략)                   | 제어 문자가 있거나 128자를 넘으면 재질문                                                                                 |

이미 등록된 alias는 **조용히 덮어쓰지 않고** 다시 묻습니다. 호스트 키 지문을 다시 고정하는 것은 `--force`를 직접 붙여야 하는 동작이기 때문입니다. 반대로 `ssh-mcp host add --force`처럼 **`--force`를 이미 준 채로** 위저드에 들어왔다면 그 alias를 받아들이고, 다시 고정한다는 사실을 한 줄로 알립니다.

사용자명과 라벨의 길이 상한은 `hosts.json` 스키마와 같은 값입니다. 위저드에서 먼저 걸러야 하는 이유는, 저장 단계에서야 걸리면 비밀번호·키 생성·원격 `authorized_keys` 설치까지 모두 끝난 뒤이고 **원격에 심은 공개키가 남기** 때문입니다.

질문이 끝나면 **이후 흐름은 인자를 직접 준 것과 완전히 같습니다.** 위저드는 답을 명령행 인자로 바꿔 넣을 뿐이며, 비밀번호 입력·지문 `yes` 확인·승인 폴백 강제 선택은 그대로입니다. `--approval-mode`나 `--label`을 미리 주면 그 질문만 건너뜁니다. 인자를 하나라도 주면(예: alias만) 위저드는 뜨지 않고 지금까지처럼 사용법 오류가 납니다.

Windows에서는 `cmd /c` 로 감쌉니다.

```bat
cmd /c npx @get-bot/ssh-mcp host add myhost deploy@web01.example.com
```

**`setup`은 언제나 TTY를 요구합니다.** 비밀번호를 화면에 보이지 않게 입력받는 단계가 있기 때문이며, 아래 어떤 플래그를 줘도 이 요구는 면제되지 않습니다. `stdin`이 TTY가 아니면 비밀번호 단계에서 즉시 실패하고 `hosts.json`·키 파일 어느 것도 남기지 않습니다. 즉, `setup`을 CI나 스크립트에서 비대화형으로 완주시킬 방법은 없습니다 — 이것은 의도된 제약입니다.

진행 순서:

1. alias(`/^[a-z0-9][a-z0-9._-]{0,63}$/i` 형식)와 `user@host[:port]`를 파싱합니다.
2. **주소에 닿는지 먼저 확인합니다.** 해당 host:port로 TCP 연결을 시도합니다(5초). 실패하면 `connection_failed`와 사람이 읽을 사유("호스트 이름을 찾을 수 없습니다", "포트가 닫혀 있습니다", "응답이 없습니다")를 출력하고 **비밀번호를 묻지도, 키를 만들지도 않은 채** 종료합니다. 이 단계는 TCP 핸드셰이크까지만 하며 호스트 키 지문 확인과 비밀번호 전송은 아래 순서 그대로입니다.
3. 터미널에서 비밀번호를 화면에 표시하지 않고 입력받습니다. 사용 직후 메모리에서 지웁니다.
4. ed25519 키 쌍을 생성합니다(패스프레이즈 없음). 개인키는 `0600`, 공개키는 `0644`로 저장합니다.
5. 비밀번호로 1차 접속해 호스트 키 지문을 계산하고 화면에 표시한 뒤 `yes` 입력을 요구합니다. 거절하면 아무것도 쓰지 않고 종료합니다.
6. 원격 `~/.ssh/authorized_keys`에 공개키를 등록합니다(멱등 — 같은 alias로 다시 실행해도 중복 추가되지 않습니다).
7. 비밀번호 없이 새 개인키만으로 재접속을 검증합니다. **이 검증에 성공했을 때만** 다음 단계로 진행합니다.
8. **승인 폴백을 강제로 묻습니다.** 아래 참고.
9. (Windows만) `icacls`로 키 디렉터리를 하드닝합니다. 소유자 계정과 `NT AUTHORITY\SYSTEM`을 제외한 **모든 principal을 제거**합니다 — 프로필 아래 새로 만든 디렉터리에 흔히 딸려오는 `BUILTIN\Administrators` 항목도 예외 없이 제거 대상입니다. 하드닝 후 ACL을 다시 읽어 두 principal만 남았는지 확인하며, 조금이라도 남아 있으면 생성한 키를 삭제하고 `hosts.json`에 아무것도 기록하지 않은 채 중단합니다.
10. 여기까지 전부 통과했을 때만 `hosts.json`에 항목을 원자적으로 기록합니다.
11. 성공하면 Claude Desktop/Claude Code 등록 스니펫과 [`install`](#install--클라이언트-등록) 자동 등록 안내 한 줄을 stderr에 출력합니다.

### 승인 폴백 — 강제 선택이며 기본값이 없습니다

Claude Desktop은 elicitation(사람에게 되묻는 프로토콜 기능)을 지원하지 않습니다. 그래서 Desktop에 연결된 호스트는 파괴적/관리자 명령을 만나면 전부 "2단계 토큰" 경로를 탑니다. **이 경로에서는 토큰을 모델이 직접 받아 스스로 재호출할 수 있으므로, 서버 혼자서는 실제로 사람이 승인했음을 보장하지 못합니다.**

이 트레이드오프 때문에 `approvalFallback`에는 조용한 기본값을 두지 않기로 결정했습니다.

- `host add`는 7단계(키 전용 재접속 검증) 성공 직후, 위 트레이드오프를 설명하는 고정 문안을 출력하고 `token` 또는 `fail-closed` 중 하나를 **직접 선택**하게 합니다. 미리 골라둔 기본값이 없고, 빈 입력(Enter만)은 다시 묻습니다. 3회 연속 빈 입력이면 명령 자체가 중단되고 `hosts.json`은 생성되지 않습니다.
- `--approval-fallback token|fail-closed` 플래그는 **이 프롬프트만** 건너뜁니다. 비밀번호 입력 단계의 TTY 요구는 그대로입니다.
- 손으로 `hosts.json`을 편집해 이 필드를 지우면 서버는 **`fail-closed`로 간주**합니다. 어디에도 조용한 fail-open 경로는 없습니다. 이때 서버 기동 로그(stderr)에 경고가 1회 출력됩니다.
- `token`을 고른 호스트에는 아래 [보안 모델](#보안-모델)의 완화책이 전부 적용됩니다.

두 값의 실제 차이는 [승인 모드](#승인-모드) 표를 참고하세요.

### `--force` — 기존 alias 재설정

기존 alias에 대해 `setup`을 다시 실행하려면 `--force`가 필요합니다.

- `--force` 없이 기존 alias면 `alias_exists` 오류로 즉시 중단합니다.
- `--force`가 있으면: (1) 기존 지문과 새로 계산된 지문을 **나란히** 출력하고, (2) 두 지문이 다르면 "서버가 교체됐거나 중간자 공격일 수 있다"는 경고를 덧붙이며, (3) `yes`를 직접 타이핑해야 진행합니다. **어떤 경우에도 조용히 재핀하지 않습니다.**
- `stdin`이 TTY가 아니면 `--force` 자체가 거부됩니다. 지문 재핀은 사람의 확인이 반드시 있어야 하는 동작이기 때문입니다.

### `--approval-mode`, `--label`, `--alias`, `--port`

- `--approval-mode <auto|ask-destructive|ask-all|deny>`: 호스트의 초기 승인 모드를 지정합니다. 생략 시 기본값은 `ask-destructive`입니다.
- `--label "<텍스트>"`: `list_hosts` 응답과 사람이 읽는 안내에 쓰이는 표시 이름입니다. 생략 가능합니다.
- `--alias <name>`: alias를 플래그로 지정합니다. 첫 위치 인자를 대신할 수 있습니다.
- `--port <1-65535>`: 포트를 지정합니다. 대상을 `user@host:2222` 형태로 준 경우에는 그쪽이 이깁니다.

값이 여러 경로에서 올 때의 우선순위는 **위저드에서 사람이 확인한 답 > 명시한 플래그 > `--from-ssh-config`가 읽어온 값**입니다.

### `--from-ssh-config` — 이미 써 둔 ssh_config에서 가져오기

```bash
npx @get-bot/ssh-mcp host add --from-ssh-config web01
```

`~/.ssh/config`(환경변수 `SSH_MCP_SSH_CONFIG`로 다른 경로를 지정할 수 있습니다)에서 이름이 **정확히 일치하는** `Host` 블록을 찾아 `HostName`·`Port`·`User` 세 값을 위저드 기본값으로 채웁니다. 이미 OpenSSH에 설명해 둔 서버를 두 번 설명하지 않게 하는 것이 목적입니다.

**가져오는 것은 메타데이터 세 개뿐입니다.** 기존 키를 재사용하지 않고, `IdentityFile`·`IdentityAgent`는 읽되 무시하며, ssh-agent도 `known_hosts`도 참조하지 않습니다. 비밀번호 입력, 지문 확인, 전용 키 생성과 설치는 이 플래그가 없을 때와 완전히 같은 경로를 탑니다. 채워진 값은 위저드에서 확인 단계로 보여주고 고칠 수 있으므로 TTY가 필요합니다.

거절하는 경우가 있고, 거절할 때는 **부분 가져오기를 하지 않습니다**(세 값 중 셋만 맞고 하나가 틀린 결과보다 아무것도 주지 않는 편이 낫다는 판단입니다). 아래에 해당하면 `config_unsupported` 사유와 함께 종료 코드 2입니다.

- 대상 블록에 `ProxyJump`/`ProxyCommand`가 있는 경우
- 요청한 이름에 매치되는 **와일드카드 `Host` 블록**이 `HostName`·`Port`·`User`·`ProxyJump`·`ProxyCommand` 중 하나라도 설정하는 경우. `Host *`에 `ServerAliveInterval`만 있는 흔한 설정은 세 값을 바꿀 수 없으므로 그냥 무시합니다.
- `Match` 블록이 그 다섯 키워드 중 하나를 설정하는 경우. 조건이 무엇이든 거절합니다 — 적용 여부를 판정하려면 `ssh -G`를 다시 구현해야 하기 때문입니다.

`Include`는 **한 단계만** 따라갑니다(glob과 `~` 확장 지원). 그 안에서 또 `Include`가 나오면 따라가지 않고 stderr에 한 줄 알립니다.

> OpenSSH 자신은 키워드마다 파일 전체에서 **처음** 나온 값을 씁니다. 이 구현은 그 순서 규칙을 흉내내지 않고, 위와 같이 "값을 바꿀 수 있는 블록이 있으면 거절"하는 쪽으로 보수적으로 어긋납니다.

## host list — 등록된 호스트 보기

```bash
npx @get-bot/ssh-mcp host list
npx @get-bot/ssh-mcp host list --json
```

`hosts.json`을 읽어 alias, 접속 대상, 승인 모드, 승인 폴백, 호스트 키 지문 **접두 16자**, 라벨을 표로 출력합니다. 출력은 stdout이라 파이프하고 grep할 수 있습니다.

**개인키 경로와 지문 전문은 출력하지 않습니다.** [`list_hosts` 도구](#도구-9개-레퍼런스)와 같은 기준이며, 사람과 모델이 서로 다른 그림을 보지 않게 하려는 것입니다. 승인 폴백이 파일에 없어 `fail-closed`로 정규화된 항목은 `fail-closed(누락)`으로 표시합니다.

`--json`은 `list_hosts` 도구 응답과 같은 필드 구성(`{ hosts: [...], count }`)을 stdout에 출력합니다. 예약어와 같은 alias인 항목에만 `reserved_alias: true`가 하나 더 붙고, 그 밖의 필드는 도구 응답과 동일합니다. 등록된 호스트가 없어도 마찬가지로 `{"hosts": [], "count": 0}`을 내므로 스크립트에서 분기 없이 파싱할 수 있습니다.

표 모드에서만 빈 레지스트리를 `등록된 호스트가 없습니다. ssh-mcp host add로 추가하세요.` 한 줄로 안내합니다. 두 경우 모두 종료 코드 0이며, `hosts.json`이 깨져 있으면 `config_invalid` 사유를 stderr에 내고 종료 코드 1입니다(그때 stdout에는 아무것도 쓰지 않습니다).

`host list --help`는 사용법을 stdout에 출력하고 종료 코드 0입니다(`doctor`와 같은 관례 — 요청한 출력은 오류가 아닙니다). 모르는 옵션은 stderr에 사용법과 함께 종료 코드 2입니다.

## install — 클라이언트 등록

이 서버를 MCP 호스트에 등록해 주는 명령입니다. `doctor`가 출력하는 스니펫을 손으로 붙여넣어도 결과는 같지만, 그러려면 SSH와 아무 상관 없는 플랫폼 세부(Windows에서는 `cmd /c`로 감싸야 한다는 것, 두 클라이언트가 등록 정보를 서로 다른 곳에 서로 다른 형식으로 둔다는 것)를 알아야 합니다. `install`은 그 부분을 대신합니다.

```bash
npx @get-bot/ssh-mcp install                  # 목록에서 고릅니다
npx @get-bot/ssh-mcp install claude-code
npx @get-bot/ssh-mcp install claude-desktop
```

### 클라이언트 선택

클라이언트를 생략하고 터미널에서 실행하면 목록이 나옵니다.

```
? 어느 클라이언트에 등록할까요?
❯ Claude Code
  Claude Desktop
  둘 다

claude 감지됨: ~/.local/bin/claude
↑↓ 이동 • ⏎ 선택
```

- **조작.** `↑`/`↓`로 이동하고 `Enter`로 확정합니다. 항목 이름을 입력해 좁힐 수도 있습니다(그래서 `j`/`k` 이동은 켜지 않았습니다 — 라이브러리에서 이 둘은 함께 쓸 수 없습니다). 강조된 항목의 설명이 목록 아래에 한 줄로 보입니다. `Ctrl+C`는 아무것도 등록하지 않고 끝냅니다.
- **감지는 힌트일 뿐입니다.** `claude`를 `PATH`에서 찾고 Claude Desktop 설정 폴더가 있는지만 봅니다(프로세스는 띄우지 않습니다). 감지되지 않아도 선택할 수 있습니다 — 지금 막 설치했을 수도 있으니까요.
- **"둘 다"** 는 Claude Code(scope 질문 포함) → Claude Desktop 순서로 실행하고 마지막에 두 결과를 요약합니다. 하나라도 실패하면 종료 코드 1입니다.
- **터미널이 아니면 묻지 않습니다.** 파이프나 CI에서 클라이언트 없이 실행하면 추측하지 않고 사용법 오류(종료 코드 2)로 끝내며 두 가지 명령을 안내합니다. 클라이언트 전용 플래그(`--scope`, `--config`)만 주고 클라이언트를 빼도 같은 오류입니다.

| 옵션                             | 설명                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                  | 등록할 MCP 서버 이름. 기본 `ssh-mcp`. 영숫자로 시작하고 영숫자·`.`·`_`·`-`만 쓸 수 있습니다(최대 64자)           |
| `--scope <local\|user\|project>` | `claude-code` 전용. 생략하면 터미널에서 묻습니다([scope 선택](#scope-선택)). `claude-desktop`에 주면 사용법 오류 |
| `--home <path>`                  | `SSH_MCP_HOME` 환경변수를 함께 등록합니다                                                                        |
| `--config <path>`                | `claude-desktop` 전용. 설정 파일 경로를 재지정합니다                                                             |
| `--force`                        | 같은 이름이 이미 등록돼 있으면 교체합니다                                                                        |
| `--dry-run`                      | 아무것도 바꾸지 않고 수행할 내용만 출력합니다                                                                    |
| `-h`, `--help`                   | 도움말                                                                                                           |

종료 코드는 `setup`과 같습니다 — `0` 성공, `1` 실패, `2` 사용법 오류. 출력은 stderr로 나갑니다(`doctor`가 stdout을 쓰는 것과 대비됩니다). 예외는 `--help` 하나로, 요청한 사용법은 다른 명령과 같이 stdout에 내고 종료 코드 0입니다 — 그래야 `install --help | less`에 내용이 있습니다.

`--home`과 `--config`의 값은 절대 경로로 변환해 등록합니다. 서버는 MCP 호스트가 정한 작업 디렉터리에서 실행되므로 상대 경로는 사용자가 의도한 곳을 가리키지 않습니다. 값을 받는 플래그(`--name`, `--scope`, `--home`, `--config`) 뒤에 `-`로 시작하는 토큰이 오면 값으로 삼키지 않고 사용법 오류로 끝냅니다 — 그러지 않으면 `--home --dry-run`이 `--dry-run`을 값으로 먹고 실제로 파일을 쓰게 됩니다.

### 등록되는 명령 형태

| 플랫폼  | 등록되는 명령                    |
| ------- | -------------------------------- |
| Windows | `cmd /c npx -y @get-bot/ssh-mcp` |
| 그 외   | `npx -y @get-bot/ssh-mcp`        |

Windows에서는 **두 클라이언트 모두** `cmd /c`로 감쌉니다. Claude Code 2.1.270은 감싸지 않은 `npx`로도 연결되지만(실측), 구버전 Claude Code와 Claude Desktop은 감싸야 하며, 자동 경로에서 클라이언트마다 다른 형태를 쓰는 것보다 하나로 통일하는 편이 지원하기 쉽습니다. 이유 자체는 [Windows](#windows) 절에 있습니다.

### `install claude-code`

`claude mcp add <name> -s <scope> [-e SSH_MCP_HOME=<path>] -- <명령>`을 대신 실행합니다. Claude Code의 레지스트리 파일 형식은 공개된 계약이 아니므로 직접 편집하지 않고 CLI에 위임합니다.

- `--force`를 주면 먼저 `claude mcp remove -s <scope> <name>`을 실행합니다. 등록된 적이 없어 실패하는 것은 정상이므로 무시하고 add로 넘어갑니다.
- `claude`를 PATH에서 찾지 못하면 Windows에서는 `cmd /c claude ...`로 한 번 더 시도합니다(npm으로 설치한 구버전의 `claude`는 배치 파일입니다). 그래도 못 찾으면 **직접 붙여넣을 수 있는 명령 한 줄**을 출력하고 종료 코드 1로 끝냅니다.
- 다만 인자에 `&`, `|`, `<`, `>`, `^`, `%`, `!`, `"` 중 하나가 있으면 `cmd` 경유 재시도를 **하지 않습니다**. `cmd.exe`가 그 문자를 해석해 의도하지 않은 명령이 실행될 수 있기 때문입니다(예: `--home "C:\R&D\ssh-mcp"`). 이때도 수동 명령을 출력하고 종료 코드 1입니다. 공백은 안전하므로 허용합니다.
- 이 판정은 `--force`의 remove까지 포함해 **한 번에** 내립니다. remove만 실행되고 add가 거부되면 기존 등록이 지워진 채 아무것도 복구되지 않기 때문에, 거부할 상황이면 remove도 실행하지 않습니다.
- `claude`의 출력은 그대로 중계하며, 비영 종료 코드는 그대로 실패로 취급합니다. `--force`의 remove가 "등록된 적 없음"으로 실패하는 것은 정상이므로 그 출력은 중계하지 않고 건너뛰었다는 한 줄만 남깁니다.

성공하면 `claude mcp list` 또는 Claude Code 안의 `/mcp`로 확인하세요.

### scope 선택

Claude Code는 등록을 세 가지 범위 중 하나에 저장합니다. **기본값인 `local`은 명령을 실행한 그 디렉터리에만 적용됩니다.** 홈 디렉터리에서 설치 명령을 치면 홈 디렉터리 전용으로 등록되고, 정작 일하는 프로젝트에서 Claude Code를 열면 도구가 보이지 않습니다. 그래서 `--scope`를 생략하면 터미널에서 한 번 묻습니다.

```
? Claude Code 어디에 등록할까요?
❯ 이 프로젝트만 (local)
  모든 프로젝트 (user)

/home/me/project 에서 연 Claude Code에만 보입니다. Claude Code의 기본값입니다.
↑↓ 이동 • ⏎ 선택
```

목록은 [`@inquirer/select`](https://www.npmjs.com/package/@inquirer/select)가 그립니다. 좁은 창에서의 줄 바꿈과 콘솔별 차이는 그쪽이 처리합니다.

조작은 클라이언트 목록과 같습니다. `local`이 미리 선택돼 있으므로 Enter만 누르면 `local`입니다. 저장소로 공유하려면 `--scope project`를 직접 지정하세요. `Ctrl+C`로 빠져나가면 **아무것도 등록하지 않고** 종료 코드 1로 끝냅니다.

질문은 **stdin과 stderr가 모두 터미널이고 `TERM`이 `dumb`가 아닐 때만** 뜹니다. 목록은 stderr에 그리고 키는 stdin에서 읽으므로 둘 중 하나만 리다이렉트돼도 물어볼 수 없습니다. 그런 실행에서는 묻지 않고 위에 적은 비대화형 규칙을 따릅니다 — 더 단순한 형태로 대신 묻지 않습니다. `TERM` 판정은 앞뒤 공백과 대소문자를 무시하고, **빈 값도 `dumb`으로 봅니다.** 반대로 `TERM` 자체가 설정돼 있지 않은 것은 정상으로 취급합니다 — Windows 콘솔이 그렇고, 그것을 거부하면 Windows에서는 질문이 아예 뜨지 않습니다.

터미널인데도 질문 자체를 띄우지 못하는 경우가 하나 있습니다. Node가 20.17보다 낮으면 목록을 그리는 `@inquirer`를 불러오지 못합니다. 이때는 기본값으로 넘어가지 않고 **아무것도 등록하지 않은 채 종료 코드 1**로 끝내며, Node를 올리거나 `--scope`를 직접 지정하라고 안내합니다. 물어볼 수 없다는 이유로 등록 범위를 대신 정해 버리면, 사용자가 의도하지 않은 디렉터리에만 등록된 사실을 나중에야 알게 되기 때문입니다.

### WSL

WSL 안에서는 `process.platform`이 `linux`이므로 **감싸지 않은 `npx -y @get-bot/ssh-mcp`** 형태로 등록하고, `claude`도 리눅스 바이너리를 찾습니다. Windows 네이티브에서 실행할 때와 동작이 갈리는 곳은 한 군데뿐입니다.

Claude Desktop은 Windows 앱이라 WSL 쪽에는 설정 폴더가 없습니다. 그래서 클라이언트 목록에서 "감지되지 않음(WSL에서는 Windows의 Claude Desktop 설정에 접근하지 않습니다)"으로 표시되지만 **선택 자체는 막지 않습니다.** `--config /mnt/c/Users/<이름>/AppData/Roaming/Claude/claude_desktop_config.json`처럼 경로를 직접 주면 WSL에서도 Windows 쪽 Desktop 설정을 편집할 수 있습니다. 그렇게 등록한 항목은 Windows의 Claude Desktop이 실행하므로 명령 형태를 `cmd /c ...`로 직접 맞춰야 한다는 점에 주의하세요 — 이 경우는 자동 판단이 맞지 않는 유일한 조합입니다.

- `--scope`를 지정하면 묻지 않습니다. 문서의 한 줄 명령과 스크립트는 그대로 비대화형으로 동작합니다.
- 파이프나 CI처럼 질문을 그릴 수 없는 환경이면 묻지 않고 `local`로 진행하되, 그 사실과 바꾸는 방법을 한 줄로 알립니다.
- `--dry-run`도 같은 규칙을 따릅니다. 출력의 `-s <scope>`는 최종 선택값입니다.

| scope     | 저장 위치                             | 보이는 범위                                            |
| --------- | ------------------------------------- | ------------------------------------------------------ |
| `local`   | `~/.claude.json`의 해당 프로젝트 항목 | 그 디렉터리에서 연 Claude Code에서만                   |
| `user`    | `~/.claude.json` 최상위               | 어느 디렉터리에서 열어도                               |
| `project` | 저장소의 `.mcp.json`                  | 저장소를 공유하는 모든 사람(첫 사용 시 각자 승인 필요) |

같은 이름이 `local`과 `user` 양쪽에 있으면 해당 프로젝트에서는 `local`이 우선합니다. `user`로 등록했는데 한 프로젝트에서만 옛 설정이 보인다면 그 프로젝트의 `local` 항목을 지우세요.

### `install claude-desktop`

`claude_desktop_config.json`을 직접 편집합니다. 기본 경로는 Windows `%APPDATA%\Claude\`, macOS `~/Library/Application Support/Claude/`, 그 외 `~/.config/Claude/`입니다.

이 파일에는 사용자의 **다른 MCP 서버 설정이 함께** 들어 있습니다. 그래서 이해하지 못하는 파일은 절대 건드리지 않습니다.

- JSON 파싱에 실패하거나 `mcpServers`가 객체가 아니면 **아무것도 쓰지 않고** 경로와 사유를 출력한 뒤 종료 코드 1로 끝냅니다.
- 같은 이름의 항목이 이미 있고 `--force`가 없으면 역시 아무것도 쓰지 않고 종료 코드 1입니다.
- 덮어쓰기 전에 같은 디렉터리에 `claude_desktop_config.json.bak-<YYYYMMDD-HHmmss>` 백업을 만듭니다. 같은 이름이 이미 있으면 `-1`, `-2`… 를 붙여 **기존 백업을 절대 덮어쓰지 않습니다**(타임스탬프가 초 단위라 같은 초에 두 번 실행할 수 있습니다).
- POSIX에서는 **원래 파일의 권한을 그대로 유지합니다.** 새 내용은 임시 파일에 쓰고 rename 하는데, 그대로 두면 임시 파일의 기본 권한(보통 `0644`)이 대상 파일에 옮겨붙습니다. 이 파일은 우리 것이 아니라 Claude Desktop의 것이고 다른 MCP 서버의 자격증명이 들어 있을 수 있으므로, `0600`으로 잠가 둔 설정이 설치 후에 세상에 열리면 안 됩니다. 백업도 같은 권한으로 만듭니다. 새로 만드는 파일에는 아무것도 강제하지 않습니다.
- 쓰기는 임시 파일에 쓴 뒤 rename으로 교체합니다(`hosts.json`과 같은 원자적 교체).
- 다른 키와 다른 서버 항목은 모두 보존합니다. 다만 파일 전체를 2칸 들여쓰기로 다시 직렬화하므로 기존 들여쓰기·공백은 바뀔 수 있습니다.

반영하려면 Claude Desktop을 **완전히 종료했다가** 다시 시작해야 합니다. 그 뒤 도구 목록에 정확히 9개가 보여야 합니다.

### `--dry-run`

아무것도 바꾸지 않고, `claude-code`는 실행할 명령 한 줄을, `claude-desktop`은 대상 경로와 추가·교체될 항목 JSON을 출력합니다. `claude-code`에서 `--scope`를 생략했다면 [scope 질문](#scope-선택)은 그대로 뜹니다.

```bash
$ npx @get-bot/ssh-mcp install claude-code --scope local --dry-run
[dry-run] 아무것도 바꾸지 않았습니다. 실행할 명령:
  claude mcp add ssh-mcp -s local -- cmd /c npx -y @get-bot/ssh-mcp
```

## connect / exec — 터미널에서 직접 쓰기

등록해 둔 호스트에 **사람이** 바로 접속하거나 명령 한 줄을 실행하는 경로입니다. `hosts.json`의 주소·포트·사용자명·개인키를 그대로 쓰므로, `host add`를 한 번 하면 Claude와 사람이 같은 접속 정보를 공유합니다.

```bash
npx @get-bot/ssh-mcp connect web1
npx @get-bot/ssh-mcp exec web1 -- systemctl status nginx
```

실제로 실행되는 것은 시스템 `ssh`이며 인자는 다음으로 고정됩니다.

```
ssh -i <privateKeyPath> -p <port> -o IdentitiesOnly=yes <user>@<hostname> [명령...]
```

`IdentitiesOnly=yes`는 장식이 아닙니다. 이것이 없으면 OpenSSH가 에이전트에 있는 키를 먼저 전부 내밀고, `MaxAuthTries 3`인 서버는 우리 키를 시도해 보기도 전에 거절합니다. `-i`만으로는 막지 못합니다.

터미널을 그대로 자식 프로세스에 넘기므로(`stdio: 'inherit'`) 비밀번호 프롬프트, `less`, 색상, 창 크기 변경이 직접 `ssh`를 친 것과 똑같이 동작합니다. **MCP 도구가 거부하는 대화형 프로그램(`vim`, `top`)도 이 경로에서는 그대로 쓸 수 있습니다.** `exec`의 `--` 뒤 토큰은 하나도 바꾸지 않고 넘깁니다.

> **이 경로는 게이트를 거치지 않습니다.** 명령 분류·승인·감사·출력 발췌가 전부 적용되지 않고, 호스트 키 확인도 ssh-mcp가 `hosts.json`에 고정한 지문이 아니라 **OpenSSH의 `known_hosts`**를 따릅니다. 즉 같은 서버에 대해 두 경로가 서로 다른 신뢰 근거를 씁니다. 승인과 감사가 필요하면 MCP 도구 `exec`를 쓰세요.

종료 코드는 `ssh`의 것을 그대로 돌려줍니다. 예외는 셋입니다 — 등록되지 않은 alias는 `host_not_found` 사유와 함께 `2`, `hosts.json`이 깨졌거나 `ssh` 실행 파일이 PATH에 없으면 `1`(운영체제별 설치 안내를 stderr에 냅니다), 사용법 오류는 `2`입니다. `connect`는 alias 하나만 받고 다른 인자를 조용히 넘기지 않습니다 — `ssh-mcp connect web1 -X`는 `-X`가 목적지 뒤에 붙어 원격 명령으로 해석되므로, 지원하는 것처럼 보이게 두는 대신 사용법 오류로 끝냅니다.

**기술 스택 경계.** 이 두 명령은 시스템 `ssh`에 위임하는 **CLI 전용** 예외입니다. MCP 서버의 기동과 도구 호출은 종전대로 순수 JavaScript `ssh2`만 쓰며, OpenSSH가 설치되지 않은 머신에서도 아무 영향 없이 동작합니다. 이 경계는 ESLint 규칙으로 강제됩니다 — 서버·도구·SSH 전송 계층은 `src/connect/`를 import 할 수 없고, 진입점은 `src/commands.ts`의 동적 import 하나뿐입니다. `doctor`의 `ssh` 항목이 정보(INFO)로만 표시되고 실패 개수에 잡히지 않는 것도 같은 이유입니다.

## 도구 9개 레퍼런스

모델이 실제로 읽는 안내문과 동일한 문구입니다.

| 도구             | 설명                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 주요 인자                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `list_hosts`     | 등록된 SSH 호스트의 alias, 접속 정보, 승인 모드, 승인 폴백을 반환한다. 다른 도구에 넘길 `host` 값을 여기서 확인한다. 비밀키 경로와 호스트 키 지문 전문은 반환하지 않는다.                                                                                                                                                                                                                                                                                                                                                                                       | (없음)                                                                          |
| `exec`           | 등록된 호스트에서 셸 명령을 한 번 실행하고 stdout, stderr, exit code를 분리해 반환한다. 명령은 서버가 안전/파괴적/관리자로 분류하며 호스트의 승인 모드에 따라 확인을 요구할 수 있다. **응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.** 대화형 프로그램(vim, top, less 등)은 지원하지 않는다. 작업 디렉터리와 환경변수는 호출 간에 유지되지 않는다 — 유지가 필요하면 `open_session`을 쓴다.                   | `host`, `command`, `format?`, `timeout_sec?`, `confirmation_token?`             |
| `upload`         | 로컬 파일을 원격 경로로 SFTP 전송한다. 원격에 같은 경로가 있으면 덮어쓴다. 전송은 호스트의 승인 모드를 따르며 관리자 등급으로 분류된다. **응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.** ssh-mcp 설정 디렉터리(`~/.ssh-mcp`) 안의 파일은 전송할 수 없다.                                                                                                                                                    | `host`, `local_path`, `remote_path`, `confirmation_token?`                      |
| `download`       | 원격 파일을 로컬 경로로 SFTP 전송한다. 로컬에 같은 경로가 있으면 기본적으로 실패하며, 덮어쓰려면 `overwrite: true`를 넘긴다. 전송은 호스트의 승인 모드를 따르며, `overwrite: true`는 파괴적 등급으로 분류된다(그 외에는 관리자 등급). **응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.** ssh-mcp 설정 디렉터리(`~/.ssh-mcp`) 안의 경로에는 내려받을 수 없다.                                                  | `host`, `remote_path`, `local_path`, `overwrite?`, `confirmation_token?`        |
| `open_session`   | 상태가 유지되는 원격 셸 세션을 열고 `session_id`를 반환한다. 이후 `run_in_session` 호출들이 작업 디렉터리, 환경변수, 활성화한 가상환경을 공유한다. 호스트당 최대 5개이며 30분간 쓰지 않으면 자동으로 닫힌다. 다 쓰면 `close_session`으로 닫는다.                                                                                                                                                                                                                                                                                                                | `host`                                                                          |
| `run_in_session` | 열린 세션 안에서 명령을 실행한다. `cd`, `export`, `source venv/bin/activate`의 효과가 다음 호출까지 유지된다. 분류와 승인은 `exec`와 완전히 동일하다. **응답이 `confirmation_required`이면, `confirmation_token`을 붙여 다시 호출하기 전에 반드시 사용자에게 명령 전문을 보여주고 대화에서 명시적 승인을 받아야 한다. 사용자 승인 없이 재호출하지 말 것.** 대화형 프로그램은 지원하지 않는다.                                                                                                                                                                   | `session_id`, `command`, `format?`, `timeout_sec?`, `confirmation_token?`       |
| `close_session`  | 세션을 닫고 원격 셸을 종료한다. 이미 닫힌 세션에 호출해도 오류가 아니다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `session_id`                                                                    |
| `history`        | 이 서버가 남긴 감사 로그를 최신순으로 조회한다. 호스트·기간·등급·도구·승인 결과로 거를 수 있고, 회전된 파일까지 이어 읽는다. `next_cursor`를 다음 호출의 `cursor`로 넘겨 페이지를 잇는다 — 페이징 종료 판정은 `entries`가 비었는지가 아니라 `next_cursor === null`로 한다(필터가 좁으면 결과 없는 페이지가 나올 수 있다). 읽을 수 없는 줄은 건너뛰고 개수만 `skipped`에 보고하며 원문은 싣지 않는다. 감사 파일이 회전해 커서를 이어받을 수 없으면 `history_cursor_stale`을 돌려준다 — 그때는 `cursor` 없이 다시 조회한다.                                       | `host?`, `since?`, `until?`, `grade?`, `tool?`, `outcome?`, `limit?`, `cursor?` |
| `fetch_output`   | `exec`/`run_in_session`가 발췌로 잘라낸 출력의 전문을 처음부터 순서대로 페이지 단위로 읽는다. `stdout_meta.output_ref` 또는 `stderr_meta.output_ref`가 non-null일 때만 쓸 수 있다. `total_bytes`는 마스킹 후 보관 길이이며 `stdout_meta.total_bytes`(와이어 바이트)와 다를 수 있다. 페이징 종료 판정은 `next_cursor === null`로 한다. 보관은 서버 메모리에만 10분간 유지되며 디스크에 기록되지 않는다 — 만료·폐기·재시작 후에는 `output_expired`이고, 그때는 명령을 다시 실행해야 한다. 개인키 블록은 보관 시점에 마스킹돼 있고 그 외 리댁션은 적용되지 않는다. | `output_ref`, `cursor?`, `max_bytes?`                                           |

**`history`와 `fetch_output`은 승인을 거치지 않습니다.** 둘 다 원격에 아무것도 보내지 않고 이 프로세스 안에서만 답합니다 — `history`는 감사 파일에서, `fetch_output`은 메모리의 출력 보관소에서. 그래서 `readOnlyHint: true`이고 `requiresUserInteraction`도 붙지 않습니다. 다만 호출 자체는 다른 도구와 똑같이 감사 줄 한 개로 남으며, 그 줄의 `command`는 `null`입니다.

`exec`, `run_in_session` 두 도구에만 `_meta: { "anthropic/requiresUserInteraction": true }`가 붙어 있습니다. Claude Code에서 always-allow·bypassPermissions 설정을 무력화하고 매 호출마다 사람에게 확인을 강제하는 비표준 Anthropic 확장입니다. 필요하면 `SSH_MCP_REQUIRE_USER_INTERACTION=0`으로 끌 수 있습니다.

`upload`/`download`의 `local_path`가 `~/.ssh-mcp`(레지스트리·개인키·상태·감사 로그) 안으로 해석되면, 승인 모드나 등급과 **무관하게** 승인 절차를 거치지도 않고 곧바로 `local_path_forbidden`으로 거부됩니다. 게이트를 통과해도 우회할 수 없는 하드 블록입니다.

`exec`/`run_in_session` 응답에는 네 가지가 조건부로 더 붙습니다.

- **`parsed` / `parse_error`.** `format: "json"`으로 호출했을 때만 나타납니다. 기본값 `format: "text"`에서는 두 필드가 `null`로도 붙지 않습니다 — [format: "json" 구조화 출력](#format-json-구조화-출력)을 보세요.
- **`stdout_meta.output_ref` / `stderr_meta.output_ref`.** 그 스트림이 발췌로 잘렸고 전문이 보관됐을 때만 문자열이고, 그 밖에는 `null`입니다. [출력 보관과 fetch_output](#출력-보관과-fetch_output)을 보세요.

- **`classification_coverage`.** 원격 호스트의 로그인 셸이 평소대로 POSIX 계열이면 이 필드는 응답에 아예 나타나지 않습니다(전체 커버리지). `open_session`이 마지막으로 관측한 셸이 `cmd`나 PowerShell이었을 때만(`state.json`의 `observedShells` 기준) `classification_coverage: "reduced"`가 포함됩니다. `exec`는 자체 셸 프로브가 없어 이 마지막 관측치에만 의존합니다.
- **`sudo`가 비밀번호를 요구하면 사후에 `sudo_password_required`로 번역됩니다.** stdin이 항상 닫혀 있으므로 `sudo`가 비밀번호를 요구하면 반드시 비영 종료 코드로 실패하는데, 그 stderr가 `sudo: no tty present`, `no askpass program`, `a password is required`, `[sudo] password for ` 중 하나에 걸리면(그리고 종료 코드가 0이 아니면) 원래 오류 대신 이 코드로 응답합니다. [sudo](#sudo) 절을 보세요.

## 승인 모드

명령은 내장 정규식 패턴으로 **안전(safe) / 관리자(privileged) / 파괴적(destructive)** 셋 중 하나로 분류됩니다. 어느 패턴에도 걸리지 않으면 `safe`입니다. 호스트별 `patternOverrides`로 패턴을 추가하거나(모든 범위) 내장 패턴을 개별 해제할 수 있습니다(`destructive`/`privileged`만, 임의 안전 선언은 불가).

승인 모드는 호스트마다 `auto` / `ask-destructive`(기본값) / `ask-all` / `deny` 중 하나이고, 실제 동작은 클라이언트가 elicitation을 지원하는지와 그 호스트의 `approvalFallback` 값에 따라 갈립니다.

| 클라이언트                                      | 모드              | 등급                     | 동작                                                                                                                                  |
| ----------------------------------------------- | ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (elicitation 지원)                  | `ask-destructive` | safe                     | 즉시 실행                                                                                                                             |
| Claude Code                                     | `ask-destructive` | destructive / privileged | elicitation 확인창 1회 → 사람이 결정                                                                                                  |
| Claude Code                                     | `ask-all`         | 전부                     | elicitation 확인창 1회                                                                                                                |
| Claude Desktop (elicitation 미지원)             | `ask-destructive` | safe                     | 즉시 실행                                                                                                                             |
| Claude Desktop, `approvalFallback: token`       | `ask-destructive` | destructive / privileged | `confirmation_required` + 토큰 반환 → 모델이 사용자 승인을 받은 뒤 재호출. **사람 개입은 Desktop의 도구 승인 대화상자에만 의존한다**  |
| Claude Desktop, `approvalFallback: fail-closed` | `ask-destructive` | destructive / privileged | `approval_unavailable`로 거부. 토큰 미발급                                                                                            |
| Claude Desktop, `approvalFallback: fail-closed` | `ask-all`         | 전부(safe 포함)          | `approval_unavailable`로 거부. 토큰 미발급 — `ask-all`은 사람에게 물을 수 없으면 무엇이든 거부한다는 뜻이라 안전 등급도 예외가 아니다 |
| **`approvalFallback` 필드가 없음(손편집 등)**   | `ask-*`           | destructive / privileged | `fail-closed`와 동일하게 처리. 기동 시 경고 1회                                                                                       |
| 아무 클라이언트                                 | `deny`            | destructive / privileged | `command_denied`. 토큰 미발급                                                                                                         |
| 아무 클라이언트                                 | `auto`            | 전부                     | 즉시 실행. 기동 시 경고 1회                                                                                                           |

**서버가 실제로 강제할 수 있는 것은 `fail-closed`와 Claude Code의 `requiresUserInteraction`뿐입니다.** 그 외에는 클라이언트 쪽 UI(대화상자, elicitation 창)를 신뢰해야 합니다. 자세한 내용은 [보안 모델](#보안-모델)을 보세요.

**elicitation 요청의 스키마.** 요청은 `mode: "form"`으로 보내며(필드는 선택이지만 명시합니다 — 다른 모드인 URL 모드는 사람이 브라우저에서 답하는 방식이라 이 게이트가 쓸 수 없습니다), 불리언 필드 `confirm` 하나만 요구합니다.

```json
{
  "mode": "form",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "confirm": {
        "type": "boolean",
        "title": "스페이스로 체크 후 Accept",
        "description": "체크하지 않고 Accept를 누르면 실행하지 않습니다.",
        "default": false
      }
    },
    "required": ["confirm"]
  }
}
```

`confirm`이 정확히 `true`로 승인된 경우에만 실행되고, 그 외(거절·취소·타임아웃·`confirm: false`)는 전부 `command_denied`로 처리됩니다.

**승인 메시지는 세 줄입니다.** 첫 줄이 승인 대상(명령 전문, 또는 파일 전송의 경우 작업과 양쪽 경로), 둘째 줄이 호스트와 도구, 셋째 줄이 등급과 분류 사유입니다.

```
rm -rf /var/log/nginx/old
lionpay-stg (root@10.0.0.9:22) · exec
등급: destructive · 사유: rm-command 외 1개
```

세 줄인 이유는 Claude Code(2.1.271 실측)가 elicitation 메시지의 **첫 세 줄만 보여주고 나머지를 `… (+N more lines)`로 접으며, 그 접힌 부분은 펼칠 수 없기 때문**입니다. 사유가 길면 셋째 줄이 접히지 않도록 개수만 세어 `외 N개`로 줄입니다 — 전체 목록은 감사 로그의 `reasons`에 그대로 남습니다.

**승인 창에서는 체크박스를 먼저 체크해야 합니다.** Claude Code(2.1.274, Windows 11 실측)는 이 필드를 체크되지 않은 체크박스 `☐`로 그립니다. 방향키나 Tab으로 체크박스에 포커스를 옮겨 스페이스로 `☑`로 바꾼 뒤 Accept를 누르세요. 체크하지 않고 그냥 Accept를 누르면 창은 닫히지만 `confirm: false`가 와서 **실행되지 않습니다** — 즉 손대지 않는 것 자체가 "실행하지 않겠다"는 답입니다. 같은 안내가 체크박스 제목(`스페이스로 체크 후 Accept`)과 그 `description`에도 들어 있습니다 — 제목은 좁은 창에서 잘리므로 눌러야 할 키를 앞에 두었고, 클라이언트가 `description`을 그리지 않을 수 있어 제목만으로도 뜻이 통하게 했습니다.

**`default: false`는 장식이 아닙니다.** 같은 스키마를 세 가지로 바꿔가며 실측했습니다(2026-09-17, Claude Code 2.1.274). `default`를 빼면 체크 전에는 제출 자체가 "This field is required"로 막혀 Accept가 먹통 키처럼 보이고, `default: true`로 두면 체크박스가 **이미 체크된 채로** 떠서 손대지 않은 Accept가 곧바로 승인이 됩니다(fail-open). `default: false`만이 빈 체크박스로 떠서 양쪽 답이 모두 도달 가능하고, 위험한 쪽에 키 입력 하나를 요구합니다. 값이 `true`로 바뀌면 깨지는 테스트를 `tests/unit/approval.test.ts`에 두었습니다.

`confirm: true` 요구 자체는 "Accept 버튼이 눌렸다"와 "실행하겠다는 값이 왔다"를 분리해 두려는 의도(AC17.1b)라 유지합니다. 이 형태는 MCP TypeScript SDK가 파괴적 작업 확인에 쓰는 공식 예제와 같습니다 — 필수 불리언 하나를 요구하고, `accept`로 돌아왔더라도 값이 `true`가 아니면 실행하지 않습니다.

**`confirmation_required` 응답은 명령 전문을 그대로 담습니다.** 토큰 발급 경로(`confirmation_required`)의 응답 본문에는 `confirmation_token`과 함께 명령 문자열이 최대 8192자까지(분류기의 명령 길이 상한과 동일) 잘리지 않고 담깁니다 — 모델이 사용자에게 보여줄 재료를 완제품으로 주기 위함입니다.

**토큰 검증 실패는 `command_denied`가 아닙니다.** 잘못되었거나(`confirmation_token_invalid`), 이미 쓰였거나(`confirmation_token_used`), 만료되었거나(`confirmation_token_expired`), 다른 명령/호스트에 발급된(`confirmation_token_mismatch`) 토큰은 각각 전용 오류 코드로 구분됩니다. `command_denied`는 `deny` 모드이거나 사람이 명시적으로 거절한 경우에만 씁니다 — 둘을 같은 코드로 뭉치면 "승인 절차 자체가 실패했다"와 "사람이 거절했다"를 로그에서 구분할 수 없기 때문입니다.

## `hosts.json` 스키마

경로: `~/.ssh-mcp/hosts.json` (Windows: `%USERPROFILE%\.ssh-mcp\hosts.json`).

```jsonc
{
  "schemaVersion": 1,
  "hosts": {
    "prod-web": {
      "hostname": "web01.example.com",
      "port": 22,
      "user": "deploy",
      "privateKeyPath": "C:\\Users\\me\\.ssh-mcp\\keys\\prod-web",
      "hostKey": {
        "algo": "ssh-ed25519",
        "sha256": "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
      },
      "approvalMode": "ask-destructive",
      "approvalFallback": "fail-closed",
      "auditMode": "full",
      "patternOverrides": {
        "destructive": {
          "add": ["^helm\\s+uninstall\\b"],
          "remove": ["^git\\s+push\\b.*\\s--force\\b"],
        },
        "privileged": { "add": [], "remove": [] },
      },
      "defaultTimeoutSec": 60,
      "maxOutputBytes": 1048576,
      "label": "프로덕션 웹",
      "createdAt": "2026-09-11T12:00:00.000Z",
    },
  },
}
```

| 필드                                                                                | 타입 / 제약                                                                                                                                                                                      | 기본값                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `schemaVersion`                                                                     | `1` 고정. 다른 값이면 로드 거부                                                                                                                                                                  | 필수                                               |
| alias(키)                                                                           | `/^[a-z0-9][a-z0-9._-]{0,63}$/i`                                                                                                                                                                 | 필수                                               |
| `hostname`                                                                          | 문자열, 1~253자                                                                                                                                                                                  | 필수                                               |
| `port`                                                                              | 정수, 1~65535                                                                                                                                                                                    | `22`                                               |
| `user`                                                                              | 문자열, 공백/콜론 불가                                                                                                                                                                           | 필수                                               |
| `privateKeyPath`                                                                    | 문자열                                                                                                                                                                                           | 필수                                               |
| `hostKey.algo`                                                                      | 문자열                                                                                                                                                                                           | 필수                                               |
| `hostKey.sha256`                                                                    | `SHA256:` + base64 43자                                                                                                                                                                          | 필수                                               |
| `approvalMode`                                                                      | `auto` \| `ask-destructive` \| `ask-all` \| `deny`                                                                                                                                               | `ask-destructive`                                  |
| `approvalFallback`                                                                  | `token` \| `fail-closed` — **명시적으로 optional이며 zod 기본값이 없다.** `setup`이 쓰는 항목에는 항상 값이 들어간다. 손편집으로 누락되면 로드 시 `fail-closed`로 정규화되고 `warn` 1회를 남긴다 | (기본값 없음. 누락 시 동작은 `fail-closed`와 동일) |
| `auditMode`                                                                         | `full` \| `metadata-only` — 감사 줄에 명령 문자열을 남길지                                                                                                                                       | `full`                                             |
| `patternOverrides.destructive.add/remove`, `patternOverrides.privileged.add/remove` | 정규식 문자열 배열, 각 512자 이하                                                                                                                                                                | `[]`                                               |
| `defaultTimeoutSec`                                                                 | 정수, 1~3600                                                                                                                                                                                     | `60`                                               |
| `maxOutputBytes`                                                                    | 정수, 1024~4194304(4 MiB)                                                                                                                                                                        | `1048576`                                          |
| `label`                                                                             | 문자열, 128자 이하, optional                                                                                                                                                                     | —                                                  |
| `createdAt`                                                                         | ISO 8601 datetime                                                                                                                                                                                | 필수                                               |

모든 객체는 `.strict()`로 검증됩니다. 정의되지 않은 키(예: 과거 계획에 있던 `patternOverrides.allow`)가 남아 있으면 **조용히 무시되지 않고 검증에서 거부**됩니다. `allow`류 임의 안전 선언 필드는 v1에 없습니다 — 내장 파괴적/관리자 패턴을 개별적으로 끄는 것(`remove`)은 허용하지만, 임의 정규식을 "안전하다"고 선언하는 길은 의도적으로 열어두지 않았습니다.

## Claude Desktop / Claude Code 연결

### Claude Desktop

한 줄로 끝내려면 [`install`](#install--클라이언트-등록)을 쓰세요. 플랫폼에 맞는 형태로 `claude_desktop_config.json`을 대신 편집하고, 기존 내용은 백업합니다.

```bash
npx @get-bot/ssh-mcp install claude-desktop
```

직접 편집하려면 `claude_desktop_config.json`에 다음을 추가합니다.

macOS/Linux:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": ["-y", "@get-bot/ssh-mcp"]
    }
  }
}
```

Windows (Claude Desktop은 셸 없이 서버를 스폰하므로 반드시 `cmd /c` 형태를 쓰세요 — [Windows](#windows) 절 참고):

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@get-bot/ssh-mcp"]
    }
  }
}
```

설정 후 Claude Desktop을 재시작하면 도구 목록에 정확히 9개가 나타나야 합니다.

### Claude Code

여기서도 [`install`](#install--클라이언트-등록)이 가장 짧은 길입니다. 내부적으로 `claude mcp add`를 실행합니다.

```bash
npx @get-bot/ssh-mcp install claude-code
```

직접 등록하려면:

```bash
claude mcp add ssh-mcp -- npx -y @get-bot/ssh-mcp
```

Windows에서도 위 형태 그대로 연결됩니다(2.1.270 실측 — Claude Code가 `npx.cmd`를 자체적으로 처리합니다). 구버전이거나 연결에 실패하면 감싼 형태를 쓰세요:

```bash
claude mcp add ssh-mcp -- cmd /c npx -y @get-bot/ssh-mcp
```

`/mcp`에서 같은 9개 도구가 보이는지 확인하세요.

## Windows

- **네이티브 빌드 도구가 없어도 됩니다.** `npm install --omit=optional`(또는 `npm ci --omit=optional`)로 선택적 네이티브 의존성 설치를 건너뛸 수 있습니다. `ssh2`는 순수 JS이므로 필수 기능에 영향이 없습니다.
- **셸 없이 서버를 띄우는 호스트에는 `npx`를 `command`로 직접 지정하지 마세요.** Windows에서 `npx`는 실제로 `npx.cmd` 배치 파일입니다. `child_process.spawn(cmd, args, { shell: false })`로 서버를 띄우는 호스트(Claude Desktop이 그렇습니다)에서는 `.cmd` 셸 확장자 연결이 적용되지 않아 스폰이 `ENOENT`로 실패합니다. `cmd /c npx ...`로 감싸면 `cmd.exe`가 `.cmd` 확장자를 직접 해석하므로 문제가 사라집니다. 이 사실은 CI의 `windows-spawn` 잡이 두 가지 스폰을 모두 재현해 검증합니다. 반면 **Claude Code 2.1.270은 감싸지 않은 `npx` 형태로도 연결됩니다**(Windows 11 실측) — 스폰을 자체적으로 처리하기 때문입니다.
- **`install`은 Windows에서 두 클라이언트 모두 `cmd /c` 형태로 등록합니다.** Claude Code가 bare `npx`도 받아들이더라도, 구버전 호환과 Claude Desktop과의 일관성을 위해 자동 경로는 한 가지 형태만 씁니다. [`install` 절](#install--클라이언트-등록)을 보세요.
- 연결이 안 될 때는 가장 먼저 `node dist/index.js doctor`(또는 `npx @get-bot/ssh-mcp doctor`)를 실행하세요. 15개 항목을 점검합니다.
- 키 디렉터리는 `icacls`로 하드닝됩니다. 계정 소유자와 `NT AUTHORITY\SYSTEM`을 제외한 모든 principal(상속된 `BUILTIN\Administrators` 포함)을 제거합니다. `setup` 중 하드닝이 실패하면 생성된 키를 정리하고 등록을 중단합니다.
- 원격 셸이 `cmd`나 `powershell`로 감지되면(즉 원격도 Windows OpenSSH인 경우) 상태 유지 세션(`open_session`)을 지원하지 않습니다. [원격 셸 지원 범위](#원격-셸-지원-범위)를 보세요.

## 대화형 프로그램은 지원하지 않습니다

v1은 PTY(가상 터미널)를 할당하지 않습니다. 그래서 화면을 다시 그리거나 실시간 키 입력을 기다리는 프로그램은 동작하지 않습니다.

명령이 대화형 프로그램으로 감지되면 `isError: true`, 오류 코드 `interactive_program_refused`와 함께 감지된 프로그램명과 대안이 반환됩니다. 판정은 두 그룹으로 나뉩니다.

**무조건 거부(21개).** 인자와 무관하게 항상 거부됩니다.

| 프로그램                                            | 대안                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `vim`, `vi`, `nvim`, `emacs`, `nano`, `pico`, `joe` | 파일을 `download`로 받아 로컬에서 편집한 뒤 `upload`. 또는 `cat > <file> <<'EOF' ... EOF`로 한 번에 작성 |
| `less`, `more`                                      | `sed -n '1,200p' <file>`, `head -n 200 <file>`, `tail -n 200 <file>`, `grep -n <패턴> <file>`            |
| `htop`, `btop`, `atop`, `iotop`                     | `ps aux --sort=-%cpu \| head -20` (배치 모드가 없어 `top`과 달리 항상 무조건 거부)                       |
| `man`                                               | `<명령> --help`, `<명령> -h`                                                                             |
| `watch`                                             | `run_in_session`을 반복 호출                                                                             |
| `tmux`, `screen`                                    | `open_session`이 호출 간 작업 디렉터리·환경변수를 유지해준다                                             |
| `dialog`, `whiptail`                                | 모든 응답을 커맨드라인 플래그로 직접 전달                                                                |
| `visudo`                                            | 검증된 파일을 `/etc/sudoers.d/<name>`에 업로드하고 `visudo -c -f <file>`로 검사                          |
| `passwd`                                            | `chpasswd <<< "<user>:<password>"` (여전히 관리자로 분류됨)                                              |

**조건부 거부(13개).** 인자 형태에 따라 대화형 여부가 갈립니다. 아래 조건을 만족하면 실행되고, 아니면 거부됩니다.

| 프로그램            | 거부 조건                                                                                        | 대안                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `top`               | `-b`, `-bn1`, `--batch-mode` 등 배치 플래그가 없으면 거부(있으면 한 번 출력하고 종료하므로 허용) | `top -b -n 1`, 이후 `ps aux --sort=-%cpu \| head -20`      |
| `mysql`             | `-e`/`--execute` 없으면 거부                                                                     | `mysql -e "<SQL>"`                                         |
| `psql`              | `-c`/`-f` 없으면 거부                                                                            | `psql -c "<SQL>"`, `psql -f <file>`                        |
| `redis-cli`         | 인자 없이 호출하면 거부                                                                          | `redis-cli <command>`, `redis-cli --scan`                  |
| `python`, `python3` | 스크립트나 `-c` 없이(REPL) 호출하면 거부                                                         | `python3 -c "<code>"`, 또는 스크립트 업로드 후 실행        |
| `node`              | 스크립트나 `-e` 없이 호출하면 거부                                                               | `node -e "<code>"`, 또는 스크립트 업로드 후 실행           |
| `irb`, `ruby`       | REPL 호출이면 거부                                                                               | `ruby -e "<code>"`                                         |
| `git`               | `commit`(메시지 플래그 없음), `rebase -i`, `add -i/-p`, `mergetool`, `difftool`                  | `-m`/`-F`/`--no-edit` 등 비대화형 플래그 사용              |
| `crontab`           | `-e`(편집기 실행)면 거부                                                                         | `crontab -l > /tmp/cron && <편집> && crontab /tmp/cron`    |
| `systemctl`         | `edit` 서브커맨드면 거부                                                                         | drop-in을 업로드하고 `systemctl daemon-reload`             |
| `ssh`               | 원격 명령 없이(로그인 셸) 호출하면 거부                                                          | 두 번째 호스트를 `ssh-mcp host add`로 등록하고 직접 `exec` |

**이 감지는 위험도 판정이 아닙니다.** 파괴적/관리자 분류와는 완전히 별개의 검사이며, 대화형 프로그램이 아니라는 이유로 명령이 "안전"으로 승격되지는 않습니다. 예를 들어 `mysql -e "DROP DATABASE prod"`는 이 검사를 통과하지만, 이어서 분류기가 관리자/파괴적 여부를 판단합니다.

## 백그라운드(`&`) 작업

최상위 세그먼트가 `&`로 끝나는 명령(예: `npm run dev &`)은 **거부하지 않고 실행**하지만, 응답에 `background_job: true`와 함께 다음 경고가 붙습니다.

> 이 명령은 백그라운드로 분리됐다. 이후 출력은 어느 호출에도 귀속되지 않으며 세션 종료 시 정리되지 않을 수 있다.

**출력 귀속은 v1에서 정의되지 않습니다.** 백그라운드로 넘어간 프로세스의 이후 stdout/stderr를 어떤 도구 호출과도 연결해 회수할 방법이 없습니다. 거부하지 않는 이유는 `&`가 정당한 운영 작업에 흔히 쓰이고, 거부하면 사용자가 `nohup ... &`처럼 서버가 알아채기 더 어려운 형태로 우회할 뿐이기 때문입니다.

## sudo

`sudo`는 **NOPASSWD가 설정된 서버에서만** 동작합니다. ssh-mcp는 sudo 비밀번호를 저장하지도, 입력받지도 않습니다(v1 비목표).

내부적으로 모든 실행 채널은 stdin을 항상 닫습니다. stdin이 닫힌 상태에서 `sudo`가 비밀번호를 요구하면 `sudo: no tty present and no askpass program specified` 류의 메시지와 함께 즉시 실패합니다. ssh-mcp는 이 실패 패턴을 감지해 원래 오류 대신 `sudo_password_required`를 반환합니다.

**명령 문자열은 어떤 경우에도 한 바이트도 변형하지 않습니다.** `sudo`에 `-n`을 자동으로 끼워 넣는 등의 재작성을 하지 않습니다 — 그런 재작성은 분류·승인의 대상과 실제 실행 대상을 어긋나게 만들 수 있기 때문입니다. `sudo -S`(stdin에서 비밀번호를 읽는 옵션)는 stdin이 닫혀 있어 반드시 실패할 것이 확실하므로 분류 단계에서 미리 `sudo_password_required`로 거부합니다.

## 바이너리 출력

stdout/stderr가 유효한 UTF-8이 아니면 해당 스트림을 base64로 인코딩해 반환하고, 응답에 `encoding: "base64"`를 포함합니다. UTF-8이면 `encoding: "utf8"`입니다. 비-UTF-8 출력에서는 줄 기반 발췌가 의미가 없으므로 앞·뒤를 **바이트** 단위로 보존하며 `omitted_lines: null`, `omitted_bytes`는 정확한 값을 반환합니다.

## format: "json" 구조화 출력

`exec`와 `run_in_session`은 `format` 인자를 받습니다. 기본값은 `"text"`이고, 그때 서버는 명령 문자열을 한 바이트도 건드리지 않으며 응답에 `parsed`·`parse_error` 필드가 **아예 추가되지 않습니다**.

`format: "json"`을 주면 아래 표에 있는 **단일 명령**에 한해 서버가 그 도구의 JSON 출력 플래그를 붙여 실행하고, stdout을 파싱해 `parsed`에 함께 담습니다.

| 명령                                                  | 재작성                                    | 파싱           |
| ----------------------------------------------------- | ----------------------------------------- | -------------- |
| `docker container ls`, `docker ps`, `docker images`   | 끝에 `--format json`                      | `JSON.parse`   |
| `docker inspect`                                      | 없음(이미 JSON)                           | `JSON.parse`   |
| `systemctl list-units`, `list-timers`, `list-sockets` | 끝에 `--output=json`                      | `JSON.parse`   |
| `journalctl`                                          | 끝에 `-o json`                            | `JSON.parse`   |
| `lsblk`                                               | 끝에 `-J`                                 | `JSON.parse`   |
| `ip addr`, `ip link`, `ip route`                      | `ip` 바로 뒤에 `-j` **삽입**              | `JSON.parse`   |
| `df`                                                  | 플래그를 `-P`로 교체, **피연산자는 유지** | 고정 컬럼 파서 |
| `ps`                                                  | 전체를 `ps -eo <컬럼>`으로 교체           | 고정 컬럼 파서 |

표에 없는 명령(`docker rm` 등)은 재작성 대상이 아닙니다. `docker`에 하위 명령 없는 항목을 두지 않은 것은 의도적입니다 — `docker rm`이 조용히 플래그를 얻는 일이 없어야 합니다.

**`ip`만 삽입인 이유.** iproute2는 `ip [OPTIONS] OBJECT {COMMAND}`를 파싱하면서 대시로 시작하지 않는 첫 단어에서 옵션 읽기를 멈춥니다. `ip addr -j`는 `-j`가 주소 명령의 인자로 넘어가 장치 이름으로 해석되고 실패합니다. 나머지 프로그램은 플래그를 끝에 받아들입니다.

**이미 같은 플래그를 준 경우**에는 재작성분이 뒤에 한 번 더 붙습니다(`docker ps --format '{{.Names}}'` → `docker ps --format '{{.Names}}' --format json`). 이는 해당 도구들이 같은 플래그를 여러 번 받으면 **마지막 값을 쓰는** 동작에 기댄 설계입니다. `lsblk -J`, `ip -j`, `systemctl --output=json`처럼 한 토큰으로 이미 지정된 형태는 중복을 붙이지 않고 건너뜁니다.

**`df`와 `ps`만 파서가 따로 있는 이유.** 두 명령에는 JSON 출력 모드가 어느 구현에도 없습니다. 그래서 출력 형태가 고정되는 형태로 정규화한 뒤 고정 컬럼 파서로 읽습니다. `df`는 `-P`(POSIX 출력)로 맞추는데, 이 모드의 보장이 "파일시스템 하나당 한 줄"이고 헤더 문구와 컬럼 수까지 GNU·busybox·BSD에서 같아지기 때문입니다. 블록 단위는 구현마다 달라(`-P`에서 GNU·busybox는 1024바이트, BSD는 512바이트) 헤더의 `<N>-blocks`에서 읽어 `block_size_bytes`로 함께 돌려줍니다. `ps`의 컬럼 목록은 `src/output/tables.ts`의 `PS_COLUMNS`가 정본이며, 이 문서에 문자열을 옮겨 적지 않습니다.

**재작성된 명령이 분류·승인·감사·실행의 대상입니다.** 승인 창에 보이는 문자열, 감사 줄의 `command`, 실제로 원격에서 도는 문자열이 모두 같습니다. 재작성이 등급을 바꾸지 않는다는 것(예: `sudo df -h` → `sudo df -P`는 여전히 관리자 등급)은 표의 모든 항목에 대해 테스트로 고정돼 있습니다.

**재작성하지 않는 경우.** 명령에 파이프·리다이렉트·`;`·`&&`·`||`·서브셸이 있으면 손대지 않고 **원문 그대로 실행**한 뒤 `parsed: null`, `parse_error: "not_rewritable"`을 돌려줍니다. 표에 없는 명령도 같습니다. 어느 경우든 `stdout`에는 실행 결과가 정상적으로 담기므로, 잃는 것은 `parsed` 하나뿐입니다.

**파싱 입력은 발췌 상한과 무관한 전체 stdout입니다.** 응답의 `stdout`이 발췌로 잘렸더라도 파서는 잘리기 전 전문을 읽습니다. 다만 두 개의 상한이 있습니다.

- stdout이 `min(4 × maxOutputBytes, 4 MiB)`를 넘으면 파싱을 포기하고 `parse_error: "too_large"`.
- 파싱은 됐지만 `parsed`를 직렬화한 크기가 `min(2 × maxOutputBytes, 4 MiB)`를 넘으면 싣지 않고 `parse_error: "parsed_too_large"`. 데이터가 있는데 봉투가 작은 경우이므로 명령 범위를 좁히면 됩니다.

**`parsed`에도 리댁션이 적용됩니다.** 민감한 키 이름(`password`·`token` 등)은 `[redacted]`로, 문자열 안의 개인키 블록은 마스킹됩니다. 다만 로그용 리댁션과 달리 문자열을 2 KiB에서 자르지 않고 중첩 깊이 상한도 64입니다 — `docker inspect` 결과가 잘려 깨진 JSON이 되는 것을 막기 위한 것입니다.

## 출력 보관과 `fetch_output`

발췌(§[바이너리 출력](#바이너리-출력) 위의 출력 상한)로 잘린 스트림은 v1에서 그냥 사라졌습니다. v1.1부터는 잘린 스트림의 **전문**이 서버 메모리에 남고, 응답의 `stdout_meta.output_ref`/`stderr_meta.output_ref`로 `fetch_output`에 넘길 수 있습니다.

```
exec → stdout_meta: { truncated: true, output_ref: "…", total_bytes: 9876543 }
     → fetch_output { output_ref, cursor: 0 }      → { chunk, next_cursor: 65536, … }
     → fetch_output { output_ref, cursor: 65536 }  → { chunk, next_cursor: null, … }
```

- **한 번에 읽는 양**은 `max_bytes`로 정하며 기본 64 KiB, 최소 1 KiB, 최대 1 MiB입니다.
- **페이징 종료 판정은 `next_cursor === null`**입니다.
- **`chunk`의 인코딩은 `encoding` 필드를 따릅니다** — UTF-8 스트림이면 텍스트, 발췌기가 비-UTF-8로 판정한 스트림이면 base64입니다. `exec` 응답과 같은 규칙이므로 디코딩 방법도 같습니다.
- **`fetch_output`의 `total_bytes`와 `stdout_meta.total_bytes`는 다른 양입니다.** 앞은 마스킹을 마친 보관 버퍼의 길이이고, 뒤는 원격에서 실제로 흘러온 와이어 바이트입니다. 마스킹이 길이를 바꾸므로 두 값이 다를 수 있습니다.

보관의 성질은 다음과 같습니다.

- **메모리에만 있고 디스크에 쓰지 않습니다.** 이 경로에는 파일을 여는 코드가 없습니다.
- **10분**이 지나면 폐기됩니다. 서버를 재시작해도 사라집니다. 만료·폐기·재시작 뒤의 조회는 `output_expired`이며, 그때는 명령을 다시 실행해야 합니다.
- **총량 64 MiB**를 넘으면 가장 오래된 항목부터 버립니다.
- **스트림 하나당 상한은 `min(4 × maxOutputBytes, 16 MiB)`**입니다. 이 상한을 넘긴 스트림은 보관하지 않으므로, `truncated: true`인데도 `output_ref`가 `null`일 수 있습니다.
- **개인키 블록은 보관 시점에 한 번 마스킹됩니다.** 페이지 경계가 개인키를 가로질러도 어느 페이지에도 키 바이트가 나오지 않게 하기 위해서이며, 그 외의 리댁션은 적용하지 않습니다.
- **`output_ref`는 추측할 수 없고(128비트 난수) 응답 외에는 어디에도 기록되지 않습니다.** 감사 줄에도 넣지 않습니다.
- **`close_session`이나 세션 만료는 보관 출력을 폐기하지 않습니다.** 수명은 위의 TTL 규칙만 따릅니다.

## 오류 코드

도구 응답의 `error` 필드에 담기는 코드입니다. `confirmation_required`만 `isError: false`인 정상 흐름이고 나머지는 `isError: true`입니다.

| 코드                                                                                                                    | 의미                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config_invalid`                                                                                                        | `hosts.json` 파싱/검증 실패                                                                                                                                         |
| `host_not_found`                                                                                                        | 등록되지 않은 alias                                                                                                                                                 |
| `host_key_mismatch`                                                                                                     | 핀 고정된 호스트 키 지문과 불일치                                                                                                                                   |
| `connection_failed`                                                                                                     | TCP 연결 또는 SSH 핸드셰이크가 인증 전에 실패(호스트에 닿지 않음, 포트 거부, 프로토콜 오류). `auth_failed`(자격증명 거부)나 내부 오류와 원인을 구분하기 위한 코드다 |
| `auth_failed`                                                                                                           | 공개키 인증 실패                                                                                                                                                    |
| `command_denied`                                                                                                        | `deny` 모드이거나, 사람이 elicitation 확인창에서 명시적으로 거절함                                                                                                  |
| `approval_unavailable`                                                                                                  | `approvalFallback: "fail-closed"`인 호스트에서 클라이언트가 elicitation을 지원하지 않음                                                                             |
| `confirmation_required`                                                                                                 | 2단계 승인 시작(오류 아님)                                                                                                                                          |
| `confirmation_token_invalid` / `confirmation_token_used` / `confirmation_token_expired` / `confirmation_token_mismatch` | 토큰 검증 실패 — `command_denied`와는 별개 코드다([승인 모드](#승인-모드) 참고)                                                                                     |
| `interactive_program_refused`                                                                                           | 대화형 프로그램으로 감지됨                                                                                                                                          |
| `command_timeout`                                                                                                       | 실행 시간 초과                                                                                                                                                      |
| `command_too_long`                                                                                                      | 명령이 8192자를 초과                                                                                                                                                |
| `session_not_found` / `session_expired` / `session_terminated` / `session_limit_exceeded`                               | 세션 관련 오류                                                                                                                                                      |
| `shell_incompatible`                                                                                                    | POSIX 계열로 보이지만 마커 핸드셰이크가 실패함                                                                                                                      |
| `unsupported_shell`                                                                                                     | 셸이 fish/cmd/powershell로 감지됨                                                                                                                                   |
| `local_file_exists`                                                                                                     | `download`가 `overwrite` 없이 기존 파일과 충돌                                                                                                                      |
| `local_path_forbidden`                                                                                                  | `upload`/`download`의 `local_path`가 `~/.ssh-mcp` 내부(설정·키·감사 파일)로 해석됨. 모델이 자기 설정을 덮어쓰지 못하게 막는 하드 블록 — 승인 여부와 무관하게 거부   |
| `sftp_failed`                                                                                                           | SFTP 오류                                                                                                                                                           |
| `sudo_password_required`                                                                                                | `sudo`가 비밀번호를 요구함(NOPASSWD 아님)                                                                                                                           |
| `alias_exists`                                                                                                          | `--force` 없이 기존 alias로 `setup` 실행                                                                                                                            |
| `history_cursor_stale`                                                                                                  | `history`의 `cursor`가 가리키던 위치를 감사 로그 회전으로 이어받을 수 없음. `cursor` 없이 다시 조회하세요                                                           |
| `output_expired`                                                                                                        | `fetch_output`의 `output_ref`가 만료(10분)·폐기(총량 상한)됐거나 서버가 재시작됨. 명령을 다시 실행해야 합니다                                                       |
| `internal_error`                                                                                                        | 예상 밖 내부 오류(버그). 재현 정보와 함께 이슈로 보고하세요                                                                                                         |

### `parse_error`

`format: "json"` 호출에서만 나타나는 별도의 필드입니다. 오류 코드가 아니라 **`parsed`가 비어 있는 이유**이며, 이 값이 있어도 응답 자체는 정상이고 `stdout`에는 실행 결과가 그대로 담깁니다. 정의역은 여덟 개이고 정본은 `src/tools/gated.ts`의 `ParseErrorReason`입니다.

| 값                    | 무슨 일이 있었나                                              | 다음 수                                                                    |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `not_rewritable`      | 파이프·리다이렉트·`;`·`&&`·서브셸이 있어 원문 그대로 실행됐다 | 단일 명령으로 다시 부르거나, 그냥 `stdout`을 읽는다                        |
| `too_large`           | stdout이 파싱 상한을 넘었다                                   | 명령 범위를 좁히거나, 발췌를 읽고 나머지는 `fetch_output`으로 넘긴다       |
| `invalid_json`        | 명령은 돌았지만 JSON이 아닌 것을 출력했다                     | 대개 원격 도구가 그 플래그를 모르는 구버전이다 — `format: "text"`로 읽는다 |
| `parsed_too_large`    | 파싱은 됐지만 결과가 응답에 들어가지 않는다                   | 명령 범위를 좁힌다. 데이터는 있고 봉투가 작다                              |
| `output_not_retained` | 서버가 stdout을 보관하지 않아 파싱할 바이트가 없었다          | **호출자가 할 수 있는 것이 없다** — 아래를 보세요                          |
| `empty_output`        | 헤더 줄조차 없다. 대개 명령 자체가 실패했다                   | `exit_code`와 `stderr`를 읽는다. `format`의 문제가 아니다                  |
| `header_unrecognized` | 표 헤더가 정규화된 그 형태가 아니다                           | `format: "json"`은 같은 방식으로 또 실패한다 — `format: "text"`를 쓴다     |
| `row_unparsable`      | 헤더는 맞았는데 행 하나가 어긋났다                            | 읽기가 중간에 끊긴 경우가 많아 같은 호출이 다시 성공하기도 한다            |

**`output_not_retained`만 성격이 다릅니다.** 나머지 일곱은 명령이나 그 출력에 대한 설명이고 호출자에게 다음 수가 남아 있습니다 — 범위를 좁히거나, 다시 부르거나, `format: "text"`로 내려가거나, `stderr`를 읽거나. 이 값은 **서버 쪽 결함**을 가리킵니다. 파싱 경로를 배선하면서 파싱할 바이트를 남기지 않은 상태라, 재시도해도 같은 값이 돌아오고 `format`을 무엇으로 바꿔도 마찬가지입니다. 같은 사건이 서버 로그에 `error` 레벨로 남으며, 해결은 다른 요청이 아니라 코드 수정입니다.

## 보안 모델

- **서버가 실제로 강제할 수 있는 것은 두 가지뿐입니다.** 호스트의 `approvalFallback: "fail-closed"`, 그리고 Claude Code에서만 동작하는 `_meta`의 `anthropic/requiresUserInteraction`. 그 외의 모든 승인 전달은 클라이언트 쪽 UI를 신뢰하는 구조입니다. [승인 모드](#승인-모드) 표를 참고하세요.
- **`ask-all` + `fail-closed` 호스트에서 클라이언트가 elicitation을 지원하지 않으면 안전 명령을 포함해 모두 `approval_unavailable`로 거부됩니다**(자가 승인 가능한 토큰을 발급하지 않습니다). `ask-all`은 "사람에게 물을 수 없으면 무엇이든 거부한다"는 뜻이므로 안전 등급도 예외가 아닙니다. 더 느슨한 동작이 필요하면 그 호스트를 `ask-destructive`나 `approvalFallback: "token"`으로 설정하세요.
- **Claude Desktop 사용자는 `exec`와 `run_in_session`에 "항상 허용(always allow)"을 설정하지 마세요.** 이 두 도구는 서버가 강제로 확인을 요구하도록 설계됐고, Desktop에서 always-allow를 걸면 그 설계 의도가 무력화됩니다.
- **프로덕션 호스트에는 `"approvalFallback": "fail-closed"`를 권장합니다.** `token` 모드는 Desktop처럼 elicitation을 지원하지 않는 클라이언트에서 파괴적/관리자 명령을 계속 쓸 수 있게 하는 완화책이지만, 그 경로에서는 서버가 사람의 승인을 검증할 수 없습니다(응답의 `server_cannot_verify_human_approval: true` 필드가 이 사실을 명시합니다). 사람 개입은 전적으로 Desktop 자체의 도구 승인 대화상자에 의존합니다.
- **토큰은 프로세스 메모리에만 있습니다.** 서버를 재시작하면 발급된 모든 `confirmation_token`이 무효가 됩니다. 토큰은 명령 문자열과 호스트에 바인딩된 1회용입니다.
- **도구 어노테이션(`readOnlyHint`, `destructiveHint` 등)은 힌트일 뿐 보안 경계가 아닙니다.** MCP SDK 자체가 "신뢰할 수 없는 서버의 어노테이션을 클라이언트가 신뢰해서는 안 된다"고 명시합니다. 차단은 전적으로 서버 내부의 분류·승인 로직이 담당합니다. 예외적으로 `_meta`의 `requiresUserInteraction`은 Claude Code에서는 실제 강제력이 있지만, 이것도 Claude Code 한정이며 다른 호스트는 무시합니다.
- **잘린 출력은 메모리에만, 10분간, 개인키 블록을 마스킹해 보관합니다.** 디스크에는 기록하지 않고 총량은 64 MiB로 묶이며 오래된 것부터 버려집니다. 이 보관본을 가리키는 `output_ref`는 128비트 난수이고 응답 외에는 어디에도 — 감사 줄에도 — 기록되지 않습니다. 자세한 규칙은 [출력 보관과 fetch_output](#출력-보관과-fetch_output)에 있습니다.
- **`connect`/`exec` CLI는 이 문서의 승인·감사 모델 밖입니다.** 사람이 직접 치는 경로이고 시스템 `ssh`에 위임하므로 분류·승인·감사가 적용되지 않으며, 호스트 키도 `known_hosts`를 따릅니다. 반대로 **MCP 서버 경로는 시스템 `ssh`의 존재 여부와 무관합니다** — 서버·도구·SSH 전송 계층은 그 코드를 import 할 수 없도록 ESLint로 막혀 있습니다. [connect / exec](#connect--exec--터미널에서-직접-쓰기) 절을 보세요.
- **감사 파일은 명령 문자열을 담으며 모드 `0600`입니다.** `auditMode: "metadata-only"`로 바꾸면 명령 문자열 자체는 기록하지 않지만 등급·승인 결과·바이트 수 등 나머지 필드는 그대로 남습니다.
- **감사 쓰기 실패는 도구 호출을 막지 않습니다.** 감사 파일에 쓰지 못해도(디스크 가득 참 등) `warn` 로그만 남기고 원래 도구 호출은 계속 성공 처리됩니다. 감사가 가용성보다 우선하지 않는다는 트레이드오프입니다.
- **Windows 원격 셸에서는 분류 커버리지가 축소됩니다.** 내장 파괴적/관리자 패턴은 POSIX 셸 문법을 전제로 만들어졌으므로, 원격 로그인 셸이 `cmd`나 `powershell`로 감지되면 `del /s /q`, `Remove-Item -Recurse -Force` 같은 명령이 `safe`로 판정될 수 있습니다. 이런 호스트에서는 `exec`/`run_in_session` 응답과 `doctor` 진단에 `classification_coverage: "reduced"` 표시가 붙습니다.

## 알려진 한계

구현 중 남기기로 결정한 잔여 위험입니다. 버그가 아니라 트레이드오프이며, 어디에서도 조용히 감춰지지 않습니다.

- **비밀번호는 ssh2 내부에서 JS 문자열이 됩니다.** `setup`이 읽어들인 비밀번호는 `Buffer`로 보관되며 사용 후 `fill(0)`으로 지웁니다. 하지만 `ssh2` 1.17.0의 `ConnectConfig`가 `password` 필드로 문자열만 받기 때문에, 접속 시점에 그 버퍼 내용을 문자열로 한 번 복사합니다. JavaScript 문자열은 불변이라 이 복사본은 `fill(0)`으로 지울 수 없고 가비지 컬렉터가 수거할 때까지 메모리에 남습니다. 원본 버퍼는 여전히 지워지므로 노출 범위는 제한되며, 이 잔여 위험을 없애려면 ssh2가 `Buffer`를 받아들여야 합니다(현재는 받지 않습니다).
- **감사 로그 쓰기는 원자적이지 않습니다.** 한 줄을 16 KiB로 제한해 쪼개질 확률은 낮추지만, 이는 원자성 보장이 아니라 실용적 완화입니다. 같은 `SSH_MCP_HOME`을 공유하는 서버 프로세스 2개가 동시에 쓰면 줄이 섞일 수 있습니다. ssh-mcp는 로컬 PC 한 대에 개인 서버 키를 두고 쓰는 단일 사용자 도구를 목표로 하므로 v1에서는 이 위험을 감수합니다. 실제로 섞임이 관측되면 프로세스별 감사 파일(`audit-<pid>.jsonl`) 분리가 v1.1 후보입니다.
- **감사 쓰기 실패는 도구 호출을 막지 않습니다** (앞서 [보안 모델](#보안-모델)에도 있는 내용). 드물게 쓰기가 실패하면(디스크 가득 참 등) 그 호출의 감사 줄 한 개가 누락되고 `warn` 로그만 남습니다.
- **`format: "json"`에서 `ps`는 선택 범위가 전체 프로세스로 넓어지고, `df`는 반대로 피연산자를 지킵니다.** 두 명령을 나란히 보면 규칙이 하나로 읽힙니다. `df -h /var`는 `df -P /var`가 되어 "어느 파일시스템을 물었는지"가 남지만, `ps -p 123`도 `ps aux`도 똑같이 전체 프로세스 목록을 내는 형태로 정규화됩니다. `df`는 플래그(`-h`)와 피연산자(`/var`)가 문법으로 구분되는 반면, `ps`는 선택 플래그(`-e`·`-p`·`-u`)와 포맷 플래그(`-o`)가 같은 인자 문법이고 BSD 문법(`ps aux`)에는 대시조차 없어서 "플래그만 버리고 피연산자는 남긴다"를 적용할 대상이 없기 때문입니다. **특정 프로세스만 보려면 `format: "text"`로 두세요.** 컬럼 목록에 경과시간(`etime`)과 CPU(`pcpu`)가 없는 것도 같은 성격의 타협입니다 — busybox에서 그 키워드들은 빌드 옵션에 따라 없을 수 있고, 없는 키워드는 컬럼 하나가 비는 것이 아니라 **명령 자체의 실패**가 됩니다. 임의의 원격 호스트를 상대하는 도구이므로 빌드에 따라 달라지는 키워드를 쓰지 않습니다.
- **`format: "json"`에서 따옴표·이스케이프된 인자를 가진 `df`는 재작성하지 않습니다.** `df -h "/mnt/my disk"`는 원문 그대로 실행되고 `parsed: null` + `parse_error: "invalid_json"`이 됩니다(고정 컬럼 파서로 가지 않고 `JSON.parse`로 떨어지기 때문입니다). **`stdout`에는 실제 출력이 정상적으로 담기므로 잃는 것은 `parsed` 하나뿐입니다.** 분류기의 토큰에 원문 위치 정보가 없어 따옴표 친 단어가 원문 어디에 있는지 찾을 수 없고, 토큰 값으로 다시 조립하면 `$MOUNT` 같은 확장이 죽습니다. 남은 선택지는 "피연산자를 버리고 전체 파일시스템을 보고하기"와 "`parsed`를 포기하기" 둘뿐인데, 묻지 않은 질문에 성공적으로 답하는 쪽이 더 나쁘다고 판단했습니다.
- **타임아웃된 `exec`의 원격 프로세스 정리는 POSIX 원격에서만 동작합니다.** sshd는 세션 채널의 SSH `signal` 요청을 무시하고 pty 없는 채널이 닫혀도 자식이 죽지 않으므로, 서버는 타임아웃 뒤 `pkill -TERM -P <pid>`와 `kill -TERM <pid>`를, 유예 후 다시 `KILL`로 보냅니다. `pkill`이 없는 원격(스톡 `ubuntu:24.04`에는 `procps`가 없습니다)에서는 `kill`만으로 축소되며 연결당 한 번 알립니다. 원격 로그인 셸이 `cmd`나 PowerShell이면 이 정리는 적용되지 않습니다.
- **잘린 출력을 보관하는 동안 메모리를 더 씁니다.** 명령이 도는 내내 방향마다 하나씩, 스트림당 최대 `min(4 × maxOutputBytes, 16 MiB)`의 버퍼가 살아 있습니다. 한 호스트에 세션 5개를 동시에 열고 모두 큰 출력을 내면 출력 보관소의 64 MiB와 **별개로** 최대 약 160 MiB가 더 필요할 수 있습니다. 호스트의 `maxOutputBytes`를 낮추면 이 값도 함께 내려갑니다.
- **`SSH_MCP_REQUIRE_USER_INTERACTION=0`은 Claude Code의 프롬프트 강제를 끕니다.** 이 환경변수를 설정하면 `exec`/`run_in_session`의 `_meta` 힌트가 빠져, Claude Code에서 always-allow를 걸어 둔 경우 더 이상 매 호출마다 확인창이 뜨지 않습니다. **`approvalFallback: "token"`으로 설정한 호스트와 이 옵션을 함께 쓰지 마세요.** `token` 경로는 애초에 서버가 사람의 승인을 검증할 수 없다는 전제 위에 있고(§[보안 모델](#보안-모델)), Claude Code의 강제 프롬프트가 사실상 그 호스트에 남은 유일한 클라이언트 측 방어선인 경우가 많습니다. 둘을 같이 쓰면 그 방어선마저 사라집니다.

## 감사 로그

경로: `~/.ssh-mcp/audit.jsonl` (Windows: `%USERPROFILE%\.ssh-mcp\audit.jsonl`). 생성 시 모드 `0600`(Windows는 `icacls` 하드닝 대상).

한 도구 호출마다 성공·실패·거부와 무관하게 정확히 한 줄이 추가됩니다. 2단계 토큰 승인(요청 → 재호출)은 두 줄로 남습니다.

| 필드                                  | 설명                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                       | 항상 `1`. `history` 도구가 v1/v1.1 혼재 파일을 읽을 수 있게 한다. 값이 다른 줄은 읽지 않고 `skipped.unknown_schema`로만 셉니다 |
| `ts`                                  | ISO 8601 UTC, 밀리초                                                                                                           |
| `tool`                                | 9개 도구 이름 중 하나                                                                                                          |
| `host`                                | alias 또는 `null` (`run_in_session`/`close_session`은 `session_id`로 역조회)                                                   |
| `session_id`                          | 문자열 또는 `null`                                                                                                             |
| `command`                             | 리댁션 통과 문자열, 2 KiB 절단. `auditMode: "metadata-only"`면 `null`                                                          |
| `command_grade`                       | `safe` / `privileged` / `destructive` / `null`                                                                                 |
| `reasons`                             | 매칭된 패턴 id 배열                                                                                                            |
| `approval_mode`                       | 호출 시점 호스트의 `approvalMode`                                                                                              |
| `approval_outcome`                    | 아래 8개 값 중 하나                                                                                                            |
| `approval_fallback`                   | `token` / `fail-closed` / `null`                                                                                               |
| `server_cannot_verify_human_approval` | `approval_outcome === "token-approved"`일 때 `true`                                                                            |
| `exit_code`                           | 숫자 또는 `null`                                                                                                               |
| `error_code`                          | 오류 코드 또는 `null`                                                                                                          |
| `exec_duration_ms`                    | 실제 원격 실행 시간(ms)                                                                                                        |
| `approval_wait_ms`                    | 승인 대기 시간(ms). 느린 실행과 사람의 긴 고민 시간을 구분하기 위해 별도 필드로 둔다                                           |
| `stdout_bytes` / `stderr_bytes`       | 발췌 전 원본 총 바이트                                                                                                         |
| `truncated`                           | 발췌 여부                                                                                                                      |
| `normalized_command` / `segments`     | 분류기가 실제로 매칭에 쓴 정규화 문자열·세그먼트. `metadata-only`면 `null`                                                     |
| `client`                              | `{name, version}` 또는 `null`                                                                                                  |
| `audit_mode`                          | 이 줄이 기록된 모드(`full`/`metadata-only`)                                                                                    |

**`approval_outcome`의 8개 값**: `not-required`, `auto`, `elicitation-approved`, `token-approved`, `pending-confirmation`, `declined`, `denied`, `approval_unavailable`.

**출력 본문은 기록하지 않습니다.** 바이트 수만 남습니다.

**회전.** 10 MiB를 넘으면 회전합니다(`.3` 삭제 → `.2`를 `.3`으로 → `.1`을 `.2`로 → 본체를 `.1`로). 총 4개 파일, 최대 약 40 MiB. 한 줄은 16 KiB로 제한되며, 넘치면 `command` → `segments` → `normalized_command` → `reasons` 순으로 잘립니다.

**모델은 `history` 도구로 이 로그를 읽습니다.** 회전된 파일까지 이어 읽으므로 사람이 `jq`로 네 파일을 붙이는 것과 같은 결과를 한 번에 얻습니다.

```jsonc
// 최근 20줄
{ "limit": 20 }

// 특정 호스트에서 파괴적으로 분류된 호출만
{ "host": "web1", "grade": "destructive" }

// 어제 하루, 사람이 거절한 것만
{ "since": "2026-09-16T00:00:00Z", "until": "2026-09-16T23:59:59Z", "outcome": "declined" }

// 다음 페이지 — 직전 응답의 next_cursor를 그대로 넘긴다
{ "host": "web1", "cursor": "<next_cursor>" }
```

`limit`은 기본 50, 최대 200입니다. 응답은 `{ entries, next_cursor, skipped }`입니다. **`entries`가 비었다고 끝난 것이 아닙니다** — 필터가 좁으면 한 페이지를 다 읽고도 걸리는 줄이 없을 수 있으므로, 종료 판정은 `next_cursor === null`로 합니다. 한 번의 호출이 훑는 줄 수에는 상한이 있어서(10,000줄), 그 전에 `limit`을 채우지 못해도 커서를 주고 돌아옵니다. 깨져서 읽을 수 없는 줄은 건너뛰고 개수만 `skipped`에 `invalid_json`/`unknown_schema`로 보고하며 원문은 싣지 않습니다. 감사 파일이 회전해 커서가 가리키던 자리를 이어받을 수 없으면 틀린 페이지를 주는 대신 `history_cursor_stale`로 실패합니다 — 그때는 `cursor` 없이 다시 조회하세요.

사람이 직접 읽을 때는 `jq`가 그대로 편합니다.

```bash
# 최근 20개 호출의 도구/승인 결과
jq -r '.tool + " " + .approval_outcome' ~/.ssh-mcp/audit.jsonl | tail -20

# 파괴적으로 분류된 호출만
jq -c 'select(.command_grade == "destructive")' ~/.ssh-mcp/audit.jsonl

# 승인 결과별 집계
jq -r '.approval_outcome' ~/.ssh-mcp/audit.jsonl | sort | uniq -c | sort -rn
```

## 진단 (`ssh-mcp doctor`)

```bash
npx @get-bot/ssh-mcp doctor
npx @get-bot/ssh-mcp doctor --json
npx @get-bot/ssh-mcp doctor --patterns
```

**연결이 안 되면 가장 먼저 이 명령을 돌리세요.** 결과는 stdout에 출력됩니다(서버 모드가 아니므로 stdout을 JSON-RPC 전용으로 쓸 필요가 없습니다).

| #   | 항목                                      | 비고                                                                                                                                                                                                                                   |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Node 버전 ≥ 20                            | 미만이면 FAIL. 서버는 Node 20이면 동작하지만, 대화형 질문(`install`·`host add`)은 `@inquirer`가 요구하는 20.17 이상이 필요합니다                                                                                                       |
| 2   | `ssh2` 로드                               | 네이티브 `cpu-features` 바인딩 유무는 정보로만 표시                                                                                                                                                                                    |
| 3   | `~/.ssh-mcp/` 레이아웃                    | 없지만 생성 가능하면 PASS(신규 설치). 생성도 불가할 때만 FAIL                                                                                                                                                                          |
| 4   | 디렉터리·키 파일 권한                     | POSIX `0700`/`0600` 확인. Windows는 등록된 개인키가 하나도 없으면 **`icacls`를 실행하지 않고 PASS**(아직 `setup`을 안 한 새 머신을 FAIL로 만들지 않기 위함) — 개인키가 있으면 `icacls`로 ACL을 읽어 확인                               |
| 5   | `hosts.json` 스키마                       | 파싱/zod 검증 실패 시 FAIL, issue 경로 표시                                                                                                                                                                                            |
| 6   | `audit.jsonl` 쓰기 가능                   | 현재 크기·회전 파일 수 함께 표시                                                                                                                                                                                                       |
| 7   | 호스트별 키 파일 존재·권한                | 파일 없으면 FAIL                                                                                                                                                                                                                       |
| 8   | 호스트별 TCP 연결(5초)                    | 실패 시 FAIL                                                                                                                                                                                                                           |
| 9   | 호스트별 호스트 키 지문 일치              | 불일치 시 FAIL                                                                                                                                                                                                                         |
| 10  | 호스트별 키 전용 인증                     | 인증 실패 시 FAIL. **명령은 실행하지 않는다**                                                                                                                                                                                          |
| 11  | 호스트별 승인 설정                        | FAIL 없음. `auto`/`token`/필드 누락은 WARN                                                                                                                                                                                             |
| 12  | 마지막 클라이언트의 elicitation 지원 여부 | FAIL 없음. 기록 없으면 "미기록"                                                                                                                                                                                                        |
| 13  | 원격 셸 분류 커버리지                     | FAIL 없음. `cmd`/`powershell`로 관측된 호스트는 WARN, 미관측은 "미확인" 정보 행                                                                                                                                                        |
| 14  | 분류 패턴 목록                            | 항상 PASS(정보 행). `--patterns`로 단독 출력 가능                                                                                                                                                                                      |
| 15  | 호스트 설정 스니펫 출력                   | 항상 PASS. Windows에서는 `cmd /c` 변형도 함께 출력. 표 출력에는 [`install`](#install--클라이언트-등록) 자동 등록 안내 한 줄이 스니펫 뒤에 붙습니다(`--json` 페이로드에는 없음)                                                         |
| 16  | 시스템 `ssh` 실행 파일                    | **FAIL이 없는 정보 행**입니다. `ssh`가 있으면 경로를, 없으면 [`connect`/`exec`](#connect--exec--터미널에서-직접-쓰기)만 못 쓴다는 안내를 표시합니다. MCP 서버와 도구 9개는 `ssh` 없이 동작하므로 이 항목은 실패 개수에 잡히지 않습니다 |

**종료 코드.** FAIL이 하나라도 있으면 `1`, 없으면 `0`. WARN은 종료 코드에 영향을 주지 않습니다.

`--json`은 `{ ok, checks: [{ id, name, status, detail }], snippets }` 형태로 같은 결과를 stdout에 출력합니다.

### 알려진 의존성 이슈

**ssh2 1.17.0의 ed25519 키 생성 결함.** `utils.generateKeyPairSync('ed25519')`가 대략 130회에 1회(약 0.7%) 확률로 손상된 키 쌍을 반환합니다(인코딩된 본문이 3바이트 짧게 나와 파싱에 실패합니다). `ssh-mcp host add`는 키를 생성한 직후 양쪽 반쪽을 다시 파싱하고, 개인키에서 유도한 공개키 지문이 공개키 반쪽의 지문과 일치하는지 확인한 뒤에만 그 키 쌍을 디스크에 기록합니다. 검증에 실패하면 최대 12회까지 재생성을 시도하며, 그래도 전부 실패하면 `internal_error: …` 메시지와 종료 코드 1로 중단하며 아무것도 기록하지 않습니다 — 이 경우 사용자는 `setup`을 다시 실행하면 됩니다.

## 원격 셸 지원 범위

`open_session`은 접속 직후 짧은 프로브로 원격 로그인 셸을 자동 감지합니다.

| 분류   | 셸                                        | 상태 유지 세션(`open_session`)                                               |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------- |
| 지원   | `bash`, `zsh`, `sh`/`dash`, busybox `ash` | 지원                                                                         |
| 미지원 | `fish`                                    | `unsupported_shell` 오류. `exec` 도구는 셸과 무관하게 계속 동작함            |
| 미지원 | Windows `cmd`, PowerShell                 | `unsupported_shell` 오류. `classification_coverage: "reduced"`가 함께 표시됨 |

미지원 셸에서는 다음 대안이 오류 응답에 함께 담깁니다.

- `exec` 도구로 단발 명령을 실행한다. `exec`는 모든 셸에서 동작한다.
- 작업 디렉터리 유지가 필요하면 명령을 `cd /path && <명령>` 형태로 합친다.
- 원격 사용자의 로그인 셸을 바꿀 수 있다면 `chsh -s /bin/bash`로 지원 셸로 전환한다(fish 등 POSIX 계열 유닉스에 한함. Windows OpenSSH에는 해당하지 않는다).

**세션 프리앰블은 `set +e; set +u` 두 개뿐입니다.** `set`은 POSIX 특수 내장 명령이라 인자 오류가 비대화형 셸을 즉시 종료시키므로, `set -o pipefail`처럼 셸마다 지원 여부가 갈리는 옵션은 애초에 보내지 않습니다(구버전 dash·busybox ash는 알 수 없는 옵션을 치명적 오류로 거부합니다 — 참고로 dash 0.5.12 이상은 Git for Windows에 포함된 버전을 포함해 `pipefail`을 지원하지만, 그 사실에 기대지 않고 아예 보내지 않는 쪽을 택했습니다). 대신 프레임은 `eval` 직후 `$?`를 읽으므로, 사용자가 세션 안에서 스스로 `set -o pipefail`을 켜둔 값은 그대로 존중됩니다.

**문법 오류가 있는 명령을 `run_in_session`에 보내면 셸에 따라 결과가 다릅니다.** `eval`은 POSIX 특수 내장 명령이라 그 안의 문법 오류가 비대화형 셸을 끝낼 수 있습니다.

- `bash`, `zsh`는 살아남습니다 — exit code `2`와 함께 세션이 계속됩니다.
- `dash`, busybox `ash`는 POSIX 규칙을 문자 그대로 따르므로 **세션 채널 자체가 종료됩니다.** 서버는 채널이 닫히는 것을 즉시 감지해 그 호출과 이후 같은 세션에 대한 호출을 `session_terminated`로 응답합니다. 데이터가 어긋나거나 멈추지 않으며, 그냥 세션이 끝난 것으로 취급됩니다 — 사용자는 `open_session`으로 새 세션을 열면 됩니다.

**세션 안에서 `exit`만 단독으로 실행하면 그 세션은 설계대로 끝납니다** (`session_terminated`, 오류가 아니라 예상된 동작). 명령의 종료 상태만 확인하고 싶다면 세션을 끝내지 않는 서브셸 형태로 감싸세요: `(exit 3)`.

**출력 발췌 규칙(AC12).** `exec`/`run_in_session`의 stdout·stderr가 호스트의 `maxOutputBytes`(기본 1 MiB)를 넘으면, 단순 절단 대신 앞부분(head)과 뒷부분(tail)을 보존하고 가운데를 한 줄로 대체합니다.

- head 예산: 전체 상한의 **40%** 바이트 또는 **최소 20줄** 중 늦게 채워지는 쪽까지.
- tail 예산: 전체 상한의 **60%** 바이트 또는 **최소 20줄**(20줄이 전부 최대 길이여도 담기도록 160 KiB 하한).
- 다만 **하드 실링이 최소 줄 수 보장보다 우선**합니다 — 메모리 사용량이 무한정 늘어나는 것을 막기 위해, 최소 줄 수를 채우려는 확장이 하드 실링을 넘기면 그 시점에서 멈춥니다.
- 생략 표시 줄은 고정 형식입니다: `[ssh-mcp] ──── 중간 12,345줄 / 9,876,543바이트 생략 ────` (정규식으로 파싱 가능, 천 단위 구분자는 표시용).
- 응답의 `stdout_meta`/`stderr_meta`에 `truncated`, `total_bytes`, `total_lines`, `head_bytes`, `tail_bytes`, `omitted_lines`, `omitted_bytes`, `returned_bytes`가 정확한 값으로 담깁니다.

## 설계 결정

아래 ADR(Architecture Decision Record)은 v1이 `.omc/plans/ssh-mcp-plan.md`, v1.1이 `.omc/plans/ssh-mcp-v11-plan.md`에 전문이 있습니다. 여기서는 제목만 남깁니다.

- **ADR-001.** 세션 명령 완료를 양방향 UUID 마커 + base64 + `eval` + stdin 차단으로 감지한다
- **ADR-002.** 통합 테스트를 두 엔드포인트로 파라미터화한다 — 인프로세스 픽스처(양 OS) + 실제 sshd 컨테이너(ubuntu)
- **ADR-003.** elicitation을 우선하고, 미지원 호스트에는 기본값 없는 호스트별 `approvalFallback`을 강제 선택시킨다
- **ADR-004.** MCP 도구 어노테이션은 UX 힌트로만 쓰고 보안 경계로 삼지 않는다
- **ADR-005.** 명령 분류를 2-pass로 수행한다(전체 문자열 + 세그먼트)
- **ADR-006.** 발췌로 잘린 중간 출력을 v1에서는 보관하지 않는다
- **ADR-007.** 감사 로그는 append-only JSONL이고, 쓰기 실패는 서비스를 막지 않는다
- **ADR-008.** 출력 상한 초과 시 앞·뒤를 보존하고 가운데를 한 줄로 대체한다
- **ADR-009.** 원격 셸 지원 경계를 POSIX 계열 4종으로 두고 나머지는 조기 거부한다

v1.1에서 추가된 결정입니다. ADR-006(발췌로 잘린 출력을 보관하지 않는다)은 ADR-010이 뒤집었습니다.

- **ADR-010.** 발췌 누산기에 옵트인 보관 옵션을 두고 `output_ref`는 응답 조립부에서 발행한다
- **ADR-011.** `history`는 역방향 청크 읽기 + `(파일, 오프셋, 크기, 줄 해시)` 커서로 구현한다
- **ADR-012.** 재작성은 게이트 직전에 하되, 누락을 브랜드 타입으로 막는다
- **ADR-013.** ssh_config 가져오기는 위저드와 같은 "argv를 채운다" 경로를 쓰고, 플래그 토큰만 만든다
- **ADR-014.** `connect`/`exec`는 `ssh`를 먼저 찾고 `shell:false`로 spawn한다
- **ADR-015.** `real-sshd`는 저장소 안 Dockerfile을 잡에서 빌드해 띄운다
- **ADR-016.** 승인 elicitation 스키마는 probe 실측 후 enum을 우선 채택한다
- **ADR-017.** 선행 단계를 앞에 두되 브랜치 보호 등록은 릴리스 게이트로 미룬다
- **ADR-018.** 타임아웃된 `exec`는 프레임으로 받은 pid를 2차 채널에서 거둔다

**계획에 없던 추가.** [알려진 의존성 이슈](#알려진-의존성-이슈)에 적은 키 쌍 건전성 검증(재파싱 + 지문 일치 확인 + 최대 12회 재시도)은 원래 계획서에는 없었습니다. ssh2 1.17.0의 결함이 구현 중에 발견되면서 `ssh-mcp/src/setup/keygen.ts`에 추가됐습니다. [`install` 명령](#install--클라이언트-등록)(`ssh-mcp/src/install/`)도 계획서에 없던 추가분으로, Windows에서 `cmd /c`로 감싸야 한다는 사실을 사용자가 알아야만 등록할 수 있다는 마찰을 없애기 위해 2026-09-14에 넣었습니다.

## 로드맵 / 범위 밖

0.3.0에서 아래 여섯 항목이 v1.1 후보 목록을 떠나 실제 기능이 됐습니다 — `history` 도구, 커서 기반 출력 조회(`fetch_output`), `format: "json"` 구조화 출력, `host add --from-ssh-config`, 터미널 직접 접속 CLI(`connect`/`exec`), 그리고 실제 OpenSSH 컨테이너를 상대로 도는 CI 티어(`real-sshd`). 앞의 다섯은 각각 이 문서의 해당 절에 설명이 있습니다.

아직 없지만 설계가 막지 않는 것들입니다.

- SQLite 감사 저장소 — JSONL을 대체 또는 보강
- `.mcpb` 원클릭 번들 패키징
- `connect`/`exec`에 ssh-mcp 지문 강제 — 지금 이 경로는 OpenSSH의 `known_hosts`를 따르므로, `hosts.json`에 고정한 지문을 `-o` 옵션으로 넘겨 두 경로의 신뢰 근거를 하나로 맞추는 것이 후속 후보입니다
- 따옴표 친 인자를 가진 명령의 재작성 — `src/safety/normalize.ts`의 토큰에 원문 위치(span)를 실으면 [알려진 한계](#알려진-한계)의 `df -h "/mnt/my disk"` 제약이 그대로 해소됩니다. 분류기의 핵심 자료구조라 Phase E 범위 밖이었습니다
- `%CPU`·경과시간을 포함한 `ps` 컬럼 — 원격의 `ps`가 무엇인지 알 수 있게 되면(예: 호스트별 프로브 결과 캐시) 빌드 의존 키워드를 골라 쓸 수 있습니다

다음은 v1에서 명시적으로 제외되었고 로드맵에도 없습니다.

- 원격 MCP 서버로의 프로토콜 터널링 프록시
- 원격 파일 읽기·부분 편집·검색 도구
- sudo 비밀번호 입력
- 동반 SKILL.md 스킬, npm 자동 배포
- 특정 운영 작업(서비스 재시작, 로그 분석 등)에 특화된 큐레이션 도구 — 범용 셸이 목표
