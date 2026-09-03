# Windows Desktop Connector 및 WPF 통합 설계

RELU AI Bridge 0.6.0은 사람이 실행해 둔 Windows 분석 프로그램을 Claude/Codex의
로컬 MCP 작업 공간에 연결한다. 화면을 캡처하거나 UI Automation으로 조작하는 방식이
아니라, 기존 프로그램의 분석 계층이 현재 선택 구간과 제한된 조회 함수를 직접
제공하는 구조다.

이 저장소의 기준 구현은 Android 로그를 차트로 표시하는 WPF 프로그램이다.

```text
WPF chart / existing analysis engine
  ├─ selection-completed event
  ├─ bounded statistics / series / excerpts
  └─ extracted sections / anomaly candidates
                 │ .NET 8 Desktop Connector SDK
                 ▼
      ws://127.0.0.1:5746/relu/desktop/ws
                 │ mutual HMAC + live Context
                 ▼
            RELU AI Bridge
  ├─ server-owned schema/effect policy
  ├─ trusted_always 기본 / manual 선택 policy
  ├─ stale-selection execution guard
  └─ list_sessions / get_context /
     list_capabilities / execute
                 │
                 ▼
       Claude / Codex + analysis Skill
```

## Perfetto 연결과 무엇이 같은가

분석 관점에서는 같은 패턴이다. Perfetto plugin이 선택 area와 Trace Processor의
제한된 함수를 제공하듯, WPF Connector가 선택 구간과 기존 분석 엔진의 제한된 함수를
제공한다. Claude/Codex는 두 경우 모두 live session을 찾고, 현재 Context와
Capability를 조회한 뒤 선택 구간을 분석한다.

차이는 adapter 위치다.

| 구분 | Perfetto | WPF Android Log Viewer |
| --- | --- | --- |
| 실행 위치 | browser tab의 Perfetto plugin | Windows process의 .NET SDK |
| 데이터 엔진 | Trace Processor | 기존 WPF 분석 계층 |
| WebSocket | `/perfetto/ws` 및 generic Perfetto session | `/relu/desktop/ws` |
| browser 구분 | exact `Origin` 필수 | `Origin`이 있으면 거부 |
| stale target | trace/connection/area snapshot | dataset/selection revision guard |

선택 이벤트 자체가 Claude/Codex를 새로 실행하거나 모델 호출을 강제로 시작하지는
않는다. 사용자가 이미 실행 중인 AI client에서 “현재 선택 구간 분석”을 요청하면
최신 Context를 읽는다. 이는 Perfetto의 현재 사용 흐름과 같다. 무인 자동 분석 loop가
필요하면 별도의 회사 승인, 비용·중단 조건 및 결과 전달 정책을 가진 orchestration
기능으로 설계해야 하며 Desktop Connector 권한에 암묵적으로 포함하지 않는다.

## 저장소 구성

```text
sdk-dotnet/
  src/Relu.AI.Bridge.DesktopConnector/   공용 net8.0 SDK
  tests/                                  wire/auth/guard self-test

examples/wpf-android-log-viewer/
  WpfAndroidLogViewer.Integration.csproj  net8.0-windows 통합 예제
  ReluWpfIntegration.cs                   composition root
  AndroidLogViewerViewModel.cs            chart event 연결 예
  IAndroidLogAnalysisEngine.cs            기존 분석 계층 경계
  AndroidLogCapabilities.cs               정적 Capability handler
  SelectionContextStore.cs                thread-safe live Context

config/android-log-viewer.desktop.service.example.json
                                         server registry 예제
skills/relu-analyze-selection/            Claude/Codex 공통 분석 절차
```

SDK는 외부 NuGet package를 runtime에 내려받거나 임의 assembly를 load하지 않는다.
검증된 RELU release의 `sdk-dotnet/`을 사내 NuGet registry에 재패키징하거나 application
solution에서 source/project reference로 고정한다.

