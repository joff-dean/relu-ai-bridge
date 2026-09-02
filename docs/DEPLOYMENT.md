# RELU AI Bridge 운영 배포

## 배포 단위

1. **RELU core**: Node.js MCP/Context/Data/approval server
2. **Web Connector SDK**: 각 사내 웹서비스 build에 포함하는 작은 ESM package
3. **.NET Desktop Connector SDK**: Windows 분석 프로그램에 포함하는 net8.0 library
4. **Analysis Skill suite**: Claude/Codex에 복사하는 checksum inventory와 Markdown
5. **Service registry**: 내부 Origin/app ID/schema/endpoint/env 이름을 포함한 company-only config
6. **Perfetto Connector #1 overlay**: plugin과 `PerfettoAdapterV57`을 포함해 빌드한 UI

외부 release에는 회사 hostname, credential과 company fork diff를 넣지 않는다. Immutable internal mirror에 반입한 뒤 integration repo가 service registry와 overlay를 결합한다.

## 권장 topology

```text
Managed browser ── service token ──┐
Windows analyzer ─ desktop token ──┤
                                  ▼
Claude/Codex ── control token ── RELU @ loopback
                                  │
                                  ├─ Perfetto 전용 token + browser Data Plane
                                  └─ fixed internal HTTPS APIs
```

RELU는 사용자 PC의 low-privilege account로 실행한다. 중앙 공용 RELU server로 여러 사용자의 Context를 모으지 않는다. Loopback MCP를 cloud client에 연결해야 한다면 회사가 승인한 tunnel을 별도 credential로 운영한다.

같은 `dataDir`에는 정확히 하나의 RELU process만 실행한다. Core가 instance lock으로
이를 강제하므로 systemd/launchd와 수동 `serve`를 동시에 시작하지 않는다. 종료 후
새 process를 시작해 lock ownership과 저장소 flush 순서를 보존한다.

## 설정 소유권

- Platform/security: base config, service Origin/token audience, Capability/effect/schema, egress endpoint, OS sandbox
- Service owner: bounded handler/API, output schema, service/API secret, rollout/rollback
- Perfetto owner: v57 adapter, feature SQL, alignment acceptance
- End user: once/session/always grant와 revoke
- AI governance: Claude/workspace와 데이터 등급 허용 범위

Git 금지 항목: `config/local.json`, 모든 token/API credential, audit/dataDir, 실제 Context/result/trace와 internal hostname이 포함된 integration manifest.

## Secret 주입

항상 필요한 control:

```text
RELU_AI_BRIDGE_CONFIG=/approved/path/config.json
RELU_AI_BRIDGE_TOKEN=<control secret>
```

`perfetto.enabled:true`인 장비에서만 다음 값도 필수다.

```text
RELU_PERFETTO_CONNECTOR_TOKEN=<Perfetto connector secret>
```

Service마다:

```text
RELU_BATTERY_CONNECTOR_TOKEN=<browser connector secret>
RELU_WIKI_CONNECTOR_TOKEN=<browser connector secret>
RELU_WIKI_API_AUTHORIZATION=<Bridge-to-API credential>
RELU_ANDROID_LOG_VIEWER_TOKEN=<desktop connector secret>
```

Control, Perfetto, service, API credential은 모두 서로 달라야 한다. Launch argument와 일반 shell history보다 secret manager, systemd credential, managed wrapper를 사용한다.

## macOS launchd

`deploy/launchd/com.company.relu-ai-bridge.plist.example`의 wrapper/config 경로를
바꾼다. Template에는 token이 없고 Node를 직접 실행하지 않는다. Wrapper는 회사가
소유한 절대경로 파일이어야 하며 다음 계약을 지킨다.

1. 소유자 외 쓰기를 금지하고(권장 mode `0700`) 저장소 checkout 안에 두지 않는다.
2. 회사 secret manager에서 control token과, 활성화한 경우 Perfetto/service/API
   credential을 읽어 환경변수로 export한다.
