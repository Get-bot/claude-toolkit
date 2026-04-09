# Frontmatter Specification

TIL을 Git에 푸시할 때 사용하는 Markdown + Frontmatter 형식.

## Frontmatter란?

Markdown 파일 맨 위에 `---`로 감싸는 메타데이터 블록.
Hugo, Jekyll 같은 정적 사이트 생성기가 이 정보를 읽어서 글 목록, 태그 분류 등에 활용한다.
쉽게 말해 **"글의 이력서"**가 파일 상단에 붙는 것.

## 파일 경로

```
posts/TIL-YYMMDD-slug.md
```

- 레포: `https://github.com/Get-bot/TIL`
- 디렉토리: `posts/`
- 파일명: `TIL-YYMMDD-slug.md`
- 예: `TIL-260409-redis-cache.md`, `TIL-260409-oauth2-kakao-login.md`
- slug 규칙: 주제의 영어 키워드, 소문자, 하이픈 구분

## Frontmatter 필드

```yaml
---
title: "[TIL-YYMMDD] 주제명"   # 필수. Notion 제목과 동일
date: YYYY-MM-DD              # 필수. 작성 날짜 (ISO 8601)
tags: ["tag1", "tag2"]        # 필수. 관련 기술/키워드 태그
categories: ["TIL"]           # 필수. 카테고리 (기본값: TIL)
description: "한 줄 요약"      # 필수. 핵심 내용 요약 (검색/SEO 활용)
---
```

## 태그 추출 규칙

1. **기술 스택** 이름은 무조건 태그에 포함: Spring Boot, Redis, Kafka, PostgreSQL 등
2. **작업 유형** 키워드 포함: 리팩토링, 성능최적화, 버그수정, 테스트 등
3. **패턴/개념** 이름 포함: Cache-Aside, OAuth2, SRP, Saga 등
4. 태그는 **3~7개** 범위로 유지
5. 태그 형식: 기술명은 공식 표기 (Spring Boot, not springboot)

## 본문 변환 규칙

Notion 블록 → Markdown 변환 시:

| Notion Block | Markdown |
|-------------|----------|
| Heading 2 | `## 제목` |
| Heading 3 | `### 제목` |
| Bulleted List | `- 내용` |
| Numbered List | `1. 내용` |
| Code Block | ``` 코드 ``` |
| Quote | `> 인용` |
| Divider | `---` |
| Bold | `**굵게**` |
| Inline Code | `` `코드` `` |

## 완성된 파일 예시

```markdown
---
title: "[TIL-260409] OAuth2 카카오 로그인 구현"
date: 2026-04-09
tags: ["Spring Boot", "OAuth2", "JWT", "Spring Security"]
categories: ["TIL"]
description: "Spring Security OAuth2 Client로 카카오 로그인 구현, JWT refresh race condition 해결"
---

## 잘한 점

### 상황 1
- OAuth2 기반 카카오 소셜 로그인 기능을 구현해야 했다.

### 액션 1
- Spring Security OAuth2 Client를 활용하여 카카오 로그인 플로우를 구현했다.

### 칭찬 1
- 처음 다루는 OAuth2 플로우를 하루 만에 동작하게 만든 점.

---

## 개선점

### 문제 1
- JWT refresh 로직에서 race condition 발생.

### 원인 1
- 동시 refresh 요청 시 이전 토큰 무효화 이슈.

### 액션플랜 1
- Redis 기반 lock 또는 refresh token rotation 전략 검토.

---

## 배운 점

### 배움 1
- 인증 로직의 책임 분리(SRP)가 테스트 용이성에 직접적으로 영향을 미친다.

### 의미 1
- 초기 설계 시 책임 분리를 의식적으로 고려하는 습관 필요.

---

## 핵심 내용

### 키워드
- `OAuth2 Authorization Code Flow`, `Spring Security OAuth2 Client`

### 요약
- OAuth2 인가 코드 플로우: 사용자 인증 → 인가 코드 → 액세스 토큰 교환 → 리소스 접근.
- JWT refresh 동시 요청은 Redis SETNX로 직렬화하여 해결 가능.

### 코드/명령어
```yaml
spring.security.oauth2.client.registration.kakao:
  client-id: ${KAKAO_CLIENT_ID}
  authorization-grant-type: authorization_code
  redirect-uri: "{baseUrl}/login/oauth2/code/kakao"
```

### 참고 자료
- https://docs.spring.io/spring-security/reference/servlet/oauth2/login.html
```

## 커밋 메시지 형식

```
TIL: YYYY-MM-DD - <주제명>
```

예시:
- `TIL: 2026-04-09 - OAuth2 카카오 로그인 구현`
- `TIL: 2026-04-09 - Redis 캐시 전략`
- `TIL: 2026-04-08 - Kafka Consumer 그룹 관리`
