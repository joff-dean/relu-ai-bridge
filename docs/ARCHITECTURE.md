# RELU AI Bridge 아키텍처

RELU AI Bridge 0.7.0은 하나의 transport를 모든 대상에 강요하지 않는다. Windows desktop
앱은 application 안에 bridge를 포함하는 embedded 경로를 사용하고, Perfetto/browser와
사내 HTTP API는 별도 중앙 bridge 경로를 사용한다.

## 두 실행 토폴로지

```text
A. Embedded desktop

Claude / Codex ──stdio──▶ EndViewer.exe <internal MCP mode>
                              │ CurrentUserOnly named pipe
                              ▼
                         EndViewer.exe GUI process
                         ├─ ReluEmbeddedBridgeHost
                         ├─ live selection Context
                         └─ existing analysis engine

B. Central Perfetto/browser bridge

Claude / Codex ──authenticated HTTP MCP──▶ RELU AI Bridge @ loopback
Browser/Perfetto ──origin-bound WS────────▶ session/capability registry
Fixed API       ◀──allowlisted HTTPS───────┘
```

두 경로는 Context/Capability/stale-target 원칙을 공유하지만 process와 credential 경계가
다르다.

| 항목 | Embedded desktop | 중앙 Perfetto/browser |
| --- | --- | --- |
| 배포 | EndViewer 단일 실행 파일에 포함 | RELU server를 별도 배포 |
| MCP transport | stdio | Streamable HTTP |
| app 연결 | `CurrentUserOnly` named pipe | loopback WebSocket/HTTPS |
| Node.js | 필요 없음 | 필요 |
| RELU local JSON/port | 없음 | 있음 |
| 연결 credential | 없음 | audience별 credential |
| Capability authority | 서명된 app binary/source | server-owned registry config |

Desktop 앱을 중앙 `/relu/desktop/ws`에 연결하는 이전 토폴로지는 지원하지 않는다.
Desktop token과 외부 service JSON도 사용하지 않는다.

## Embedded desktop 경로

### Process 역할

EndViewer는 한 실행 파일 안에서 두 mode를 제공한다.

1. **GUI mode**: WPF와 분석 엔진을 시작하고 `ReluEmbeddedBridgeHost`가 live Context,
   Capability와 named pipe를 소유한다.
2. **MCP stdio mode**: WPF window를 만들지 않고 `ReluMcpStdioEntryPoint`가 Claude/Codex의
   stdio frame을 named pipe request로 중계한다.

`ReluAiClientRegistrar`는 GUI 최초 실행 시 설치된 Claude Code/Codex CLI를 각각 찾아
공식 조회/등록 명령으로 같은 executable의 stdio mode를 user scope에 추가한다. AI
client 설정 파일을 직접 편집하지 않으며 다른 executable이 소유한 같은 이름을
덮어쓰지 않는다.

User-scope 등록은 같은 Windows 계정의 모든 Claude Code/Codex 프로젝트에 보인다.
EndViewer가 실행 중이면 그 프로젝트들도 현재 선택의 read-only 도구를 호출할 수 있고,
`active`는 권한 경계가 아니다. 공용 OS 계정을 쓰지 않으며 프로젝트별 격리가 필요한
조직은 managed MCP allowlist로 범위를 제한한다.

Pipe의 첫 instance는 사용자별 GUI host 하나가 독점한다. 실제 EndViewer는 단일 GUI
instance를 강제하거나 두 번째 instance의 bridge 충돌을 안전한 상태로 처리해야 한다.

최초 등록 전에 이미 실행된 AI client는 server 목록을 캐시할 수 있어 한 번의
restart/reload가 필요하다. 이는 MCP server가 이미 실행 중인 client 설정을 임의로
hot-patch할 수 없다는 client lifecycle 제한이다. Exclusive managed MCP 환경에서는
registrar가 정책을 우회하지 않고 IT가 안정된 서명 경로를 사전 등록한다.

### Desktop Context와 Capability

GUI process는 한 EndViewer instance를 live session으로 취급한다. Context에는 다음처럼
현재 분석 대상을 식별하는 최소 값만 둔다.

```text
opaque log resource ID
dataset revision
selection ID + revision
selection start/end + timebase
bounded parser/filter metadata
```

아직 로그/구간 선택이 없으면 host와 등록은 유지하되 Context/분석 호출은
`CONTEXT_UNAVAILABLE`로 실패한다. 첫 확정 selection 뒤 같은 session에서 분석 가능
상태가 된다. 가짜 기본 구간이나 이전 dataset의 selection을 재사용하지 않는다.

