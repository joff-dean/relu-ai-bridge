# RELU AI Bridge .NET Desktop Connector SDK

`Relu.AI.Bridge.DesktopConnector`는 Windows/WPF 분석 프로그램의 기존 분석 계층을
RELU AI Bridge에 연결하는 dependency-free `net8.0` library다. 임의 UI Automation,
screen capture, reflection, assembly loading, URL 또는 shell proxy를 제공하지 않는다.

## 빌드

상위 `Directory.Build.props/targets`가 없는 승인된 격리 root에서 실행하고 자동 import도
명시적으로 끈다.

```powershell
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet run --project .\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet pack .\sdk-dotnet\src\Relu.AI.Bridge.DesktopConnector\Relu.AI.Bridge.DesktopConnector.csproj `
  -c Release --no-build --output C:\approved-release-output\nuget `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false `
  -p:Version=0.4.0 -p:PackageVersion=0.4.0
```

사내 feed에 올리기 전 `.nupkg` inventory, nuspec의 exact ID/version과 빈 dependency
group, SHA-256을 [사내 동기화 가이드](../docs/INTERNAL_SYNC_KO.md#sdk와-skill-사내-배포)대로
검증한다.

Test executable은 core와 공유하는
[`compat/desktop-auth-v1.json`](../compat/desktop-auth-v1.json)을 읽어 exact UTF-8
registration digest, Unicode/decimal/exponent, server/client HMAC transcript를 검증한다.

## 공용 API

- `ReluDesktopConnectorOptions`: loopback endpoint, service/app/instance identity,
  secret/context provider, 정적 Capability 목록과 required execution guard field
- `IReluConnectorSecretProvider`: Windows Credential Manager나 회사 Secret Agent adapter
- `IReluDesktopContextProvider`: 현재 resource/selection의 bounded JSON snapshot
- `ReluDesktopCapability`: server registry에 이미 존재하는 이름과 local handler 연결
- `ReluDesktopConnector`: mutual HMAC, reconnect/heartbeat, context update, bounded request와
  cancellation 관리

WPF UI thread에서 생성할 때 `InitialActive`에 최초 값을 넣고, 이후 창 활성화 event에서
`SetActiveAsync`를 호출한다. Connector background thread는 WPF의 `IsActive` property나
delegate를 직접 읽지 않고 thread-safe cache만 등록/context event에 사용한다. Context
저장소 변경은 `NotifyContextChangedAsync(Action, ...)` callback 안에서 수행해야 success
응답의 마지막 guard와 update가 같은 send gate에 직렬화된다. 인증 도중 전송을 생략한
변경도 SDK가 `hello_ack` 직후 최신 Context update를 다시 보내므로 다음 선택 event까지
서버가 오래된 registration snapshot에 머물지 않는다.

`InstanceId`는 설치별 stable opaque 값이어야 하지만 token이나 사용자명을 포함하면 안
된다. Connector token과 stable ID는 별도 저장소/ACL로 관리한다. Resume secret은 SDK
process memory에만 둔다.

Handler는 `ReluCapabilityInvocation.ContextSnapshot`만 작업 대상으로 사용하고 전달된
`CancellationToken`을 존중해야 한다. SDK는 server `contextGuard`를 handler 직전과
직후의 live Context에 비교한다. Mutation이 timeout/취소되면 적용 여부가 모호할 수
있으므로 호출자가 임의 재실행하면 안 된다.

Handler가 cancellation을 무시하더라도 timeout 응답 후 즉시 concurrency slot을 재사용하지
않는다. 실제 handler task가 끝날 때까지 slot과 request ID를 유지하므로 반복 timeout이나
reconnect로 background 분석 task가 무제한 누적되지 않는다.

실제 WPF 적용 코드는 [Android Log Viewer 예제](../examples/wpf-android-log-viewer/README_KO.md),
전체 신뢰 경계는 [Desktop Connector 설계](../docs/DESKTOP_CONNECTOR_KO.md)를 따른다.
