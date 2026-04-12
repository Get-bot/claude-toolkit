---
name: til-manager
description: >
   TIL(Today I Learned) 작성 및 관리 스킬. 사용자가 오늘 한 일, 커밋 로그, 공부한 내용을 전달하면
   주제별로 구조화된 TIL을 생성하고 Notion DB에 저장한 뒤, 요청 시 GitHub에 Markdown+frontmatter로 푸시한다.
   하루에 여러 주제의 TIL을 개별적으로 작성할 수 있다.
   "TIL 작성", "오늘 회고", "TIL 푸시", "오늘 뭐했는지 정리", "커밋 정리해줘",
   "TIL 노션에 올려줘", "TIL 깃에 올려줘", "Redis 공부한 거 TIL로 만들어줘" 같은 요청이 들어오면 이 스킬을 사용한다.
   "오늘 뭐 배웠지", "일일 정리", "데일리 로그", "학습 일지", "작업 로그 정리",
   "이번 주 회고", "스프린트 회고 정리", "오늘 대화 내용으로 TIL 만들어줘" 같은 요청에도 트리거된다.
   사용자가 커밋 메시지나 작업 내용을 단순히 붙여넣기만 해도 TIL로 구조화할 의도로 판단하고 이 스킬을 사용한다.
   회고, 일일 기록, 학습 기록, 데일리 로그, 주제별 학습 정리, 스프린트/주간 회고 관련 요청에도 트리거된다.
---

# TIL Manager Skill

사용자의 작업/학습 내용을 받아 **주제별** 구조화된 TIL을 생성하고, Notion과 GitHub으로 관리하는 스킬.


## ⚠️ 필수 레퍼런스 — 작업 전에 반드시 읽어라

이 스킬은 5개의 레퍼런스 파일에 의존한다. **TIL 생성/푸시 작업을 시작하기 전에 해당 Phase에 필요한 파일을 `view` 도구로 반드시 읽어라.** SKILL.md 본문의 요약만으로는 템플릿 구조 누락·AI 문체 오염·Notion 속성 오류가 발생한다.

| 파일 | 언제 읽는가 | 왜 필요한가 |
|------|-----------|-----------|
| `references/til-template.md` | **Phase 1 시작 전 (필수)** | TIL 4섹션 구조, 하위 블록(상황/액션/칭찬 등), 작성 원칙, 예시 |
| `references/human-writing-guide.md` | **Phase 1 시작 전 (필수)** | AI 패턴 회피, 사람 문체 패턴, 섹션별 톤 가이드, 감정 표현 사전 |
| `references/notion-setup.md` | **Notion 저장 직전 (필수)** | DB 속성명, data_source_id, MCP 호출 예시, 트러블슈팅 |
| `references/frontmatter-spec.md` | **Phase 1 Step 0 + Phase 2 (필수)** | slug/파일명 규칙, Frontmatter 필드, 태그 추출 규칙, 본문 변환 규칙 |
| `references/git-repo-setup.md` | **Phase 2에서 레포 정보가 없을 때** | 자동 메모리 경로, 고정 저장 스키마, 레포 정보 확인 순서, 브랜치 자동 감지 |

**읽는 방법**: `view` 도구를 사용한다. 예: `view("references/til-template.md")`

---


## 핵심 컨셉

- **주제별 TIL**: 하루에 여러 개 작성 가능. 각 TIL은 하나의 주제에 집중한다.
- **제목 형식**: `[TIL-YYMMDD] 주제명` (예: `[TIL-260409] Redis 캐시 전략`)
- **AI 강점 활용**: 사용자 입력에서 핵심 개념, 코드 스니펫, 키워드를 자동 추출한다.

## 전체 워크플로우

```
[사용자 입력] → [TIL 생성] → [Notion DB 저장] → [사용자 리뷰/수정] → [Git 푸시]
     ↑                ↑
  커밋 로그        raw 텍스트
  공부 내용        대화 내용 (Claude.ai)
```