3. secret이나 Context를 stdout/stderr에 출력하지 않는다.
4. 마지막에는 `exec /absolute/path/to/node /absolute/path/to/relu-ai-bridge/bin/relu-ai-bridge.mjs serve`로 process를 교체한다.

Wrapper를 먼저 같은 사용자로 수동 검증한 뒤 launchd에 등록한다. `StandardOutPath`
와 `StandardErrorPath`도 `/tmp` 대신 접근 통제·rotation이 적용된 절대경로로 바꾼다.

```bash
launchctl print gui/$(id -u)/com.company.relu-ai-bridge
curl --fail http://127.0.0.1:5746/health
```

`StandardOutPath`에는 Context/result를 쓰지 않는다. Log directory의 회사 정책과 rotation을 적용한다.

## Linux systemd

`deploy/systemd/relu-ai-bridge.service.example`을 검토한다.

```bash
systemctl --user daemon-reload
systemctl --user enable --now relu-ai-bridge.service
systemctl --user status relu-ai-bridge.service
```

`ReadWritePaths`는 dataDir과 실제로 write 승인할 project만 둔다. 가능하면 `EnvironmentFile` 대신 systemd credentials 또는 회사 secret agent를 사용한다.

## Windows

Standard user의 회사 service manager/Task Scheduler로 실행한다.

```powershell
node C:\Company\relu-ai-bridge\bin\relu-ai-bridge.mjs doctor
node C:\Company\relu-ai-bridge\bin\relu-ai-bridge.mjs serve
```

`RELU_AI_BRIDGE_CONFIG`, `RELU_AI_BRIDGE_TOKEN`, `RELU_PERFETTO_CONNECTOR_TOKEN`과 service/API credential은 승인된 Windows credential solution에서 주입한다. Perfetto overlay/release Bash script는 WSL 또는 승인된 Linux worker를 사용한다.

WPF Connector를 배포하는 장비에서는 .NET 8 SDK/runtime compatibility를 사전 검증하고
같은 RELU release의 `sdk-dotnet/`을 사내 NuGet registry 또는 source reference로 고정한다.
상위 `Directory.Build.props/targets`가 없는 승인된 격리 root에서 실행하고 자동 import도
명시적으로 끈다.

```powershell
dotnet build C:\Company\relu-ai-bridge\sdk-dotnet\Relu.AI.Bridge.DesktopConnector.sln -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet run --project C:\Company\relu-ai-bridge\sdk-dotnet\tests\Relu.AI.Bridge.DesktopConnector.Tests\Relu.AI.Bridge.DesktopConnector.Tests.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet build C:\Company\relu-ai-bridge\examples\wpf-android-log-viewer\WpfAndroidLogViewer.Integration.csproj -c Release `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false
dotnet pack C:\Company\relu-ai-bridge\sdk-dotnet\src\Relu.AI.Bridge.DesktopConnector\Relu.AI.Bridge.DesktopConnector.csproj -c Release --no-build --output C:\Company\release-out\nuget `
  -p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false `
  -p:Version=0.4.0 -p:PackageVersion=0.4.0
powershell.exe -NoProfile -File C:\Company\relu-ai-bridge\scripts\skills\install-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\Work\AndroidAnalysis
powershell.exe -NoProfile -File C:\Company\relu-ai-bridge\scripts\skills\verify-skills.ps1 `
  -Scope project -Target both -ProjectPath C:\Work\AndroidAnalysis
```

