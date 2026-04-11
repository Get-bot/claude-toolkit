---
name: til-manager
description: >
  TIL(Today I Learned) 작성 및 관리 스킬. 사용자가 오늘 한 일, 커밋 로그, 공부한 내용을 전달하면
  주제별로 구조화된 TIL을 생성하고 Notion DB에 저장한 뒤, 요청 시 GitHub에 Markdown+frontmatter로 푸시한다.
  하루에 여러 주제의 TIL을 개별적으로 작성할 수 있다.
  "TIL 작성", "오늘 회고", "TIL 푸시", "오늘 뭐했는지 정리", "커밋 정리해줘", "TIL 노션에 올려줘",
  "TIL 깃에 올려줘", "Redis 공부한 거 TIL로 만들어줘" 같은 요청이 들어오면 이 스킬을 사용한다.
  회고, 일일 기록, 학습 기록, 데일리 로그, 주제별 학습 정리 관련 요청에도 트리거된다.
---

# TIL Manager Skill

사용자의 작업/학습 내용을 받아 **주제별** 구조화된 TIL을 생성하고, Notion과 GitHub으로 관리하는 스킬.

## 핵심 컨셉

- **주제별 TIL**: 하루에 여러 개 작성 가능. 각 TIL은 하나의 주제에 집중한다.
- **제목 형식**: `[TIL-YYMMDD] 주제명` (예: `[TIL-260409] Redis 캐시 전략`)
- **AI 강점 활용**: 사용자 입력에서 핵심 개념, 코드 스니펫, 키워드를 자동 추출한다.

## 전체 워크플로우

```
[사용자 입력] → [TIL 생성] → [Notion DB 저장] → [사용자 리뷰/수정] → [Git 푸시]
     ↑                ↑
  커밋 로그        raw 텍스트
  공부 내용        혼합 입력
```

**두 가지 커맨드**를 지원한다:

| 커맨드 | 트리거 예시 | 동작 |
|--------|-----------|------|
| **TIL 생성** | "오늘 TIL 작성해줘", "커밋 정리해서 TIL 만들어줘" | 입력 → TIL 구조화 → Notion 저장 |
| **TIL 푸시** | "TIL 깃에 올려줘", "오늘 TIL 푸시해줘" | Notion에서 fetch → Markdown 변환 → Git push |

---

## Phase 1: TIL 생성

### Step 0 — 주제 판별

사용자 입력에서 **TIL 주제**를 먼저 파악한다.

- 사용자가 주제를 명시한 경우: "Redis 공부한 거 TIL로 만들어줘" → 주제: `Redis 캐시`
- 사용자가 주제를 안 준 경우: 입력 내용에서 핵심 주제를 추출하여 제안한다
- 여러 주제가 섞인 경우: "이건 2개의 TIL로 나누면 좋겠는데, 하나로 합칠까요 아니면 따로 만들까요?" 라고 물어본다

**제목 생성 규칙**:
- 형식: `[TIL-YYMMDD] 주제명`
- 주제명은 **한국어 자연어** — 검색하기 쉽게, 구체적으로
- 좋은 예: `[TIL-260409] Redis Cache-Aside 패턴 적용`, `[TIL-260409] OAuth2 카카오 로그인 구현`
- 나쁜 예: `[TIL-260409] 오늘 한 일`, `[TIL-260409] 공부`

**Git 파일명 생성 규칙**:
- 주제명을 영어 slug로 변환: `posts/TIL-YYMMDD-slug.md`
- 예: `posts/TIL-260409-redis-cache-aside.md`, `posts/TIL-260409-oauth2-kakao-login.md`
- slug는 소문자, 하이픈 구분, 특수문자 제거

### Step 1 — 입력 분석

사용자 입력은 두 가지 유형이 있다. 혼합 입력도 가능하다.

**유형 A: 커밋 로그 기반**
사용자가 커밋 메시지, PR 내용, 작업 로그를 전달하면:
1. 커밋을 기능/버그픽스/리팩토링 등으로 분류
2. 작업의 맥락(왜 이 작업을 했는지)을 유추하거나 질문
3. TIL 템플릿의 네 섹션(잘한 점/개선점/배운 점/핵심 내용)에 자동 배치