Capability 이름, 설명, input/output schema, effect, timeout, concurrency, 결과 상한과
분석 instructions는 EndViewer의 검토된 service definition/source/binary에 고정한다.
Instructions는 MCP `2025-06-18` `initialize` 응답에 컴파일되므로 desktop에 별도 Skill 설치가
없다. AI argument, 로그 본문 또는 runtime JSON이 Capability나 instructions를 바꿀 수
없다. Handler는 기존 domain/application service를 직접 호출하며 UI Automation, screen
scraping, reflection target 또는 arbitrary assembly loading을 사용하지 않는다.

실행 순서:

```text
MCP tool call
  → embedded fixed capability/schema validation
  → live dataset/selection projection snapshot
  → named pipe dispatch
  → handler 직전 projection 재검사
  → bounded analysis engine + cancellation
  → handler 완료 뒤 projection 재검사
  → bounded result
```

선택이 바뀌면 in-flight read를 취소하고 stale 결과를 반환하지 않는다. 기본 desktop
Capability는 read-only여서 RELU approval prompt 없이 실행한다. 향후 mutation을 추가할
때는 operation ID, durable deduplication, preview와 ambiguous-result reconciliation을
embedded host에 별도로 구현해야 한다.

### Desktop trust boundary

Named pipe 이름은 `Windows 사용자 SID + serviceId`의 domain-separated SHA-256으로
사용자별 분리하고 원문 SID는 노출하지 않는다. Pipe는 `CurrentUserOnly`로 생성하고
TCP listener를 열지 않는다. stdio process는
AI client가 등록된 EndViewer 절대 경로에서 실행한다. GUI host가 없으면
`APPLICATION_NOT_RUNNING`으로 실패하며 중앙 server나 임의 port로 fallback하지 않는다.

이 구조가 desktop bearer token을 필요 없게 하지만 같은 Windows 사용자 전체를 강하게
분리하지는 않는다. EndViewer/AuthentiCode 서명, 안정된 launcher 경로 ACL, update
manifest와 application allowlisting이 배포 신뢰의 일부다.

## 중앙 Context Plane

이하 절은 Perfetto/browser 중앙 bridge에만 적용된다.

Browser SDK는 연결 시 service ID와 fresh client nonce를 보내고, bridge는 exact Origin,
service와 audience별 connector credential로 server proof를 만든다. Client가 proof를
확인한 뒤에만 registration과 Context를 전송한다. Client proof는 canonical registration
digest를 포함하며 raw credential은 WebSocket message에 들어가지 않는다.

중앙 registration은 다음을 포함한다.

- service ID와 connector version
- page-load random client ID
- registry에 이미 존재하는 Capability 구현 목록
- `contextSchema`를 통과한 Context
- focus/visibility hint
- reconnect 동안만 메모리에 유지하는 resume 값

Bridge는 exact Origin, proof, duplicate-key 없는 JSON, schema/size와 registry 교집합을
검증한 뒤 session을 만든다. Context는 기본적으로 메모리에만 존재하며 public session
목록은 원문/title/URL 대신 opaque key와 Capability 이름만 반환한다.

`bindingFields`는 resource scope를 만들고 execution guard는 빠르게 변하는 selection을
묶는다. Policy 통과 후 target snapshot을 다시 확인하고 browser handler도 dispatch 직전
live projection을 비교한다.

## 중앙 Capability Registry와 Data Plane

중앙 registry는 config의 `connectors.services[]`에서 만들어진다.

```text
service ID + exact origins + connector audience
capability ID + description
input/output schema + effect
timeout + concurrency + result byte limit
transport(browser | http)
fixed endpoint/method/auth-env (HTTP only)
```

Browser registration은 구현 목록을 좁힐 수만 있고 schema/effect/endpoint를 넓힐 수 없다.
미지원 schema keyword는 startup 오류다. Input과 output 모두 byte/depth/node/string/array
제한을 통과해야 한다.

### Browser transport

```text
execute
  → registry/schema/effect/local policy
  → browser WebSocket request + Context guard
  → static browser handler
  → bounded result
```

### HTTP transport

```text
execute
  → exact config URL + GET/POST
  → bridge가 auth env 주입
  → redirect 거부
  → JSON/size/output schema 검증
```

AI/browser는 URL, method, header 또는 credential을 선택하거나 읽을 수 없다. 임의 URL,
script, selector, command proxy는 없다.

## MCP Plane

Embedded와 중앙 경로 모두 핵심 discovery contract를 제공한다.

```text
list_sessions
get_context
list_capabilities
execute
```

Embedded stdio에서는 현재 EndViewer session과 고정 desktop Capability만 보인다. 중앙
`/mcp`에서는 연결된 browser/API session, Perfetto 전용 도구와 선택적 local coding
도구가 보인다. 한 transport에서 다른 transport의 session을 암묵적으로 proxy하지 않는다.

