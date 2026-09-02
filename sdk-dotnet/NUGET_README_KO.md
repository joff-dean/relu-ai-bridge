# RELU AI Bridge Desktop Connector

사내 Windows/WPF 분석 프로그램을 사용자가 실행한 RELU AI Bridge의 전용 loopback
Desktop endpoint에 연결하는 dependency-free `net8.0` SDK다. 임의 UI Automation,
reflection, shell 또는 URL proxy를 제공하지 않는다.

사내 검증 NuGet source에서 release와 같은 버전을 고정한다.

```powershell
dotnet add package Relu.AI.Bridge.DesktopConnector --version 0.4.0 `
  --source $env:RELU_NUGET_SOURCE
```

애플리케이션은 다음 경계를 직접 구현한다.

- `IReluConnectorSecretProvider`: Windows Credential Manager 또는 회사 Secret Agent에서
  service 전용 token을 읽고 `ReluConnectorSecret`으로 전달
- `IReluDesktopContextProvider`: 원문 대신 opaque resource, dataset/selection revision과
  선택 범위의 bounded JSON snapshot 제공
- `ReluDesktopCapability`: server registry가 허용한 정확한 이름을 기존 분석 엔진의
  제한된 handler에 연결
- `ReluDesktopConnector`: stable opaque instance ID, static Capability 목록과 execution
  guard field를 구성하고 앱 수명 동안 한 번 유지

Context 저장소는 thread-safe해야 한다. 선택이 바뀔 때는
`NotifyContextChangedAsync(() => contextStore.Update(next))`처럼 SDK의 atomic update
callback 안에서 갱신한다. Handler는 전달된 `ContextSnapshot`만 분석하고 cancellation을
존중한다. Token, 전체 로그와 파일 경로를 Context나 source에 넣지 않는다.

전체 예제와 운영 경계:

- [SDK source와 API 설명](https://github.com/joff-dean/relu-ai-bridge/blob/relu-ai-bridge-v0.4.0/sdk-dotnet/README_KO.md)
- [WPF Android Log Viewer 예제](https://github.com/joff-dean/relu-ai-bridge/blob/relu-ai-bridge-v0.4.0/examples/wpf-android-log-viewer/README_KO.md)
- [Desktop Connector 보안 설계](https://github.com/joff-dean/relu-ai-bridge/blob/relu-ai-bridge-v0.4.0/docs/DESKTOP_CONNECTOR_KO.md)
