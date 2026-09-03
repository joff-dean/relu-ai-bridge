# RELU AI Bridge 아키텍처

RELU AI Bridge의 core는 특정 웹서비스나 Windows 프로그램을 모른다. 서버 시작 시 로드한 service registry와 각 Connector가 구현한 작은 adapter를 통해 여러 사내 분석 서비스를 하나의 MCP workspace로 노출한다. Perfetto는 Connector #1이며 전용 보안·정렬 기능을 유지한다.

## 논리 구조

```text
AI Client Plane
Claude / Codex
      │ Streamable HTTP MCP + server-issued MCP session
      ▼
Local Control Plane
RELU AI Bridge @ explicit loopback
      ├─ MCP router
      ├─ Session + Context Registry
      ├─ server-owned Capability Registry
      ├─ trusted_always / manual Approval Policy
      ├─ bounded Audit
      └─ Connector Broker
             │
  ┌──────────┴──────────────────────────┐
  │ Context Plane                       │ Data Plane
  │ browser/desktop → opaque context    │ exact capability dispatch
  ▼                                     ▼
Web SDK / .NET Desktop SDK    browser/desktop handler / fixed HTTPS API
  │                                     │
  └──── Log Viewer / Wiki / DB / Perfetto ────┘
```

## Context Plane

브라우저 탭 또는 데스크톱 application instance 하나를 live RELU session으로 취급한다.
Browser SDK는 연결 직후 service ID와
page-load마다 생성한 fresh 256-bit client nonce만 담은 `auth_init`을 보낸다. 이
시점에는 raw token, client descriptor, Context와 reconnect secret을 보내지 않는다.
Bridge는 WebSocket handshake에서 관찰한 exact Origin과 service ID에 대응하는 token을
HMAC key로 사용해 fresh server nonce의 proof를 반환한다. SDK가 현재 페이지의 exact
`location.origin`, service, protocol과 양쪽 nonce에 묶인 server proof를 검증한 뒤에만
다음 registration을 `auth_response`에 포함한다.

- 서비스 ID와 connector version
- page-load마다 생성한 random client ID
- 서버 registry에 이미 존재하는 browser Capability의 구현 목록
- registry의 `contextSchema`에 맞는 현재 Context
- 현재 focus/visibility 상태
- reconnect 중에만 유지하는 resume secret

Client HMAC proof에는 canonical registration의 SHA-256 digest도 포함된다. Bridge가 proof와
digest를 검증한 뒤에만 session을 만들고 `hello_ack`을 보낸다. Raw connector token은
어떤 WebSocket application message에도 들어가지 않는다. 브라우저가 보낸 service ID,
Capability 이름, schema, effect 또는 resource ID만으로 권한을 넓히지 않는다.

Context는 Bridge 메모리에만 존재한다. 탭이 끊기면 제거되고 기본 session/audit 파일에는 기록되지 않는다. 목록 API는 Context 원문이나 page title/URL 대신 opaque session key와 서비스 이름만 반환한다.

각 service는 `bindingFields`로 payload/document/account처럼 권한과 작업 중복 방지에 필요한 top-level Context 필드를 지정한다. Bridge는 projection hash를 resource binding으로 사용한다. local policy를 통과한 뒤 server snapshot을 다시 검사하고, outbound browser request에도 projection guard를 넣는다. SDK가 handler 직전에 live Context와 비교하므로 100ms context-update debounce 사이의 stale 요청도 실행되지 않는다.

SDK protocol:

```text
client → server  auth_init, auth_response, response,
                 event(context.update/session.active), pong
server → client  auth_challenge, hello_ack, request, ping
```

Browser WebSocket path는 `/relu/ws`로 고정된다. SDK도 `ws://127.0.0.1:<port>/relu/ws` 계열 explicit loopback만 허용한다. 순서·audience·nonce·proof가 다르거나 5초 timeout이 지나면 해당 연결을 fail-closed한다. 매 연결 nonce가 달라 캡처한 proof는 재사용할 수 없다.

Desktop SDK는 `/relu/desktop/ws`만 사용한다. 이 endpoint는 `Origin` header가 있으면
값과 무관하게 upgrade를 거부해 browser JavaScript 경로와 분리한다. Service별 정확한
app ID 하나와 stable opaque instance ID, 전용 audience, 양쪽 nonce를 mutual HMAC에
묶는다. Server proof 확인 뒤에만 exact UTF-8 `registrationJson`을 보내고, 그 raw byte
digest를 client proof에 포함한다. Bridge는 proof를 먼저 검증한 뒤 duplicate-key 없는
JSON parse, identity, Context schema와 Capability 교집합을 확인한다.

