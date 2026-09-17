# Quartz 지식베이스 푸시 (옵션)

TIL을 [Quartz](https://quartz.jzhao.xyz/) 기반 지식베이스 레포에도 게시하는 **옵션 경로**.

**기본 푸시 대상은 Notion + TIL 레포다.** 이 문서의 절차는 사용자가 quartz를 명시적으로 요청했을 때만 수행한다.

---

## 언제 실행하는가

| 사용자 발화 | 동작 |
|---|---|
| "TIL 깃에 올려줘", "오늘 TIL 푸시해줘" | TIL 레포만. **quartz는 묻지도 않는다** |
| "퀄츠에도 올려줘", "블로그에도 올려줘", "지식베이스에도 올려줘", "quartz에도 푸시", "둘 다 올려줘" | TIL 레포 + quartz |
| "퀄츠에만 올려줘" | quartz만 |

기본 경로에 질문을 하나 더 얹지 않는 것이 이 옵션의 설계 의도다. 먼저 제안하지 마라.

**선행 조건**: quartz에 올릴 본문은 Phase 2 Step 2에서 만든 TIL 레포용 Markdown을 그대로 재사용한다. 본문을 다시 생성하지 않는다.

---

## 메모리 스키마 (`quartz_repo.md`)

경로 규칙(`<MEMORY_DIR>`)은 `git-repo-setup.md`의 "자동 메모리 경로 규칙"과 동일하다.

| 항목 | 고정값 |
|---|---|
| 메모 파일명 | `quartz_repo.md` (변형 금지) |
| 메모 타입 | `reference` |
| 메모 name | `Quartz repo` |
| `MEMORY.md` 인덱스 라인 | `- [Quartz repo](quartz_repo.md) — {remote_url} ({local_path})` |

**본문 템플릿**:
```markdown
---
name: Quartz repo
description: TIL 옵션 게시 대상 Quartz 지식베이스 레포
metadata:
  type: reference
---

- remote_url: {원격 URL, 예: https://github.com/alice/quartz_base}
- local_path: {로컬 클론 절대 경로, 예: /d/quartz_base}
- default_branch: {기본 브랜치명, 예: main}
- content_root: {노트 루트, 보통 content}
- areas: {영역 폴더 목록, 예: ai, architecture, concurrency, cs, database, observability, security, spring, study, testing, workflow}
- convention_doc: {레포 자체 작성 규칙 문서 경로, 예: content/notes/writing-guide.md — 없으면 생략}
```

### 정보 확인 순서

1. `<MEMORY_DIR>/quartz_repo.md` 가 있으면 파싱해서 쓴다. 다시 묻지 않는다.
2. 없으면 한 번만 질문한다 — 원격 URL, 로컬 클론 경로.
3. `default_branch` 는 `git-repo-setup.md` Step 3의 브랜치 감지 스크립트를 그대로 재사용한다.
4. `content_root` / `areas` 는 **실측**한다. 레포마다 다르므로 추측하지 마라.
   ```bash
   cd "<QUARTZ_PATH>"
   ls -d content/*/ 2>/dev/null | sed 's|content/||; s|/$||'
   ```
   이 목록에서 **영역이 아닌 폴더는 빼고** 저장한다 — `MOC/`(지도), `notes/`(메타 노트),
   `templates/`·`private/`(빌드 제외)에는 TIL을 넣지 않는다. 판단이 애매하면 각 폴더의 `index.md`
   첫 문단을 읽어보면 그 폴더가 영역인지 아닌지 드러난다.
5. 위 템플릿대로 저장하고 `MEMORY.md` 에 인덱스 라인 한 줄을 추가한다.

> **`convention_doc` 이 있으면 작업 전에 반드시 읽어라.** 레포가 스스로 정한 규칙이 이 문서보다 우선한다. 이 문서의 태그·폴더·파일명 규칙은 그 규칙이 없을 때의 기본값이다.

---

## Step 1 — 배치 경로 결정

Quartz에는 `posts/` 가 없다. **영역 폴더에 직접** 둔다.

```
<content_root>/<area>/TIL-YYMMDD-slug.md
```

- **파일명은 TIL 레포와 동일한 것을 재사용한다.** slug 규칙은 `frontmatter-spec.md` 가 정본이다. 두 레포에서 파일명이 갈라지면 나중에 대조가 불가능하다.
- 하위 시리즈 폴더(`database/jpa/`, `security/oauth2/`)는 그 폴더에 **이미 같은 계열 노트가 2편 이상** 있을 때만 쓴다. 한 편짜리 폴더를 새로 파지 마라.
- 영역을 **추정한 뒤 사용자에게 확인받는다.** 추정 근거를 한 줄로 밝힌다: "Kafka consumer lag 얘기라 `concurrency/` 로 봤습니다."

### 영역 추정 힌트

아래는 참고용 신호 테이블이다. **실제 폴더 목록은 메모리의 `areas` / 실측이 우선**이다.

| 신호 | 영역 |
|---|---|
| Spring/Boot, DI, AOP, `@Transactional` 동작, 프로필·설정 | `spring` |
| SQL, 인덱스, 실행계획, 트랜잭션 격리, JPA/ORM, 복제 | `database` |
| 락, race condition, Redis, Kafka, 대기열, 부하 분산 | `concurrency` |
| 인증/인가, JWT, OAuth2, 암호화, 프록시 헤더 | `security` |
| 테스트 전략, Testcontainers, mock, 픽스처, 느린 테스트 | `testing` |
| 도메인 설계, 경계 긋기, 패턴 선택, 리팩토링 판단 | `architecture` |
| 로그, traceId, MDC, 구조화 로깅, 메트릭 | `observability` |
| 일하는 방식, PDCA, 설계 문서, 결정 로그, 리뷰 프로세스 | `workflow` |
| Claude Code, 에이전트, MCP, 스킬, 프롬프트 설계 | `ai` |
| 책 정리 | `study/<책>/` |
| 알고리즘, 자료구조, 시간 복잡도 | `cs` |

어디에 둘지 10초 이상 고민되면 **더 자주 찾아볼 쪽**에 두고, 다른 쪽 `index.md` 에서 링크한다.

### 중복 확인

같은 날짜·slug 파일이 **다른 영역 폴더에** 이미 있으면 새로 만들지 말고 기존 파일을 갱신한다. 파일명이 곧 URL이라 옮기면 링크가 깨진다.

```bash
find "<QUARTZ_PATH>/<content_root>" -name 'TIL-YYMMDD-*'
```

---

## Step 2 — Frontmatter 변환

**본문은 손대지 않는다.** TIL 레포 판과 quartz 판의 본문은 바이트 단위로 같아야 한다. 차이는 `tags` 한 줄뿐이다.

| 필드 | TIL 레포 | Quartz |
|---|---|---|
| `title` | `"[TIL-YYMMDD] 주제명"` | 동일 |
| `date` | `YYYY-MM-DD` | 동일. **생략 금지** — 없으면 커밋일로 잡혀 최근 노트 정렬이 흐트러진다 |
| `tags` | 공식 표기 (`"Spring Boot"`) | **소문자 kebab-case 영어** (`"spring-boot"`) |
| `categories` | `["TIL"]` | 그대로 유지 |
| `description` | 한 줄 요약 | 동일 |

추가로 쓸 수 있는 필드:
- `draft: true` — 미완성. 배포에서 제외된다.
- `source: <원문 URL>` — 외부(벨로그 등)에서 옮겨온 글.
- `aliases: ["한글-별칭"]` — 한글 위키링크로도 잡히게 한다.

### 태그 변환 규칙

1. 소문자 + 하이픈: `Spring Boot` → `spring-boot`, `Single Source of Truth` → `single-source-of-truth`
2. 한국어 태그는 영어로 통일: `문서 리팩토링` → `documentation`, `코드 리뷰` → `code-review`, `테스트` → `testing`, `성능최적화` → `performance`, `트랜잭션` → `transaction`
3. **새 태그를 만들기 전에 레포에 이미 쓰이는 표기를 찾아 재사용한다.** `spring-boot` 와 `springboot` 가 섞이면 태그 페이지가 둘로 갈라진다.
   ```bash
   cd "<QUARTZ_PATH>/<content_root>"
   find . -name '*.md' -print0 | xargs -0 awk '
     FNR==1 { fm=0; done=0; intags=0 }
     /^---[[:space:]]*$/ { if (!done) { if (fm) { done=1; fm=0 } else fm=1 }; next }
     fm && /^tags:/ { sub(/^tags:[[:space:]]*/,""); if (length($0)) print; intags=1; next }
     fm && intags && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]*/,""); print; next }
     fm { intags=0 }
   ' | tr -d '[]"' | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
     | grep -v '^$' | sort | uniq -c | sort -rn | head -40
   ```
4. 3~7개 유지.

---

## Step 3 — 영역 `index.md` 큐레이션 한 줄

Quartz에서 영역 폴더의 `index.md` 는 그 폴더의 첫 페이지이자 탐색 입구다. 새 노트를 넣으면 여기에 한 줄을 추가한다.

**형식**: `- [[TIL-YYMMDD-slug|표시 제목]] — 한 줄 요약`

- 위키링크는 **파일명(확장자 제외)** 으로 건다. 하위 폴더에 있어도 경로 없이 잡힌다.
- 표시 제목은 `[TIL-YYMMDD] ` 접두사를 뗀 자연어. 목록에서 날짜는 의미가 없다.
- 요약은 `description` 을 그대로 붙여넣지 마라. **그 노트를 왜 열어야 하는지**를 한 문장으로 쓴다. 기존 줄들의 톤을 먼저 읽고 맞춘다.
- 들어갈 소제목을 고른다. 마땅한 곳이 없으면 새 소제목을 만들지 말고 가장 가까운 절의 마지막에 붙인다.

> **🔴 초안을 사용자에게 보여주고 승인받은 뒤 커밋한다.** 이 한 줄은 사람이 읽는 큐레이션 문장이라, 자동 생성 결과를 그대로 밀어 넣으면 index 전체의 톤이 무너진다. 어느 영역 폴더인지와 이 한 줄을 **같이** 확인받아라.

**영역을 가로지르는 주제**면 `MOC/*.md` 의 해당 "실"에도 한 줄을 제안한다. 확신이 없으면 제안만 하고 사용자 판단에 맡긴다 — MOC는 서사라 아무 데나 끼우면 흐름이 끊긴다.

---

## Step 4 — 커밋 & 푸시

### 커밋 메시지

```
docs(<area>): [TIL-YYMMDD] 주제명
```

예시: `docs(concurrency): [TIL-260420] Kafka Consumer 피크 부하 시간축 분산`

- TIL 레포의 `TIL: YYYY-MM-DD - 주제명` 과 형식이 **다른 건 의도된 것**이다. quartz 레포는 conventional commits를 쓴다. 레포마다 그 레포의 컨벤션을 따른다.
- `<area>` 는 파일이 들어간 영역 폴더명. 하위 시리즈면 `docs(database/jpa):`.
- 대상 레포가 conventional commits를 쓰지 않으면(`git log --oneline -20` 으로 확인) 그 레포의 실제 스타일에 맞춘다.

### 묶는 단위

- **TIL 파일 + `index.md` 수정은 한 커밋**으로 묶는다. 노트와 그 입구는 같이 움직인다.
- TIL이 여러 개면 **TIL 단위로 커밋을 나눈다.**

### 실행

플레이스홀더는 `quartz_repo.md` 에서 로드한다.

```bash
cd "<QUARTZ_PATH>"
git pull origin <DEFAULT_BRANCH>

# CRLF가 섞여 들어가지 않게 LF로 변환하며 배치
# (quartz 레포는 보통 .gitattributes에 `* text=auto eol=lf` 를 건다)
sed 's/\r$//' "<generated-file>" > "<content_root>/<area>/TIL-260409-redis-cache.md"

# tags 줄을 quartz 표기로 교체한 뒤(Step 2), index.md 한 줄 추가(Step 3)
git add "<content_root>/<area>/TIL-260409-redis-cache.md" "<content_root>/<area>/index.md"
git commit -m "docs(<area>): [TIL-260409] Redis 캐시 전략"
git push origin <DEFAULT_BRANCH>
```

> `<DEFAULT_BRANCH>` 를 `main` 으로 하드코딩하지 마라. 메모리에서 로드한 값만 쓴다.

push하면 대부분 GitHub Actions가 자동 배포한다. 배포 성패는 이 스킬의 책임이 아니지만, 사용자에게 Actions 페이지 링크는 알려준다.

---

## 에러 처리

| 상황 | 대응 |
|---|---|
| `quartz_repo.md` 없음 | "정보 확인 순서"대로 한 번만 질문하고 저장 |
| 메모리의 `areas` 와 실측이 다름 | 실측 우선. 메모리를 갱신한다 |
| 영역 판단이 안 섬 | 후보 2개와 근거를 제시하고 사용자가 고르게 한다 |
| 같은 slug 파일이 다른 영역에 이미 있음 | 이동 금지. 기존 파일을 갱신한다 |
| `index.md` 에 맞는 소제목이 없음 | 새 소제목을 만들지 말고 가장 가까운 절 끝에 추가하는 안을 제시 |
| quartz push 실패 | **TIL 레포 푸시는 이미 끝났다는 사실을 먼저 알린다.** 그 다음 quartz만 재시도하거나 수동 절차를 안내한다 |
| Claude.ai(MCP) 환경 | git push가 불가능하다. 변환된 파일과 `index.md` 한 줄을 제시하고 수동 반영을 안내한다 |
