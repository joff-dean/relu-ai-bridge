# RELU AI Bridge .NET Embedded Desktop SDK

`Relu.AI.Bridge.DesktopConnector` 0.7.0은 Windows/WPF 분석 프로그램 안에 MCP bridge를
포함하기 위한 dependency-free `net8.0` SDK다. 최종 사용자가 RELU나 Node.js를 따로
설치하고 token·port·JSON을 설정하는 모델이 아니다. EndViewer 개발자가 이 SDK를
application에 포함해 하나의 실행 파일로 배포한다.

이 repository는 SDK와 WPF 통합 골격까지만 제공한다. 실제 EndViewer application source,
분석 엔진, installer, signing material과 완성된 `EndViewer.exe`는 포함하지 않는다.
EndViewer 팀이 통합·publish·서명한 뒤에야 아래의 단일 실행 파일 사용자 계약이 완성된다.

## 배포 계약

```text
Claude/Codex ──stdio──▶ EndViewer.exe <내부 stdio mode>
                           │ CurrentUserOnly named pipe
                           ▼
                       EndViewer GUI
                       └─ embedded bridge + 분석 엔진
```

- 일반 실행은 WPF UI와 embedded host를 시작한다.
- AI client가 시작한 같은 binary의 내부 mode는 stdio MCP entry point로 동작한다.
- 두 process는 외부 port가 아닌 `CurrentUserOnly` named pipe로 연결된다.
- 사용자에게 connector token, RELU local config, 프로젝트 `.mcp.json`을 요구하지 않는다.
- 최초 실행 시 registrar가 Claude Code/Codex 공식 CLI를 사용해 user-scope MCP 등록을
  조회·추가·검증한다.

등록 전에 이미 실행 중이던 Claude/Codex는 server 목록을 다시 읽지 않을 수 있다.
최초 등록 직후 한 번만 client를 재시작하거나 MCP를 reload한다. Exclusive managed MCP
환경은 user 등록을 허용하지 않을 수 있으므로 IT가 안정된 서명 executable 경로를
조직 정책에 사전 등록해야 한다.

User-scope 등록은 같은 Windows 계정의 다른 Claude Code/Codex 프로젝트에도 보인다.
EndViewer가 실행 중이면 이 프로젝트들도 현재 선택의 read-only 도구를 호출할 수 있으며
창의 active 상태는 권한 경계가 아니다. 공용 계정을 피하고 승인된 프로젝트에서만
사용하거나, 더 강한 격리는 조직 managed MCP 정책으로 적용한다.

## 빌드

상위 `Directory.Build.props/targets`가 없는 승인된 격리 root에서 실행하고 자동 import도
명시적으로 끈다.

```powershell
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet run --project .\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet pack .\sdk-dotnet\src\Relu.AI.Bridge.DesktopConnector\Relu.AI.Bridge.DesktopConnector.csproj `
  -c Release --no-build -o .\artifacts\nuget `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false `
  -p:Version=0.7.0 -p:PackageVersion=0.7.0