`bindingFields`는 persistent resource scope를 결정한다. 선택 구간처럼 빠르게 바뀌는
필드는 명시적 `executionGuardFields`에 추가할 수 있다. 이 모드에서 Bridge는 policy 통과 뒤와
dispatch 직전 projection을 재검사하고 Desktop SDK도 handler 직전·직후 live projection을
비교한다. `executionGuardFields`를 명시하지 않은 기존 browser 계약은 strict
`contextVersion` mode를 유지해 모든 Context update가 pending 실행을 취소한다.

## Capability Registry

Registry는 config의 `connectors.services[]`에서 server startup에 만들어진다. 각 Capability는 다음 고정 속성을 갖는다.

```text
service id + exact origins + service token audience
capability id + description
input schema + output schema
effect + timeout + concurrency
client kinds(browser | desktop) + browser exact Origin 또는 desktop exact app ID
transport(browser | desktop | http)
fixed HTTP endpoint/method/auth-env (HTTP일 때만)
```

인증된 browser registration의 목록은 설정과 교집합을 만드는 데만 사용한다. unknown 이름을 광고하면 연결을 거부한다. AI의 `execute` argument에는 URL, method, header, script, selector나 command가 존재하지 않는다.

Strict schema subset은 object/array/string/integer/number/boolean, enum과 bounded property keyword만 지원한다. 미지원 keyword는 무시하지 않고 config load를 실패시킨다. 입력과 출력 모두 byte, depth, node, string, array 제한을 통과한다. `connectors.maxResultBytes`는 배열 항목별 상한이 아니라 직렬화한 Capability 결과 전체의 합산 byte 상한이다.

## Data Plane

### Browser transport

Perfetto Trace Processor처럼 엔진이 탭 내부에 있거나 현재 UI를 이동할 때 사용한다.

```text
execute(session, action, params)
  → registry/schema/effect/approval policy
  → WebSocket request
  → SDK의 정적 handler
  → bounded schema-validated result
```

Handler에는 AbortSignal, mutation `operationId`와 승인 당시 `contextGuard`를 전달한다. Session당 16개, Capability별 설정된 concurrent limit을 넘기지 않는다. Read timeout도 late response/연결 종료까지 busy tombstone을 유지한다. Mutation timeout 뒤에는 resource/action을 잠그고 자동 retry하지 않는다.

### Desktop transport

WPF 같은 native application의 기존 domain/application service를 정적 handler로
연결한다. UI Automation, screen scraping, reflection target 또는 arbitrary assembly
loading은 사용하지 않는다.

```text
execute(session, action, params)
  → registry/schema/effect/approval policy
  → desktop WebSocket request + selection guard
  → .NET SDK가 live Context 재검증
  → 기존 bounded analysis engine
  → live Context 재검증 + bounded result
```

설치별 stable instance ID로 application-instance binding을 재현하므로 `manual`에서는 같은
dataset의 persistent grant를 앱 재시작 뒤에도 유지할 수 있고, `trusted_always`에서는
개별 grant 없이 같은 resource 경계를 다시 검사한다. Resume secret은 process memory에만 둔다. 같은 instance의
live session이 없고 app/instance HMAC이 다시 검증된 경우에만 stale reconnect record를
회전하며, 살아 있는 session의 takeover는 거부한다.

### HTTP transport

기존 Wiki/DB/Log REST API가 있을 때 사용한다.

```text
execute
  → exact config URL + GET/POST
  → Bridge process가 auth env 주입
  → redirect=manual
  → JSON/size/output schema 검증
```

AI나 browser는 endpoint, method와 credential을 선택하거나 읽을 수 없다. HTTPS가 기본이며 명시적 개발 옵션이 없으면 HTTP 설정을 거부한다.

## MCP Plane

Endpoint는 `/mcp`이며 `initialize`, notification, `ping`, `tools/list`, `tools/call`과 session `DELETE`를 구현한다. Initialize가 발급한 `mcp-session-id`를 이후 요청에서 검증하며 임의·종료된 session ID는 거부한다.

