# WPF Android Log Viewer embedded 연결 예제

이 예제는 EndViewer 같은 WPF 로그 분석 프로그램에 RELU AI Bridge 0.7.0을 내장한다.
최종 사용 흐름은 단순하다.

1. 사용자가 `EndViewer.exe`를 실행한다.
2. 앱이 Claude Code/Codex user scope 등록을 자동 확인한다.
3. 사용자가 차트 구간을 선택한다.
4. 이미 실행한 Claude/Codex에서 “EndViewer의 현재 구간을 분석해줘”라고 요청한다.

별도 RELU 설치, Node.js, daemon, port, connector token, RELU JSON, 프로젝트
`.mcp.json` 또는 desktop Skill 설치는 필요하지 않다.

이 directory는 integration library와 예제 골격이며 실행 가능한 proprietary EndViewer
application, 실제 분석 엔진, installer 또는 서명된 `EndViewer.exe`를 포함하지 않는다.
아래 코드를 회사 EndViewer project에 합치고 Windows release pipeline에서 publish·서명해야
최종 사용자의 단일 실행 파일 배포가 완성된다.

## 구성

- `ReluWpfIntegration.cs`: embedded host, stdio mode, registrar와 WPF 생명주기의 정본
- `AndroidLogViewerViewModel.cs`: chart selection-completed/activation event 연결
- `SelectionContextStore.cs`: thread-safe dataset/selection Context
- `IAndroidLogAnalysisEngine.cs`: 기존 분석 계층의 최소 interface
- `AndroidLogCapabilities.cs`: bounded read-only Capability handler
- `AndroidLogModels.cs`: wire에 허용하는 Context/result DTO

## 단일 executable 실행 모드

일반 실행에서는 WPF UI와 `ReluEmbeddedBridgeHost`를 시작한다. Claude/Codex가 등록된
MCP server를 열 때는 같은 `EndViewer.exe`가 내부 stdio mode로 다시 실행되고,
`ReluMcpStdioEntryPoint`가 stdio MCP를 GUI process의 `CurrentUserOnly` named pipe로
중계한다. 내부 mode에서는 새 WPF window를 만들지 않는다.

같은 사용자에서 GUI host는 하나만 실행한다. Service ID로 정해진 첫 named-pipe instance를
독점하므로 실제 EndViewer는 application single-instance 정책으로 두 번째 실행을 기존
창에 전달하거나, bridge 시작 충돌을 bounded 상태로 표시하고 본래 viewer UI는 계속
동작하게 처리한다.

`ReluAiClientRegistrar`는 앱 시작 뒤 Claude와 Codex를 각각 탐지해 공식 CLI 조회/등록
명령을 사용한다. JSON/TOML을 직접 편집하지 않고 user-scope 결과가 현재 EndViewer의
안정된 절대 경로를 가리키는지 다시 확인한다. 같은 server 이름이 다른 executable을
가리키면 사용자 설정을 덮어쓰지 않는다.

User-scope 등록은 같은 Windows 계정의 모든 Claude Code/Codex 프로젝트에 보인다.
EndViewer가 실행 중이면 승인된 다른 프로젝트에서도 현재 selection의 read-only 분석
도구를 호출할 수 있으며 window `active`는 권한 경계가 아니다. 공용 OS 계정을 피하고
회사 승인 프로젝트만 사용하거나 managed MCP 정책으로 범위를 제한한다.

최초 등록 전에 이미 열려 있던 AI client는 server 목록을 캐시할 수 있으므로 등록 직후
한 번 재시작하거나 MCP reload가 필요하다. 이후 실행에서는 다시 설정할 것이 없다.
Exclusive managed MCP 환경은 IT가 EndViewer stdio command를 사전 등록해야 한다.

정확한 constructor와 method signature는
[`ReluWpfIntegration.cs`](ReluWpfIntegration.cs)를 정본으로 사용한다. 이 문서는 API를
추정하지 않으며 아래 entry point와 lifecycle 예제는 현재 공개 API에 맞춘 최소 골격이다.

### 1. Generated WPF `Main`보다 먼저 stdio mode 분기

AI client가 `EndViewer.exe --relu-mcp-stdio`를 시작했을 때 `Application`, dispatcher,
window 또는 splash screen을 하나라도 먼저 만들면 stdio MCP process가 GUI process로
오동작할 수 있다. `App.xaml`이 생성하는 `Main` 대신 다음 custom `Program.Main`을 실제
EndViewer application project에 추가한다. Namespace는 앱에 맞게 바꾼다.

```csharp
using System;
using WpfAndroidLogViewer.Integration;

namespace Company.EndViewer;

internal static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // 이 호출 전에는 App, Window, Dispatcher 또는 UI service를 만들지 않는다.
        var mcpExitCode = ReluWpfIntegration
            .RunMcpModeIfRequestedAsync(args)
            .GetAwaiter()
            .GetResult();

        if (mcpExitCode is int exitCode)
        {
            return exitCode;
        }

        var app = new App();
        app.InitializeComponent();
        return app.Run();
    }
}
```