**두 가지 커맨드**를 지원한다:

| 커맨드 | 트리거 예시 | 동작 |
|--------|-----------|------|
| **TIL 생성** | "오늘 TIL 작성해줘", "커밋 정리해서 TIL 만들어줘" | 입력 → TIL 구조화 → Notion 저장 |
| **TIL 푸시** | "TIL 깃에 올려줘", "오늘 TIL 푸시해줘" | Notion에서 fetch → Markdown 변환 → Git push |

---

## Phase 1: TIL 생성

> **🔴 시작 전 필수**: 아래 두 파일을 `view` 도구로 읽어라. 읽지 않으면 진행하지 마라.
> 1. `view("references/til-template.md")` — 템플릿 구조 + 작성 원칙 + 예시
> 2. `view("references/human-writing-guide.md")` — 문체 가이드 + AI 패턴 회피 규칙


### Step 0 — 주제 판별

사용자 입력에서 **TIL 주제**를 먼저 파악한다.

- 사용자가 주제를 명시한 경우: "Redis 공부한 거 TIL로 만들어줘" → 주제: `Redis 캐시`
- 사용자가 주제를 안 준 경우: 입력 내용에서 핵심 주제를 추출하여 제안한다
- 여러 주제가 섞인 경우: "이건 2개의 TIL로 나누면 좋겠는데, 하나로 합칠까요 아니면 따로 만들까요?" 라고 물어본다

**제목 생성 규칙**:
- 형식: `[TIL-YYMMDD] 주제명`
- 주제명은 **한국어 자연어** — 6개월 후에 검색할 때 바로 떠오르는 단어로. "오늘 한 일" 같은 제목은 나중에 아무 의미가 없다.
- 좋은 예: `[TIL-260409] Redis Cache-Aside 패턴 적용`, `[TIL-260409] OAuth2 카카오 로그인 구현`
- 나쁜 예: `[TIL-260409] 오늘 한 일`, `[TIL-260409] 공부`

**Git 파일명 생성 규칙**: `references/frontmatter-spec.md`의 "파일 경로" 섹션 참조.
- 형식: `posts/TIL-YYMMDD-slug.md` (상세 slug 규칙은 정본 문서에 있다)

### Step 1 — 입력 분석

사용자 입력은 세 가지 유형이 있다. 혼합 입력도 가능하다.

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

**유형 C: 대화 기반 (Claude.ai 전용)**
사용자가 "오늘 대화 내용으로 TIL 만들어줘"처럼 과거 대화를 소스로 요청하면:
1. `recent_chats(n: 10)`로 오늘/최근 대화 목록을 가져온다
2. `conversation_search`로 기술적 내용이 있는 대화를 필터링 (키워드: 작업 내용, 기술명, 에러 등)
3. 대화에서 학습/작업/트러블슈팅 내용을 추출
4. 추출된 내용을 사용자에게 **먼저 보여주고 확인**받은 뒤 TIL 생성 — 대화에는 잡담도 섞여 있으므로 자동으로 전부 넣지 않는다
5. 이후 유형 B와 동일하게 구조화

> 유형 C는 사용자가 별도로 입력을 정리할 필요 없이 "오늘 뭐했는지 알아서 정리해줘"가 가능하게 하는 게 목적이다.
> Claude Code에서는 이 도구(`recent_chats`, `conversation_search`)가 없으므로 유형 A/B를 사용한다.

### Step 2 — TIL 콘텐츠 구조화

반드시 `references/til-template.md`를 `view` 도구로 읽고 그 템플릿을 따른다. (위에서 이미 읽었다면 생략 가능)

