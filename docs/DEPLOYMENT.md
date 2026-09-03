# RELU AI Bridge 운영 배포

이 문서는 RELU AI Bridge 0.7.0의 두 배포 경로를 구분한다.

- Windows desktop은 EndViewer 단일 executable에 embedded bridge를 포함한다.
- Perfetto/browser와 fixed API는 별도 중앙 bridge를 사용한다.

Desktop 사용자를 중앙 bridge 설치 절차로 안내하거나 browser에 tokenless named pipe를
적용하면 안 된다.

## 배포 단위

1. **Embedded Desktop SDK**: EndViewer build에 포함하는 `net8.0` library
2. **EndViewer application artifact**: GUI/stdio mode, runtime과 분석 instructions를
   포함한 회사 서명 단일 executable
3. **Central RELU core**: Perfetto/browser용 Node.js MCP/Context/Data/approval server
4. **Web Connector SDK**: 사내 browser service build에 포함하는 ESM package
5. **Central Service registry**: browser Origin/schema/endpoint/env 이름을 가진
   company-only config
6. **Central Analysis Skill suite**: Perfetto/browser workflow용 checksum inventory
7. **Perfetto Connector #1 overlay**: plugin과 `PerfettoV58Adapter`를 포함한 UI

외부 release에는 회사 hostname, credential, EndViewer 업무 데이터와 company fork diff를
넣지 않는다. Immutable mirror에 반입한 뒤 사내 integration repo가 signed EndViewer와
central registry/overlay를 각각 만든다.

## 권장 topology

```text
Embedded desktop

Claude/Codex ──stdio──▶ EndViewer.exe <internal MCP mode>
                           │ CurrentUserOnly named pipe
                           ▼
                      EndViewer.exe GUI
                      └─ embedded host + analysis engine

Central Perfetto/browser

Managed browser ──service credential──┐
Perfetto ────────Perfetto credential──┤
                                      ▼
Claude/Codex ───control credential── RELU @ loopback
                                      └─ fixed internal HTTPS APIs
```

Embedded desktop은 Node.js, TCP port, RELU local JSON과 desktop connector credential을
사용하지 않는다. 중앙 bridge는 사용자 PC의 low-privilege account에서 실행하고 여러
사용자의 Context를 공용 server에 모으지 않는다.

같은 중앙 `dataDir`에는 정확히 하나의 RELU process만 실행한다. Core instance lock을
지키며 systemd/launchd와 수동 `serve`를 동시에 시작하지 않는다.

## 설정 소유권

- Desktop product owner: embedded service definition, Capability/schema/effect,
  MCP `2025-06-18` `initialize` `instructions`, WPF lifecycle와 stable launcher
- Desktop platform/security: signing, installer/update chain, path ACL, `CurrentUserOnly`
  pipe, managed MCP 등록
- Central platform/security: base config, approval policy, browser Origin/credential
  audience, egress endpoint와 OS sandbox
- Browser service owner: bounded handler/API, output schema, service/API credential
- Perfetto owner: v58 adapter, feature SQL와 alignment acceptance
- AI governance: Claude/Codex workspace와 데이터 등급 허용 범위

Git 금지 항목은 중앙 `config/local.json`, 모든 실제 credential, audit/dataDir, 실제
Context/result/trace, EndViewer 로그와 internal hostname이 포함된 manifest다.

## Embedded Windows EndViewer 배포

이 저장소의 desktop deliverable은 SDK와 WPF integration skeleton이다. 실제 EndViewer
source/분석 엔진/installer/signing material/완성 exe는 회사 내부 product repository와
Windows release pipeline이 소유한다.

### Build 구성

EndViewer application은 release `relu-ai-bridge-v0.7.0`의 .NET SDK를 NuGet 또는 reviewed
project reference로 고정한다. 최종 사용자가 package를 설치하는 것이 아니라 application
build가 이를 포함한다.

