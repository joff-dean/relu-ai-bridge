# RELU AI Bridge

RELU AI Bridge는 Claude·Codex 같은 로컬 AI 클라이언트를 사내 웹 분석 서비스에 연결하는 **독립 구현 local-first MCP 플랫폼**이다. 브라우저는 사용자가 현재 보는 화면의 구조화된 Context만 알려주고, 실제 조회·UI 동작은 서비스별로 사전에 등록한 Capability만 실행한다. AI가 임의 URL, HTTP method, header, script, DOM selector 또는 shell command를 만드는 범용 proxy가 아니다.

Perfetto v57.2 REF/DUT 분석은 이 플랫폼의 첫 번째 커넥터다. 이후 Android Log Viewer, LLM Wiki, Issue DB 같은 서비스를 같은 방식으로 추가할 수 있다.

## 전체 구조

```text
Claude Code / Codex
                 │ MCP 한 번 등록
                 ▼
        RELU AI Bridge (127.0.0.1:5746)
        ├─ Session / Context Registry
        ├─ server-owned Capability Registry
        ├─ once / session / always 승인
        ├─ MCP: list_sessions / get_context /
        │        list_capabilities / execute
        └─ Connector별 Data Plane
                 │
       ┌─────────┼───────────┬──────────┐
       ▼         ▼           ▼          ▼
   Perfetto   Log Viewer   LLM Wiki   Issue DB
   browser TP browser/API  fixed API  fixed API
```

Context Plane과 Data Plane을 분리한다.

- **Context Plane**: 브라우저 탭이 `payloadId`, 선택 시간, 현재 문서 같은 현재 화면 문맥을 loopback WebSocket으로 보낸다.
- **Data Plane**: 서버 설정에 고정된 browser handler 또는 정확한 사내 API endpoint로만 조회한다. API credential은 Bridge process에만 둔다.
- **MCP Plane**: Claude/Codex는 서비스별 MCP를 여러 개 등록하지 않고 RELU 하나에서 세션과 Capability를 발견한다.

## 구현된 기능

- 범용 live session/context registry와 active-tab 추적
- 공통 브라우저 SDK `@company/relu-ai-connector`
- 서버 권위의 서비스별 exact Origin, Capability, 입력·출력 schema, effect policy
- browser Data Plane과 고정 URL의 GET/POST JSON Data Plane
- 서비스별 connector token, Perfetto token과 MCP/admin control token 분리
- `list_sessions → get_context → list_capabilities → execute` generic MCP
- `한 번 / 현재 세션 / 항상 허용 / 거부 / 철회` 로컬 승인
- MCP session·page instance·`bindingFields` resource·Origin·connector version·schema/effect/policy에 묶인 scope
- 승인 후 대상 재검증과 SDK 실행 직전 Context guard
- resource·`policyEpoch` 단위의 영속 mutation operation ledger, 수동 reconciliation과 검증된 archive
- Claude가 generic 도구를 우선 찾도록 하는 설정과 `anthropic/alwaysLoad` metadata
- Perfetto v57.2 Connector #1, bounded read-only SQL, durable REF/DUT, coarse correlation + constrained DTW
- 제한된 파일/명령 profile, Goal, Compact & Resume, browser worker 기능
- 외부 release bundle, manifest, 사내 immutable mirror와 integration 검증 자동화
- runtime npm dependency와 telemetry 없음

Chat On Steroids나 다른 외부 agent 프로젝트의 코드·runtime을 복사하거나 실행하지 않는다. Node.js 표준 라이브러리와 공개 Perfetto API로 작성됐다.

## 빠른 시작

요구사항은 Node.js 20.11 이상과 macOS/Linux다. Windows local server도 가능하지만 Perfetto overlay script는 WSL 또는 Linux build worker를 권장한다.

```bash
node ./bin/relu-ai-bridge.mjs init \
  ./config/local.json \
  /absolute/path/to/approved/project
```

