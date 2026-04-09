# TIL 템플릿

TIL 생성 시 반드시 이 템플릿 구조를 따른다.
제목 형식: `[TIL-YYMMDD] 주제명` (예: `[TIL-260409] Redis 캐시 전략`)
하루에 여러 개 작성 가능. 각 TIL은 하나의 주제에 집중한다.

---

## 구조

```
## 잘한 점
> "오늘의 나는 무엇을 잘했는지" 작성해 보세요.

### 상황 N
- (간략한 상황 설명. 맥락을 이해하기 위함.)

### 액션 N
- (구체적으로 어떤 행동이 잘한 점이었는지.)

### 칭찬 N
- (자기 긍정의 하이라이트. 진정성 있게.)

---

## 개선점
> "어떤 문제/어려움을 겪었는지, 향후 어떤 액션으로 해결할 것인지" 작성해 보세요.

### 문제 N
- (현재 업무에서 해결되어야 하는 문제.)

### 원인 N
- (문제의 원인 분석.)

### 액션플랜 N
- (문제 해결을 위해 다음에 실행할 구체적 액션.)

---

## 배운 점
> "오늘 일에서 어떤 것을 배웠는지" 작성해 보세요.

### 배움 N
- (오늘의 업무/학습을 통해 배운 것.)

### 의미 N
- (이 배움을 왜 기록하고 싶은지. 앞으로 어떤 의미가 있는지.)

---

## 핵심 내용
> "오늘 배운 기술적 내용의 핵심을 정리해 보세요." 나중에 레퍼런스로 다시 찾아볼 수 있도록.

### 키워드
- (오늘의 핵심 기술 키워드 나열. 예: `Cache-Aside`, `@CacheEvict`, `TTL`)

### 요약
- (핵심 개념을 1-3문장으로 압축 정리.)

### 코드/명령어 (선택)
- (기억해둘 코드 스니펫, 설정값, 명령어 등. 코드 블록으로 작성.)

### 참고 자료 (선택)
- (도움이 된 문서, 블로그, 공식 문서 링크.)
```

---

## 작성 원칙

1. **N은 1부터 순번** — 각 섹션 내 항목이 여러 개면 번호를 매긴다 (상황 1, 상황 2, ...)
2. **빈 섹션은 억지로 채우지 않는다** — 해당 없으면 "오늘은 특별히 없음"으로 표기
3. **기술 용어는 영어 그대로** — Spring Boot, Redis, Kafka 등
4. **구체적으로 쓴다** — "잘했다" (X) → "A 기능의 API 응답시간을 300ms에서 20ms로 줄였다" (O)
5. **칭찬은 진정성 있게** — 사용자의 톤에 맞추되 과장하지 않는다
6. **액션플랜은 실행 가능하게** — "앞으로 잘하자" (X) → "매일 PR 올리기 전 테스트 커버리지 확인하자" (O)
7. **핵심 내용은 미래의 나를 위한 레퍼런스** — "배운 점"은 회고, "핵심 내용"은 기술 노트. 6개월 후에 검색해서 바로 쓸 수 있을 정도로 구체적으로 적는다.
8. **핵심 내용의 코드/참고자료는 선택** — 코드 없이 개념만 정리해도 OK. 억지로 코드를 넣지 않는다.

---

## 커밋 로그 기반 생성 예시

**입력:**
```
feat: 카카오 OAuth2 로그인 구현
fix: JWT 토큰 만료 시 refresh 로직 버그 수정
refactor: UserService에서 인증 로직을 AuthService로 분리
```

**생성 결과:**