```powershell
dotnet build C:\Company\relu-ai-bridge\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet run --project C:\Company\relu-ai-bridge\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet build C:\Company\relu-ai-bridge\examples\wpf-android-log-viewer\WpfAndroidLogViewer.Integration.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet pack C:\Company\relu-ai-bridge\sdk-dotnet\src\Relu.AI.Bridge.DesktopConnector\Relu.AI.Bridge.DesktopConnector.csproj -c Release --no-build --output C:\Company\release-out\nuget `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false `
  -p:Version=0.7.0 -p:PackageVersion=0.7.0
```

실제 EndViewer `WinExe` project는 custom `[STAThread] Program.Main`을
`StartupObject`로 지정해 `--relu-mcp-stdio`를 WPF 생성 전에 분기한다. `SelfContained`와
`PublishSingleFile`을 켜고 WPF trimming은 명시적으로 끈다.

```xml
<PropertyGroup>
  <StartupObject>Company.EndViewer.Program</StartupObject>
  <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
  <SelfContained>true</SelfContained>
  <PublishSingleFile>true</PublishSingleFile>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
  <PublishTrimmed>false</PublishTrimmed>
</PropertyGroup>
```

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

Custom `Main`, `StartAsync`, selection-completed와 종료 `DisposeAsync`의 최소 골격은
[WPF Android Log Viewer 예제](../examples/wpf-android-log-viewer/README_KO.md)를 따른다.

EndViewer composition root는 다음 역할을 연결한다.

- `ReluEmbeddedBridgeHost`: GUI process의 Context/Capability와 named pipe
- `ReluMcpStdioEntryPoint`: 같은 exe의 internal stdio MCP mode
- `ReluAiClientRegistrar`: Claude Code/Codex user-scope 공식 CLI 등록·검증

User-scope 등록은 같은 Windows 계정의 모든 Claude Code/Codex 프로젝트에 보이므로 승인된
프로젝트/데이터 분류에서만 사용한다. 프로젝트 격리가 필요한 장비는 managed MCP 정책을
사용한다. GUI host는 사용자별 단일 instance로 운영하고, selection 전 Context/분석
요청은 `CONTEXT_UNAVAILABLE`이어야 한다.

분석 절차는 embedded service definition의 MCP `2025-06-18` `initialize` 응답으로 컴파일한다.
Desktop용 Skill을 별도 설치하지 않는다.

### Packaging과 등록

1. EndViewer와 필요한 runtime을 회사 표준 single-exe artifact로 publish한다.
2. Authenticode/publisher와 update manifest를 서명한다.
3. 일반 사용자가 쓸 수 없고 관리자/installer만 쓸 수 있는 안정된 launcher 경로에
   설치한다.
4. GUI/stdio mode가 같은 signed binary에서 시작되는지 확인한다.
5. Named pipe가 `CurrentUserOnly`이고 peer PID의 OS 보고 process image를
   `Path.GetFullPath`로 정규화한 값이 현재 EndViewer 경로와 다를 때 양방향 연결을
   거부하는지 확인한다.
6. 일반 사용자 권한의 최초 GUI 실행이 Authenticode/publisher를 검증한 Claude/Codex만
   탐지해 user-scope 등록을 조회·추가·재조회하는지 확인한다. 관리자 실행과 임의
   `PATH` executable은 자동 등록하지 않아야 한다.
7. 다른 executable이 소유한 같은 MCP 이름을 덮어쓰지 않는지 확인한다.
8. 등록 전에 이미 실행 중이던 AI client에는 한 번 restart/reload가 필요함을 안내한다.

AI client는 등록 command를 자체 user 설정에 보관하지만 사용자가 JSON/TOML이나 project
`.mcp.json`을 만들지 않는다. Exclusive managed MCP 환경에서는 registrar가 정책을
우회하지 않으며 IT가 안정된 EndViewer 경로와 internal stdio mode를 사전 등록한다.

Desktop에서는 legacy desktop service JSON/auth vector를 배포하거나 참조하지 않는다.
Desktop token, HMAC vector, stable instance credential과 중앙 desktop WebSocket 절차도
없다.

### Runtime 운영

사용자는 `EndViewer.exe`만 실행한다. 별도 daemon/service를 시작하지 않는다. GUI host가
없으면 stdio endpoint는 `APPLICATION_NOT_RUNNING`으로 실패하고 중앙 bridge나 임의 port로
fallback하지 않는다. 앱 종료 시 in-flight request를 취소하고 pipe를 닫는다.

