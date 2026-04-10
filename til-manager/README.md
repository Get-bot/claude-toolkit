# til-manager

Claude Code용 TIL 자동화 스킬.

커밋 로그나 오늘 한 일을 던지면, 4섹션 구조로 잡아서 Notion에 저장하고 GitHub에 Markdown으로 push한다.

## 왜 만들었나

TIL은 좋은 습관인데, 매일 하기엔 세팅이 너무 번거롭다.
Notion 열고, 템플릿 복사하고, 구조 맞춰 쓰고, Markdown으로 변환하고, Git에 push하고.
TIL 자체보다 이 과정에 시간이 더 든다.

이 스킬은 "오늘 이거 했어" 한마디면 나머지를 알아서 처리한다.

AI가 쓴 글은 "유의미한 성과를 달성하였다" 같은 보고서 톤이 나오기 쉽다.
TIL은 보고서가 아니라 내 기록이니까, human-writing-guide를 포함해서 자연스러운 문체로 나오게 했다.

## 동작 방식

**입력:**

```
오늘 Redis 캐시 적용했는데 무효화 전략 안 세워서 한번 터졌음.
Cache-Aside랑 Write-Through 차이를 확실히 이해하게 됨.
```

**결과:** 4섹션(잘한 점 / 개선점 / 배운 점 / 핵심 내용)으로 구조화되어 Notion에 저장된다.

```markdown
## 잘한 점

### Redis 캐시 적용으로 API 속도 개선

**상황**
- API 응답이 느려서 사용자 체감 속도 이슈가 쌓임
- 특히 상품 목록 조회가 병목

**액션**
- Redis 캐시를 붙여서 응답 속도 대폭 개선 (600ms → 80ms)
- `@Cacheable`로 읽기 경로에 캐시 적용

**칭찬**
- 성능 문제를 직접 캐치해서 해결까지 가져간 것
- PR에 before/after 수치를 박아 넣은 점

---

## 개선점

### 캐시 무효화 전략 부재로 정합성 이슈

**문제**
- 캐시 무효화 전략 없이 넣어서 데이터 정합성 이슈 발생
- 관리자가 수정한 상품 정보가 사용자 화면에 반영 안 됨

**원인**
- 급하게 캐시를 넣다 보니 무효화 전략을 미리 안 짰음
- 쓰기 경로에서 `@CacheEvict`를 아예 빼먹음

**액션플랜**
- Cache-Aside vs Write-Through 비교 후 서비스에 맞는 전략 확정
- 다음 스프린트에 무효화 로직 도입

---

## 배운 점

### Cache-Aside vs Write-Through 트레이드오프

**배움**
- Cache-Aside는 읽기 중심, Write-Through는 쓰기 정합성이 중요할 때 쓴다
- 둘의 트레이드오프를 CS 들어온 순간 이해도가 확 올라감

**의미**
- 캐시는 "붙이면 빨라지는 것"이 아니라 "무효화 전략까지 세트"라는 걸 몸으로 배웠다
- 앞으로 캐시 넣기 전에 무효화 경로부터 먼저 설계하자

---

## 핵심 내용

### 키워드
- `Cache-Aside`, `Write-Through`, `TTL`, `@Cacheable`, `@CacheEvict`

### 요약
- TTL만으로 무효화하면 stale data 노출 → 명시적 invalidation 필수.
```

"TIL 깃에 올려줘" 하면 Notion에서 가져와서 frontmatter 붙인 Markdown으로 변환, Git push까지 처리한다.

## 설치