## 통합 순서

### 1. 서버 registry 등록

[`config/android-log-viewer.desktop.service.example.json`](../config/android-log-viewer.desktop.service.example.json)의
service 객체를 주 설정 `connectors.services`에 넣는다. 예제의 핵심 계약은 다음과 같다.

```json
{
  "id": "android-log-viewer",
  "tokenEnv": "RELU_ANDROID_LOG_VIEWER_TOKEN",
  "clientKinds": ["desktop"],
  "origins": [],
  "desktopAppIds": ["com.relu.AndroidLogViewer"],
  "bindingFields": ["logResourceId", "datasetRevision"],
  "executionGuardFields": [
    "logResourceId",
    "datasetRevision",
    "selectionId",
    "selectionRevision",
    "selection"
  ]
}
```

`bindingFields`는 approval policy의 resource 경계다. 선택마다 바뀌는 값은 넣지
않아 같은 dataset 안에서 승인 창을 반복하지 않게 한다. 반면
`executionGuardFields`에는 selection identity/revision과 전체 `selection` 객체를 포함해
승인 대기 또는 실행 도중 ID·revision·start/end 중 하나라도 바뀐 요청을 거부한다.
새 로그를 열거나 dataset revision이 바뀌면
resource scope도 바뀐다. `manual`이면 다시 승인하고, 새 설치 기본인
`trusted_always`이면 prompt 없이 새 경계를 검사한 뒤 진행한다.

Browser와 desktop이 모두 필요한 논리 서비스라도 한 token을 두 runtime에 공유할 수
없다. Registry는 `clientKinds`에 정확히 한 transport만 허용하므로 별도 service ID와
`tokenEnv`를 사용한다. 이렇게 해야 한 application의 credential 노출이 다른
transport로 확대되지 않는다. Desktop service에는 client-side guard가 없는 HTTP
Capability도 섞을 수 없다. 필요한 고정 API는 별도 browser/HTTP service로 등록한다.

### 2. 전용 secret 주입

```powershell
$env:RELU_ANDROID_LOG_VIEWER_TOKEN = '<company-secret-provider-result>'
```

예시를 설명하기 위한 표현일 뿐, 운영에서는 회사 Secret Agent, Windows Credential
Manager 또는 승인된 process supervisor가 주입해야 한다. Token을 source, JSON,
command line, 로그, exception, URL 또는 Windows registry 평문 값으로 두지 않는다.
MCP/admin control token과도 반드시 다른 값이어야 한다.

### 3. 기존 WPF 분석 계층 연결

[`IAndroidLogAnalysisEngine`](../examples/wpf-android-log-viewer/IAndroidLogAnalysisEngine.cs)을
기존 통계·차트·텍스트 추출 코드에 구현한다. Connector handler가 View의 control tree를
탐색하지 않게 하고, 이미 존재하는 domain/application service를 직접 호출한다.

[`ReluWpfIntegration`](../examples/wpf-android-log-viewer/ReluWpfIntegration.cs)을 application
수명 동안 하나 유지한다. 차트의 selection-completed 이벤트에서
`UpdateSelectionAsync`를 호출하고, 창 활성화 변경은 `WindowActivationChangedAsync`로
전달한다. `active`는 목록 정렬용 hint이며 mutation 대상을 자동 결정하는 권한 근거가
아니다.

`InstanceId`는 설치별로 안정적이고 opaque해야 한다. 사용자명, 장치 serial, 경로,
token을 포함하지 말고 현재 사용자만 읽을 수 있는 app-data ACL 아래에서 관리한다.
Connector resume secret은 process 메모리에만 유지한다. 앱이 정상적으로 재시작되면
Bridge는 같은 authenticated app/instance의 살아 있는 session이 없을 때에만 이를
회전한다.

### 4. 시작과 확인

사람이 Bridge, WPF 프로그램, Claude/Codex를 실행한다.