Context에는 opaque dataset/selection과 bounded metadata만 두고 전체 로그와 사용자 경로를
넣지 않는다. Handler 전후 selection guard, cancellation, item/전체 JSON byte 상한을
항상 적용한다. 기본 Capability는 read-only다. Mutation을 추가하려면 별도 operation ID,
deduplication과 ambiguous-result interlock을 보안 검토한다.

## 중앙 bridge Credential 주입

이 절은 Perfetto/browser 중앙 bridge에만 적용된다.

항상 필요한 값:

```text
RELU_AI_BRIDGE_CONFIG=/approved/path/config.json
RELU_AI_BRIDGE_TOKEN=<control credential>
```

`perfetto.enabled:true`인 장비:

```text
RELU_PERFETTO_CONNECTOR_TOKEN=<Perfetto connector credential>
```

Browser/API service 예:

```text
RELU_BATTERY_CONNECTOR_TOKEN=<browser connector credential>
RELU_WIKI_CONNECTOR_TOKEN=<browser connector credential>
RELU_WIKI_API_AUTHORIZATION=<bridge-to-API credential>
```

Control, Perfetto, browser service와 API credential은 서로 달라야 한다. Launch argument와
일반 shell history 대신 secret manager, systemd credential 또는 managed wrapper를
사용한다.

## 중앙 macOS/Linux/Windows service

macOS는 `deploy/launchd/com.company.relu-ai-bridge.plist.example`, Linux는
`deploy/systemd/relu-ai-bridge.service.example`을 검토한다. Wrapper/service는 다음을
지킨다.

- 검토된 Node와 RELU entrypoint의 절대 경로 사용
- company secret manager에서 중앙 credential 주입
- Context/result/credential을 stdout/stderr에 출력하지 않음
- dataDir과 승인 project만 write 허용
- 시작 뒤 PID/port ownership과 `http://127.0.0.1:5746/health` 확인

Windows에서 중앙 Perfetto/browser bridge까지 운영하는 장비만 회사 service
manager/Task Scheduler로 Node process를 시작한다. 이 과정은 embedded EndViewer 실행과
별개다. Perfetto overlay/release Bash script는 WSL 또는 승인된 Linux worker를 사용한다.

## Browser Connector rollout

1. Central registry schema와 exact browser Origin을 review한다.
2. Browser service 전용 connector credential을 발급한다.
3. Read-only Capability부터 활성화한다.
4. Synthetic data로 origin/audience/schema/timeout을 검증한다.
5. 소수 사용자 canary에서 session과 active policy를 확인한다.
6. Context/result가 audit/dataDir에 저장되지 않는지 marker scan한다.
7. 필요한 좁은 mutation만 `operationId`와 함께 추가한다.

Schema/effect hash가 바뀌면 새 approval scope다. `manual`에서는 재승인하고
`trusted_always`에서도 새 schema/effect와 Context guard를 검사한다.

## 중앙 Connector `policyEpoch`과 operation ledger

`connectors.policyEpoch`는 중앙 approval scope와 mutation operation key에 들어간다. 값을
올리면 모든 중앙 Connector grant가 무효화되고 새 operation namespace가 열린다. 장비별
단조 증가 값이며 rollback에서도 낮추지 않는다.

Connector peer는 browser handshake에서 server가 관찰한 exact Origin이다. Page binding과
`bindingFields` resource가 실제 대상을 묶는다. Embedded desktop은 이 중앙 ledger나
approval JSON을 사용하지 않는다.

원장이 비어 있지 않으면 다음 절차를 사용한다.

1. 현재 epoch와 `dataDir`을 기록하고 모든 pending/ambiguous operation을 판정한다.
2. 같은 `dataDir`의 중앙 RELU process를 모두 중지한다.
3. 검토한 config의 `connectors.policyEpoch`를 더 큰 값으로 바꾼다.
4. 평소와 같은 중앙 config/credential 환경에서 maintenance 명령을 실행한다.

