# Windows Desktop Embedded Bridge 및 WPF 통합 설계

RELU AI Bridge 0.7.0의 Windows desktop 기본 경로는 별도 RELU 프로그램을 설치하는
방식이 아니다. 회사가 배포하는 `EndViewer.exe`에 .NET bridge를 포함하고, 사용자가
EndViewer를 실행하면 Claude Code와 Codex 연결 준비까지 앱이 자동으로 끝낸다.

최종 사용자는 다음 항목을 만들거나 입력하지 않는다.

- RELU AI Bridge 또는 Node.js 별도 설치
- daemon/service 실행과 localhost port 설정
- desktop connector token 또는 secret
- `config/local.json`, desktop service JSON, 프로젝트 `.mcp.json`
- EndViewer 외의 MCP host 실행 파일

NuGet/project reference는 EndViewer 개발자가 빌드할 때 사용하는 구성 요소다. 최종
배포물에는 필요한 코드와 runtime을 포함하며 사용자에게 별도 설치 단계가 노출되지
않아야 한다.

> 이 저장소가 제공하는 것은 SDK와 WPF 통합 골격이다. 회사의 proprietary EndViewer
> application source, 실제 분석 엔진, installer, 서명 인증서와 완성된 `EndViewer.exe`는
> 포함하지 않는다. 아래의 “실행만 하면 된다”는 EndViewer 팀이 이 골격을 실제 앱에
> 통합하고 Windows에서 빌드·서명·검증한 배포물에 대한 사용자 계약이다.

## 단일 실행 파일의 이중 모드

```text
사용자의 일반 실행
EndViewer.exe
  ├─ WPF UI + 기존 Android 로그 분석 엔진
  ├─ ReluEmbeddedBridgeHost
  │    ├─ 현재 dataset/selection Context
  │    ├─ 서명된 배포물에 고정된 Capability/schema/effect
  │    └─ CurrentUserOnly named pipe server
  └─ ReluAiClientRegistrar
       └─ Claude Code/Codex user-scope MCP 자동 등록

AI client가 MCP server를 시작할 때
Claude/Codex ──stdio──▶ EndViewer.exe <내부 stdio mode>
                           └─ ReluMcpStdioEntryPoint
                                │ CurrentUserOnly named pipe
                                ▼
                         실행 중 EndViewer GUI process
```

같은 `EndViewer.exe`가 두 역할을 한다.

- 일반 모드에서는 WPF UI와 `ReluEmbeddedBridgeHost`를 시작한다.
- 내부 stdio 모드에서는 UI를 열지 않고 `ReluMcpStdioEntryPoint`가 MCP stdio와
  EndViewer의 named pipe를 중계한다.
- `ReluAiClientRegistrar`는 AI client에 같은 실행 파일의 내부 stdio 모드를 등록한다.

GUI host는 Windows 사용자별로 한 process만 실행해야 한다. Pipe 이름은 Windows 사용자
SID와 EndViewer service ID를 domain-separated SHA-256으로 해시해 사용자별로 고정하고,
원문 SID는 노출하지 않는다. 첫 pipe instance를 독점하므로 두 번째 GUI instance는 bridge 시작에
성공할 수 없다. 실제 제품은 application single-instance 정책으로 두 번째 실행을 기존
창으로 전달하거나, bridge 충돌을 bounded 상태로 표시하고 로그 viewer 자체는 계속
사용할 수 있게 처리한다.

내부 mode switch의 정확한 인자와 API 호출 순서는
[`ReluWpfIntegration.cs`](../examples/wpf-android-log-viewer/ReluWpfIntegration.cs)를
정본으로 사용한다. 공개 문서의 임의 코드 조각보다 현재 release 예제가 우선한다.

## 최초 실행과 자동 등록

EndViewer 일반 모드가 시작되면 registrar는 다음 순서로 동작한다.

1. EndViewer가 일반 사용자 권한인지 확인한다. 관리자/elevation 상태거나 판정할 수
   없으면 자동 등록하지 않는다.
2. Windows의 임의 `PATH` 명령을 실행하지 않는다. 알려진 설치 위치와 현재 실행 중인
   client 경로 중 Authenticode 및 공식 OpenAI/Anthropic publisher 검증을 통과한
   Claude Code/Codex CLI만 후보로 삼는다.
   Codex 공식 설치 script의 기본 경로인
   `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`도 이 검증 대상에 포함한다.