```powershell
node .\bin\relu-ai-bridge.mjs doctor
node .\bin\relu-ai-bridge.mjs serve
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release
dotnet run --project .\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release
```

WPF에서 로그와 구간을 선택한 뒤 MCP 순서는 다음과 같다.

1. `list_sessions`에서 `android-log-viewer` desktop session 확인
2. `get_context`로 dataset과 정확한 selection revision 확인
3. `list_capabilities`로 현재 서버 registry 계약 확인
4. 통계와 downsampled series를 먼저 조회
5. 필요한 경우에만 추출 section, anomaly, 제한된 원문을 조회
6. 마지막에 `get_context`를 다시 읽어 같은 selection인지 확인

## Capability 설계 원칙

예제는 read-only 함수만 제공한다.

| Capability | 목적 | 기본 상한 |
| --- | --- | --- |
| `get_selection_stats` | 선택 구간의 기존 집계 | bounded metric 200개 |
| `get_selection_series` | 분석용 downsampled chart | series 6개, 각 1,000 point |
| `get_extracted_sections` | 기존 분석기가 뽑은 section | section 100개 |
| `find_anomalies` | 기존 알고리즘의 이상 후보 | 후보 100개 |
| `get_log_excerpt` | 후보 주변 최소 원문 | 최대 200줄 |

전체 로그 파일, 무제한 chart point, 임의 파일 경로, SQL, URL, reflection target,
script 또는 UI selector를 parameter로 받지 않는다. 결과에는 적용 filter, timebase,
sampling/parser version, truncation과 dropped-record 정보를 함께 주는 것이 좋다.
각 row·point·section 상한과 별도로, 직렬화한 Capability 결과 전체가
`connectors.maxResultBytes` 합산 byte 상한을 통과해야 한다.

나중에 `focus_range`나 annotation 같은 UI mutation을 추가한다면 server registry의
`effect`를 정확히 표시하고 unique `operationId`, timeout 후 ambiguous 판정 및 local
policy를 적용해야 한다. `trusted_always`도 operation ledger, Context guard와
`once/deny` 전용 ambiguous 판정 확인을 우회하지 않는다. Read로 위장해 추가하면 안 된다.

## 인증과 stale-selection 방어

Desktop endpoint는 다음 순서로 fail-closed한다.

1. explicit loopback의 정확한 `/relu/desktop/ws`만 허용한다.
2. browser가 자동으로 보내는 `Origin` header가 하나라도 있으면 upgrade를 거부한다.
3. app ID, stable instance ID, 양쪽 fresh nonce와 전용 audience를 server/client HMAC에
   모두 묶는다. Raw token은 wire에 보내지 않는다.
4. server proof를 검증하기 전에는 Context와 resume secret을 보내지 않는다.
5. Desktop registration의 정확한 UTF-8 JSON 문자열 digest를 client proof에 묶는다.
   이는 JavaScript와 .NET의 Unicode·decimal 직렬화 차이를 제거한다.
6. HMAC 검증 뒤에만 duplicate-key 없는 JSON parse, identity, byte/depth/node limit,
   Context schema와 advertised Capability 교집합을 확인한다.

각 연결의 수신 message 처리 queue는 최대 32개 frame, 설정된 단일 message 상한의 2배이자
최대 4 MiB로 제한하며 모든 Connector 연결의 대기 byte 합도 16 MiB로 제한한다. 초과,
인증 실패, protocol 오류 또는 연결 종료가 발생하면 해당 연결을 즉시 terminal 상태로
바꾸고 아직 처리하지 않은 frame을 버리며, 고정된 사유의 audit event를 한 번만 남긴다.
따라서 빠른 sender가 비동기 audit/검증보다 앞서 무제한 메모리나 인증 뒤 작업을 쌓을 수
없다.

