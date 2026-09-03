# RELU 커넥터 개발 가이드

RELU AI Bridge 0.7.0은 대상 runtime에 따라 두 방식으로 연결한다.

- Windows/WPF 분석 프로그램: application에 embedded bridge를 포함한다.
- Browser/Perfetto/고정 HTTP API: 별도 중앙 bridge와 registry를 사용한다.

Windows 앱에 중앙 desktop WebSocket adapter를 붙이는 방식은 지원하지 않는다. Legacy
desktop service JSON, auth vector와 token/HMAC handshake를 새 구현의 기준으로 사용하지
않는다.

## 먼저 topology를 결정한다

| 질문 | Embedded desktop | 중앙 browser/HTTP |
| --- | --- | --- |
| 배포 단위 | EndViewer 단일 executable | RELU server + web SDK/config |
| AI transport | 같은 exe의 stdio mode | Streamable HTTP MCP |
| 앱 transport | `CurrentUserOnly` named pipe | origin-bound loopback WebSocket/HTTPS |
| Node/port/local JSON | 없음 | 필요 |
| 연결 credential | 없음 | audience별로 필요 |
| 정책 권위 | signed service definition | central server registry |

공통 원칙은 Context와 Data Plane 분리, static Capability, bounded schema/result,
stale-target guard와 no-proxy invariant다.

## 공통 Capability 설계

Capability는 하나의 작고 이름 있는 업무 동작이다.

좋은 예:

```text
wiki.search
wiki.get_document
log.get_selection_stats
log.get_selection_series
viewer.focus_range
```

금지 예:

```text
execute_http(url, method, headers, body)
run_javascript(code)
query_database(sql)
click(selector)
invoke_reflection(type, method)
```

각 Capability에는 고정 effect가 있다.

| effect | 의미 | 기본 권고 |
| --- | --- | --- |
| `read` | 데이터 조회 | 첫 release의 기본값 |
| `ui_mutation` | 선택·focus 같은 화면 변경 | operation ID와 preview 필요 |
| `data_mutation` | 데이터 변경 | 별도 보안 review/idempotency 뒤에만 |
| `external_side_effect` | 메시지·배포 등 외부 효과 | 초기에는 사용하지 않음 |

모든 object schema는 `additionalProperties:false`, string은 `maxLength`, array는
`maxItems`를 가져야 한다. `$ref`, dynamic schema와 URL/method/header/script/selector/
command처럼 proxy를 만드는 input을 사용하지 않는다. Item 제한과 전체 JSON byte 제한을
동시에 적용하고 큰 결과는 filter, pagination, aggregate 또는 downsample한다.

Context에는 opaque resource/revision/selection만 넣는다. 원문 전체, access token,
cookie, 사용자 account와 전체 파일 경로를 넣지 않는다.

## 1. Embedded Windows Desktop

### SDK 공급

Release `relu-ai-bridge-v0.7.0`의 `sdk-dotnet/`을 내부 NuGet package 또는 reviewed
project reference로 고정한다. Package version은 `0.7.0`이다. EndViewer 개발자가 build에
포함하며 최종 사용자는 RELU/NuGet/Node를 설치하지 않는다. Runtime에 외부 NuGet/Git
URL에서 최신 code를 내려받지 않는다.

### Composition root

EndViewer의 application startup은 다음 세 API를 연결한다.

- `ReluEmbeddedBridgeHost`: GUI process에서 live Context, fixed Capability와
  `CurrentUserOnly` named pipe server를 소유한다.
- `ReluMcpStdioEntryPoint`: 같은 executable의 internal mode에서 stdio MCP를 처리하고
  GUI host로 중계한다.
- `ReluAiClientRegistrar`: Claude Code/Codex의 공식 CLI를 사용해 user-scope MCP 등록을
  조회·추가·검증한다.

정확한 constructor와 lifecycle signature는
[`examples/wpf-android-log-viewer/ReluWpfIntegration.cs`](../examples/wpf-android-log-viewer/ReluWpfIntegration.cs)를
정본으로 사용한다. 문서가 컴파일 signature를 중복 추정하지 않는다.

일반 mode는 WPF UI와 host를 시작한다. AI client가 MCP server를 시작하면 동일
`EndViewer.exe`가 internal stdio mode로 실행되며 WPF window를 만들지 않는다. GUI가
실행 중이지 않으면 `APPLICATION_NOT_RUNNING`으로 실패하고 중앙 bridge/임의 port로
fallback하지 않는다.

### 자동 등록과 managed 환경

Registrar는 Claude와 Codex를 독립 탐지하고 공식 CLI의 조회/등록/재조회 절차만 사용한다.
AI client JSON/TOML을 직접 편집하지 않는다. Same-name 등록이 다른 executable을 가리키면
덮어쓰지 않고 진단한다. Stable Authenticode-signed launcher 절대 경로를 등록한다.