핵심 원칙:
- 사용자가 준 **원문의 뉘앙스를 보존**한다. 지나치게 포장하지 않는다.
- "칭찬" 항목은 진정성 있게 작성한다. 억지 칭찬은 금물.
- 각 항목의 **상황→액션→칭찬** (또는 **문제→원인→액션플랜**, **배움→의미**) 흐름이 하나의 블록 안에서 자연스럽게 이어져야 한다.
- 기술 용어는 영어 그대로 유지한다.
- 빈 섹션은 강제로 채우지 않는다 — 억지로 채운 내용은 나중에 읽을 때 노이즈가 되고, TIL의 신뢰도를 떨어뜨린다. 해당 없으면 "오늘은 특별히 없음"으로 표기.
- **"핵심 내용"은 기술 레퍼런스 노트**다. "배운 점"이 "왜 의미 있는지" 회고라면, "핵심 내용"은 "구체적으로 뭘 어떻게"에 대한 팩트 기반 정리. 6개월 후에 검색해서 바로 쓸 수 있을 정도로 구체적으로 적는다.

#### 문체 가이드 — "사람이 쓴 것처럼"

TIL은 개인 기록이다. 보고서가 아니다. `references/human-writing-guide.md`를 `view` 도구로 읽고 자연스러운 문체를 유지한다. (위에서 이미 읽었다면 생략 가능)

### Step 3 — Notion DB에 저장

Notion MCP 도구를 사용하여 사용자의 TIL 데이터베이스에 새 페이지를 생성한다.

> **🔴 Notion 저장 전 필수**: `view("references/notion-setup.md")`를 읽고, DB 정보가 메모리에 있는지 확인하라.
> 없으면 notion-setup.md의 "DB 정보 확인 순서"를 따라 사용자에게 DB URL을 요청하고, 스키마를 자동 탐색하여 메모리에 저장한다.

메모리에서 로드한 값(`data_source_id`, `title_property`, `date_property`)을 사용하여 페이지를 생성한다:

> 하루에 같은 날짜로 여러 TIL이 생길 수 있다. 주제명으로 구분한다.
> 생성 실패 시 fallback 경로는 `references/notion-setup.md`의 "Fallback 경로" 참조.

**페이지 본문 작성**:
Notion의 block 구조에 맞게 TIL 내용을 작성한다.
- Heading 2: 섹션 제목 (잘한 점, 개선점, 배운 점, 핵심 내용)
- Heading 3: 핵심 키워드 제목 (예: "카카오 OAuth2 로그인 구현"), 그리고 "핵심 내용" 하위 블록(키워드, 요약, 코드/명령어, 참고 자료)
- Bold text: 회고 3섹션의 블록 라벨 (상황, 액션, 칭찬, 문제, 원인, 액션플랜, 배움, 의미) — 라벨은 한 줄 볼드로만 두고 아래에 bullet을 붙인다
- Bulleted list: 각 블록 라벨 아래의 세부 내용
- Code block: 핵심 내용의 코드/명령어

생성 후 사용자에게 Notion 페이지 링크를 제공한다.

---

## Phase 2: TIL 푸시 (Notion → Git)

> **🔴 시작 전 필수**: `view("references/frontmatter-spec.md")`로 frontmatter 필드, 태그 규칙, slug 규칙을 확인하라.

사용자가 Notion에서 TIL을 수정한 뒤 "푸시해줘"라고 요청하면 실행.

> **사전 조건**: 사용자의 TIL 레포 정보가 필요하다. 레포 정보가 없으면
> `view("references/git-repo-setup.md")`를 읽고 설정 단계를 수행한다.

### Step 1 — Notion에서 TIL fetch

1. 사용자가 특정 TIL을 지정한 경우: 해당 페이지를 fetch
2. "오늘 TIL 푸시해줘"라고 한 경우: 오늘 날짜의 모든 TIL을 검색
   - `Notion:notion-search(query: "TIL-YYMMDD", data_source_url: "collection://{메모리의 data_source_id}")`
   - 여러 개면 목록을 보여주고 "전부 푸시할까요, 선택할까요?" 확인
3. `Notion:notion-fetch`로 페이지 전체 내용을 가져옴
4. Notion block 구조를 파싱

### Step 2 — Markdown + Frontmatter 변환