[skills](https://github.com/vercel-labs/skills) CLI로 설치한다.

```bash
npx skills add Get-bot/claude-toolkit/til-manager
```

글로벌 설치 후 사용:

```bash
npm install -g skills
skills add Get-bot/claude-toolkit/til-manager
```

직접 복사:

```bash
git clone https://github.com/Get-bot/claude-toolkit.git
cp -r claude-toolkit/til-manager ~/.claude/skills/til-manager
```

## 사전 준비

### Notion

1. Notion에 데이터베이스 생성 (Title + Date 속성이면 충분)
2. Claude.ai 또는 Claude Code에서 Notion MCP 연결

처음 TIL 작성 시 Claude가 Notion DB URL을 물어본다. 알려주면 자동으로 연결된다.

### GitHub

TIL용 레포를 만들고 `posts/` 디렉토리를 준비한다. 여기에 파일이 쌓인다.

## 사용법

Claude Code나 Claude.ai에서 자연어로 요청하면 된다.

| 하고 싶은 것 | 예시 |
|-------------|------|
| TIL 작성 | "오늘 TIL 작성해줘", "커밋 정리해서 TIL 만들어줘" |
| 특정 주제 TIL | "Redis 공부한 거 TIL로 만들어줘" |
| Git push | "TIL 깃에 올려줘", "오늘 TIL 푸시해줘" |
| 하루 회고 | "오늘 뭐했는지 정리해줘" |

입력은 커밋 로그, 자유 텍스트, 둘 다 섞어서 가능하다.

### 커밋 로그 입력

```
feat: 카카오 OAuth2 로그인 구현
fix: JWT 토큰 만료 시 refresh 로직 버그 수정
refactor: UserService에서 인증 로직을 AuthService로 분리
```

커밋 타입에 따라 자동으로 섹션에 배치된다.
`feat` → 잘한 점, `fix` → 개선점/배운 점, `refactor` → 잘한 점/배운 점.

### 자유 텍스트 입력

```
오늘 캐시 적용했는데 무효화 전략 안 세워서 한번 터짐.
일단 TTL로 때웠는데 좀 찝찝함.
```

키워드 기반으로 자동 분류된다.
"해결했다" → 잘한 점, "어려웠다" → 개선점, "알게 되었다" → 배운 점.

## AI 느낌 안 나는 문체

이 스킬의 핵심 차별점이다. AI가 쓴 TIL은 어디서든 비슷하게 나온다.

```
❌ "API 응답 속도를 유의미하게 개선하였다"
❌ "체계적으로 접근하여 문제를 해결하였다"
```

human-writing-guide가 이런 톤을 잡아준다.

```
✅ "API 응답이 300ms에서 20ms로 줄었다"
✅ "하나씩 찾아보면서 해결했다"
```

사용자의 톤을 미러링하는 방식이다.
캐주얼하게 쓰면 캐주얼하게, 격식체로 쓰면 정돈되게 나온다.

## 파일 구조

```
til-manager/
├── SKILL.md                    # 스킬 본체
└── references/
    ├── til-template.md         # TIL 4섹션 템플릿
    ├── human-writing-guide.md  # 자연스러운 문체 가이드
    ├── frontmatter-spec.md     # Git push용 Markdown frontmatter 규격
    └── notion-setup.md         # Notion DB 연결 설정
```

## 커스터마이징

| 바꾸고 싶은 것 | 수정할 파일 |
|--------------|-----------|
| TIL 구조/섹션 | `references/til-template.md` |
| 문체 규칙 | `references/human-writing-guide.md` |
| Notion DB 설정 | `references/notion-setup.md` |
| frontmatter 형식 | `references/frontmatter-spec.md` |
| Git 레포 경로 | `SKILL.md` 내 레포 URL |

## Git Push 결과물

```markdown
---
title: "[TIL-260409] Redis 캐시 전략"
date: 2026-04-09
tags: ["Redis", "Cache-Aside", "Spring Boot"]
categories: ["TIL"]
description: "Cache-Aside 패턴 적용, TTL 기반 무효화 전략"
---

## 잘한 점
...
```

파일명: `posts/TIL-260409-redis-cache.md`
커밋 메시지: `TIL: 2026-04-09 - Redis 캐시 전략`

## 제한사항

- Notion MCP가 연결되어 있어야 Notion 저장이 가능하다
- Claude.ai에서는 Git push가 직접 안 된다 (파일 다운로드 후 수동 push)
- Claude Code (CLI)에서는 Git push까지 자동으로 처리된다
- 같은 날 같은 주제로 다시 쓰면 업데이트할지 새로 만들지 물어본다

## 라이선스

MIT