실제 WPF `.csproj`에서 custom entry point를 선택한다. `StartupObject`는 위 namespace를
포함한 정확한 type이어야 한다.

```xml
<PropertyGroup>
  <OutputType>WinExe</OutputType>
  <TargetFramework>net8.0-windows</TargetFramework>
  <UseWPF>true</UseWPF>
  <StartupObject>Company.EndViewer.Program</StartupObject>
</PropertyGroup>
```

`StartupObject`가 없으면 generated `App.Main`이 먼저 실행되어 `--relu-mcp-stdio` 분기가
보장되지 않는다. Async `Main`에서 UI 시작 전 `await`로 thread가 바뀌게 하지 말고 위처럼
`[STAThread]` 진입점에서 mode 판정을 끝낸 후 GUI를 만든다.

### 2. 일반 GUI startup과 종료 연결

일반 mode의 기존 composition root에서 분석 엔진을 준비한 뒤 integration 한 개를
application 수명 동안 유지한다. 시작 시 로그나 선택 구간이 없어도 된다. 아래의 분석
엔진 생성 부분만 실제 EndViewer service로 교체한다.

```csharp
using System.Windows;
using Relu.AI.Bridge.DesktopConnector;
using WpfAndroidLogViewer.Integration;

public partial class App : Application
{
    private ReluWpfIntegration? _relu;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        IAndroidLogAnalysisEngine analysisEngine = CreateExistingAnalysisEngine();
        _relu = new ReluWpfIntegration(
            analysisEngine,
            initiallyActive: true);

        // Host가 먼저 열리고 이어서 Claude/Codex user-scope 등록을 확인한다.
        ReluWpfIntegrationStartResult start = await _relu.StartAsync();
        if (!start.BridgeStarted)
        {
            // 두 번째 GUI 또는 pipe 예약 충돌은 본래 viewer를 종료시키지 않는다.
            ShowBoundedBridgeStatus(start.Message);
        }
        else if (start.Registration is not null)
        {
            ShowBoundedRegistrationStatus(start.Registration);
        }

        // 기존 MainWindow/ViewModel에 같은 _relu instance를 주입한다.
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            _relu?.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        finally
        {
            base.OnExit(e);
        }
    }
}
```

`CreateExistingAnalysisEngine`, `ShowBoundedBridgeStatus`와
`ShowBoundedRegistrationStatus`는 application-owned
함수다. 등록 실패로 본래 로그 분석
UI를 종료하지 말고 상태만 제한적으로 표시한다. CLI stdout/stderr 전체를 UI나 로그에
복사하지 않는다.

첫 selection-completed event 전에도 host와 registrar는 동작한다. 이때 Context 조회나
분석 요청은 `CONTEXT_UNAVAILABLE`과 구간 선택 안내를 반환하며, 첫 확정 선택 뒤 별도
재시작 없이 분석 가능 상태가 된다. 빈 ID, 임의의 기본 범위 또는 이전 dataset의
selection을 초기값으로 만들지 않는다.

차트의 **selection-completed** event에서 drag 중간 값이 아니라 확정된 구간을 전달한다.

```csharp
private async void OnChartSelectionCompleted(
    string logResourceId,
    string datasetRevision,
    long startMs,
    long endMs)
{
    await _viewModel.OnChartSelectionCompletedAsync(
        logResourceId,
        datasetRevision,
        startMs,
        endMs);
}
```

기존 event args에서 네 값을 꺼내는 부분만 앱에 맞게 바꾼다. 창 활성화 event는
`OnWindowActivationChangedAsync`에 전달한다. Selection update와 종료 dispose를 fire-and-
forget으로 버리지 말고 예외를 application의 bounded 진단 정책으로 처리한다.

로그 close, dataset unload, selection clear 이벤트에서는 반드시
`await _viewModel.OnSelectionClearedAsync()`를 호출한다. 이 연결을 생략하면 닫힌 dataset의
마지막 selection이 현재 Context로 남을 수 있다. Clear 뒤 다음 확정 selection 전까지는
`CONTEXT_UNAVAILABLE`이 반환된다.

## 기존 분석 엔진 연결

`IAndroidLogAnalysisEngine`을 기존 통계·차트·텍스트 추출 계층에 구현한다. Handler는
WPF control tree, 화면 좌표, UI Automation, 임의 reflection을 탐색하지 않고 이
interface만 호출한다.

선택 완료 시 다음 최소 Context를 한 번에 갱신한다.

- opaque `logResourceId`
- `datasetRevision`
- opaque `selectionId`와 증가하는 `selectionRevision`
- selection start/end와 timebase
- parser/filter version처럼 결과 해석에 필요한 bounded metadata

사용자명, 전체 파일 경로와 전체 로그를 Context에 넣지 않는다. 창의 active 상태는
목록 정렬용 hint일 뿐 분석 대상이나 권한을 자동 결정하지 않는다.

## 제공 Capability