`references/frontmatter-spec.md`의 필드 정의와 본문 변환 규칙에 따라 변환한다. 파일 경로·slug 규칙도 같은 문서 참조.

### Step 3 — Git Push

#### 🔖 커밋 네이밍 컨벤션 (고정 규칙)

**형식**: `TIL: YYYY-MM-DD - 주제명`

- 날짜는 **풀 포맷**(`YYYY-MM-DD`). 파일명의 `YYMMDD`와 다르다.
- 주제명은 TIL 제목에서 `[TIL-YYMMDD] ` 접두사만 떼고 그대로 사용한다.
- 구분자는 ` - ` (하이픈 양옆 공백 1칸).
- **이 규칙은 고정이다. 사용자에게 묻지 않는다.** — `git log --oneline`으로 TIL을 검색할 때 일관된 포맷이어야 패턴 매칭이 된다. 사용자가 별도로 다른 메시지를 지정한 경우에만 그 지시를 따른다.

**예시**:
```
TIL: 2026-04-11 - PR 리뷰로 정리한 Spring Boot + Kotlin 관용 패턴
TIL: 2026-04-09 - Kotlin JPA Entity 패턴 — 선착순 이벤트 도메인 설계
```

**하루 여러 TIL 푸시 시**: 각 TIL을 **개별 커밋**으로 나눈다 — 하나의 커밋에 여러 주제를 묶으면 `git log`로 주제별 추적이 불가능하다.

**파일 경로 규칙 재확인**:
- 경로: `posts/TIL-YYMMDD-slug.md` (2자리 연도, 영어 slug)
- 커밋 메시지의 날짜와 파일명의 날짜는 **같은 날**을 가리켜야 한다 — 불일치하면 `git log`와 파일 탐색 결과가 엇갈려서 나중에 혼란스럽다.

#### 환경별 실행 방법

**Claude Code (CLI 환경)**:

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

> `<DEFAULT_BRANCH>`를 하드코딩된 `main`으로 절대 치환하지 말 것. 메모에서 로드한 실제 값으로만 실행해야 한다.
> 메모가 없으면 `view("references/git-repo-setup.md")`를 읽고 설정 단계를 먼저 수행한다.

**Claude.ai (MCP 환경)**:
Claude.ai에서는 직접 git push가 불가능하므로:
1. Markdown 파일을 `create_file`로 생성하여 `present_files`로 다운로드 제공
2. 사용자에게 수동 push 안내, 또는
3. GitHub API를 통한 파일 생성 시도 (Personal Access Token 필요)

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

핵심 내용은 다른 3개 섹션의 기술적 디테일을 **레퍼런스 노트**로 압축한 것이다.

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
| Notion 페이지 생성 실패 (data_source_id) | 1차: parent를 `page_id`(메모리에서 로드)로 변경하여 sub-page로 생성 시도. 2차: 그래도 실패하면 Markdown 파일로 생성하여 다운로드 제공 + Notion에 수동 복사 안내. |
| Notion DB ID를 모름 | 사용자에게 DB URL을 물어보고, ID를 추출하여 기억 |
| DB 속성명이 다름 | `notion-fetch`로 스키마 확인 후 자동 매핑 |
| 같은 주제의 TIL이 이미 존재 | 사용자에게 업데이트할지 / 새로 만들지 확인 |
| 여러 주제가 섞인 입력 | "2개 TIL로 나눌까요?" 제안 |
| Git push 실패 | 에러 메시지 공유 + 수동 push 가이드 제공 |
| 입력이 너무 짧음 | 추가 질문으로 내용 보강 유도 — 단, 사용자가 짧게 쓴 의도일 수 있으니 강요하지 않는다 |
| 푸시 시 오늘 TIL이 여러 개 | 목록 보여주고 전체/선택 푸시 확인 |
| 대화 기반(유형 C) 검색 결과 없음 | "오늘 기술적인 대화가 없는 것 같아요. 직접 내용을 알려주시겠어요?" |