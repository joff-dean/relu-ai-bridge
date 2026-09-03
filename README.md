# RELU AI Bridge

RELU AI Bridge는 Claude·Codex 같은 로컬 AI 클라이언트를 사내 웹 분석 서비스와 Windows 데스크톱 분석 프로그램에 연결하는 **독립 구현 local-first MCP 플랫폼**이다. Browser/desktop integration은 사용자가 현재 보는 화면의 구조화된 Context만 알려주고, 실제 조회·UI 동작은 사전에 고정한 Capability만 실행한다. AI가 임의 URL, HTTP method, header, script, DOM selector, reflection target 또는 shell command를 만드는 범용 proxy가 아니다.

Perfetto v58.2 REF/DUT 분석은 중앙 browser 경로의 첫 번째 커넥터다. Android Log Viewer는
Windows embedded 경로의 기준 예제이며, LLM Wiki와 Issue DB 같은 browser/HTTP 서비스는
중앙 경로에 추가한다.

## 전체 구조

```text
Windows desktop: 설치 없는 embedded 경로

Claude / Codex ──stdio──▶ EndViewer.exe --relu-mcp-stdio
                              │ CurrentUserOnly named pipe
                              ▼
                         실행 중 EndViewer.exe
                         └─ 내장 Capability + 분석 엔진

Perfetto/browser: 중앙 bridge 경로

Claude / Codex ──HTTP MCP──▶ RELU AI Bridge @ 127.0.0.1:5746
                                  │ browser WebSocket / fixed API
                                  ▼
                          Perfetto · 사내 웹서비스
```

Context Plane과 Data Plane을 분리한다.

- **Embedded desktop 경로**: EndViewer 배포물에 RELU .NET 구성 요소를 포함한다. 사용자는 RELU, Node.js, port, token 또는 RELU 설정 파일을 별도로 설치·입력하지 않는다.
- **중앙 bridge 경로**: Perfetto/browser와 고정 사내 API는 기존 loopback 서버의 Context/Data/MCP Plane을 사용한다. 이 경로만 별도 서버 설정과 audience별 credential이 필요하다.
- 두 경로는 도구 이름을 공유할 수 있지만 transport와 신뢰 경계가 다르다. Desktop 앱을 중앙 `/relu/desktop/ws`에 연결하는 구형 배포 절차는 지원하지 않는다.

## 구현된 기능

- 범용 live session/context registry와 active-tab 추적
- 공통 브라우저 SDK `@company/relu-ai-connector`
- .NET 8 embedded bridge SDK와 WPF Android Log Viewer 통합 예제
- 최종 EndViewer 단일 실행 파일에 통합할 GUI/stdio 이중 모드 SDK와 `CurrentUserOnly` named pipe relay
- 최초 실행 시 Claude Code/Codex 사용자 범위 MCP 자동 등록·검증
- 서버 권위의 서비스별 connector peer, Capability, 입력·출력 schema, effect policy
- browser Data Plane과 고정 URL의 GET/POST JSON Data Plane
- 중앙 browser 서비스별 connector token, Perfetto token과 MCP/admin control token 분리
- `list_sessions → get_context → list_capabilities → execute` generic MCP
- 중앙 bridge의 `trusted_always` 기본 정책과 embedded desktop read-only Capability의 즉시 실행
- MCP session·page/application instance·`bindingFields` resource·connector peer·connector version·schema/effect/policy에 묶인 scope
- local policy 통과 후 대상 재검증과 SDK 실행 직전 Context guard
- resource·`policyEpoch` 단위의 영속 mutation operation ledger, 수동 reconciliation과 검증된 archive
- Claude가 generic 도구를 우선 찾도록 하는 설정과 `anthropic/alwaysLoad` metadata
- Embedded desktop의 MCP `2025-06-18` `initialize` 응답에 내장된 분석 `instructions`와 중앙
  Perfetto/browser용 `relu-analyze-selection` Skill
