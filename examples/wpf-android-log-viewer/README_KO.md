# WPF Android Log Viewer 연결 예제

이 예제는 기존 WPF 로그 분석 프로그램의 **분석 엔진 API**를 RELU AI Bridge에 연결한다. 화면 좌표, UI Automation, 화면 캡처 또는 임의 reflection은 사용하지 않는다. 사용자가 Claude/Codex를 실행해 둔 상태에서 차트 구간을 선택하면 WPF는 선택 context만 갱신하고, 모델은 MCP를 통해 허용된 통계·차트·텍스트 조회 capability를 호출한다.

## 구성

- `IAndroidLogAnalysisEngine.cs`: 기존 분석 엔진이 구현할 명시적 인터페이스
- `AndroidLogCapabilities.cs`: 분석 엔진 메서드를 5개 allowlist capability로 연결
- `SelectionContextStore.cs`: 원문 없이 현재 로그·dataset·selection ID/revision과 시간 범위만 보관
- `ReluWpfIntegration.cs`: .NET Connector 구성과 WPF 생명주기 연결
- `AndroidLogViewerViewModel.cs`: 차트 selection-completed 이벤트 연결 예제
- [`../../config/android-log-viewer.desktop.service.example.json`](../../config/android-log-viewer.desktop.service.example.json): Bridge registry에 넣을 단일 권위 service 설정

## 적용 순서

1. `IAndroidLogAnalysisEngine`를 기존 분석 서비스로 구현한다. 각 메서드는 전달받은 `LogSelection` snapshot만 분석하고 결과 개수·문자열 길이를 service schema 이하로 제한한다.
2. service 예제 객체를 Bridge 설정의 `connectors.services` 배열에 추가한다.
3. Bridge 프로세스에는 service 설정의 `tokenEnv` 환경 변수로 전용 토큰을 주입한다.
4. WPF에는 같은 토큰을 반환하는 `IReluConnectorSecretProvider`를 구현한다. Windows Credential Manager, DPAPI 기반 회사 Secret Agent 같은 저장소를 사용하고, `ReluConnectorSecret` 생성에 사용한 임시 byte buffer도 공급자에서 즉시 zero 처리한다.
5. 설치별 stable opaque ID를 `IStableInstanceIdProvider`로 공급하고 `ReluWpfIntegration`을 애플리케이션 수명 동안 한 번 유지한다.
6. 차트의 구간 선택 완료 이벤트에서 `OnChartSelectionCompletedAsync`를 호출한다.

```csharp
var stableInstanceId = await installationIdentity.GetStableInstanceIdAsync(stoppingToken);

await using var relu = new ReluWpfIntegration(
    existingAnalysisEngine,
    credentialManagerSecretProvider,
    stableInstanceId,
    initialSelection,
    initiallyActive: mainWindow.IsActive);

var viewModel = new AndroidLogViewerViewModel(
    relu,
    SynchronizationContext.Current
        ?? throw new InvalidOperationException("WPF UI context is required."));

await relu.StartAsync(stoppingToken);

// 기존 chart control의 selection-completed event handler
await viewModel.OnChartSelectionCompletedAsync(
    opaqueLogResourceId,
    immutableDatasetRevision,
    selectedStartMs,
    selectedEndMs,
    stoppingToken);
```

`stableInstanceId`는 매 실행 새 GUID를 만들면 안 된다. 사용자명·경로·회사명·토큰을 포함하지 않는 3~128자 opaque 값이어야 하며, 현재 사용자만 읽고 쓸 수 있는 Local AppData 파일 ACL이나 회사 설치 identity 저장소에 유지한다. 인증 토큰은 이 파일과 분리해 Credential Manager/Secret Agent에서 공급한다. 토큰을 명령행 인자, 로그, 소스 코드, 일반 설정 JSON에 기록하지 않는다.

## 승인과 selection 안전성

service 설정의 승인 resource binding은 `logResourceId + datasetRevision`이다. 사용자가 이 immutable dataset에 `항상 허용`을 선택하면 같은 dataset의 다른 구간을 분석할 때 승인을 반복하지 않는다. 로그 파일이 바뀌거나 dataset revision이 바뀌면 기존 승인이 재사용되지 않는다.

실행 직전 guard는 다음 다섯 필드를 모두 비교한다.

- `logResourceId`
- `datasetRevision`
- `selectionId`
- `selectionRevision`
- `selection` (`startMs`, `endMs` 전체 객체)

구간이 바뀌면 `UpdateSelectionAsync`가 SDK의 `NotifyContextChangedAsync` atomic callback
안에서 context 저장소를 먼저 갱신하고 이전 구간에 묶인 실행을 취소한다. Context update와
success 응답의 마지막 guard 검사는 같은 send gate로 직렬화되므로 늦게 도착한 결과가 새
선택 구간의 결과로 표시되지 않는다. handler는 전달된 `ContextSnapshot`의
`LogSelection`을 사용해야 하며, 실행 중 변하는 ViewModel 전역 selection을 다시 읽으면
안 된다.

샘플 capability는 모두 read-only다. 나중에 annotation이나 화면 이동 같은 mutation을 추가한다면 서버 registry에서 effect와 operation ID 정책을 명시하고, timeout/연결 단절 후 결과는 **ambiguous**로 취급해야 한다. cancellation을 무시한 mutation handler를 자동 재실행하면 안 된다.

## 데이터 최소화

연결 등록과 context update에는 원문 로그를 넣지 않는다. Claude/Codex가 실제 분석을 요청한 경우에만 다음 순서로 bounded 결과를 반환하는 것이 권장된다.

1. `get_selection_stats`
2. `find_anomalies`
3. `get_extracted_sections`
4. 필요할 때만 `get_selection_series`
5. 마지막 근거 확인에만 `get_log_excerpt`

로그 내용에 포함된 명령문이나 prompt 형태 문자열은 데이터일 뿐 지시로 취급하지 않는다.

## 빌드와 테스트

Windows의 .NET 8 SDK 환경에서 실행한다.

```powershell
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release
dotnet run --project .\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release
dotnet build .\examples\wpf-android-log-viewer\WpfAndroidLogViewer.Integration.csproj -c Release
```

SDK 테스트는 Bridge core와 공유하는 `compat/desktop-auth-v1.json`을 읽어 endpoint audience, Unicode·decimal·exponent가 포함된 raw `registrationJson`, SHA-256 digest, server/client HMAC을 교차 검증한다.
