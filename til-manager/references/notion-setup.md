# Notion DB 설정 가이드

## 확인 완료된 DB 정보

| 항목 | 값 |
|------|---|
| Page URL | `https://www.notion.so/2f672cc5d225812abccbd87e68b5328a` |
| DB 이름 | Today I Learned |
| Data Source ID | `2f672cc5-d225-81a6-a131-000b2b6e5f02` |
| Title 속성 | `[1/4]` (title 타입) |
| Date 속성 | `작성일` (date 타입) |

## Notion 페이지 생성 방법

`Notion:notion-create-pages` MCP 도구 사용:

```
Notion:notion-create-pages(
  parent: { data_source_id: "2f672cc5-d225-81a6-a131-000b2b6e5f02" },
  pages: [{
    properties: {
      "[1/4]": "[TIL-260409]",
      "date:작성일:start": "2026-04-09",
      "date:작성일:is_datetime": 0
    },
    icon: "✍️",
    content: "<TIL 본문 - Notion Markdown>"
  }]
)
```

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| "Database not found" | DB가 Notion 연결(Integration)에 공유되었는지 확인 |
| 속성 타입 불일치 | `notion-fetch`로 실제 타입 확인 후 재매핑 |
| 페이지 생성 실패 | 필수 속성 누락 여부 확인 |
| MCP 연결 안 됨 | Claude.ai 설정에서 Notion MCP 활성화 확인 |
