# TIL Git 레포 설정 가이드 (최초 1회)

TIL 푸시 대상 Git 레포는 **사용자별로 다르다**. 이 스킬은 특정 레포에 고정되어 있지 않다.
이 설정은 **Phase 2(푸시)에서만 필요**하다. Phase 1(Notion 저장)은 Git 레포 정보가 없어도 동작한다.

---

## 자동 메모리 경로 규칙

자동 메모리는 다음 경로 규칙을 따른다:

```
~/.claude/projects/<PROJECT_SLUG>/memory/MEMORY.md
~/.claude/projects/<PROJECT_SLUG>/memory/til_repo.md
```

- `<PROJECT_SLUG>`는 현재 작업 디렉토리(`cwd`)를 Claude Code가 슬러그화한 문자열이다.
    - 변환 규칙: 드라이브 구분자(`:`)와 경로 구분자(`/`, `\`)를 `-`로 치환
    - 예: `D:\claude-toolkit` → `D--claude-toolkit`, `/Users/alice/work` → `-Users-alice-work`
- **실제 경로 확인 방법**: Claude Code 세션이 시작될 때 SessionStart 훅 컨텍스트에 실제 경로가 포함되어 있다. 의심스러울 땐 `ls ~/.claude/projects/` 로 디렉토리 목록을 확인한 뒤 현재 `cwd` 와 매칭되는 슬러그를 고른다.

> 이후 이 문서에서 `<MEMORY_DIR>` 이라고 쓰면 위 경로 규칙으로 해석된 실제 디렉토리를 의미한다.

---

## 고정 저장 스키마

TIL 레포 정보는 **파일명과 인덱스 라인 포맷을 고정**한다. 변동하면 다음 세션에서 조회가 비결정적이 된다.

| 항목 | 고정값 |
|---|---|
| 메모 파일명 | `til_repo.md` (복수형·변형 금지) |
| 메모 타입 | `reference` |
| 메모 name | `TIL repo` |
| `MEMORY.md` 인덱스 라인 | `- [TIL repo](til_repo.md) — {remote_url} ({local_path})` |

**`til_repo.md` 본문 템플릿**:
```markdown
---
name: TIL repo
description: 사용자의 TIL Git 레포 - Phase 2 푸시 시 사용
type: reference
---

- remote_url: {원격 URL, 예: https://github.com/alice/TIL}
- local_path: {로컬 클론 절대 경로, 예: /d/repos/TIL}
- default_branch: {기본 브랜치명, 예: main 또는 master}
```

> TIL 파일은 항상 레포 루트의 `posts/` 디렉토리 하위에 저장한다 (본 스킬 고정 규칙).

---

## 레포 정보 확인 순서

1. **자동 메모리 조회 먼저**:
    - `<MEMORY_DIR>/til_repo.md` 파일이 존재하는지 확인 (파일명 기반 결정적 조회)
    - 있으면 파싱하여 `remote_url`, `local_path`, `default_branch` 를 꺼내 사용한다
    - 사용자에게 다시 묻지 않는다

2. **없으면 사용자에게 한 번만 질문**:
   ```
   TIL을 푸시할 Git 레포를 알려주세요:
   - 원격 URL (예: https://github.com/<user>/TIL)
   - 로컬 클론 경로 (예: /d/repos/TIL 또는 ~/repos/TIL)
   ```

3. **받은 정보로 기본 브랜치 자동 확인**:
   ```bash
   local_path="<local_path>"
   # 방어적 틸드 확장 — "$local_path" 처럼 따옴표로 묶으면 bash 가 ~ 를 literal 로
   # 해석하므로, 사용자가 ~/repos/TIL 을 입력한 경우 cd 가 실패한다.
   local_path="${local_path/#\~/$HOME}"
   cd "$local_path" || { echo "경로를 찾을 수 없습니다: $local_path" >&2; exit 1; }

   ref=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
   default_branch="${ref#origin/}"

   # 폴백: origin/HEAD 미설정(fresh clone 등) 시 원격에 직접 질의.
   if [ -z "$default_branch" ]; then
     default_branch=$(GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=10 \
       git ls-remote --symref origin HEAD 2>/dev/null \
       | awk '/^ref: refs\/heads\// { sub("refs/heads/", "", $2); print $2; exit }')
   fi

   if [ -z "$default_branch" ]; then
     echo "기본 브랜치를 자동으로 확인하지 못했습니다. 직접 지정해 주세요 (예: main 또는 master)." >&2
     exit 2
   fi

   printf 'default_branch=%s\n' "$default_branch"
   ```

    - **exit code 구분**: tier 0 `cd` 실패는 `exit 1`, tier 3 자동 확인 실패는 `exit 2`
    - **exit 2 도달 시**: 사용자에게 브랜치명을 직접 질문한 뒤 응답값을 `default_branch`로 사용
    - **private 레포 주의**: `ls-remote`는 네트워크 호출이라 인증이 안 돼 있으면 폴백 실패

   > **왜 파이프 대신 변수 할당인가**: `git ... | awk ... || fallback` 형태는 `pipefail` 미설정 시
   > `awk`가 빈 입력에도 exit 0을 반환해 `||` 폴백이 실행되지 않는다.

4. **고정 스키마로 즉시 저장**:
    - `<MEMORY_DIR>/til_repo.md` 파일을 위의 본문 템플릿대로 작성
    - `<MEMORY_DIR>/MEMORY.md` 에 인덱스 라인 한 줄 추가

5. 이후 세션부터는 Step 1(파일명 기반 조회)에서 바로 재사용된다.

---

## 레포 구조 가정

본 스킬은 대상 레포가 다음 구조를 **갖추고 있다고 가정**한다:
- `posts/` 디렉토리가 존재 (없으면 `git add` 전에 생성)
- 기본 브랜치는 임의 (`main`, `master`, `trunk` 등) — 실제 값은 위 Step 3에서 확인
- 사용자가 push 권한을 가진 상태 (인증은 본 스킬의 책임이 아님)