| Capability | 반환 내용 | 상한 |
| --- | --- | --- |
| `get_selection_stats` | 기존 집계 metric | 최대 200개 |
| `get_selection_series` | downsampled series | 6개 × 1,000 point |
| `get_extracted_sections` | 기존 추출 section | 최대 100개 |
| `find_anomalies` | 기존 알고리즘 후보 | 최대 100개 |
| `get_log_excerpt` | 후보 주변 최소 원문 | 최대 200줄 |

Capability/schema/effect는 application source와 서명된 binary에 고정한다. 로그 내용,
model argument 또는 외부 JSON으로 새 handler를 추가하지 않는다. 각 item 상한뿐 아니라
전체 직렬화 JSON byte 상한도 적용한다.

분석 순서와 보고 형식도 embedded service definition에 고정해 MCP `2025-06-18`
`initialize` 응답의 `instructions`로 자동 제공한다. 로그 본문이 instructions나 Skill을 교체하게
하지 않는다.

## Selection 안전성

Embedded host는 요청 직전과 handler 완료 뒤 dataset/selection projection을 비교한다.
선택이 바뀌면 진행 중 handler를 취소하고 stale 결과를 정상 응답으로 보내지 않는다.
Read-only 분석에서 context-changed를 받으면 Claude/Codex는 Context부터 다시 조회하며
이전·새 구간 결과를 합치지 않는다.

기본 예제는 read-only이므로 RELU approval prompt를 만들지 않는다. 향후 focus/annotation
같은 mutation을 추가하려면 unique operation ID, 중복 실행 차단, preview와 timeout 뒤
ambiguous 판정을 별도로 설계한다.

## 등록·pipe 보안

- Named pipe는 `CurrentUserOnly`로 만들고 TCP listener를 열지 않는다.
- GUI와 stdio process는 연결 직후 Windows peer PID의 OS 보고 process image path를
  `Path.GetFullPath`로 정규화해 서로 검증한다.
- Registrar가 등록하는 command는 안정된 회사 서명 executable의 절대 경로다.
- Registrar는 임의 `PATH` executable이나 elevated EndViewer에서 자동 등록하지 않고,
  Authenticode/publisher를 확인한 공식 Claude/Codex CLI만 실행한다.
- 실행 중 GUI host가 없으면 stdio endpoint는 `APPLICATION_NOT_RUNNING`으로 실패한다.
- CLI command 전체 출력, Context 원문과 exception detail을 로그에 남기지 않는다.
- 같은 Windows 사용자가 허용된 EndViewer executable 자체를 relay로 실행하는 경우는
  pipe ACL과 same-image 검사만으로 완전히 식별할 수 없으므로
  EndViewer 서명, 설치 경로 ACL과 application allowlisting을 함께 적용한다.

## 개발 검증

```powershell
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release
dotnet run --project .\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release
dotnet build .\examples\wpf-android-log-viewer\WpfAndroidLogViewer.Integration.csproj -c Release
```

### 3. Self-contained single-file publish

다음 속성은 **실제 EndViewer WPF application project**에 둔다. 이 저장소의 integration
library project가 아니라 최종 `WinExe` project에 적용한다.

```xml
<PropertyGroup>
  <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
  <SelfContained>true</SelfContained>
  <PublishSingleFile>true</PublishSingleFile>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
  <PublishTrimmed>false</PublishTrimmed>
</PropertyGroup>
```

WPF는 trimming을 지원 대상으로 가정할 수 없으므로 `PublishTrimmed`는 반드시 `false`로
유지한다. Single-file 밖으로 복사되는 application content가 있으면 embedded `Resource`로
전환하거나 승인된 배포 inventory에 명시한다.

Windows build worker에서 두 RID를 각각 publish한다.

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

각 RID 산출물을 별도로 서명·검증한다. AI registration은 exact executable path를
저장하므로 `C:\Program Files\Company\EndViewer\EndViewer.exe`처럼 버전과 RID update
뒤에도 유지되는 회사 관리 launcher 경로를 사용한다. 버전별 하위 폴더의 exe를 직접
등록하지 않는다. PDB가 필요하면 사용자 배포물과 분리된 접근 통제 symbol store에 둔다.

최종 사용자에게 제공하는 절차는 “서명된 EndViewer를 실행한다” 하나뿐이다. RELU,
NuGet, Node.js, token, config, Skill 또는 별도 MCP host를 설치하라고 안내하지 않는다.

추가로 clean Windows 사용자에서 다음을 확인한다.

- EndViewer 단일 실행 파일만 배포해 GUI/stdio mode가 모두 시작된다.
- Claude/Codex가 독립적으로 user-scope 등록되고 exact command가 검증된다.
- 최초 등록 후 실행 중 client의 1회 restart/reload 안내가 정확하다.
- managed MCP 장비는 사용자 등록을 우회하지 않고 IT 항목을 사용한다.
- 다른 Windows 사용자는 pipe에 연결할 수 없다.
- GUI 종료/재시작, pipe 재연결과 `APPLICATION_NOT_RUNNING` 상태가 일관된다.
- selection 변경 중 cancellation과 handler 전후 guard가 stale 결과를 막는다.

전체 설계와 운영 제한은
[Desktop Embedded Bridge 문서](../../docs/DESKTOP_CONNECTOR_KO.md)를 따른다.