최초 등록 전에 이미 실행 중인 client는 MCP 목록을 캐시할 수 있으므로 등록 직후 한 번
restart/reload가 필요하다. 이후에는 EndViewer 실행 외에 사용자 설정이 없다. Exclusive
managed MCP가 user 등록을 막으면 우회하지 않고 IT가 stable launcher와 internal stdio
mode를 사전 등록한다.

### Embedded service definition

Desktop Capability 이름, description, input/output schema, effect, timeout, concurrency,
결과 상한과 분석 지침은 EndViewer source/binary에 컴파일한다. 분석 지침은 MCP `2025-06-18`
`initialize` 응답으로 자동 제공하므로 desktop Skill 설치가 없다. 로그/Context와
model argument가 이 definition을 확장하거나 교체할 수 없다.

Public repository는 SDK와 WPF integration skeleton까지만 제공한다. 실제 EndViewer
application/분석 엔진/installer/signed exe는 내부 product repository에서 통합한다.
GUI host는 사용자별 단일 instance로 운영하고, selection 전에도 host와 registrar는
시작하되 Context/분석 호출은 `CONTEXT_UNAVAILABLE`로 거부한다. User-scope MCP는 같은
Windows 계정의 다른 AI 프로젝트에도 보이므로 필요한 경우 managed MCP로 격리한다.

Context 예:

```text
opaque logResourceId
datasetRevision
selectionId + selectionRevision
selection start/end + timebase
bounded parser/filter metadata
```

Chart selection-completed event에서 전체 projection을 atomic하게 갱신한다. Host는 handler
직전과 완료 뒤 dataset/selection projection을 비교하고 변경되면 stale 결과를 폐기한다.
Handler는 cancellation을 존중한다. 화면 캡처, UI Automation, control-tree 탐색, 임의
reflection/assembly loading을 사용하지 않고 기존 domain/application service를 호출한다.

기본 desktop Capability는 read-only이며 RELU approval prompt 없이 실행한다. Mutation을
추가할 때는 unique operation ID, durable deduplication, preview와 timeout 뒤 ambiguous
판정을 embedded host에 별도로 구현한다.

### Desktop 배포 경계

- EndViewer 단일 executable과 필요한 runtime을 회사가 package/sign한다.
- Installer/update manifest, launcher path와 directory ACL을 검증한다.
- Pipe는 `CurrentUserOnly`이며 다른 Windows 사용자 접근을 거부한다.
- CLI output, Context 원문, 전체 로그와 exception detail을 등록/connection log에 남기지
  않는다.
- AI client의 user 설정에는 command만 남고 desktop bearer/env secret은 없다.
- 별도 RELU local JSON, project `.mcp.json`, desktop service JSON과 Skill을 요구하지 않는다.

`CurrentUserOnly`는 같은 Windows 사용자로 실행된 악성 process를 완전히 식별하지 않는다.
Application signing/allowlisting과 low-privilege 운영을 함께 사용한다.

## 2. 중앙 Browser Data Plane

### Web SDK 공급

`sdk/package.json`은 `private:true`다. Release `0.7.0`과 digest를 고정한 뒤 사내 registry에
재패키징하거나 서비스 저장소에 vendor한다. 외부 Git URL과 개발자 절대 `file:` 경로를
shared lockfile에 남기거나 runtime에 동적 다운로드하지 않는다.

### Central service registry

`config/battery-viewer.service.example.json`을 기준으로 중앙 설정의
`connectors.services`에 browser 객체를 추가한다.

```json
{
  "id": "llm-wiki",
  "displayName": "LLM Wiki",
  "tokenEnv": "RELU_WIKI_CONNECTOR_TOKEN",
  "origins": ["https://wiki.internal.example"],
  "bindingFields": ["documentId"],
  "contextSchema": {
    "type": "object",
    "properties": {
      "documentId": { "type": "string", "maxLength": 128 },
      "sectionId": { "type": "string", "maxLength": 128 }
    },
    "required": ["documentId"],
    "additionalProperties": false
  },
  "capabilities": []
}
```

Origin은 scheme/host/port가 모두 일치해야 하며 wildcard/path를 사용하지 않는다. 서비스별
`tokenEnv`는 분리하고 control credential을 재사용하지 않는다. Browser registration의
Capability 목록은 구현 교집합일 뿐 이름/schema/effect/timeout은 central registry가
소유한다.

### Browser handler

```js
const connector = new ReluWebConnector({
  serviceId: 'battery-viewer',
  token: runtimeConfig.connectorToken,
  getContext,
  capabilities: {
    get_stats: async (_args, { signal }) => {
      return calculateStats({ signal, maxSamples: 100_000 });
    }
  }
});
```