```

최종 EndViewer publish는 회사 표준에 따라 필요한 .NET runtime을 포함하고 Authenticode
서명과 설치 경로 ACL을 적용한다. 버전별 임시 경로가 아니라 AI client 등록이 계속
가리킬 안정된 launcher 경로를 사용한다.

## 공용 API 역할

- `ReluEmbeddedBridgeHost`: GUI process에서 static Capability, live Context와
  `CurrentUserOnly` named pipe server를 소유한다.
- `ReluMcpStdioEntryPoint`: 같은 실행 파일의 내부 mode에서 MCP stdio를 처리하고 실행 중
  GUI host로 중계한다.
- `ReluAiClientRegistrar`: Claude Code와 Codex의 user-scope MCP 등록을 공식 CLI로
  조회·추가·검증한다. 다른 executable이 소유한 같은 이름은 덮어쓰지 않는다.
- `IReluDesktopContextProvider`: 현재 dataset/selection의 bounded JSON snapshot을
  thread-safe하게 제공한다.
- `ReluDesktopCapability`: 고정된 이름/schema/effect와 기존 분석 handler를 연결한다.

EndViewer 분석 절차는 embedded service definition에 포함하고 MCP `2025-06-18`
`initialize` 응답의 `instructions`로 자동 제공한다. Desktop 사용자는 별도 Skill을 설치하지
않으며 Context/로그가 runtime instructions를 바꿀 수 없다.

생성자, option과 lifecycle method의 정확한 호출 순서는 release와 함께 빌드되는
[`ReluWpfIntegration.cs`](../examples/wpf-android-log-viewer/ReluWpfIntegration.cs)를
정본으로 사용한다. API signature가 바뀌었을 때 문서의 추정 코드보다 컴파일되는 예제가
우선한다.

## WPF 생명주기

1. `Main` 또는 application startup의 가장 앞에서 내부 stdio mode인지 판정한다.
2. stdio mode이면 WPF window를 만들지 않고 `ReluMcpStdioEntryPoint`에 제어를 넘긴다.
3. 일반 mode이면 분석 engine/context provider를 만든 뒤 `ReluEmbeddedBridgeHost`를
   application lifetime 동안 하나 유지한다.
4. host가 준비된 뒤 `ReluAiClientRegistrar`로 지원 client를 등록·검증한다.
5. chart selection-completed event는 Context를 atomic하게 갱신한다.
6. 종료 시 in-flight request를 취소하고 pipe/host를 dispose한다.

GUI host는 사용자별 하나만 허용한다. 실제 EndViewer는 single-instance application으로
두 번째 실행을 기존 창에 전달하거나, pipe 선점 실패를 bounded 상태로 처리해야 한다.
또한 시작 시 selection이 없어도 host/registrar는 올라오며 Context와 분석 도구는 첫
selection-completed event까지 `CONTEXT_UNAVAILABLE`을 반환한다. 가짜 초기 구간이나
이전 dataset selection을 사용하지 않는다.

등록 실패는 로그 분석 UI 시작을 막지 않아야 한다. 단, 등록 상태와 복구 방법은 사용자와
IT가 확인할 수 있는 bounded 진단으로 노출하고 command output 전체를 log에 복사하지
않는다.

### Custom `[STAThread]` entry point

WPF `Application`이나 dispatcher를 만들기 전에 `--relu-mcp-stdio`를 분기해야 한다.
Generated `App.Main` 대신 다음 entry point를 actual EndViewer project에 두고 namespace를
앱에 맞춘다.

```csharp
using System;
using WpfAndroidLogViewer.Integration;

namespace Company.EndViewer;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        var mcpExitCode = ReluWpfIntegration
            .RunMcpModeIfRequestedAsync(args)
            .GetAwaiter()
            .GetResult();

        if (mcpExitCode is int exitCode)
        {
            return exitCode; // stdio mode에서는 GUI를 절대 만들지 않는다.
        }

        var app = new App();
        app.InitializeComponent();
        return app.Run();
    }
}
```

실제 WPF application `.csproj`에는 fully-qualified `StartupObject`가 필요하다.

```xml
<PropertyGroup>
  <OutputType>WinExe</OutputType>
  <TargetFramework>net8.0-windows</TargetFramework>
  <UseWPF>true</UseWPF>
  <StartupObject>Company.EndViewer.Program</StartupObject>