3. Token/API key/password 등 credential 형태의 환경 변수를 제거한 child environment에서
   해당 CLI의 공식 MCP 조회 명령으로 기존 user-scope 항목을 확인한다.
4. 항목이 없으면 EndViewer의 안정된 절대 경로와 내부 stdio mode를 user scope에
   등록한다.
5. 항목이 앱이 소유한 동일 경로, stdio transport, 단일 내부 인자, 빈 environment로
   정확히 일치하면 그대로 사용한다.
6. 동일한 이름이 다른 executable이나 실행 환경을 가리키면 덮어쓰지 않고 진단을
   남긴다.
7. process 내부 gate와 SID로 분리한 `Global\` named mutex 아래에서 같은 Windows
   계정의 모든 login session을 직렬화한다. add 직전 재조회하고, 등록 뒤 공식 조회
   명령으로 실제 저장된 전체 실행 계약을 다시 검증한다.

JSON/TOML을 직접 수정하지 않는다. AI client가 자체 user 설정에 등록 정보를 보관하는
것은 MCP client의 필수 동작이지만, EndViewer가 공식 CLI를 통해 이를 대신하므로 사용자가
설정 파일을 찾거나 편집할 필요는 없다.

Registrar는 시작 전에 존재하거나 재조회에서 발견한 충돌을 덮어쓰지 않는다. 다만
Codex CLI의 `mcp add`에는 compare-and-set/no-clobber API가 없으므로, 마지막 재조회와
`add` 사이의 매우 짧은 구간에 같은 Windows 계정의 별도 process가 동일 server 이름을
새로 쓰는 경우까지 원자적으로 보호할 수는 없다. 같은 계정의 process는 설정 파일도 직접
수정할 수 있다는 신뢰 경계 안의 잔여 race다. 운영 중 별도 `codex mcp add/remove`
자동화를 동시에 실행하지 않고, 조직 managed MCP를 쓰는 환경에서는 앱 등록을 비활성화한다.

이 등록은 project scope가 아니라 **Windows 사용자 범위**다. 따라서 같은 OS 계정으로
실행하는 다른 Claude Code/Codex 프로젝트도 `relu-endviewer` 서버를 발견하고, EndViewer가
열려 있으면 현재 선택 Context와 read-only 분석 도구를 호출할 수 있다. `active` 값은
정렬 hint일 뿐 호출 권한 경계가 아니다. 공용 계정을 피하고 회사가 승인한 AI 프로젝트와
데이터 분류에서만 사용하며, 더 강한 프로젝트 격리가 필요한 환경은 조직 managed MCP로
허용 범위를 제한한다.

Claude와 Codex 중 하나만 설치되어 있어도 해당 client 연결은 완료한다. CLI를 찾지 못한
client는 EndViewer 실행을 방해하지 않고 다음 실행에서 다시 확인한다.

### 최초 한 번 필요한 reload

최초 자동 등록 **전에 이미 실행 중이던** Claude/Codex는 시작할 때 읽은 MCP server
목록을 캐시할 수 있다. 프로토콜상 EndViewer가 다른 process의 이미 열린 MCP 목록을
강제로 바꿀 수 없으므로 등록 직후에는 다음 중 하나가 한 번 필요하다.

- Claude/Codex 재시작
- client가 제공하는 MCP reload/reconnect

등록이 끝난 다음부터는 같은 절차를 반복할 필요가 없다. EndViewer 업데이트 후에도
등록이 깨지지 않도록 회사 배포는 버전별 임시 파일이 아닌 안정된 서명 launcher 경로를
유지해야 한다.

### 회사 managed MCP

Claude Code가 exclusive `managed-mcp.json` 정책으로 운영되거나 Codex 조직 정책이
사용자 범위 MCP 추가를 막으면 앱이 이를 우회하지 않는다. 이 환경에서는 IT가 EndViewer
배포 전에 다음 값을 조직 정책에 등록해야 한다.

- 회사가 관리하는 안정된 `EndViewer.exe` 절대 경로
- EndViewer의 내부 stdio mode 인자
- 별도 environment secret이 없는 local stdio server 계약

이것은 사용자별 수동 설정이 아니라 IT 배포 정책이다. Pilot 장비에서 서명, 설치 경로,
CLI 조회 결과와 client restart 동작을 함께 검증한다.

## WPF 통합 책임

EndViewer composition root는 다음 세 API를 연결한다.

- `ReluEmbeddedBridgeHost`: GUI process 안에서 현재 Context와 고정 Capability handler를
  제공하고 user-only named pipe를 소유한다.
- `ReluMcpStdioEntryPoint`: AI client가 시작한 stdio process에서 MCP frame을 처리하고
  실행 중 GUI host로 중계한다.
- `ReluAiClientRegistrar`: Claude Code/Codex의 user-scope 등록을 조회·추가·검증한다.

앱은 기존 domain/application service를 handler에 직접 연결한다. View의 control tree,
화면 캡처, UI Automation, 임의 reflection 또는 assembly 동적 로딩으로 데이터를 찾지
않는다.

차트의 selection-completed event에서는 opaque log ID, dataset revision, selection
ID/revision과 start/end를 atomic Context로 갱신한다. 창 활성화 값은 목록 정렬용 hint일
뿐 mutation 대상을 자동 결정하는 권한 근거가 아니다.

앱 시작 시 아직 로그를 열거나 구간을 선택하지 않았어도 GUI host와 registrar는 시작한다.
이 상태에서 session 목록은 유지하되 Context 조회와 분석 실행은 bounded
`CONTEXT_UNAVAILABLE` 오류와 “먼저 구간을 선택하라”는 메시지를 반환한다. 첫
selection-completed event가 들어오면 별도 재등록이나 재시작 없이 정상 분석 상태로
전환한다. 빈 ID, 임의의 `0..1` 범위 또는 이전 파일의 selection을 가짜 초기값으로
만들지 않는다.

## Capability 설계

Android 로그 viewer의 기본 Capability는 read-only다.

| Capability | 목적 | 권장 상한 |
| --- | --- | --- |
| `get_selection_stats` | 현재 구간의 집계 | metric 200개 |
| `get_selection_series` | 분석용 downsampled chart | series 6개, 각 1,000 point |
| `get_extracted_sections` | 기존 분석기의 section | section 100개 |
| `find_anomalies` | 기존 알고리즘의 이상 후보 | 후보 100개 |
| `get_log_excerpt` | 후보 주변 최소 원문 | 최대 200줄 |

Capability 이름, input/output schema, effect와 제한은 EndViewer의 검토된 source/binary에
고정한다. 런타임 JSON, 모델 argument 또는 로그 내용이 이를 확장할 수 없다. 전체 로그,
임의 파일 경로, SQL, URL, command, selector와 reflection target을 parameter로 받지
않는다. 큰 결과는 aggregate, filter, downsample하고 전체 직렬화 byte 상한도 적용한다.

현재 embedded 기본은 read-only이므로 RELU 승인 창 없이 호출한다. 향후 annotation이나
`focus_range` 같은 mutation을 추가할 때는 `operationId`, deduplication, timeout 뒤
ambiguous 판정, preview 및 회사 정책을 별도 구현해야 한다. “항상 허용”이라는 편의를
중복 실행 방어나 stale-selection 검증을 끄는 의미로 해석하면 안 된다.

## 선택 변경 방어

MCP 호출은 다음 순서를 지킨다.

1. AI client가 현재 Context와 selection revision을 읽는다.
2. embedded host가 Capability input과 결과 크기를 검증한다.
3. handler 직전에 live dataset/selection projection을 비교한다.
4. 기존 분석 엔진을 bounded cancellation token과 함께 호출한다.
5. handler 완료 뒤 같은 projection을 다시 비교한다.
6. 구간이 바뀌었으면 결과를 반환하지 않고 context-changed 오류로 끝낸다.

Read-only 분석 중 context-changed 오류를 받으면 AI는 이전 결과와 새 결과를 합치지 않고
Context부터 다시 읽는다. Handler는 cancellation을 존중해야 하며, 동작 중인 task를
버린 채 새 요청을 무제한 생성해서는 안 된다.

선택 event 자체가 새 Claude/Codex 대화를 만들거나 모델 호출을 강제하지는 않는다.
사용자가 이미 실행한 AI client에서 “EndViewer의 현재 구간을 분석해줘”라고 요청하면
최신 Context를 사용한다. 무인 자동 호출은 비용·중단·결과 전달 정책이 필요한 별도
orchestration 기능이며 embedded bridge의 암묵적 권한이 아니다.

## Named pipe 보안 경계

- desktop 경로는 TCP/WebSocket listener와 port를 열지 않는다.
- pipe 이름은 `Windows 사용자 SID + serviceId`의 domain-separated SHA-256으로
  사용자별 분리하며 원문 SID는 포함하지 않는다.
- pipe는 Windows `CurrentUserOnly`로 만들고 다른 Windows 사용자 접근을 거부한다.
- 연결 직후 pipe 양쪽에서 peer PID를 OS에 질의하고 OS가 보고한 process image를
  `Path.GetFullPath`로 정규화한 값이 현재 `EndViewer.exe`의 정규화된 경로와 정확히
  같은지 확인한다. GUI와 stdio relay가 서로 다른
  실행 파일이면 요청을 읽거나 쓰기 전에 연결을 닫는다.
- stdio relay 등록도 같은 EndViewer binary의 안정된 절대 경로 하나만 허용한다.
- Context와 결과는 bounded schema를 통과하며 원문 전체나 exception detail을 log에
  남기지 않는다.
- 실행 중 EndViewer가 없으면 stdio endpoint는 명확한 `APPLICATION_NOT_RUNNING` 상태를
  반환하고 임의 process나 중앙 bridge로 fallback하지 않는다.
- 앱 종료 시 pipe와 in-flight request를 닫고, 재실행 시 새 process에 다시 연결한다.

별도 token을 없앤 것은 “인증 없이 TCP port를 공개한다”는 뜻이 아니다. stdio child는
AI client가 시작하고 pipe는 같은 Windows 사용자와 same-image 검사로 제한된다. 다만 같은
사용자 권한의 공격자가 허용된 EndViewer binary 자체를 relay mode로 실행하는 경우까지
완전히 구분하는 암호학적 경계는 아니다. 회사는 EndViewer와
업데이트 manifest를 서명하고 설치 경로 ACL, application allowlisting 및 low-privilege
운영 정책을 적용해야 한다.

## Perfetto/browser와의 구분

Perfetto와 browser connector는 웹 origin과 browser process를 넘어 통신하므로 이
embedded named-pipe 경로를 사용하지 않는다. 그 경로는 계속 다음 구성으로 운영된다.

```text
Perfetto/browser ──authenticated loopback WebSocket──▶ 중앙 RELU AI Bridge
Claude/Codex     ──authenticated HTTP MCP────────────▶ 중앙 RELU AI Bridge
```

따라서 중앙 경로에는 Node.js runtime, `config/local.json`, port `5746`, control token과
connector별 token이 필요하다. 이 요구사항을 EndViewer desktop 사용자에게 적용해서는
안 되며, 반대로 EndViewer의 tokenless named pipe 계약을 browser에 적용해서도 안 된다.

## 분석 instructions 공급

EndViewer 분석 순서와 보고 형식은 embedded service definition에 고정하고 MCP `2025-06-18`
`initialize` 응답의 `instructions`에 컴파일해 제공한다. 따라서 desktop 사용자는 별도 Skill을
설치하지 않는다. Instructions는 Capability 권한을 추가하지 않으며 실제 함수/schema는
같은 signed service definition과 handler 교집합이 결정한다.

저장소의 별도 `skills/` 배포는 Perfetto/browser 중앙 workflow용이다. EndViewer가 이
파일을 사용자 profile에 복사하거나 로그 안의 prompt/URL을 instructions로 로드해서는
안 된다.

## 개발·배포 체크리스트

- EndViewer 한 개의 서명된 실행 파일에서 GUI/stdio mode가 모두 동작한다.
- 최종 사용자 장비에 별도 RELU/Node 설치가 필요하지 않다.
- desktop token, environment secret, RELU local JSON, project `.mcp.json`과 별도 Skill
  설치가 없다.
- EndViewer 분석 instructions가 signed service definition의
  `initialize` `instructions`에 포함된다.
- registrar가 Claude/Codex를 독립적으로 탐지하고 user-scope 등록을 idempotent하게
  검증한다.
- 앱이 소유하지 않은 같은 이름의 MCP 등록을 덮어쓰지 않는다.
- 최초 등록 전 실행 중이던 client의 1회 restart/reload를 안내한다.
- managed MCP 환경에서는 IT 사전 등록을 검증한다.
- pipe가 `CurrentUserOnly`이고 다른 사용자 연결 테스트가 실패한다.
- GUI 미실행, 종료, 재실행과 stdio relay 재연결을 검증한다.
- selection 변경 중 취소 및 handler 전후 guard를 검증한다.
- Capability input/output/전체 byte 제한을 검증한다.
- 배포 경로와 binary signature/update chain을 검증한다.

빌드와 실제 통합 시작점은
[.NET SDK 문서](../sdk-dotnet/README_KO.md)와
[WPF Android Log Viewer 예제](../examples/wpf-android-log-viewer/README_KO.md)를 따른다.