범용 discovery 도구:

```text
list_sessions
get_context
list_capabilities
execute
```

Perfetto 전용 도구와 제한된 local coding/agent 도구도 같은 MCP에 존재한다. Claude에는 네 범용 도구와 핵심 Perfetto 도구에 discovery metadata를 제공한다.

## 승인 모델

새로 생성한 설정은 `trusted_always`를 명시하며 always-eligible 호출을 prompt/pending/grant
없이 통과시킨다. `manual`은 기존 once/session/always/deny UI를 사용한다. 브라우저나
모델은 이 정책을 바꾸거나 수동 승인을 생성할 수 없고, pending request는 local
admin/companion UI에서만 결정한다. `once/deny` 전용 안전 interlock은 자동 정책에서도
pending으로 남는다.

승인과 mutation 원장에서 사용하는 **connector peer**는 browser라면 WebSocket
handshake에서 server가 관찰한 exact Origin이고, desktop이라면 allowlist의 app ID에서
도출한 `relu-desktop://<sha256>` opaque trust-domain key다. Desktop app ID 원문은
routing/authentication metadata로만 쓰고 scope·원장에는 opaque peer를 넣는다.

RELU Capability scope는 단순 문자열 prefix가 아니라 다음 tuple을 canonical JSON으로 직렬화하고 SHA-256으로 만든다.

```text
scope version
kind(context.read | capability)
connector/service id
connector peer(browser exact Origin | desktop opaque app trust-domain hash)
page/application-instance binding + bindingFields resource binding
connector version + transport + fixed HTTP descriptor
capability id
input/output schema hash
effect
policy epoch
execution guard mode + fields
```

수동 `once` fingerprint에는 normalized argument digest와 operation ID가 추가된다.
`session` grant는 pending 생성 시 서버가 검증한 MCP session ID만 사용하며 승인 요청
body가 이를 바꾸지 못한다. 수동 `always`는 exact hashed scope에서만 동작한다. 정책을
전환하면 이전 pending/grant를 무효화해 나중에 재활성화되지 않게 한다.

## Credential audience

```text
RELU_AI_BRIDGE_TOKEN
  └─ MCP + local control/admin API

RELU_PERFETTO_CONNECTOR_TOKEN
  └─ exact Perfetto Origin + plugin ID의 /perfetto/ws mutual HMAC만

RELU_<SERVICE>_CONNECTOR_TOKEN
  └─ 해당 service + exact Origin의 /relu/ws 또는 exact app ID의
     /relu/desktop/ws mutual HMAC만

RELU_<SERVICE>_API_AUTHORIZATION
  └─ Bridge → 고정 Data Plane API header만
```

Connector token으로 `/mcp`, `/bridge`, `/api`를 호출하면 401이다. Control token으로 Perfetto/generic service HMAC proof를 만들 수도 없다. Service Origin 목록은 HTTP control CORS 목록과 합치지 않는다.

## Perfetto Connector #1

```text
Perfetto UI plugin
  → /perfetto/ws exact Origin/plugin audience + fresh nonce mutual HMAC
  → server proof 뒤에만 client/trace descriptor 공개(raw token wire 미전송)
  → server-owned closed method set
  → PerfettoV58Adapter
  → tab 내부 trace.engine
```

기존 closed method set, SQL lexer/function allowlist, outer row limit, one-query-per-client lock, tagged bigint와 REF/DUT binding을 generic execute 뒤에서도 우회하지 않는다. Generic `perfetto:<client>` session의 `query_sql`은 내부적으로 기존 `perfetto_query`를 호출한다.

Read/query/select/align은 approval 전의 client ID만 기억하지 않고 trace binding, exact connection, plugin version과 선택적 REF/DUT assignment를 snapshot으로 묶는다. 승인 뒤 같은 ID가 새 trace/connection으로 교체되면 dispatch를 거부한다. `select_range`, `perfetto_select_area`, DUT 선택을 반영하는 `perfetto_align`은 기존 connector operation ledger를 함께 사용하므로 operation dedupe, restart recovery, ambiguous timeout과 admin reconciliation 계약도 동일하다. Alignment preview는 원장을 만들지 않으며, applied alignment는 승인과 입력 확정 뒤 SQL/DTW 전에 operation을 선점한다.