Feed publish 전 package inventory, nuspec의 exact ID/version과 빈 dependency group,
SHA-256을 [사내 동기화 가이드](INTERNAL_SYNC_KO.md#sdk와-skill-사내-배포)대로 확인한다.

Stable application instance ID는 token과 분리한 current-user ACL의 app data로 관리한다.
Resume secret은 process memory 밖에 저장하지 않는다. Desktop endpoint, WPF integration과
Skill 공급 경계는 [Desktop Connector 설계](DESKTOP_CONNECTOR_KO.md)와
[Skill 설계](SKILLS_KO.md)를 따른다.

## Connector rollout

1. Registry schema와 browser exact Origin 또는 desktop exact app ID 하나를 review한다.
2. Service 전용 connector token을 생성한다.
3. Read-only Capability만 활성화한다.
4. Synthetic data와 `node --test test/connectors.test.mjs` 패턴으로 token/Origin 또는 app identity/schema/timeout을 검증한다.
5. 소수 사용자 canary에서 `/admin/`의 session/approval 흐름을 확인한다.
6. Context/result가 audit/dataDir에 저장되지 않는지 marker scan한다.
7. 필요할 때 좁은 UI mutation을 `operationId`와 함께 추가한다.
8. Data/external mutation은 별도 보안 review 뒤에만 활성화한다.

Registry의 schema/effect hash가 바뀐 Capability는 자체적으로 재승인이 필요하다.
모든 Connector grant와 mutation ID namespace를 함께 교체해야 하는 검토된 정책 변경만
`connectors.policyEpoch`를 증가시킨다.

## Connector `policyEpoch`과 operation ledger 보관

`connectors.policyEpoch`는 단순 version label이 아니다. 값은 approval scope와 mutation
operation key/ID에 모두 들어간다. 값을 올리면 모든 Connector grant가 무효화되고,
보관된 이전 세대와 분리된 새 operation ID namespace가 열린다. 값은 장비별로 **단조
증가**해야 하며 rollback에서도 낮추지 않는다.

승인·원장에서 connector peer는 browser의 server-observed exact Origin 또는 desktop
app ID에서 도출한 `relu-desktop://<sha256>` opaque trust-domain key다. 원장 JSON의
호환 필드명은 `origin`이지만 desktop record에 app ID 원문을 저장하지 않는다. 별도의
page/application-instance binding과 `bindingFields` resource가 실제 대상을 묶는다.

원장이 비어 있지 않으면 다음 승인된 변경 절차를 사용한다.

1. 현재 epoch `N`과 `dataDir`을 기록한다. `/admin/` 변경 작업 원장에서 `pending` 작업이
   끝날 때까지 기다리고 `ambiguous` 작업은 실제 대상 상태를 확인한 뒤 별도 local once
   승인으로 판정한다.
2. RELU AI Bridge와 같은 `dataDir`을 쓰는 모든 process를 중지한다. 명령은
   `.instance-lock`이 있으면 실행을 거부하므로 live daemon과 병행할 수 없다.
3. 검토한 config의 `connectors.policyEpoch`를 `N`보다 큰 값으로 바꾼다. 감소나 기존 값
   재사용은 금지한다.
4. 평소 Bridge를 시작할 때와 같은 `RELU_AI_BRIDGE_CONFIG` 및 필수 secret 환경을
   주입해 maintenance 명령을 실행한다.

```bash
export RELU_AI_BRIDGE_CONFIG=/absolute/path/to/relu-config.json
# Control/Perfetto/service/API secret도 평소와 같은 secret wrapper로 주입
node /absolute/path/to/relu-ai-bridge/bin/relu-ai-bridge.mjs archive-ledger
```

명령은 다음 조건을 모두 만족할 때만 진행한다.

- 기존 `connector-operations.json`이 지원하는 v1/v2 schema, 최대 32 MiB/4,096
  records와 record ID 검증을 통과한다.
- 모든 record가 `completed`, `completed_no_result`, `confirmed_applied`, `failed` 중
  하나다. `pending` 또는 `ambiguous`가 하나라도 있으면 아무것도 reset하지 않는다.
- config의 새 epoch가 원장 epoch보다 크다.

성공하면 `dataDir/connector-operation-archives/`에 mode `0600` archive를 exclusive하게
생성하고 file sync·재읽기 검증을 마친 다음, live 원장을 sync한 임시 파일에서 새
epoch의 빈 v2 문서로 원자 교체한다. POSIX에서는 각 단계의 directory entry도 sync하며,
directory sync를 제공하지 않는 지원 platform에서는 file sync와 atomic rename으로
fallback한다.
출력되는 SHA-256은 archive 파일 자체의 byte hash가 아니라 보관된 ledger JSON의
canonical content digest다. Archive 경로, `N → 새 epoch`, record 수와 digest를 접근
통제된 변경 티켓/감사 시스템에 저장한 후 Bridge를 재시작하고 기존 grant가 다시
요청되는지 확인한다. Archive에는 raw argument/result는 없지만 service/connector peer,
capability, operation ID, hash와 timestamp metadata가 있으므로 `dataDir`과 같은 등급으로
보호하고 retention 정책을 적용한다.

원장이 비어 있으면 `archive-ledger`는 `no archival is required`로 종료한다. 이 경우
archive를 만들지 않고 새 epoch config로 Bridge를 시작할 수 있다. `pending`이 disk에
남은 crash 상황에서는 JSON을 편집하지 말고 기존 epoch로 Bridge를 다시 시작해
`ambiguous`로 복구한 뒤 Admin에서 판정한다. 실패·중단 시 원장이나 archive를 수동
삭제하지 말고 원인을 해결한 뒤 같은 절차를 다시 수행한다.

## Local coding 권한 opt-in

초기 설정은 파일 write, command, Goal loop와 multi-agent를 끈다. Write가 필요하면
root별 `readOnly:false`와 `permissions.write:true`를 함께 검토한다. Command는
`permissions.commands:true`만 켜서는 사용할 수 없고 승인된 profile도 필요하다.
Command profile에는 업무에 필요한 최소 timeout을 지정하고 전역/root별 concurrency,
kill grace와 완료 session TTL 기본 상한을 완화하지 않는다.
Command의 `cwd`는 sandbox가 아니므로 mutable repository script를 실행하는 profile은
전용 OS account/container 또는 egress·filesystem을 제한한 immutable wrapper에서만
운영한다. `allowArbitraryCommands`는 production에서 계속 `false`로 둔다.

## Perfetto UI 배포

```bash
scripts/perfetto/bootstrap.sh /absolute/work/perfetto-v57.2
scripts/perfetto/integrate.sh --mode copy /absolute/work/perfetto-v57.2
scripts/perfetto/verify-integration.sh /absolute/work/perfetto-v57.2
scripts/perfetto/build-test.sh --all-tests /absolute/work/perfetto-v57.2
```

사내 origin은 `perfetto.allowedOrigins`에 exact origin으로 추가한다. Wildcard/path는 허용하지 않는다. Production build hash, RELU tag, connector compatibility manifest와 company Perfetto full SHA를 함께 기록한다.

## Upgrade checklist

1. RELU core tag/commit과 release manifest/hash 검증
2. `node ./scripts/check-syntax.mjs && node --test`
3. `manage-skills.mjs verify-source`와 Claude/Codex 임시 project 설치·검증·제거
4. `.NET 8` Release build, shared desktop HMAC vector test, `net8.0-windows` WPF 예제
   build와 NuGet pack/README/LICENSE inventory 검사
5. Control/Perfetto/browser/desktop service token cross-audience 401/WS 거부 확인
6. Registry input/output schema, execution guard와 effect/policyEpoch diff review
7. Service별 bounded load/timeout/cancellation test
8. once/session/always/deny/revoke와 browser reload/desktop restart isolation test
9. Exact Perfetto v57.2 overlay unit/type/build test
10. Internal manifest에 core/connector/company target full SHA 기록
11. Read-only canary 후 production 확대

## Rollback

- Core: 직전 검증된 RELU tag artifact로 되돌리고 process 재시작
- Connector: service build와 registry entry를 함께 직전 버전으로 복구
- Credential: 의심 service token/API secret만 즉시 회전; control 침해면 전체 grant도 철회
- Perfetto: 직전 integration manifest의 immutable UI artifact로 복귀
- Mirror: history rewrite 없이 deprecated/deny metadata로 관리
- Approval: 문제 grant 철회 또는 검토 후 `approvals.json` 전체 초기화
- Policy epoch: 이미 사용한 값보다 낮추지 않는다. Core rollback에도 현재의 더 높은 `connectors.policyEpoch`와 archive를 유지한다.

Rollback 뒤에도 외부 tag, internal mirror commit, company target, registry version과 배포 artifact hash의 관계가 감사 가능해야 한다.