**유형 B: raw 텍스트 기반**
사용자가 자유 형식으로 오늘의 내용을 전달하면:
1. 내용을 잘한 점 / 개선점 / 배운 점 / 핵심 내용으로 분류
2. 각 항목을 템플릿 하위 구조에 맞게 구조화
3. 부족한 부분은 사용자에게 질문하거나, "작성해보세요" 플레이스홀더로 남김

### Step 2 — TIL 콘텐츠 구조화

반드시 `references/til-template.md`를 읽고 템플릿을 따른다.

핵심 원칙:
- 사용자가 준 **원문의 뉘앙스를 보존**한다. 지나치게 포장하지 않는다.
- "칭찬" 항목은 진정성 있게 작성한다. 억지 칭찬은 금물.
- 각 항목의 **상황→액션→칭찬** (또는 **문제→원인→액션플랜**, **배움→의미**) 흐름이 하나의 블록 안에서 자연스럽게 이어져야 한다.
- 기술 용어는 영어 그대로 유지한다.
- 빈 섹션은 강제로 채우지 않는다. 해당 없으면 "오늘은 특별히 없음" 이라고 표기.
- **"핵심 내용"은 기술 레퍼런스 노트**다. "배운 점"과 달리 회고가 아닌 팩트 기반 정리. 코드 스니펫, 설정값, 개념 요약 위주로 작성한다.

#### 문체 가이드 — "사람이 쓴 것처럼"

TIL은 개인 기록이다. 보고서가 아니다. `references/human-writing-guide.md`를 참고하여 자연스러운 문체를 유지한다.

**절대 하지 말 것 (AI 패턴):**
- "~하였습니다", "~되었습니다" 같은 수동태/경어체 → **"~했다", "~됐다"** 사용
- "유의미한 개선", "효과적으로 활용", "최적화를 달성" 같은 기업 보고서 문체 → **구체적 수치나 체감으로 표현**
- 모든 문장을 비슷한 길이로 맞추기 → **짧은 문장과 긴 문장을 자연스럽게 섞기**
- "이를 통해", "이러한 경험을 바탕으로" 같은 접속어 남발 → **그냥 끊거나, "근데", "그래서" 같은 구어체 접속사 사용**
- 결론에 교훈을 깔끔하게 정리하는 패턴 → **실제 느낌 그대로** ("아직 찝찝하다", "다음에 또 삽질할 것 같다")

**반드시 할 것 (사람 패턴):**
- 사용자의 **입력 톤을 미러링**한다. 사용자가 "ㅋㅋ 삽질했음"이라고 쓰면, TIL도 캐주얼하게
- 사용자가 "오늘 Redis 캐시 적용함"이라고 쓰면 → "Redis 캐시를 적용하여 성능을 개선하였다" (X) → "Redis 캐시 적용했다" (O)
- **불완전한 감정 표현**을 살린다: "뿌듯", "아직 찜찜", "좀 아쉬움", "다행이다"
- **구어체 표현** 자연스럽게 섞기: "한번 터졌음", "일단 돌아가게 만듦", "좀 더 파봐야 할 듯"
- 핵심 내용 섹션은 예외 — 여기는 **기술 문서 톤**으로 간결하게 작성 OK

### Step 3 — Notion DB에 저장

Notion MCP 도구를 사용하여 사용자의 TIL 데이터베이스에 새 페이지를 생성한다.

**Notion DB 정보 (확인 완료)**:
- Page URL: `https://www.notion.so/2f672cc5d225812abccbd87e68b5328a`
- Data Source ID: `2f672cc5-d225-81a6-a131-000b2b6e5f02`
- DB 이름: "Today I Learned"

**Notion 페이지 생성 시 설정할 속성들:**

| DB Property | 타입 | 값 | 예시 |
|-------------|------|---|------|
| `[1/4]` | title | `[TIL-YYMMDD] 주제명` | `[TIL-260409] Redis 캐시 전략` |
| `작성일` | date | 오늘 날짜 | `2026-04-09` |

> 현재 DB에는 Tags, Status 속성이 없다. 태그는 본문 내 해시태그로 관리하거나,
> 사용자가 원하면 DB 속성 추가를 안내한다.
> 하루에 같은 날짜로 여러 TIL이 생길 수 있다. 주제명으로 구분한다.

