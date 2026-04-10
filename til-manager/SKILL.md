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
- Heading 3: 하위 항목 (상황, 액션, 칭찬, 키워드, 요약 등)
- Bulleted list: 세부 내용
- Code block: 핵심 내용의 코드/명령어

생성 후 사용자에게 Notion 페이지 링크를 제공한다.

---

## Phase 2: TIL 푸시 (Notion → Git)

사용자가 Notion에서 TIL을 수정한 뒤 "푸시해줘"라고 요청하면 실행.

### Step 1 — Notion에서 TIL fetch

1. 사용자가 특정 TIL을 지정한 경우: 해당 페이지를 fetch
2. "오늘 TIL 푸시해줘"라고 한 경우: 오늘 날짜의 모든 TIL을 검색
   - `Notion:notion-search(query: "TIL-YYMMDD", data_source_url: "collection://2f672cc5-d225-81a6-a131-000b2b6e5f02")`
   - 여러 개면 목록을 보여주고 "전부 푸시할까요, 선택할까요?" 확인
3. `Notion:notion-fetch`로 페이지 전체 내용을 가져옴
4. Notion block 구조를 파싱

### Step 2 — Markdown + Frontmatter 변환

`references/frontmatter-spec.md`를 참고하여 변환한다.

**출력 파일 경로**: `posts/TIL-YYMMDD-slug.md`
**Git 레포**: `https://github.com/Get-bot/TIL`

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

**환경에 따라 분기한다:**

#### Claude Code (CLI 환경)
```bash
cd <TIL_REPO_PATH>
git pull origin main
cp <generated-file> posts/TIL-260409-redis-cache.md
git add posts/TIL-260409-redis-cache.md
git commit -m "TIL: 2026-04-09 - Redis 캐시 전략"
git push origin main
```

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