- Perfetto v58.2 Connector #1, bounded read-only SQL, durable REF/DUT, coarse correlation + constrained DTW
- 제한된 파일/명령 profile, Goal, Compact & Resume, browser worker 기능
- 외부 release bundle, manifest, 사내 immutable mirror와 integration 검증 자동화
- runtime npm dependency와 telemetry 없음

Chat On Steroids나 다른 외부 agent 프로젝트의 코드·runtime을 복사하거나 실행하지 않는다. Node.js와 .NET 8 표준 라이브러리 및 공개 Perfetto API로 작성됐다.

## EndViewer 사용자는 실행만 하면 된다

Windows desktop의 목표 배포 단위는 **RELU가 내장된 EndViewer 단일 실행 파일**이다.
이 저장소에는 .NET SDK와 WPF 통합 골격이 있으며 회사의 proprietary EndViewer 소스나
완성된 `EndViewer.exe`는 포함하지 않는다. EndViewer 팀이 이 골격을 실제 application에
통합해 빌드·서명하면
`ReluEmbeddedBridgeHost`가 앱 내부에서 시작되고 `ReluAiClientRegistrar`가 설치된
Claude Code와 Codex CLI에 같은 실행 파일의 stdio 모드를 사용자 범위로 등록한다.
Claude/Codex가 MCP server를 시작할 때는 `ReluMcpStdioEntryPoint`가 활성화되어 실행 중
EndViewer와 `CurrentUserOnly` named pipe로 통신한다.

Desktop 사용자에게는 다음 작업이 없다.

- RELU 또는 Node.js 별도 설치
- localhost port 선택과 daemon 실행
- token 생성·복사·입력
- `config/local.json` 또는 프로젝트 `.mcp.json` 작성
- EndViewer와 별도 Connector 실행

최초 자동 등록 전에 이미 실행 중이던 Claude/Codex는 MCP 목록을 캐시할 수 있으므로
**등록 직후 한 번만** 재시작하거나 MCP 목록을 reload해야 한다. 이후에는 EndViewer를
평소처럼 실행하면 된다. 이 user-scope 등록은 같은 Windows 계정의 모든 Claude Code
프로젝트에서 보일 수 있으므로 회사가 승인한 프로젝트에서만 사용해야 한다. 회사가 exclusive managed MCP를 강제한 장비에서는 사용자 범위
등록이 차단될 수 있으므로 IT가 EndViewer의 안정된 서명 경로를 사전 등록해야 한다.

구체적인 host/registrar API와 WPF 생명주기는
[Windows Desktop Connector 및 WPF 통합 설계](docs/DESKTOP_CONNECTOR_KO.md)를 따른다.

GUI bridge host는 Windows 사용자별 단일 EndViewer process를 전제로 한다. 제품은 두 번째
실행을 기존 창으로 전달하거나 pipe 충돌을 bounded 상태로 처리해야 한다. 앱 시작 시 아직
선택 구간이 없어도 host와 등록은 올라오며, Context/분석 호출은 첫 확정 선택 전까지
`CONTEXT_UNAVAILABLE`을 반환한다.

## Perfetto/browser 중앙 bridge 빠른 시작

아래 절차는 **Perfetto와 사내 웹서비스를 연결하는 중앙 bridge에만 해당한다**.
요구사항은 Node.js 20.11 이상이다. macOS/Linux와 Windows local server를 지원한다.
Perfetto v58.2 bootstrap·build·개발 서버에는 Python 3.10 이상이 필요하다. macOS
ARM64 build에는 Rosetta 2 또는 Java 11 이상 runtime도 필요하며, overlay script는
WSL 또는 Linux build worker를 권장한다.

```bash
node ./bin/relu-ai-bridge.mjs init \
  ./config/local.json \
  /absolute/path/to/approved/project
```

