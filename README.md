# claude-toolkit

Claude Code에서 반복되는 워크플로우를 자동화하는 스킬 모음입니다.

매번 같은 지시를 반복하는 대신, 한번 만들어두고 말 한마디로 끝낼 수 있습니다.

## 스킬 목록

| 스킬 | 설명 |
|------|------|
| [til-manager](./til-manager) | 커밋 로그나 자유 텍스트를 던지면 4섹션 TIL로 구조화해서 Notion 저장 + Git push |

## 설치

npx로 바로 설치할 수 있습니다. skills CLI가 없어도 npx가 알아서 받아줍니다.

```bash
npx skills add Get-bot/claude-toolkit/til-manager
```

개별 스킬의 상세 사용법은 각 스킬의 README를 참고해주세요.

## 요구사항

- [Claude Code](https://claude.ai/code) 또는 Claude.ai
- 스킬에 따라 Notion MCP, GitHub 연동 등 추가 설정이 필요할 수 있습니다

## 라이선스

MIT