</PropertyGroup>
```

`StartupObject`가 없으면 generated `Main`이 먼저 실행될 수 있다. Async `Main`에서 UI
thread를 바꾸지 말고 위처럼 `[STAThread]`의 동기 진입점에서 mode 판정을 마친다.

### 일반 application mode

일반 WPF startup에서는 `ReluWpfIntegration`을 한 번 만들고 `StartAsync`를 await한다.
반환된 `ReluWpfIntegrationStartResult.BridgeStarted`가 `false`이면 다른 GUI가 pipe를
소유한 상태이므로 bounded 상태만 표시하고 본래 viewer UI는 계속 실행한다.
Chart의 selection-completed event는 `UpdateSelectionAsync`, window 활성화 event는
`WindowActivationChangedAsync`로 전달한다. `OnExit`에서는 같은 instance의
`DisposeAsync`를 완료해 in-flight request와 pipe를 닫는다.

정확한 최소 App/event 골격은
[WPF Android Log Viewer 예제](../examples/wpf-android-log-viewer/README_KO.md)에 있으며,
signature의 정본은
[`ReluWpfIntegration.cs`](../examples/wpf-android-log-viewer/ReluWpfIntegration.cs)다.

## EndViewer self-contained single-file publish

다음 속성은 SDK library가 아니라 최종 WPF `WinExe` project에 둔다.

```xml
<PropertyGroup>
  <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
  <SelfContained>true</SelfContained>
  <PublishSingleFile>true</PublishSingleFile>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
  <PublishTrimmed>false</PublishTrimmed>
</PropertyGroup>
```

WPF trimming은 금지한다. 각 RID를 Windows build worker에서 별도로 publish한다.

```powershell
dotnet publish .\EndViewer.csproj -c Release -r win-x64 --self-contained true `
  -o .\artifacts\publish\win-x64 `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishTrimmed=false -p:DebugSymbols=false -p:DebugType=None

dotnet publish .\EndViewer.csproj -c Release -r win-arm64 --self-contained true `
  -o .\artifacts\publish\win-arm64 `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishTrimmed=false -p:DebugSymbols=false -p:DebugType=None
```

Publish 뒤 RID별 exe를 서명하고 stable launcher 경로에 설치한다. Registrar는
`Environment.ProcessPath`의 exact 경로를 user scope에 저장하므로 version별 폴더가 아닌
예: `C:\Program Files\Company\EndViewer\EndViewer.exe`를 계속 유지한다. App-owned
content가 별도 파일로 나오는 경우 embedded `Resource`로 바꾸거나 검토된 배포 inventory에
명시한다.

이 publish/package 과정은 EndViewer 개발·배포 담당자의 일이다. 최종 사용자는 서명된
EndViewer만 실행하며 RELU, 이 NuGet package, Node.js, token, config, Skill과 별도 MCP
host를 설치하지 않는다.

## 보안·데이터 제한

- Capability와 schema/effect는 검토된 source/binary에 고정한다.
- 화면 캡처, UI Automation, 임의 reflection/assembly loading을 사용하지 않는다.
- Context에는 opaque resource/revision/selection만 넣고 전체 로그나 사용자 경로를 넣지
  않는다.
- Handler는 cancellation을 존중하며 실행 전후 selection projection을 다시 확인한다.
- 통계, series, section, excerpt 각각의 item 제한과 전체 JSON byte 제한을 함께 적용한다.
- GUI가 실행 중이 아니면 stdio MCP는 `APPLICATION_NOT_RUNNING`으로 실패하고 다른 local
  service로 자동 fallback하지 않는다.
- Pipe 양쪽은 Windows peer PID의 OS 보고 process image를 `Path.GetFullPath`로 정규화한
  값이 현재 EndViewer 경로와 같은지 연결 직후 검사한다. Registrar는 임의 `PATH`
  executable과 elevated process를 사용하지 않고 공식
  Claude/Codex Authenticode publisher를 검증한다.
- `CurrentUserOnly`와 same-image 검사는 허용된 EndViewer executable 자체를 같은 사용자가
  relay로 실행하는 공격까지 암호학적으로 식별하지는 않는다. 서명, launcher ACL과
  application allowlisting을 함께 적용한다.

상세 설계는 [Desktop Embedded Bridge 문서](../docs/DESKTOP_CONNECTOR_KO.md), 실제 적용은
[Android Log Viewer 예제](../examples/wpf-android-log-viewer/README_KO.md)를 따른다.
