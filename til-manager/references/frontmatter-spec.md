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

- 레포: 메모리에서 로드 (`git-repo-setup.md` 참조)
- 디렉토리: `posts/`
- 파일명: `TIL-YYMMDD-slug.md`

### slug 생성 규칙

주제명에서 영어 키워드 추출 → 소문자 → 하이픈 연결 → 특수문자 제거.

| TIL 제목 | slug | 파일명 |
|----------|------|--------|
| `[TIL-260409] Redis Cache-Aside 패턴 적용` | `redis-cache-aside` | `TIL-260409-redis-cache-aside.md` |
| `[TIL-260409] OAuth2 카카오 로그인 구현` | `oauth2-kakao-login` | `TIL-260409-oauth2-kakao-login.md` |
| `[TIL-260409] Redis 캐시 전략` | `redis-cache` | `TIL-260409-redis-cache.md` |

- 한국어 키워드는 대응하는 영어로 변환 ("캐시 전략" → `cache`)
- 관사, 조사, 접속사 등 불필요한 단어 제거
- 연속 하이픈 금지 (`--` → `-`)

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

### 카카오 OAuth2 로그인 구현

**상황**
- 기존엔 이메일/비밀번호 로그인만 있었는데 신규 유입 전환율이 낮다는 피드백이 쌓임
- 이번 스프린트에 카카오부터 붙이기로 결정
- OAuth2는 처음 다뤄봄

**액션**
- Spring Security OAuth2 Client로 인가 코드 → 액세스 토큰 → 사용자 정보 조회 파이프라인 구현
- `SocialAuthService`를 분리하고 provider별 전략 패턴으로 설계
- 나중에 구글/네이버 붙일 때 provider만 추가하면 되는 구조 확보

**칭찬**
- 처음 다루는 OAuth2 플로우를 하루 만에 동작하게 만든 점
- 급할 때 "일단 돌아가게" 짜는 습관을 피하고 처음부터 확장성 고려해 분리한 판단

---

## 개선점

### JWT refresh race condition

**문제**
- refresh 로직에서 간헐적으로 401 발생
- 동시에 여러 탭에서 refresh 요청이 들어갈 때만 재현되는 패턴

**원인**
- refresh token 1회용 구조에서 첫 요청이 token을 무효화한 직후 두 번째 요청이 유효하지 않은 token으로 시도
- 단일 탭 테스트만 해서 동시성 시나리오를 놓침

**액션플랜**
- 옵션 1: Redis SETNX로 refresh 요청 직렬화
- 옵션 2: grace period로 이전 token을 짧은 시간 유효하게 유지
- POC 후 성능/복잡도 비교해 확정

---

## 배운 점

### SRP와 책임 분리의 중요성

**배움**
- 인증 로직의 책임 분리(SRP)가 테스트 용이성에 직접 영향을 미친다
- `AuthService`로 분리 후 mock 대상이 명확해지고 테스트 케이스가 단순해짐

**의미**
- 초기 설계 시 책임 분리를 의식적으로 고려하는 습관 필요
- 특히 인증/결제 같은 크로스커팅 관심사는 반드시 별도 서비스로 분리

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