**페이지 생성 예시 (Notion MCP)**:
```
Notion:notion-create-pages(
  parent: { data_source_id: "2f672cc5-d225-81a6-a131-000b2b6e5f02" },
  pages: [{
    properties: {
      "[1/4]": "[TIL-260409] Redis 캐시 전략",
      "date:작성일:start": "2026-04-09",
      "date:작성일:is_datetime": 0
    },
    icon: "✍️",
    content: "<TIL 본문 - Notion Markdown>"
  }]
)
```

**페이지 본문 작성**:
Notion의 block 구조에 맞게 TIL 내용을 작성한다.
- Heading 2: 섹션 제목 (잘한 점, 개선점, 배운 점, 핵심 내용)
- Heading 3: 핵심 키워드 제목 (예: "카카오 OAuth2 로그인 구현"), 그리고 "핵심 내용" 하위 블록(키워드, 요약, 코드/명령어, 참고 자료)
- Bold text: 회고 3섹션의 블록 라벨 (상황, 액션, 칭찬, 문제, 원인, 액션플랜, 배움, 의미) — 라벨은 한 줄 볼드로만 두고 아래에 bullet을 붙인다
- Bulleted list: 각 블록 라벨 아래의 세부 내용
- Code block: 핵심 내용의 코드/명령어

생성 후 사용자에게 Notion 페이지 링크를 제공한다.

---

## TIL 레포 설정 (최초 1회)

TIL 푸시 대상 Git 레포는 **사용자별로 다르다**. 이 스킬은 특정 레포에 고정되어 있지 않다.

### 자동 메모리 경로 규칙

자동 메모리는 다음 경로 규칙을 따른다:

```
~/.claude/projects/<PROJECT_SLUG>/memory/MEMORY.md
~/.claude/projects/<PROJECT_SLUG>/memory/til_repo.md
```