```bash
export RELU_AI_BRIDGE_CONFIG=/absolute/path/to/relu-config.json
# 중앙 control/Perfetto/browser/API credential도 평소의 secret wrapper로 주입
node /absolute/path/to/relu-ai-bridge/bin/relu-ai-bridge.mjs archive-ledger
```

명령은 live lock, schema/record ID, terminal-only 상태와 epoch 증가를 확인한 뒤 private
archive를 만들고 새 빈 ledger로 교체한다. Archive의 canonical content digest, 경로,
record 수와 epoch 전환을 접근 통제된 변경 티켓에 기록한다. Raw argument/result는
archive하지 않는다. 원장 파일을 직접 삭제하거나 epoch를 감소시키지 않는다.

## 중앙 Local coding 권한

초기 설정은 file write, command, Goal loop와 multi-agent를 끈다. Write는 root별
`readOnly:false`와 `permissions.write:true`를 함께 검토한다. Command는 승인된 profile,
timeout, concurrency와 immutable wrapper가 필요하다. `cwd` containment는 OS sandbox가
아니므로 mutable repository script는 low-privilege account/container 안에서만 실행한다.

## Perfetto UI 배포

Perfetto v58.2 도구 체인은 Python 3.10 이상을 요구한다. 여러 Python이 있으면
`EMSDK_PYTHON`으로 정확한 executable을 지정한다. macOS ARM64 worker는 Rosetta 2 또는
Java 11 이상 runtime도 준비한다.

```bash
scripts/perfetto/bootstrap.sh /absolute/work/perfetto-v58.2
scripts/perfetto/integrate.sh --mode copy /absolute/work/perfetto-v58.2
scripts/perfetto/verify-integration.sh /absolute/work/perfetto-v58.2
scripts/perfetto/build-test.sh --all-tests /absolute/work/perfetto-v58.2
```

사내 Origin은 `perfetto.allowedOrigins`에 exact origin으로 추가한다. Production build
hash, RELU tag, connector manifest와 company Perfetto full SHA를 함께 기록한다.

## Upgrade checklist

1. RELU `relu-ai-bridge-v0.7.0` tag/commit과 release manifest/hash 검증
2. 전체 Node/central browser 회귀 검증
3. Perfetto/browser 중앙 Skill source/checksum 검증
4. .NET Release build와 NuGet 0.7.0 inventory 검사
5. EndViewer single-exe GUI/stdio mode와 embedded `initialize` `instructions` 검증
6. Claude/Codex user-scope idempotent 등록, 충돌 보존과 최초 1회 reload 검증
7. Managed MCP의 IT 사전 등록과 stable signed launcher 검증
8. `CurrentUserOnly` pipe의 cross-user 거부, GUI 종료/재시작/reconnect 검증
9. Desktop selection cancellation, handler 전후 guard와 bounded result 검증
10. 중앙 control/Perfetto/browser credential cross-audience 거부 확인
11. 중앙 schema/effect/policyEpoch diff와 exact Perfetto v58.2 검증
12. Read-only canary 뒤 production 확대

## Rollback

- EndViewer: 직전 검증된 signed single-exe artifact로 배포 pointer를 되돌린다. Registrar가
  stable launcher를 계속 가리키는지 확인한다.
- Embedded registration: 앱이 소유한 user-scope 항목만 repair/remove하며 다른 MCP
  항목을 변경하지 않는다. Managed 항목은 IT change로만 수정한다.
- Central core: 직전 검증된 RELU tag artifact/config로 되돌리고 process를 재시작한다.
- Browser Connector: service build와 registry entry를 함께 복구한다.
- Central credential: 의심 audience 값만 회전한다.
- Perfetto: 직전 integration manifest의 immutable UI artifact로 복귀한다.
- Policy epoch: 이미 사용한 값보다 낮추지 않고 archive를 유지한다.
- Mirror: history rewrite 없이 deprecated/deny metadata로 관리한다.

Rollback 뒤에도 release tag, internal mirror commit, signed EndViewer, 중앙 registry,
company Perfetto target과 배포 artifact hash의 관계가 감사 가능해야 한다.
