# RELU AI Bridge Embedded Desktop SDK

사내 Windows/WPF 분석 프로그램에 local MCP bridge를 **내장**하는 `net8.0` SDK다.
패키지 버전은 0.7.0이다.

```powershell
dotnet add package Relu.AI.Bridge.DesktopConnector --version 0.7.0
```

이 명령은 EndViewer 개발자가 application을 빌드할 때만 사용한다. 최종 사용자는 RELU,
Node.js 또는 별도 Connector를 설치하지 않는다. 회사가 runtime과 SDK를 포함해 서명한
`EndViewer.exe`를 실행하면 된다.

이 package/repository에는 proprietary EndViewer application, 분석 엔진, installer,
signing material 또는 완성된 exe가 없다. EndViewer 팀이 실제 앱에 통합한 뒤 Windows
release pipeline에서 publish·서명·검증한다.

## 제공 기능

- `ReluEmbeddedBridgeHost`: GUI process의 live Context, 고정 Capability와
  `CurrentUserOnly` named pipe host
- `ReluMcpStdioEntryPoint`: 동일 실행 파일의 내부 mode에서 동작하는 MCP stdio relay
- `ReluAiClientRegistrar`: Claude Code/Codex 공식 CLI를 이용한 user-scope 자동 등록·검증
- signed service definition의 분석 절차를 MCP `2025-06-18` `initialize` 응답으로 자동 제공
- bounded Context/result schema, cancellation과 handler 전후 stale-selection guard
- 외부 runtime package download와 임의 assembly/UI Automation 없이 기존 분석 계층 호출

Desktop 연결에는 bearer token, localhost port, `config/local.json`, desktop service JSON,
프로젝트 `.mcp.json`이나 별도 desktop Skill 설치가 없다. AI client 자체의 user-scope
등록 정보는 registrar가 공식 CLI로 관리하므로 사용자가 파일을 편집하지 않는다.

최초 자동 등록 전에 이미 실행 중이던 Claude/Codex는 한 번 재시작하거나 MCP를 reload할
수 있다. 조직의 managed MCP가 user 등록을 막는 장비는 IT가 안정된 서명 EndViewer
경로를 사전 등록한다.

User-scope 등록은 같은 Windows 계정의 모든 Claude Code/Codex 프로젝트에 보인다.
GUI host는 사용자별 하나만 운영하며, 아직 선택 구간이 없으면 host/registrar는 유지하고
Context/분석 호출은 `CONTEXT_UNAVAILABLE`을 반환한다.

API signature와 composition root는 패키지 release에 대응하는 WPF 예제를 정본으로
사용한다. Context와 결과에는 전체 로그, token, 사용자 경로와 exception detail을 넣지
않고 item 수와 전체 직렬화 byte 상한을 모두 적용한다.

- [SDK source와 API 설명](https://github.com/joff-dean/relu-ai-bridge/blob/main/sdk-dotnet/README_KO.md)
- [WPF Android Log Viewer 예제](https://github.com/joff-dean/relu-ai-bridge/blob/main/examples/wpf-android-log-viewer/README_KO.md)
- [Desktop Embedded Bridge 보안 설계](https://github.com/joff-dean/relu-ai-bridge/blob/main/docs/DESKTOP_CONNECTOR_KO.md)