SDK client ID는 page load마다 새 값이다. Server request의 `bindingFields` projection을
handler 직전 live `getContext()`와 비교하고 달라졌으면 실행하지 않는다. Handler는
`AbortSignal`과 내부 scan/regex/join budget을 지킨다.

### Browser loopback 상호 인증

1. SDK가 service ID와 fresh client nonce만 보낸다.
2. Bridge가 fresh server nonce와 exact Origin/audience에 묶인 HMAC proof를 보낸다.
3. SDK가 proof를 확인한 뒤에만 Context와 implementation 목록을 보낸다.
4. Client proof는 canonical registration digest를 포함한다.
5. Bridge가 proof/schema/registry 교집합을 확인한 뒤 session을 만든다.

Raw connector credential은 WebSocket message에 넣지 않는다. Proof 전 Context와 reconnect
state를 보내지 않는다. 구형 raw-token handshake로 fallback하지 않는다.

## 3. 중앙 HTTP Data Plane

기존 Wiki/Issue/Log API가 있으면 중앙 bridge의 fixed endpoint Capability로 연결한다.

```json
{
  "name": "search",
  "transport": "http",
  "effect": "read",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 1, "maxLength": 500 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
    },
    "required": ["query"],
    "additionalProperties": false
  },
  "http": {
    "url": "https://wiki-api.internal.example/api/ai/search",
    "method": "POST",
    "timeoutMs": 10000,
    "auth": {
      "header": "authorization",
      "env": "RELU_WIKI_API_AUTHORIZATION"
    }
  }
}
```

URL/method/header 이름은 config에 고정하고 credential value는 environment에서만 읽는다.
GET/POST JSON만 지원하고 redirect를 따르지 않는다. AI/browser가 endpoint, method와
credential을 선택하거나 읽을 수 없다.

## 4. 중앙 Connector credential 배포

이 절은 browser/Perfetto 중앙 bridge에만 적용된다.

```bash
node scripts/generate-token.mjs connector
```

서비스별로 다른 값을 발급하고 bridge와 browser runtime에 승인된 secret manager/local
enrollment로 전달한다. Source, Git, query string, browser `localStorage`, audit에 저장하지
않는다. Connector credential은 MCP/admin credential로 사용할 수 없고 그 반대도 같다.

Desktop EndViewer에는 이 credential 생성·주입 단계를 적용하지 않는다.

## 5. 승인 정책

중앙 bridge의 새 설정은 `trusted_always`로 일반 보호 호출을 prompt/grant 없이 통과시킨다.
대화형 환경은 `manual`을 사용한다. Central scope는 exact browser Origin, page/resource,
schema/effect, connector version과 policy epoch에 묶인다. Mutation은 operation ID가
필요하고 timeout 뒤 ambiguous 상태를 자동 retry하지 않는다.

Embedded desktop read-only Capability는 중앙 approval/grant 저장소를 사용하지 않는다.
Signed service definition, same-user pipe, schema/result 상한과 stale-selection guard가
항상 적용된다. Desktop mutation은 별도 정책/ledger 설계 없이는 추가하지 않는다.

## 6. 검증 체크리스트

Embedded desktop:

- EndViewer 단일 executable에서 GUI/stdio mode가 분리됨
- `ReluEmbeddedBridgeHost`, `ReluMcpStdioEntryPoint`, `ReluAiClientRegistrar` lifecycle
- `CurrentUserOnly` pipe의 다른 Windows 사용자 연결 거부
- GUI 미실행/종료/재실행과 `APPLICATION_NOT_RUNNING`/reconnect
- Claude/Codex user-scope 등록의 idempotency, exact signed path와 충돌 보존
- 최초 등록 전 실행 중 client의 1회 restart/reload
- Managed MCP에서 user 등록 우회 없이 IT 항목 사용
- Embedded `initialize` `instructions`와 별도 desktop Skill/config/credential 부재
- Input/output/전체 result byte 제한과 selection 변경 cancellation/전후 guard

Central browser/HTTP:

- Exact Origin/audience만 mutual HMAC 성공
- Invalid proof/replay/timeout fail-closed와 proof 전 Context 부재
- Connector credential로 MCP/admin 호출 거부
- Unknown Capability와 client 주장 schema/effect 거부
- Input/output/size/timeout/AbortSignal 제한
- Credential/cookie/raw result가 audit/dataDir에 기록되지 않음
- Mutation operation ID, deduplication과 ambiguous reconciliation
- Browser reload/account 전환 뒤 이전 scope 미승계

Repository 검증 명령과 release gate는 [릴리스 가이드](RELEASE_KO.md)를 따른다.