명령이 출력한 control token과 별도 Perfetto connector token은 회사 secret manager에 저장한다. 기존 설정 파일은 덮어쓰지 않는다.
Perfetto를 배포하지 않는 장비는 `perfetto.enabled:false`로 명시하면 Perfetto token 주입을 생략할 수 있다.
생성되는 설정은 의도적으로 read-only다. `write`, `commands`, `goalLoop`,
`multiAgent`와 모든 command profile은 비활성 상태이며, 사내 보안 검토 뒤 필요한
기능만 하나씩 켠다.

```bash
export RELU_AI_BRIDGE_CONFIG="$PWD/config/local.json"
export RELU_AI_BRIDGE_TOKEN="$(approved-secret-command)"
export RELU_PERFETTO_CONNECTOR_TOKEN="$(approved-perfetto-secret-command)"
node ./bin/relu-ai-bridge.mjs doctor
node ./bin/relu-ai-bridge.mjs serve
```

상태와 로컬 승인 UI:

```text
http://127.0.0.1:5746/health
http://127.0.0.1:5746/admin/
```

Admin token은 현재 탭의 `sessionStorage`에만 저장한다. Perfetto와 서비스 커넥터 token은 각각 다른 값이어야 한다.

## Claude를 기본 클라이언트로 연결

Claude Code 프로젝트의 `.mcp.json` 예시:

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

## 승인 편의성과 경계

첫 보호 호출은 `APPROVAL_REQUIRED`를 반환한다. Admin에서 결정한 뒤 **같은 tool call을 다시 실행**한다.

- `한 번`: 같은 scope와 정확한 argument digest에 한 번
- `현재 세션`: 같은 Claude/Codex MCP session과 exact scope가 유지되는 동안
- `항상 허용`: 같은 service, exact Origin, page/resource binding, connector version, Capability transport/schema/effect/policy epoch에 대해 재호출 허용
- `거부`: 현재 pending 요청 거부
- `철회`: 저장된 grant 즉시 삭제

`항상 허용`은 다른 서비스, 다른 탭, 다른 payload/document/account, 바뀐 schema/effect 또는 임의 파일/명령 권한으로 확대되지 않는다. 파일 grant에는 canonical root/protected-path 정책 지문, 명령 grant에는 그 root와 정규화된 profile 전체 지문이 포함되므로 같은 이름의 대상이나 profile을 바꿔도 재승인이 필요하다. 보안상 페이지를 새로 로드하거나 `bindingFields`가 바뀌면 다시 승인한다. 반복 작업 중에는 한 번 승인으로 계속 사용할 수 있고, 모든 grant는 로컬 UI에서 철회된다.