명령이 출력한 control token과 별도 Perfetto connector token은 회사 secret manager에 저장한다. 기존 설정 파일은 덮어쓰지 않는다.
Perfetto를 배포하지 않는 장비는 `perfetto.enabled:false`로 명시하면 Perfetto token 주입을 생략할 수 있다.
생성되는 설정은 의도적으로 read-only다. `write`, `commands`, `goalLoop`,
`multiAgent`와 모든 command profile은 비활성 상태이며, 사내 보안 검토 뒤 필요한
기능만 하나씩 켠다. 새로 생성한 설정은 `approvals.policy: "trusted_always"`라서
활성화된 기능의 일반 보호 호출을 매번 묻지 않는다.

```bash
export RELU_AI_BRIDGE_CONFIG="$PWD/config/local.json"
export RELU_AI_BRIDGE_TOKEN="$(approved-secret-command)"
export RELU_PERFETTO_CONNECTOR_TOKEN="$(approved-perfetto-secret-command)"
node ./bin/relu-ai-bridge.mjs doctor
node ./bin/relu-ai-bridge.mjs serve
```

상태와 로컬 정책·승인 UI:

```text
http://127.0.0.1:5746/health
http://127.0.0.1:5746/admin/
```

Admin token은 현재 탭의 `sessionStorage`에만 저장한다. Perfetto와 서비스 커넥터 token은 각각 다른 값이어야 한다.

## 중앙 bridge를 Claude에 연결

다음 `.mcp.json` 예시는 Perfetto/browser 중앙 bridge용이다. EndViewer desktop
embedded 경로에는 사용하지 않는다.

```json
{
  "mcpServers": {
    "relu-ai-bridge": {
      "type": "http",
      "url": "${RELU_AI_BRIDGE_MCP_URL:-http://127.0.0.1:5746/mcp}",
      "headers": {
        "Authorization": "Bearer ${RELU_AI_BRIDGE_TOKEN}"
      }
    }
  }
}
```

처음 요청할 때는 다음 순서를 사용한다.

1. `list_sessions`
2. 분석할 session의 `get_context`
3. `list_capabilities`
4. 허용된 작업만 `execute`
5. Perfetto REF/DUT이면 전용 `perfetto_*` 도구 사용

Claude Code trust, 사내 managed MCP, Claude Desktop packaging, claude.ai 원격 연결 경계는 [Claude 설정 가이드](docs/CLAUDE_SETUP_KO.md)에 자세히 설명한다.

중앙 Perfetto/browser 선택 구간의 분석 순서와 보고 형식을 공급하려면 정본 Skill을
설치한다. EndViewer desktop은 embedded service definition을 MCP `2025-06-18`
`initialize` 응답의 `instructions`로 자동 제공하므로 이 단계가 필요 없다. 중앙 Project scope
예시는 다음과 같다.

```bash
ANALYSIS_PROJECT=/absolute/path/to/analysis-project
./scripts/skills/install-skills.sh --scope project --target both --project-root "$ANALYSIS_PROJECT"
./scripts/skills/verify-skills.sh --scope project --target both --project-root "$ANALYSIS_PROJECT"
```

Windows PowerShell 명령과 checksum 기반 안전한 갱신·제거 절차는
[분석 Skill 설계와 배포](docs/SKILLS_KO.md)를 따른다. Skill은 권한을 추가하지 않으며,
매 분석의 실제 실행 계약은 live `list_capabilities`가 결정한다.

## 첫 사내 웹서비스 커넥터 추가

`config/battery-viewer.service.example.json`을 복사해 서비스의 정확한 Origin, Context schema와 Capability schema를 정의하고 주 설정의 `connectors.services`에 넣는다.

서비스 전용 token을 별도로 만든다.

```bash
node scripts/generate-token.mjs connector
export RELU_BATTERY_CONNECTOR_TOKEN="$(approved-connector-secret-command)"
```

웹서비스에는 작은 SDK만 추가한다.

SDK는 외부 npm에 publish되는 package가 아니다. 검증된 release의 `sdk/`를 사내
registry에 재패키징하거나 서비스 저장소에 vendor한 뒤 아래 import 이름을 회사
scope에 맞춰 사용한다.