- `<PROJECT_SLUG>`는 현재 작업 디렉토리(`cwd`)를 Claude Code가 슬러그화한 문자열이다.
  - 변환 규칙: 드라이브 구분자(`:`)와 경로 구분자(`/`, `\`)를 `-`로 치환
  - 예: `D:\claude-toolkit` → `D--claude-toolkit`, `/Users/alice/work` → `-Users-alice-work`
- **실제 경로 확인 방법**: Claude Code 세션이 시작될 때 SessionStart 훅 컨텍스트에 실제 경로가 포함되어 있다. 의심스러울 땐 `ls ~/.claude/projects/` 로 디렉토리 목록을 확인한 뒤 현재 `cwd` 와 매칭되는 슬러그를 고른다.

> 이후 이 섹션에서 `<MEMORY_DIR>` 이라고 쓰면 위 경로 규칙으로 해석된 실제 디렉토리를 의미한다.

### 고정 저장 스키마

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

> TIL 파일은 항상 레포 루트의 `posts/` 디렉토리 하위에 저장한다 (본 스킬 고정 규칙). 레포마다 경로가 달라지는 것을 허용하지 않으므로 `posts_dir` 를 메모 스키마에 두지 않는다.

### 레포 정보 확인 순서

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
   # 해석하므로, 사용자가 ~/repos/TIL 을 입력한 경우 cd 가 실패한다. 파라미터 확장
   # (#\~ 앵커)으로 앞머리 ~ 만 $HOME 으로 치환해 따옴표 안에서도 전개되게 한다.
   local_path="${local_path/#\~/$HOME}"
   cd "$local_path" || { echo "경로를 찾을 수 없습니다: $local_path" >&2; exit 1; }

   ref=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
   default_branch="${ref#origin/}"

   # 폴백: origin/HEAD 미설정(fresh clone 등) 시 원격에 직접 질의.
   # ls-remote --symref 는 plumbing 출력이라 로케일 영향 없음.
   # GIT_HTTP_LOW_SPEED_* 는 이 한 호출에만 적용 — export 로 전역 오염시키지 않는다
   # (같은 스크립트 내 후속 git pull/push 가 의도치 않게 이 타임아웃에 걸리는 걸 방지).
   if [ -z "$default_branch" ]; then
     default_branch=$(GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=10 \
       git ls-remote --symref origin HEAD 2>/dev/null \
       | awk '/^ref: refs\/heads\// { sub("refs/heads/", "", $2); print $2; exit }')
   fi

   if [ -z "$default_branch" ]; then
     echo "기본 브랜치를 자동으로 확인하지 못했습니다. 직접 지정해 주세요 (예: main 또는 master)." >&2
     exit 2
   fi

   # 성공 시 결과값을 stdout 으로 내보내 다음 단계에서 파싱할 수 있게 한다.
   printf 'default_branch=%s\n' "$default_branch"
   ```

   - **tier 3 (자동 확인 실패) 도달 시**: 스크립트는 `exit 2` 로 종료한다. Claude 는 비영 exit code 와 stderr 경고를 보면 사용자에게 브랜치명을 직접 질문한 뒤, 응답값을 `default_branch` 로 사용해 다음 단계(til_repo.md 저장)로 넘어간다. (tier 0 `cd` 실패는 `exit 1`, tier 3 자동 확인 실패는 `exit 2` — Claude 는 exit code 로 두 실패를 구분한다.)
   - **private 레포 주의**: `ls-remote` 는 네트워크 호출이라 private 원격에서는 인증 프롬프트가 뜰 수 있다. 인증이 안 돼 있으면 폴백이 실패하고 tier 3 로 떨어진다.

   > **왜 파이프 한 줄 대신 변수 할당 + 빈 문자열 검사인가**: `git ... | awk ... || fallback`
   > 형태는 `pipefail` 미설정 시 `awk` 가 빈 입력에도 exit 0 을 반환해 `||` 폴백이 절대
   > 실행되지 않는다. 결과를 변수에 담고 빈 문자열을 검사해야 폴백이 확실히 동작한다.

   결과를 `default_branch`로 저장한다.
4. **고정 스키마로 즉시 저장**:
   - `<MEMORY_DIR>/til_repo.md` 파일을 위의 본문 템플릿대로 작성
   - `<MEMORY_DIR>/MEMORY.md` 에 위의 인덱스 라인(고정 포맷) 한 줄 추가
5. 이후 세션부터는 Step 1(파일명 기반 조회)에서 바로 재사용된다.

### 레포 구조 가정

본 스킬은 대상 레포가 다음 구조를 **갖추고 있다고 가정**한다:
- `posts/` 디렉토리가 존재 (없으면 `git add` 전에 생성)
- 기본 브랜치는 임의 (`main`, `master`, `trunk` 등) — 실제 값은 위 Step 3에서 확인하여 `til_repo.md` 의 `default_branch` 로 저장한다
- 사용자가 push 권한을 가진 상태 (인증은 본 스킬의 책임이 아님)

> 이 설정은 **Phase 2(푸시)에서만 필요**하다. Phase 1(Notion 저장)은 Git 레포 정보가 없어도 동작한다.

---

## Phase 2: TIL 푸시 (Notion → Git)

사용자가 Notion에서 TIL을 수정한 뒤 "푸시해줘"라고 요청하면 실행.

> **사전 조건**: 위의 "TIL 레포 설정" 섹션에 따라 사용자의 TIL 레포 정보(원격 URL + 로컬 경로)가 자동 메모리에 저장되어 있어야 한다. 없으면 먼저 확인 단계를 수행한다.

### Step 1 — Notion에서 TIL fetch

1. 사용자가 특정 TIL을 지정한 경우: 해당 페이지를 fetch
2. "오늘 TIL 푸시해줘"라고 한 경우: 오늘 날짜의 모든 TIL을 검색
   - `Notion:notion-search(query: "TIL-YYMMDD", data_source_url: "collection://2f672cc5-d225-81a6-a131-000b2b6e5f02")`
   - 여러 개면 목록을 보여주고 "전부 푸시할까요, 선택할까요?" 확인
3. `Notion:notion-fetch`로 페이지 전체 내용을 가져옴
4. Notion block 구조를 파싱

### Step 2 — Markdown + Frontmatter 변환

`references/frontmatter-spec.md`를 참고하여 변환한다.

**출력 파일 경로**: `posts/TIL-YYMMDD-slug.md` (대상 레포의 `posts/` 디렉토리 하위)
**Git 레포**: 자동 메모리에 저장된 사용자별 TIL 레포 사용 (위 "TIL 레포 설정" 섹션 참조)

slug 생성 규칙: 주제명에서 영어 키워드 추출 → 소문자 → 하이픈 연결
- `[TIL-260409] Redis 캐시 전략` → `posts/TIL-260409-redis-cache.md`
- `[TIL-260409] OAuth2 카카오 로그인` → `posts/TIL-260409-oauth2-kakao-login.md`

변환 결과물 예시:
```markdown
---
title: "[TIL-260409] Redis 캐시 전략"
date: 2026-04-09
tags: ["Redis", "Cache-Aside", "Spring Boot"]
categories: ["TIL"]
description: "Cache-Aside 패턴 적용, TTL 기반 무효화 전략, @Cacheable/@CacheEvict 사용법"
---

## 잘한 점
...

## 개선점
...

## 배운 점
...

## 핵심 내용
...
```

### Step 3 — Git Push

#### 🔖 커밋 네이밍 컨벤션 (고정 규칙)

**형식**: `TIL: YYYY-MM-DD - 주제명`

- 날짜는 **풀 포맷**(`YYYY-MM-DD`). 파일명의 `YYMMDD`와 다르다.
- 주제명은 TIL 제목(`[TIL-YYMMDD] 주제명`)에서 `[TIL-YYMMDD] ` 접두사만 떼고 그대로 사용한다.
- 구분자는 ` - ` (하이픈 양옆 공백 1칸).
- 기술 용어는 영어 그대로. 한국어 조사 붙이지 않음.
- **이 규칙은 고정이다. 사용자에게 "어떤 커밋 메시지로 할까요?"라고 묻지 않는다.**
  사용자가 별도로 다른 메시지를 지정한 경우에만 그 지시를 따른다.

**예시**:
```
TIL: 2026-04-11 - PR 리뷰로 정리한 Spring Boot + Kotlin 관용 패턴
TIL: 2026-04-10 - DDD 도메인 설계 3원칙
TIL: 2026-04-09 - Kotlin JPA Entity 패턴 — 선착순 이벤트 도메인 설계
```

> 참고: 주제명 내부에 하이픈(`-`)이나 em dash(`—`)가 포함돼도 괜찮다.
> 커밋 메시지를 파싱할 때는 **첫 번째 ` - `(공백-하이픈-공백)** 만 날짜/주제 구분자로 해석한다.

**하루 여러 TIL 푸시 시**: 각 TIL을 **개별 커밋**으로 나눈다. 하나의 커밋에 여러 주제를 묶지 않는다.
주제별로 한 커밋 = 한 파일 원칙을 지켜야 나중에 `git log`로 주제 추적이 쉽다.

**파일 경로 규칙 재확인**:
- 경로: `posts/TIL-YYMMDD-slug.md` (2자리 연도, 영어 slug)
- 커밋 메시지의 날짜와 파일명의 날짜는 **같은 날**을 가리켜야 한다 (포맷만 다름)

---

**환경에 따라 분기한다:**

#### Claude Code (CLI 환경)

아래 플레이스홀더는 모두 `til_repo.md` 메모에서 로드된다:
- `<TIL_REPO_PATH>` ← `local_path`
- `<DEFAULT_BRANCH>` ← `default_branch` (예: `main`, `master`)

```bash
cd <TIL_REPO_PATH>
git pull origin <DEFAULT_BRANCH>
cp <generated-file> posts/TIL-260409-redis-cache.md
git add posts/TIL-260409-redis-cache.md
git commit -m "TIL: 2026-04-09 - Redis 캐시 전략"
git push origin <DEFAULT_BRANCH>
```

> 예시의 `<DEFAULT_BRANCH>`를 하드코딩된 `main`으로 절대 치환하지 말 것. 메모에서 로드한 실제 값으로만 실행해야 한다.
> 메모가 없어서 새로 만드는 경우에도 "TIL 레포 설정" 섹션의 Step 3(기본 브랜치 자동 확인)을 먼저 수행해서 `default_branch`를 확정한 뒤에 위 명령을 실행한다.

#### Claude.ai (MCP 환경)
Claude.ai에서는 직접 git push가 불가능하므로:
1. Markdown 파일을 생성하여 다운로드 제공
2. 사용자에게 수동 push를 안내하거나
3. GitHub API를 통한 파일 생성을 시도 (Personal Access Token 필요)

> 사용자에게 환경을 확인하고, 가능한 방법을 안내한다.

---

## 입력 처리 가이드

### 커밋 로그 → TIL 매핑 규칙

커밋의 성격에 따라 TIL 섹션에 배치한다:

| 커밋 유형 | TIL 섹션 | 이유 |
|----------|---------|------|
| feat, feature | 잘한 점 | 새 기능 구현 = 성과 |
| fix, bugfix | 개선점 or 배운 점 | 버그 원인 분석 → 개선/학습 |
| refactor | 잘한 점 or 배운 점 | 코드 개선 = 성과 + 학습 |
| docs | 배운 점 | 문서화 과정의 학습 |
| test | 잘한 점 | 테스트 추가 = 품질 개선 성과 |
| chore, config | 개선점 | 환경 세팅 중 겪은 이슈 |

단순 매핑이 아니라 **맥락을 고려**한다. 예를 들어 fix 커밋이지만 "어려운 버그를 끈질기게 추적해서 해결"했다면 "잘한 점"에도 들어갈 수 있다.

### 핵심 내용 섹션 추출 규칙

"핵심 내용"은 모든 커밋/입력에서 기술적 팩트를 추출하여 구성한다:

| 추출 대상 | 예시 |
|----------|------|
| 새로 사용한 API/라이브러리 | `@CacheEvict`, `OAuth2LoginAuthenticationFilter` |
| 설정값/코드 패턴 | YAML 설정, 어노테이션 조합 |
| 개념/패턴 이름 | Cache-Aside, Token Rotation |
| 트러블슈팅 핵심 | "race condition은 SETNX로 해결" |
| 유용한 참고 링크 | 공식 문서, 블로그 |

핵심 내용은 다른 3개 섹션(잘한 점/개선점/배운 점)의 기술적 디테일을 **레퍼런스 노트**로 압축한 것이다. "배운 점"이 "왜 의미 있는지" 회고라면, "핵심 내용"은 "구체적으로 뭘 어떻게" 기록이다.

### raw 텍스트 → TIL 매핑 시그널

| 시그널 키워드 | TIL 섹션 |
|-------------|---------|
| 해결했다, 완료, 성공, 구현 | 잘한 점 |
| 어려웠다, 실수, 놓쳤다, 지연 | 개선점 |
| 알게 되었다, 배웠다, 처음, 새롭게 | 배운 점 |
| 뿌듯, 잘했다, 칭찬 | 잘한 점 → 칭찬 |

---

## 에러 처리

| 상황 | 대응 |
|------|-----|
| Notion DB ID를 모름 | 사용자에게 DB URL을 물어보고, ID를 추출하여 기억 |
| DB 속성명이 다름 | `notion-fetch`로 스키마 확인 후 자동 매핑 |
| 같은 주제의 TIL이 이미 존재 | 사용자에게 업데이트할지 / 새로 만들지 확인 |
| 여러 주제가 섞인 입력 | "2개 TIL로 나눌까요?" 제안 |
| Git push 실패 | 에러 메시지 공유 + 수동 push 가이드 제공 |
| 입력이 너무 짧음 | 추가 질문으로 내용 보강 유도 |
| 푸시 시 오늘 TIL이 여러 개 | 목록 보여주고 전체/선택 푸시 확인 |

---

## 환경별 도구 사용

### Claude.ai
- **Notion**: `Notion:notion-search`, `Notion:notion-create-pages`, `Notion:notion-fetch`, `Notion:notion-update-page`
- **파일 생성**: `create_file` → `present_files`로 다운로드 제공
- **Git**: 파일 다운로드 제공 또는 GitHub API fetch

### Claude Code
- **Notion**: Notion MCP 또는 직접 API 호출
- **Git**: 로컬 git CLI 직접 사용
- **파일 생성**: 로컬 파일시스템에 직접 작성