변경 작업은 8~128자의 `operationId`가 필요하다. 원장은 service+Origin+resource+capability 단위로 `connector-operations.json`에 mode 0600으로 저장되어 다른 탭과 재시작 뒤에도 중복 실행을 막는다. Timeout이나 연결 종료로 결과가 모호하면 자동 재시도하지 않으며 `/admin/`에서 실제 서비스 상태를 확인한 뒤 별도 once 승인을 거쳐 `적용됨` 또는 `미적용`으로 판정한다.

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
절차는 [운영 배포 가이드](docs/DEPLOYMENT.md#connector-policyepoch과-operation-ledger-보관)를 따른다.

## Perfetto Connector #1

외부 개발의 canonical baseline은 공식 Perfetto `v57.2`다.

| 항목 | 값 |
| --- | --- |
| Release | `v57.2` |
| Annotated tag object | `24bdfb9dfa2dc92883761426dd94259756fa197e` |
| Peeled commit | `da1d152cff27890903d158fe96751de3aab883cc` |
| Adapter | `v57` |
| 사내 target | 외부 저장소에 기록하지 않으며 내부 integration manifest에서 full SHA·ancestry 검증 |

```bash
scripts/perfetto/bootstrap.sh /absolute/work/perfetto-v57.2
scripts/perfetto/integrate.sh --mode symlink /absolute/work/perfetto-v57.2
scripts/perfetto/build-test.sh --install-deps --typecheck /absolute/work/perfetto-v57.2
scripts/perfetto/run-dev-server.sh /absolute/work/perfetto-v57.2
```

REF와 DUT trace를 별도 탭에서 열고 `/admin/`에서 session에 배정한다. 권장 MCP 흐름은 `perfetto_clients`, `perfetto_sessions`, `perfetto_query`, `perfetto_align(applySelection:false)`, 결과 검토, `perfetto_align(applySelection:true)` 순서다. Trace 원본은 Bridge로 복사되지 않고 SQL은 각 탭의 Trace Processor에서 실행된다.

사내 fork를 외부 baseline으로 만들지 않는다. 공식 v57.2에서 Connector를 개발하고, 회사 버전 차이는 반입 시 company-only adapter/integration으로 분리한다.

## 검증

```bash
node ./scripts/check-syntax.mjs
node --test
```

Perfetto overlay 변경 후:

```bash
scripts/perfetto/smoke-test.sh /absolute/work/perfetto-v57.2
scripts/perfetto/verify-integration.sh /absolute/work/perfetto-v57.2
scripts/perfetto/build-test.sh --unit-tests /absolute/work/perfetto-v57.2
scripts/perfetto/build-test.sh --build /absolute/work/perfetto-v57.2
```

## 사내 반입과 반복 개발

외부 RELU release와 회사 integration 결과를 별도 manifest로 관리한다. 외부 bundle은 검역 후 immutable mirror에 import하고, 사내 service connector 설정·hostname·credential·company adapter·실제 데이터는 내부 integration repo에만 둔다.

- [사내 동기화·통합 가이드](docs/INTERNAL_SYNC_KO.md)
- [외부 릴리스 가이드](docs/RELEASE_KO.md)
- [운영 배포](docs/DEPLOYMENT.md)
- [Perfetto overlay 소유 경계](integration/README_KO.md)

## 중요한 보안·운영 제한

- 기본 server는 explicit loopback에만 bind한다. 인터넷에 직접 노출하지 않는다.
- service Origin을 connector WebSocket에 추가해도 admin/control CORS는 열리지 않는다.
- DB와 API Capability는 read-only로 시작하고 결과·검색량·timeout을 작게 제한한다.
- Context와 도구 결과를 Claude/Codex가 읽으면 선택한 모델 서비스로 전달될 수 있으므로 회사 AI 정책을 적용한다.
- Context와 connector 결과는 기본 audit/session 파일에 저장하지 않는다. token·authorization·raw 결과도 기록하지 않는다.
- 운영 metadata audit는 기본 활성화하지만 자동 ChatGPT 대화 원문 기록은 기본 비활성이다. 명시적 Goal/handoff만 별도 private 상태로 보존한다.
- `active`는 브라우저가 자체 보고한 정렬용 hint일 뿐이다. 변경 대상을 active 하나만 보고 자동 선택하지 않는다.
- Mutation 원장에는 raw argument/result 대신 operation ID, argument hash, opaque resource binding과 상태만 저장한다.
- HTTP Data Plane은 설정에 고정된 endpoint만 지원하며 30x redirect를 따르지 않는다.
- Perfetto alignment confidence는 진단값이지 production 정답 보증이 아니다.
- ChatGPT web companion은 선택 기능이다. RELU의 기본 지원 경로는 Claude Code와 로컬 MCP다.
- Chrome Companion은 매 요청마다 실제 Bridge의 일회성 HMAC proof를 먼저 검증하며 control token을 HTTP bearer로 전송하지 않는다.
- 하나의 `dataDir`은 한 Bridge process만 잠글 수 있다. 승인·원장·세션 저장소를 여러 process가 동시에 갱신하는 구성은 거부된다.

## 문서

- [아키텍처](docs/ARCHITECTURE.md)
- [커넥터 개발](docs/CONNECTOR_DEVELOPMENT_KO.md)
- [보안 모델](docs/SECURITY.md)
- [MCP 도구](docs/TOOLS.md)
- [Claude 설정](docs/CLAUDE_SETUP_KO.md)
- [ChatGPT·Codex 연결](docs/CHATGPT_SETUP.md)
- [정렬 엔진](alignment/README.md)
- [Perfetto Plugin](plugin/README.ko.md)
- [Perfetto Adapter](perfetto_adapter/README.ko.md)
