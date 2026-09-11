# claude-toolkit

Claude Code에서 반복되는 워크플로우를 자동화하는 **스킬 + 도구** 모음입니다.

매번 같은 지시를 반복하는 대신, 한번 만들어두고 말 한마디로 끝낼 수 있습니다.

## 스킬 목록

| 스킬 | 설명 |
|------|------|
| [til-manager](./til-manager) | 커밋 로그나 자유 텍스트를 던지면 4섹션 TIL로 구조화해서 Notion 저장 + Git push |

## 도구 목록

| 도구 | 설명 |
|------|------|
| [ssh-mcp](./ssh-mcp) | Claude가 원격 서버에 SSH로 접속해 명령 실행·파일 전송·셸 세션을 수행하는 MCP 서버 |

## 설치

### 스킬

npx로 바로 설치할 수 있습니다. skills CLI가 없어도 npx가 알아서 받아줍니다.

```bash
npx skills add Get-bot/claude-toolkit/til-manager
```

개별 스킬의 상세 사용법은 각 스킬의 README를 참고해주세요.

### 도구

도구는 스킬과 설치 방식이 다릅니다. MCP 서버로 등록합니다.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": ["-y", "@get-bot/ssh-mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add ssh-mcp -- npx -y @get-bot/ssh-mcp
```

Windows에서는 `npx` 대신 `cmd /c npx ...` 형태로 등록해야 합니다. 자세한 내용과 설정 명령(`setup`)·도구 목록은 [ssh-mcp/README.md](./ssh-mcp/README.md)를 참고하세요.

## 요구사항

- [Claude Code](https://claude.ai/code) 또는 Claude.ai
- 스킬에 따라 Notion MCP, GitHub 연동 등 추가 설정이 필요할 수 있습니다

## 라이선스

MIT