```js
import { ReluWebConnector } from '@company/relu-ai-connector';

const connector = new ReluWebConnector({
  serviceId: 'battery-viewer',
  token: runtimeConfig.reluConnectorToken,
  getContext: () => ({
    payloadId: currentPayload.id,
    view: currentView,
    selection: currentSelection,
  }),
  capabilities: {
    get_stats: () => getBoundedStats(currentSelection),
    focus_range: ({ startMs, endMs }, { operationId, contextGuard }) => {
      if (!operationId) throw new Error('operationId required');
      focusRange(startMs, endMs);
      return { focused: true };
    },
  },
});

await connector.start();
```

SDK는 연결, 상호 인증, heartbeat, 재연결, context update와 action routing을 담당한다. Handler 직전 `getContext()`의 `bindingFields` projection을 승인 당시 값과 다시 비교하므로 stale 탭 요청은 실행하지 않는다. 서버가 fresh nonce의 HMAC proof로 자신을 증명하기 전에는 token이나 Context를 보내지 않고 raw token을 wire에 싣지 않는다. 토큰을 source, URL, `localStorage`에 넣지 않는다. 전체 절차는 [커넥터 개발 가이드](docs/CONNECTOR_DEVELOPMENT_KO.md)와 [Battery 예제](examples/battery-viewer/README_KO.md)를 따른다.

서버 API가 있는 Wiki/DB는 browser를 우회해 설정에 고정한 HTTPS endpoint로 직접 조회할 수 있다. 브라우저는 현재 문맥만 보내고 API 인증값은 `http.auth.env`로 Bridge에 주입한다. redirect, 임의 destination과 임의 header는 허용하지 않는다.

## Windows WPF 분석 프로그램 연결

`.NET 8` SDK는 기존 WPF 분석 엔진을 직접 호출하는 static Capability adapter와 embedded
MCP host를 제공한다. EndViewer가 실행되면 앱 안의 `ReluEmbeddedBridgeHost`가 현재
선택과 bounded handler를 소유한다. AI client가 실행한 동일 binary의 stdio 모드는
`ReluMcpStdioEntryPoint`를 통해 GUI process의 `CurrentUserOnly` named pipe에 붙는다.
외부 TCP listener나 desktop bearer token은 없다.

```powershell
dotnet build .\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release
```

앱 시작 시 `ReluAiClientRegistrar`를 호출하면 설치된 Claude Code/Codex CLI의 공식
등록 명령을 이용해 user scope에 현재 EndViewer의 안정된 실행 경로를 등록한다. 사용자가
프로젝트 파일을 편집하거나 RELU setup을 실행하지 않는다. 동일 이름에 앱이 소유하지
않은 등록이 있으면 덮어쓰지 않고 진단을 반환해야 한다. 회사 managed MCP에서는 앱이
정책을 우회하지 않으며 IT 배포 항목을 사용한다.

application 연결 정본은
[`examples/wpf-android-log-viewer/ReluWpfIntegration.cs`](examples/wpf-android-log-viewer/ReluWpfIntegration.cs)다.
차트에서 구간 선택이 끝나면 앱은 opaque log ID, dataset revision, selection ID/revision과
범위만 갱신한다. 통계, downsampled series, 추출 section, anomaly 후보와 최대 200줄의
제한된 원문은 각각 별도 read-only Capability로 제공한다. Capability/schema/effect
정책은 EndViewer의 서명된 배포물에 고정되며 외부 desktop service JSON은 필요 없다.

각 Capability 결과는 배열 원소별이 아니라 직렬화한 **전체 JSON 결과**가
embedded host의 결과 상한을 통과해야 한다. 따라서 줄·point·section별 상한과 전체
결과 byte 상한을 함께 지키고, 큰 결과는 filter·downsample·aggregate한다. 선택이
바뀌면 handler 전후 guard가 stale 결과를 폐기한다.

전체 위협 모델, 최초 자동 등록, 앱 재시작, WPF event 연결과 검증 방법은
[Windows Desktop Connector 및 WPF 통합 설계](docs/DESKTOP_CONNECTOR_KO.md)를 따른다.