## 승인과 mutation

Embedded desktop 기본 Capability는 read-only이고 즉시 실행한다. Capability/schema와
result 제한, same-user pipe, stale-selection guard는 승인 UI가 없어도 항상 강제된다.

중앙 bridge의 기본 정책은 `trusted_always`이며 always-eligible 보호 호출을 별도
pending/grant 없이 통과시킨다. `manual`은 once/session/always/deny 결정을 사용한다.
어느 정책도 permission, origin, fixed endpoint, schema, effect, Context guard나 operation
ledger를 확장하지 않는다.

중앙 mutation scope는 다음 tuple을 canonicalize/hash한다.

```text
scope version + service/connector
browser exact Origin peer
page binding + resource binding
connector version + transport/fixed HTTP descriptor
capability + schema/effect + policy epoch
execution guard mode/fields
```

Mutation은 unique operation ID가 필요하고 timeout/connection loss로 결과가 모호하면 자동
재시도하지 않는다. Perfetto 전용 도구와 generic select가 같은 durable ledger를 공유한다.

## 중앙 Credential audience

Desktop embedded 경로에는 아래 값이 없다. 이 표는 중앙 bridge 전용이다.

```text
RELU_AI_BRIDGE_TOKEN
  └─ HTTP MCP + local control/admin API

RELU_PERFETTO_CONNECTOR_TOKEN
  └─ exact Perfetto Origin/plugin의 WebSocket proof

RELU_<SERVICE>_CONNECTOR_TOKEN
  └─ 해당 browser service + exact Origin의 WebSocket proof

RELU_<SERVICE>_API_AUTHORIZATION
  └─ bridge → 고정 Data Plane API header
```

Audience를 재사용하지 않고 raw 값을 config, URL, Context, result 또는 audit에 넣지 않는다.

## Perfetto Connector #1

```text
Perfetto v58.2 UI plugin
  → /perfetto/ws exact Origin + nonce/HMAC proof
  → server-owned closed method set
  → PerfettoV58Adapter
  → tab 내부 trace.engine
```

Official `v58.2`/RELU `v58`만 지원한다. SQL은 bounded SELECT-only contract, pure function
allowlist, outer row limit, one-query-per-client, tagged bigint와 timeout 격리를 통과한다.
REF/DUT alignment는 bounded feature 결과만 worker로 넘기고 sample/dimension/cell/time
상한을 적용한다. Trace 원본은 중앙 bridge에 복사하지 않는다.

## 저장 데이터

Embedded EndViewer는 별도 RELU data directory, approval JSON 또는 connector credential을
만들지 않는다. AI client가 user-scope command를 자체 저장하지만 registrar가 공식 CLI로
관리한다. EndViewer가 필요로 하는 product setting은 RELU 연결 설정과 분리하며 Context,
전체 로그와 tool result를 연결 목적으로 영속하지 않는다.

중앙 bridge의 `~/.relu-ai-bridge`에는 bounded audit, manual approval 상태, mutation ledger,
Perfetto session과 선택적 Goal/handoff가 저장될 수 있다. 기본적으로 다음은 저장하지 않는다.

- 중앙 control/connector/API credential와 Authorization
- live browser Context
- Capability raw argument/result
- mutation raw argument/result
- Perfetto trace 원본과 SQL result
- page URL/title, cookie와 account 정보

## 코드 경계

```text
sdk-dotnet/              embedded desktop host/stdio/registrar SDK
examples/wpf-android-log-viewer/
                         EndViewer composition root와 bounded handler 예제

src/connectors.mjs       중앙 browser context/data broker
src/relu-tools.mjs       중앙 generic discovery/approval/dispatch
sdk/                     browser connector SDK
config/                  중앙 core + browser/HTTP service examples

src/perfetto-*.mjs       중앙 Perfetto broker/store/tools
plugin/                  Perfetto v58.2 in-tree UI plugin
perfetto_adapter/        v58 public API adapter
alignment/               bounded pure alignment engine
skills/                  Perfetto/browser 중앙 선택 분석 playbook
```

외부 repository에는 회사 hostname, path, credential, service payload와 company fork diff를
두지 않는다. 내부 integration repo가 exact release, signed EndViewer 배포물과 company-only
중앙 configuration/adapter/CI 결과를 결합한다.

이 저장소의 desktop 산출물은 SDK와 WPF 통합 골격이며 proprietary EndViewer application,
분석 엔진, installer, 서명된 최종 exe는 포함하지 않는다. 단일 실행 파일 계약은 내부
integration repository와 Windows release pipeline에서 완성·검증한다.
