# Notion DB 설정 가이드

TIL을 저장할 Notion DB는 **사용자별로 다르다**. 이 스킬은 특정 DB에 고정되어 있지 않다.
DB 정보는 메모리(Claude.ai) 또는 자동 메모리(Claude Code)에 저장하여 세션 간 재사용한다.

---

## DB 정보 확인 순서

### 1. 메모리 조회 먼저

**Claude.ai**: `memory_user_edits(command: "view")`로 TIL Notion DB 관련 메모리가 있는지 확인한다.
**Claude Code**: `<MEMORY_DIR>/til_notion.md` 파일이 존재하는지 확인한다.

있으면 저장된 값을 그대로 사용한다. 사용자에게 다시 묻지 않는다.

### 2. 없으면 사용자에게 DB URL을 요청

```
TIL을 저장할 Notion 데이터베이스 URL을 알려주세요.
예: https://www.notion.so/abc123def456...
```

### 3. DB URL에서 ID 추출 + 스키마 자동 탐색

1. URL에서 page/DB ID를 추출한다 (마지막 32자리 hex 또는 하이픈 포함 UUID)
2. `Notion:notion-fetch`로 DB 스키마를 조회하여 속성 목록을 가져온다:
   ```
   Notion:notion-fetch(url: "<사용자가 준 URL>")
   ```
3. 응답에서 다음 정보를 파싱한다:
    - `data_source_id` (DB를 가리키는 고유 ID)
    - **title 타입 속성** → TIL 제목을 넣을 필드
    - **date 타입 속성** → 작성일을 넣을 필드
4. 파싱 결과를 사용자에게 **확인**받는다:
   ```
   이 DB를 TIL 저장소로 사용할게요:
   - DB 이름: {db_name}
   - 제목 속성: {title_property} (title 타입)
   - 날짜 속성: {date_property} (date 타입)
   맞나요?
   ```

> **왜 자동 탐색인가**: 사용자에게 `data_source_id`나 속성명을 직접 물어보면 대부분 모른다.
> `notion-fetch`로 스키마를 읽으면 자동으로 매핑할 수 있어서 사용자 부담이 없다.

### 4. 메모리에 저장

**Claude.ai**: `memory_user_edits`로 저장한다:
```
memory_user_edits(command: "add", control: "TIL Notion DB: data_source_id={id}, title_property={name}, date_property={name}, page_id={id}")
```

**Claude Code**: `<MEMORY_DIR>/til_notion.md` 파일로 저장한다:
```markdown
---
name: TIL Notion DB
description: 사용자의 TIL Notion 데이터베이스 - Phase 1 저장 시 사용
type: reference
---

- data_source_id: {data_source_id}
- page_id: {page_id, fallback용}
- title_property: {title 타입 속성명}
- date_property: {date 타입 속성명}
- db_name: {DB 이름}
```

`<MEMORY_DIR>/MEMORY.md`에 인덱스 라인 추가:
```
- [TIL Notion DB](til_notion.md) — {db_name}
```

### 5. 이후 세션에서 재사용

메모리에서 로드하여 바로 사용한다. 사용자에게 다시 묻지 않는다.

---

## Notion 페이지 생성 방법

메모리에서 로드한 값을 사용하여 `Notion:notion-create-pages`를 호출한다:

```
Notion:notion-create-pages(
  parent: { data_source_id: "{메모리의 data_source_id}" },
  pages: [{
    properties: {
      "{메모리의 title_property}": "[TIL-260409] Redis 캐시 전략",
      "date:{메모리의 date_property}:start": "2026-04-09",
      "date:{메모리의 date_property}:is_datetime": 0
    },
    icon: "✍️",
    content: "<TIL 본문 - Notion Markdown>"
  }]
)
```

### Fallback 경로

| 단계 | 시도 | 실패 조건 |
|------|------|----------|
| 1차 | `data_source_id`로 DB에 직접 페이지 생성 | "Database not found" 또는 권한 오류 |
| 2차 | `page_id`로 sub-page로 생성 | 페이지 접근 불가 |
| 3차 | Markdown 파일로 생성 → 다운로드 제공 + Notion에 수동 복사 안내 | — |

> 1차에서 실패하는 가장 흔한 원인은 Notion Integration에 해당 DB가 공유되지 않은 경우다.
> 사용자에게 "Notion에서 해당 DB를 Integration에 공유했는지 확인해주세요"를 안내한다.

---

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| "Database not found" | DB가 Notion 연결(Integration)에 공유되었는지 확인 |
| 속성 타입 불일치 | `notion-fetch`로 실제 타입 재확인 후 메모리 업데이트 |
| 페이지 생성 실패 | 필수 속성 누락 여부 확인, fallback 경로 시도 |
| MCP 연결 안 됨 | Claude.ai 설정에서 Notion MCP 활성화 확인 |
| data_source_id 변경됨 | DB를 다시 fetch하여 메모리 업데이트 |