```
## 잘한 점

### 상황 1
- 카카오 소셜 로그인을 붙여야 했다. 기존에는 이메일/비밀번호만 있었는데 사용자 편의를 위해 소셜 로그인 추가.

### 액션 1
- Spring Security OAuth2 Client로 카카오 로그인 플로우를 구현했다. 인가 코드 → 액세스 토큰 → 사용자 정보 조회까지 전체 파이프라인 완성.

### 칭찬 1
- OAuth2 처음인데 하루 만에 동작하게 만들었다. 문서랑 코드 왔다갔다하면서 끝까지 해낸 게 좀 뿌듯.

## 개선점

### 문제 1
- JWT refresh 로직에서 race condition이 터져서 간헐적으로 401이 나오고 있었다.

### 원인 1
- refresh token 요청이 동시에 여러 개 들어오면, 이전 refresh token이 이미 무효화된 상태에서 다음 요청이 처리되면서 실패하는 구조. 이걸 미처 못 챙겼다.

### 액션플랜 1
- 동시성 제어 추가해야 한다. Redis 기반 lock이나 refresh token rotation 전략 검토해보자.

## 배운 점

### 배움 1
- 인증 로직이 UserService에 섞여 있으니까 테스트 짜기가 너무 힘들었다. AuthService로 분리하니까 확실히 수월해졌다. 아 이래서 SRP가 중요한 거구나.

### 의미 1
- "일단 돌아가게" 만든 코드가 쌓이면 결국 리팩토링 비용이 눈덩이가 된다. 처음부터 책임 분리를 의식하자.

## 핵심 내용

### 키워드
- `OAuth2 Authorization Code Flow`, `Spring Security OAuth2 Client`, `JWT Refresh Token Rotation`

### 요약
- OAuth2 인가 코드 플로우: 사용자 인증 → 인가 코드 발급 → 액세스 토큰 교환 → 리소스 접근. Spring Security에서는 `OAuth2LoginAuthenticationFilter`가 이 과정을 처리한다.
- JWT refresh 시 동시 요청 문제는 token rotation + Redis lock으로 해결 가능. refresh token을 1회용으로 만들고, 동시 요청은 Redis SETNX로 직렬화.

### 코드/명령어
- ```yaml
  # application.yml - 카카오 OAuth2 설정
  spring.security.oauth2.client.registration.kakao:
    client-id: ${KAKAO_CLIENT_ID}
    authorization-grant-type: authorization_code
    redirect-uri: "{baseUrl}/login/oauth2/code/kakao"
    scope: profile_nickname, account_email
  ```

### 참고 자료
- Spring Security OAuth2 공식 문서: https://docs.spring.io/spring-security/reference/servlet/oauth2/login.html
- 카카오 로그인 REST API: https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api
```

---

## raw 텍스트 기반 생성 예시

**입력:**
```
오늘 Redis 캐시 적용해서 API 응답 속도 많이 개선함. 근데 캐시 무효화 전략을 제대로 안 세워서
데이터 정합성 이슈가 한번 터졌음. TTL로 임시 처리했는데 근본적인 해결은 아닌 것 같음.
Cache-Aside 패턴이랑 Write-Through 패턴 차이를 확실히 이해하게 됨.
```

**생성 결과:**

```
## 잘한 점

### 상황 1
- API 응답이 느려서 Redis 캐시를 적용하기로 했다.

### 액션 1
- Redis 캐시 붙여서 API 응답 속도를 많이 개선했다.

### 칭찬 1
- 성능 문제를 직접 캡치해서 캐시까지 적용한 것. 스스로 문제 인식하고 해결까지 가져간 게 좋았다.

## 개선점

### 문제 1
- 캐시 무효화 전략을 안 세우고 넣어서 데이터 정합성 이슈가 한번 터졌다.

### 원인 1
- 급하게 캐시를 넣다 보니 무효화 전략을 미리 안 짰다. TTL로 일단 땜빵했는데 근본적인 해결은 아닌 것 같다.

### 액션플랜 1
- Cache-Aside vs Write-Through 비교해보고, 우리 서비스에 맞는 캐시 전략 확정하자. 다음 스프린트에서 캐시 무효화 로직 구현.

## 배운 점

### 배움 1
- Cache-Aside는 읽기 중심일 때, Write-Through는 쓰기 정합성이 중요할 때 쓴다. 둘의 트레이드오프를 오늘 실무에서 직접 느꼈다.

### 의미 1
- 캐시는 "붙이면 빨라지는 것"이 아니라 "무효화 전략까지 세트"라는 걸 몸으로 배웠다. 앞으로 캐시 넣기 전에 무효화부터 먼저 생각하자.

## 핵심 내용

### 키워드
- `Cache-Aside`, `Write-Through`, `TTL`, `@Cacheable`, `@CacheEvict`

### 요약
- **Cache-Aside**: 앱이 캐시를 직접 관리. 읽기: 캐시 miss → DB 조회 → 캐시 저장. 쓰기: DB 업데이트 → 캐시 삭제(invalidate). 읽기 중심 워크로드에 적합.
- **Write-Through**: 캐시를 통해 DB에 쓰기. 쓰기 시 캐시와 DB 동시 업데이트. 정합성이 중요한 경우 적합하지만 쓰기 지연 증가.
- TTL만으로 무효화하면 TTL 동안 stale data 노출 → 명시적 invalidation 필수.

### 코드/명령어
- ```java
  // Cache-Aside with Spring
  @Cacheable(value = "products", key = "#id")
  public Product getProduct(Long id) { ... }
  
  @CacheEvict(value = "products", key = "#id")
  public void updateProduct(Long id, ProductDto dto) { ... }
  ```
```