인증에 사용한 allowlisted app ID는 Bridge 내부에서
`relu-desktop://<sha256>` opaque app trust-domain peer로 변환된다. 승인·mutation
원장에는 원문 app ID가 아니라 이 connector peer가 들어가고, stable instance ID로
만든 별도의 application-instance binding이 설치별 desktop instance를 묶는다.

요청 시 Bridge가 보낸 `contextGuard` projection을 SDK가 handler 직전과 직후의 live
Context에 비교한다. `UpdateSelectionAsync`는 SDK의 atomic update callback 안에서
context 저장소를 갱신하고, update frame과 success 응답의 마지막 guard 검사를 같은
send gate로 직렬화한다. 인증 중에 발생해 즉시 전송하지 못한 선택 변경도 `hello_ack`
직후 최신 Context를 무조건 다시 보내 복구한다. 선택 변경 알림은 진행 중 handler의
cancellation token도 취소한다. Handler는 cancellation을 존중해야 한다. 변경 작업의
결과가 timeout이나 선택 변경 때문에 모호하면 자동 재시도하지 않는다.

Handler가 cancellation을 무시하더라도 SDK는 실제 task가 끝날 때까지 request ID와
16개 bounded 실행 slot 중 하나를 해제하지 않는다. 이 상태가 누적되면 새 요청을
fail-closed하므로 상한을 늘리거나 자동 재연결로 우회하지 말고 분석 엔진의 취소 처리를
수정한다.

선택 변경 시 SDK는 내부 failure code `CONTEXT_CHANGED`를 보낸다. Core는 SDK의 raw
detail을 MCP에 반사하지 않고 이 allowlist code를 고정 문구
`Connector selection context changed; call get_context and retry`로 변환한다. Caller는
read-only 분석에서 이 문구를 받으면 `get_context`부터 다시 읽고 이전·새 구간 결과를
합치지 않는다. Mutation은 결과가 ambiguous할 수 있으므로 이 문구만 보고 자동
재시도하지 않는다.

`Origin` 없음은 process 신원을 증명하는 장치가 아니다. 같은 Windows 계정에서 token을
가진 악성 process, 변조된 Node/.NET runtime 또는 탈취된 application process는 이
프로토콜만으로 방어할 수 없다. 전용 OS account, application signing/allowlisting,
secret ACL과 검증된 release가 함께 필요하다.

## 분석 Skill 공급

WPF binary 안에 prompt나 Skill 본문을 넣지 않는다. 검증된 release의 정본 Skill을
Claude/Codex 쪽에 별도로 설치한다.

```powershell
powershell.exe -NoProfile -File .\scripts\skills\install-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\work\android-analysis

powershell.exe -NoProfile -File .\scripts\skills\verify-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\work\android-analysis
```

Skill은 분석 순서와 보고 형식만 정한다. 실제 권한과 함수는 항상 live
`list_capabilities` 결과가 결정한다. 자세한 공급·checksum·업데이트 계약은
[분석 Skill 설계와 배포](SKILLS_KO.md)를 따른다.

## 검증 체크리스트

- `dotnet build sdk-dotnet/Relu.AI.Bridge.DesktopConnector.sln -c Release`
- `dotnet run --project sdk-dotnet/tests/Relu.AI.Bridge.DesktopConnector.Tests/Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release`
- `dotnet build examples/wpf-android-log-viewer/WpfAndroidLogViewer.Integration.csproj -c Release`
- 공유 `compat/desktop-auth-v1.json`을 Node와 .NET test가 모두 통과
- Unicode, decimal/exponent, duplicate JSON key 회귀 test 통과
- Desktop endpoint의 missing/present/forged Origin test 통과
- unknown app ID, 잘못된 audience, replay/identity swap 거부
- 같은 instance의 live takeover 거부와 앱 재시작 secret 회전 확인
- 선택 변경 중 요청 취소 및 handler 직전·직후 guard 확인
- service example을 실제 `loadConfig`로 읽는 test 통과
- full Node suite와 기존 browser/Perfetto 회귀 suite 통과
