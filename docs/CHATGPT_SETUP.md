# ChatGPT·Codex MCP 연결

RELU AI Bridge는 browser/desktop 분석 session을 노출하는 Streamable HTTP MCP endpoint를 제공한다. 기본 지원 경로는 Claude이며, 이 문서는 선택적으로 Codex/ChatGPT를 연결할 때 사용한다.

```text
URL:            http://127.0.0.1:5746/mcp
Protocol:       MCP 2025-06-18
Authentication: Authorization: Bearer <RELU_AI_BRIDGE_TOKEN>
Health:         http://127.0.0.1:5746/health
Admin:          http://127.0.0.1:5746/admin/
```

OpenAI 공식 문서 기준으로 local Codex client는 Streamable HTTP와 bearer token을 지원하며, ChatGPT web의 hosted chat은 로컬 Codex 설정을 직접 읽지 않는다. 사내/private MCP를 ChatGPT web에 연결할 때는 public ingress를 직접 만들지 말고 Secure MCP Tunnel을 사용한다.

- [Codex MCP 설정](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex Skills 만들기](https://learn.chatgpt.com/ko-KR/docs/build-skills)
- [MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 1. 서버 기동

```bash
node ./bin/relu-ai-bridge.mjs init ./config/local.json /absolute/approved/project
```

출력된 control token과 별도 Perfetto connector token을 회사 secret manager에 따로 저장한다. 저장소나 shell history에 token literal을 넣지 않는다.

```bash
export RELU_AI_BRIDGE_CONFIG="$PWD/config/local.json"
export RELU_AI_BRIDGE_TOKEN="$(approved-secret-command)"
export RELU_PERFETTO_CONNECTOR_TOKEN="$(approved-perfetto-secret-command)"
node ./bin/relu-ai-bridge.mjs doctor
node ./bin/relu-ai-bridge.mjs serve
```

다른 terminal에서:

```bash
curl --fail http://127.0.0.1:5746/health
```

## 선택: Chrome Companion 설치와 페어링

Companion은 ChatGPT web의 Goal, Compact & Resume, browser worker와 local 승인 UI를
쓰는 경우에만 설치한다. Claude Code만 사용하면 생략한다.

1. Chrome에서 `chrome://extensions`를 열고 개발자 모드를 켠다.
2. `압축해제된 확장 프로그램을 로드`에서 검토한 checkout의
   `/absolute/path/to/relu-ai-bridge/extension`을 선택한다.
3. 표시된 32자 extension ID를 복사한다. 사내 배포는 서명·정책 배포로 ID를
   고정하고, 개발용 unpacked ID를 운영 allowlist에 재사용하지 않는다.
4. `config/local.json`의 `server.allowedChromeExtensionIds`에 그 ID만 추가하고
   Bridge를 재시작한다.

```json
{
  "server": {
    "allowedChromeExtensionIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
  }
}
```

5. Extension popup에서 URL을 exact `http://127.0.0.1:5746`로 설정하고 control
   token(`RELU_AI_BRIDGE_TOKEN`과 같은 audience)을 입력한 뒤 연결 확인을 누른다.

Token은 `chrome.storage.session`에만 있어 Chrome 재시작 뒤 다시 입력해야 한다.
Companion은 각 API 호출 전에 민감한 path/body를 보내지 않는 challenge로 실제
Bridge의 fresh HMAC proof를 검증한다. 그 뒤 method/path/body digest에 묶인 one-shot
proof만 보내며 raw control token을 Authorization header로 전송하지 않는다.
확장 프로그램을 제거하거나 ID가 바뀌면 allowlist의 이전 ID를 삭제하고, 의심되는
경우 control token을 회전하며 수동 정책의 저장 grant도 함께 철회한다. `403`이면 실제
extension ID와 allowlist, Bridge 재시작 여부부터 확인한다.

## 2A. Local Codex/ChatGPT desktop 연결

`~/.codex/config.toml` 또는 trusted project의 `.codex/config.toml`에 다음을 추가한다.

```toml
[mcp_servers.relu_ai_bridge]
url = "http://127.0.0.1:5746/mcp"
bearer_token_env_var = "RELU_AI_BRIDGE_TOKEN"
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

환경변수는 Codex/ChatGPT desktop process가 실제로 상속해야 한다. 설정 후 해당 local client에서 MCP server 목록을 확인하고 필요하면 그 client를 재시작한다.

확인 항목:

- server가 enabled 상태인지
- `list_sessions`, `get_context`, `list_capabilities`, `execute`와 Perfetto 전용 도구가 보이는지
- `/mcp` 호출에 401이 아닌 initialize 응답이 오는지
- tool schema 변경 뒤 새 session에서 목록이 갱신됐는지

플랫폼 승인과 이 프로젝트의 local policy는 별개다. 새 RELU 설정의
`trusted_always`는 로컬의 always-eligible 호출을 자동 허용하지만 Codex/ChatGPT
플랫폼 자체의 approval mode나 사용자 의도를 바꾸지 않는다.

현재 Perfetto/WPF 선택 구간의 분석 절차도 함께 쓰려면 project scope Skill을 설치한다.

```bash
./scripts/skills/install-skills.sh \
  --scope project --target codex --project-root /absolute/path/to/analysis-project
./scripts/skills/verify-skills.sh \
  --scope project --target codex --project-root /absolute/path/to/analysis-project
```

설치 위치는 `<project>/.agents/skills/relu-analyze-selection`이다. User scope와 Windows
PowerShell 명령, checksum/갱신/제거 계약은 [분석 Skill 설계](SKILLS_KO.md)를 따른다.
Skill은 권한을 추가하거나 승인을 대신하지 않고 live `list_capabilities`만 실행 계약으로
사용한다.

## 2B. ChatGPT web/Work 연결

ChatGPT web은 `~/.codex/config.toml`과 local command menu를 사용하지 않는다. 다음 구조를 사용한다.

```text
ChatGPT workspace
       │ OpenAI-hosted tunnel endpoint
       ▼
Secure MCP Tunnel control plane
       │ outbound connection
       ▼
tunnel-client on managed company endpoint
       │ private/loopback HTTP
       ▼
127.0.0.1:5746/mcp
```

운영 순서:

1. 회사 Platform/ChatGPT 관리자가 tunnel 사용 권한과 target workspace를 준비한다.
2. `tunnel-client`를 이 서버와 같은 trust boundary에서 실행한다.
3. 공식 quickstart에 따라 profile을 만들고 `doctor --explain`을 통과시킨다.
4. HTTP MCP target을 이 서버의 `/mcp`로 설정한다.
5. ChatGPT Plugins의 developer-mode app에서 Connection을 Tunnel로 선택한다.
6. target workspace에 연결된 tunnel인지 확인하고 tool 목록을 검토한다.

Tunnel은 transport일 뿐이다. App invocation과 인증 lifecycle에는 정상 workspace compliance 정책이 계속 적용된다. Tunnel control-plane credential과 `RELU_AI_BRIDGE_TOKEN`, Perfetto connector token, service connector token은 모두 다른 비밀로 관리한다.

### MCP-side 인증

Tunnel profile에서 bearer header 전달을 지원하면 기본 `/mcp` endpoint를 사용한다. 조직의 승인된 gateway/mTLS가 MCP-side 인증을 담당하는 경우에만 해당 boundary 안에서 auth 구성을 조정한다.

정적 header 전달을 구성할 수 없지만 secret URL이 회사 정책상 허용될 때는 마지막 수단으로 다음을 쓸 수 있다.

```json
{
  "server": {
    "mcpAuth": "path"
  }
}
```

Target URL:

```text
http://127.0.0.1:5746/mcp/<RELU_AI_BRIDGE_TOKEN>
```

이 URL 전체가 credential이다. 일반 log, ticket, chat, screenshot 또는 release manifest에 기록하지 않는다. Browser/control API는 계속 bearer 인증을 요구한다.

## 3. 승인 정책

새 `init` 설정은 `approvals.policy:"trusted_always"`다. 일반 보호 호출은 개별
pending/grant 없이 같은 호출에서 실행된다. `manual`을 선택했거나 결과 불명 변경의
판정처럼 `once/deny`만 가능한 요청에서 Tool이 `APPROVAL_REQUIRED`를 반환하면 다음
주소를 연다.

```text
http://127.0.0.1:5746/admin/
```

Token을 입력한 뒤 해당 요청이 허용하는 결정 중 하나를 고른다.

- `한 번`: 정확히 같은 요청을 다음 1회만 허용
- `현재 세션`: 같은 session과 scope 허용
- `항상 허용`: 같은 scope를 재시작 후에도 허용
- `거부`: pending request 거부

Scope의 connector peer는 browser의 server-observed exact Origin 또는 allowlist의
desktop app ID에서 도출한 `relu-desktop://<sha256>` opaque trust-domain key다. 별도의
page/application-instance binding과 `bindingFields` resource도 scope에 결합되므로
다른 탭·desktop 설치·dataset으로 권한이 확장되지 않는다.

결정 후 원래 MCP tool call을 다시 실행한다. 수동 영구 grant는 같은 화면에서
철회한다. `trusted_always` 구성 정책은 개별 grant가 아니며 설정을 `manual`로 바꾸고
Bridge를 재시작해 해제한다. 정책 전환 시 이전 pending/grant는 무효화된다.

## 문제 해결

### 401 Unauthorized

- server process와 client가 같은 token을 쓰는지 확인한다.
- local client가 `RELU_AI_BRIDGE_TOKEN`을 상속했는지 확인한다.
- `mcpAuth`가 `bearer`인지 `path`인지 확인한다.

### Codex에 tool이 보이지 않음

- `node ./bin/relu-ai-bridge.mjs doctor`
- local client의 MCP server 목록
- `curl /health`
- 설정을 읽는 client가 desktop/CLI/IDE 중 무엇인지 확인
- schema 변경 후 해당 local client를 새로 시작

### ChatGPT web에서 tunnel이 안 보임

- tunnel이 Platform organization뿐 아니라 target ChatGPT workspace와 연결됐는지 확인한다.
- 사용자가 Tunnels Read/Use 권한을 갖는지 확인한다.
- `tunnel-client run`이 계속 실행 중인지 확인한다.
- `tunnel-client doctor --profile <name> --explain`과 local admin UI를 확인한다.

### RELU session이 0개

Browser/desktop 서비스가 주 config의 `connectors.services`에 등록됐는지, exact Origin 또는 app ID와 service별 `tokenEnv`가 맞는지, SDK status가 connected인지 확인한다. Service token은 control token과 달라야 한다.

### Perfetto client가 0개

MCP 연결과 Perfetto WebSocket 연결은 별개다. `RELU AI Bridge 연결` command에서 control token이 아닌 전용 `RELU_PERFETTO_CONNECTOR_TOKEN` 값을 입력한다. 값은 페이지 메모리에만 유지되어 reload 후 다시 입력해야 하며 raw token은 wire에 전송되지 않는다. Plugin은 loopback server의 fresh HMAC proof를 확인한 뒤에만 trace descriptor를 공개한다. 사내 Perfetto origin도 `perfetto.allowedOrigins`에 exact entry로 추가해야 한다.