Embedded desktop은 현재 Claude Code/Codex의 기본 동작과 검증된 단일 MCP
`2025-06-18` 계약만 지원한다. `initialize` 응답 뒤 `notifications/initialized`를 받는
stdio lifecycle이며 별도 discovery method나 요청별 protocol metadata는 사용하지 않는다.
중앙 desktop WebSocket, desktop token과 runtime service JSON fallback은 제공하지 않는다. Perfetto
통합 기준도 `v58.2` 하나로 고정한다.

## 중앙 bridge 승인 편의성과 경계

`init`으로 새로 만든 사내 로컬 설정의 기본값은 다음과 같다.

```json
{
  "approvals": {
    "policy": "trusted_always"
  }
}
```

`trusted_always`는 `always` 결정을 허용한 보호 호출을 추가 UI 확인, 재시도 또는
개별 grant 저장 없이 즉시 통과시킨다. 따라서 반복 사용을 위해 승인하거나 나중에
개별 철회할 항목이 생기지 않는다. `policy`를 생략해도 `trusted_always`가 적용된다.
대화형 통제가 필요한 장비만 `"policy":"manual"`을 명시하고 Bridge를 재시작한다.
폐기된 승인 키나 알 수 없는 설정은 조용히 해석하지 않고 시작 단계에서 거부한다.

| 정책 | 일반 보호 호출 | 저장 상태 |
| --- | --- | --- |
| `trusted_always` | 같은 호출에서 즉시 실행 | 자동 허용용 pending/grant 없음 |
| `manual` | 미승인 시 `APPROVAL_REQUIRED`; 결정 후 같은 호출 재실행 | once/session/always grant |

`manual`에서는 다음 결정을 사용한다.

아래 중앙 bridge 설명에서 connector peer는 browser의 server-observed exact Origin을
뜻한다. Embedded desktop은 중앙 approval/grant 저장소를 사용하지 않고 signed binary에
고정된 read-only Capability를 즉시 실행한다. 향후 desktop mutation을 추가한다면
별도 operation ledger와 ambiguous-result interlock을 앱 안에 구현해야 한다.

- `한 번`: 같은 scope와 정확한 argument digest에 한 번
- `현재 세션`: 같은 Claude/Codex MCP session과 exact scope가 유지되는 동안
- `항상 허용`: 같은 service, connector peer, page 및 resource binding, connector version, Capability transport/schema/effect/policy epoch에 대해 재호출 허용
- `거부`: 현재 pending 요청 거부
- `철회`: 저장된 grant 즉시 삭제

자동 허용은 모든 URL·파일·명령을 여는 전역 allowlist가 아니다. 비활성 permission,
read-only root, protected path, 고정 command profile, service/origin allowlist, server-owned
Capability와 schema, size/concurrency 제한, page binding, `bindingFields`,
execution guard 및 `policyEpoch`는 두 정책에서 똑같이 강제된다. Browser reload나
resource 변경은 새 경계가 되며 `manual`에서는 다시 승인하고 `trusted_always`에서는
승인 창 없이 새 경계를 검사한 뒤 진행한다. 정책을 변경하면 이전 pending/grant는
무효화되어 나중에 수동 모드로 돌아가도 되살아나지 않는다.

`trusted_always`가 신뢰하는 대상은 단일 사용자 로컬 운영 환경이지 AI 출력이나
웹/로그/trace 내용이 아니다. 기능을 긴급 차단할 때는 Bridge/Connector를 중지하고
관련 `permissions` 또는 service를 비활성화한다. credential 노출 가능성이 있으면
control, Perfetto, service credential을 각각 회전한다.

변경 작업은 8~128자의 `operationId`가 필요하다. 원장은 service+connector peer+resource+capability 단위로 `connector-operations.json`에 mode 0600으로 저장되어 다른 탭과 재시작 뒤에도 중복 실행을 막는다. Timeout이나 연결 종료로 결과가 모호하면 자동 재시도하지 않는다. `/admin/`에서 실제 서비스 상태를 확인한 뒤 `적용됨` 또는 `미적용`으로 판정하며, 이 판정은 `once/deny`만 허용하는 안전 interlock이므로 `trusted_always`에서도 한 번의 명시적 확인이 필요하다.