REF/DUT alignment는 feature query 결과만 Worker thread로 넘긴다. coarse correlation, constrained DTW, piecewise mapping에 sample/cell/operation/wall-clock 상한을 적용한다.

## 저장 데이터

기본 `~/.relu-ai-bridge`:

```text
approvals.json             active policy와 manual pending/grant, mode 0600
connector-operations.json  mutation id/hash/status 원장, mode 0600
connector-operation-archives/*.json  policyEpoch 전환 시 검증된 terminal 원장
perfetto-sessions.json     REF/DUT binding과 alignment 요약
sessions/*.json            선택적 ChatGPT goal/handoff
agents.json                선택적 browser worker routing 상태
audit/YYYY-MM-DD.ndjson    metadata 중심 bounded/redacted audit
```

다음은 기본적으로 저장하지 않는다.

- control/connector/API token과 Authorization
- live Connector Context
- Capability raw arguments/results
- mutation raw arguments/results (원장에는 digest와 상태만 저장)
- Perfetto trace 원본과 SQL result
- page URL/title, cookie, account 정보

기본값은 `privacy.recordAudit:true`, `privacy.recordSessions:false`다. 따라서
bounded/redacted 운영 metadata audit는 남기되 자동 대화 원문은 저장하지 않는다.
`permissions.sessions`와 `privacy.recordSessions`가 모두 `true`일 때만 browser
event transcript와 그 metadata를 `sessions/*.json`에 기록한다. 둘 중 하나라도
`false`이면 Goal 판정과 token 추정을 위한 bounded transcript는 현재 process
메모리에만 유지하며 재시작 시 사라진다. 기록을 켠 경우에도 event text와
metadata key/value에는 bounded recursive redactor를 적용한다.

둘 중 하나라도 `false`인 경우 session 파일도 private allowlist schema를 사용한다.
Opaque session ID, control token HMAC 기반 `conversationKey`, role,
timestamp, 명시적으로 설정한 Goal/turn과 Compact & Resume handoff text만
영속한다. Raw title, conversation ID/URL, prime ID, event와 replacement conversation
ID/URL은 파일에 쓰지 않고 현재 process의 volatile binding으로만 유지한다. 시작할
때 기존 session 파일도 이 schema로 scrub하므로 과거 raw metadata와 event가
남지 않는다. 같은 control token을 유지하면 재시작 뒤 들어온 conversation ID의
HMAC을 비교해 Goal과 session을 복원한다. Control token을 회전하면 자동 매칭은
의도적으로 끊기며, 알고 있는 opaque session ID로 명시적 Resume/rebind를 수행해야
새 HMAC binding이 만들어진다.

같은 두 설정은 `agents.json`에도 적용된다. 둘 중 하나라도 `false`이면 worker
task, follow-up message, result, label, raw prime/conversation ID와 URL, browser
client ID, command payload는 process memory에서만 유지한다. 디스크에는 schema
version, cursor, control token HMAC 기반 prime/conversation key, worker ID·상태와
timestamp만 남으며 pending command는 재시작 뒤 재전송하지 않는다. 시작할 때
legacy `agents.json`도 이 allowlist로 다시 써 과거 payload를 제거한다. 같은
process에서는 기존 routing/status/result 동작을 유지하지만 재시작 뒤에는 worker
목록과 종료 상태 같은 최소 정보만 복원되고 payload가 필요한 명령은 사용자가 다시
제공해야 한다. Worker tab이 다시 register해 volatile binding을 복구하기 전에는
follow-up routing을 거부한다. Control token을 회전하면 기존 HMAC prime을 자동
연결하지 않는다.

## 코드 경계

```text
src/connectors.mjs       generic connection/context/data broker
src/relu-tools.mjs       generic MCP discovery/approval/dispatch
sdk/                     browser connector SDK
sdk-dotnet/              .NET 8 desktop connector SDK
config/                  core + service registry examples
examples/                browser/WPF service adapter examples
skills/                  Claude/Codex 공통 분석 playbook 정본

src/perfetto-*.mjs       Connector #1 broker/store/tools
plugin/                  Perfetto in-tree UI plugin
perfetto_adapter/        v58 public API adapter
alignment/               bounded pure alignment engine
```

외부 repository에는 회사 hostname, path, credential, service payload, company fork diff를 두지 않는다. 내부 integration repo가 exact RELU release와 company-only configuration/adapter/CI 결과를 결합한다.