`connectors.policyEpoch`는 모든 Connector 승인과 mutation ID의 정책 세대를 함께
바꾸는 단조 증가 값이다. 원장이 비어 있지 않은 상태에서 이를 올릴 때는 Bridge를
중지하고 pending/ambiguous 작업을 먼저 판정한 뒤 `archive-ledger`를 실행한다.

```bash
# Bridge 중지 → config의 policyEpoch를 N보다 크게 변경 → 같은 secret 환경에서 실행
node ./bin/relu-ai-bridge.mjs archive-ledger
```

명령은 terminal record만 private archive에 보존·검증하고 새 epoch의 빈 원장을 만든다.
출력한 canonical ledger SHA-256과 archive 경로는 사내 변경 티켓에 기록한다. 원장을
직접 삭제하거나 `policyEpoch`를 감소시키면 중복 실행 방어가 깨지므로 금지한다. 상세
절차는 [운영 배포 가이드](docs/DEPLOYMENT.md#중앙-connector-policyepoch과-operation-ledger)를 따른다.

## Perfetto Connector #1

외부 개발의 canonical baseline은 공식 Perfetto `v58.2`다.
Perfetto 명령을 실행하기 전에 `python3 --version`이 3.10 이상인지 확인한다. 다른
interpreter를 쓸 때는 `EMSDK_PYTHON`을 실행 파일 경로로 지정한다. 스크립트도 실제로
선택된 interpreter를 검사해 오래된 Python으로 생성되는 불완전한 build를 막는다.
macOS ARM64에서는 bundled Closure compiler 실행을 위해 Rosetta 2를 설치하거나
Java 11 이상 runtime을 `PATH`에 둔다.

| 항목 | 값 |
| --- | --- |
| Release | `v58.2` |
| Annotated tag object | `9e9bdafee101a7bb2eac57f60d14c5ec1fa30989` |
| Peeled commit | `add693d8b338ba9599dbcbc3e300b1ab8c000897` |
| Adapter | `v58` |
| 사내 target | 외부 저장소에 기록하지 않으며 내부 integration manifest에서 full SHA·ancestry 검증 |

```bash
scripts/perfetto/bootstrap.sh /absolute/work/perfetto-v58.2
scripts/perfetto/integrate.sh --mode symlink /absolute/work/perfetto-v58.2
scripts/perfetto/build-test.sh --install-deps --typecheck /absolute/work/perfetto-v58.2
scripts/perfetto/run-dev-server.sh /absolute/work/perfetto-v58.2
```

REF와 DUT trace를 별도 탭에서 열고 `/admin/`에서 session에 배정한다. 권장 MCP 흐름은 `perfetto_clients`, `perfetto_sessions`, `perfetto_query`, `perfetto_align(applySelection:false)`, 결과 검토, `perfetto_align(applySelection:true)` 순서다. Trace 원본은 Bridge로 복사되지 않고 SQL은 각 탭의 Trace Processor에서 실행된다.

사내 fork를 외부 baseline으로 만들지 않는다. 공식 v58.2에서 Connector를 개발하고, 회사 버전 차이는 반입 시 company-only adapter/integration으로 분리한다.

## 검증

```bash
node ./scripts/check-syntax.mjs
node ./scripts/skills/manage-skills.mjs verify-source
node --test
dotnet build ./sdk-dotnet/Relu.AI.Bridge.DesktopConnector.sln -c Release -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet run --project ./sdk-dotnet/tests/Relu.AI.Bridge.DesktopConnector.Tests/Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet build ./examples/wpf-android-log-viewer/WpfAndroidLogViewer.Integration.csproj -c Release -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet pack ./sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj -c Release --no-build --output /absolute/release-output/nuget -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false -p:Version=0.7.0 -p:PackageVersion=0.7.0
```

Release/NuGet 공급은 상위 MSBuild 파일이 없는 격리 root에서 수행하고 package inventory,
nuspec ID/version/빈 dependency group과 SHA-256을
[사내 동기화 가이드](docs/INTERNAL_SYNC_KO.md#sdk와-skill-사내-배포)대로 기록한다.

Perfetto overlay 변경 후:

```bash
scripts/perfetto/smoke-test.sh /absolute/work/perfetto-v58.2
scripts/perfetto/verify-integration.sh /absolute/work/perfetto-v58.2
scripts/perfetto/build-test.sh --unit-tests /absolute/work/perfetto-v58.2
scripts/perfetto/build-test.sh --build /absolute/work/perfetto-v58.2
```

## 사내 반입과 반복 개발

외부 RELU release와 회사 integration 결과를 별도 manifest로 관리한다. 외부 bundle은 검역 후 immutable mirror에 import하고, 사내 service connector 설정·hostname·credential·company adapter·실제 데이터는 내부 integration repo에만 둔다.

- [사내 동기화·통합 가이드](docs/INTERNAL_SYNC_KO.md)
- [외부 릴리스 가이드](docs/RELEASE_KO.md)
- [운영 배포](docs/DEPLOYMENT.md)
- [Perfetto overlay 소유 경계](integration/README_KO.md)

## 중요한 보안·운영 제한

- 이 항목의 server/port/token 제한은 Perfetto/browser 중앙 bridge에 관한 것이다. Embedded desktop은 TCP listener를 열지 않는다.
- 중앙 server는 explicit loopback에만 bind한다. 인터넷에 직접 노출하지 않는다.
- service Origin을 connector WebSocket에 추가해도 admin/control CORS는 열리지 않는다.
- DB와 API Capability는 read-only로 시작하고 결과·검색량·timeout을 작게 제한한다.
- Context와 도구 결과를 Claude/Codex가 읽으면 선택한 모델 서비스로 전달될 수 있으므로 회사 AI 정책을 적용한다.
- Context와 connector 결과는 기본 audit/session 파일에 저장하지 않는다. token·authorization·raw 결과도 기록하지 않는다.
- 운영 metadata audit는 기본 활성화하지만 자동 ChatGPT 대화 원문 기록은 기본 비활성이다. 명시적 Goal/handoff만 별도 private 상태로 보존한다.
- `active`는 connector가 자체 보고한 정렬용 hint일 뿐이다. 변경 대상을 active 하나만 보고 자동 선택하지 않는다.
- Mutation 원장에는 raw argument/result 대신 operation ID, argument hash, opaque resource binding과 상태만 저장한다.
- HTTP Data Plane은 설정에 고정된 endpoint만 지원하며 30x redirect를 따르지 않는다.
- Perfetto alignment confidence는 진단값이지 production 정답 보증이 아니다.
- ChatGPT web companion은 선택 기능이다. RELU의 기본 지원 경로는 Claude Code와 로컬 MCP다.
- Chrome Companion은 매 요청마다 실제 Bridge의 일회성 HMAC proof를 먼저 검증하며 control token을 HTTP bearer로 전송하지 않는다.
- 하나의 `dataDir`은 한 Bridge process만 잠글 수 있다. 승인·원장·세션 저장소를 여러 process가 동시에 갱신하는 구성은 거부된다.

## 문서

- [아키텍처](docs/ARCHITECTURE.md)
- [커넥터 개발](docs/CONNECTOR_DEVELOPMENT_KO.md)
- [Windows Desktop Connector·WPF 통합](docs/DESKTOP_CONNECTOR_KO.md)
- [Claude/Codex 분석 Skill](docs/SKILLS_KO.md)
- [보안 모델](docs/SECURITY.md)
- [MCP 도구](docs/TOOLS.md)
- [Claude 설정](docs/CLAUDE_SETUP_KO.md)
- [ChatGPT·Codex 연결](docs/CHATGPT_SETUP.md)
- [정렬 엔진](alignment/README.md)
- [Perfetto Plugin](plugin/README.ko.md)
- [Perfetto Adapter](perfetto_adapter/README.ko.md)
