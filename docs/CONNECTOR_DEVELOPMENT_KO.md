# RELU 커넥터 개발 가이드

이 문서는 기존 사내 웹서비스를 RELU AI Bridge에 연결하는 표준 절차다. 목표는 각 서비스에 LLM이나 MCP server를 새로 넣는 것이 아니라, 공통 SDK와 작은 service adapter만 추가하는 것이다.

## SDK를 사내 서비스에 공급하는 방법

`sdk/package.json`은 의도적으로 `private:true`이며 이 외부 저장소에서 npm에
publish하지 않는다. 검증된 RELU release와 SDK version을 함께 고정한 뒤 다음 중
하나로 사내 서비스에 공급한다.

- 사내 registry: 보안 검토한 release의 `sdk/`만 내부 packaging 저장소로 복사하고,
  회사 scope/name을 확정한 사내 manifest에서만 `private`를 제거해 내부 registry에
  publish한다. 서비스 lockfile은 정확한 `0.3.0` artifact digest를 고정한다.
- vendoring: 서비스 저장소의 `vendor/relu-ai-connector/`에 검토한 `sdk/` 파일을
  복사하고 `"@company/relu-ai-connector": "file:./vendor/relu-ai-connector"`처럼
  상대 file dependency를 사용한다.

개발자 장비의 절대 `file:/...` 경로나 외부 Git URL을 공유 lockfile에 commit하지
않는다. 서비스 runtime이 이 저장소나 GitHub에서 SDK를 동적으로 내려받게 하지
않으며, core와 SDK version이 달라지면 connector compatibility test를 다시 수행한다.

## 먼저 결정할 것

서비스별로 Context Plane과 Data Plane을 분리한다.

| 질문 | Context Plane | Data Plane |
| --- | --- | --- |
| 무엇을 전달하는가 | 현재 payload/document/issue의 opaque ID, 선택 범위, view 종류 | 통계, 검색 결과, 문서 일부 같은 실제 조회 결과 |
| 방향 | Browser → Bridge | Bridge → browser handler 또는 고정 API |
| 저장 | 메모리만, 탭 종료 시 제거 | 기본 audit/session에 저장하지 않음 |
| 권한 | context read 승인 | capability별 승인 |

Context에는 원문 로그, access token, cookie, 사용자 account, 전체 문서를 넣지 않는다. 가능한 한 서버가 다시 조회할 수 있는 opaque reference와 화면 선택만 보낸다.

## 1. 서비스 registry 작성

`config/battery-viewer.service.example.json`을 기준으로 주 설정의 `connectors.services`에 객체를 추가한다.

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

규칙:

- `id`는 소문자 영문으로 시작하고 영문·숫자·`_`·`-`만 사용한다.
- `origins`는 wildcard가 아니라 scheme, host, port가 모두 일치하는 origin이다.
- 각 서비스는 별도 `tokenEnv`를 사용한다. Control/MCP token을 재사용하지 않는다.
- `bindingFields`에는 document/payload/account처럼 권한과 mutation 중복 방지를 결정하는 필수 top-level Context 필드를 1~8개 지정한다.
- 모든 object schema는 `additionalProperties:false`다.
- 모든 string에는 `maxLength`, 모든 array에는 `maxItems`를 둔다.
- 지원하지 않는 `$ref`, `oneOf`, `anyOf`, dynamic schema keyword는 startup에서 거부된다.
- `url`, `method`, `header`, `authorization`, `cookie`, `selector`, `script`, `code`, `command`, `program`, `redirect` 같은 proxy-shaped 입력 필드는 등록할 수 없다.

## 2. Capability 설계

Capability는 하나의 작고 이름 있는 업무 동작이다.

좋은 예:

```text
wiki.search
wiki.get_document
issue.find_similar
log.get_stats
log.search_logs
viewer.focus_range
```

금지 예:

```text
execute_http(url, method, headers, body)
run_javascript(code)
query_database(sql)
click(selector)
```

각 Capability에는 Bridge가 소유하는 effect가 있다.

| effect | 의미 | 기본 권고 |
| --- | --- | --- |
| `read` | 데이터 조회 | 첫 버전의 기본값 |
| `ui_mutation` | 선택·focus 같은 화면 변경 | `operationId` 필요 |
| `data_mutation` | 서버 데이터 변경 | 충분한 review/idempotency 뒤에만 |
| `external_side_effect` | 메시지·배포 등 외부 효과 | 초기에는 사용하지 않음 |

브라우저가 인증 뒤 registration에 보내는 Capability 목록은 구현 가능 여부를 나타내는 교집합 자료일 뿐이다. 이름, schema, effect, endpoint와 timeout은 모두 서버 config가 최종 권한 원본이다.

## 3. Browser Data Plane

브라우저 내부에만 데이터 엔진이 있거나 UI 동작이 필요할 때 사용한다.

```json
{
  "name": "focus_range",
  "description": "현재 그래프를 지정 구간으로 이동한다.",
  "transport": "browser",
  "effect": "ui_mutation",
  "timeoutMs": 5000,
  "maxConcurrent": 1,
  "inputSchema": {
    "type": "object",
    "properties": {
      "startMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
      "endMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
    },
    "required": ["startMs", "endMs"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": { "focused": { "type": "boolean" } },
    "required": ["focused"],
    "additionalProperties": false
  }
}
```

SDK handler는 server deadline을 `AbortSignal`로 받는다. 긴 계산은 signal을 확인하고 취소해야 한다. 작은 결과를 반환하더라도 내부적으로 무한 검색, 전체 DB scan, huge regex 또는 대규모 join을 실행하면 안 된다.

```js
const connector = new ReluWebConnector({
  serviceId: 'battery-viewer',
  token: runtimeConfig.connectorToken,
  getContext,
  capabilities: {
    get_stats: async (_args, { signal }) => {
      return calculateStats({ signal, maxSamples: 100_000 });
    },
    focus_range: async ({ startMs, endMs }, { operationId, contextGuard }) => {
      if (!operationId) throw new Error('operationId required');
      viewer.focusRange(startMs, endMs);
      return { focused: true };
    }
  }
});
```

SDK client ID는 page load마다 새 random 값이며 reconnect 동안만 유지된다. 다른 탭이나 reload에 기존 persistent approval을 넘기지 않는다. Server request에는 승인 당시 `bindingFields` projection이 들어가고 SDK가 handler 직전 live `getContext()`와 비교한다. 값이 바뀌었으면 handler를 실행하지 않는다. `contextGuard`는 추가 방어와 진단에 사용할 수 있지만 SDK 검사를 우회하거나 수정하면 안 된다.

### Loopback 상호 인증

`ws://127.0.0.1:5746` 같은 loopback 주소도 신뢰의 근거는 아니다. Bridge가 내려간
사이에 다른 local process가 같은 port를 먼저 열 수 있기 때문이다. 공통 SDK는 다음
순서를 고정하며, 이 transport를 서비스별로 다시 구현하지 않는다.

1. SDK가 service ID와 매 연결 새 256-bit client nonce만 담은 `auth_init`을 보낸다.
2. Bridge가 새 256-bit server nonce와 server HMAC proof를 보낸다.
3. SDK는 Web Crypto로 proof를 검증한다. Proof는 protocol, `/relu/ws` audience,
   service ID, 브라우저의 exact `location.origin`, 양쪽 nonce에 묶인다.
4. 검증에 성공한 경우에만 SDK가 Context, Capability 목록과 reconnect secret을 담은
   registration을 보낸다. Raw connector token은 어떤 WebSocket message에도 넣지
   않으며, client HMAC proof에는 canonical registration의 SHA-256 digest도 포함된다.
5. Bridge가 client proof와 registration digest를 검증한 뒤에만 session을 만든다.

순서가 바뀌거나, nonce/proof/audience가 다르거나, challenge가 재생되거나, 5초 안에
끝나지 않으면 해당 socket을 닫는다. 새 연결은 항상 새 nonce를 사용하므로 캡처한
proof를 다른 연결에 재사용할 수 없다. Context는 server proof 검증 **후** 필요한 만큼만
loopback으로 전달된다. 이 방어는 port 선점에 의한 token/Context 탈취를 막지만, 같은
OS account로 browser process memory나 Bridge process를 읽는 악성 코드까지 격리하지는
못한다.

브라우저에서는 SDK가 `location.origin`을 직접 사용한다. Test runner처럼
`location`이 없는 환경에서만 `origin` option에 exact HTTP(S) Origin을 지정할 수 있으며,
브라우저에서 option을 함께 주면 `location.origin`과 정확히 같아야 한다.

Bridge core와 SDK의 인증 protocol은 같은 RELU release로 배포한다. 구형 raw-token
`hello`로 fallback하는 compatibility mode는 없다. 새 SDK/구형 Bridge 또는 구형
SDK/새 Bridge 조합은 인증에 실패하므로, 사내 canary에서 두 artifact의 digest를 함께
검증한 뒤 같은 변경 창에 배포한다.

## 4. HTTP Data Plane

Wiki, Issue DB, Log Server처럼 기존 API가 있으면 브라우저를 거치지 않고 Bridge가 정확한 endpoint에 호출한다.

```json
{
  "name": "search",
  "description": "승인된 Wiki 검색 API를 호출한다.",
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
  "outputSchema": {
    "type": "object",
    "properties": {
      "documentIds": {
        "type": "array",
        "maxItems": 50,
        "items": { "type": "string", "maxLength": 128 }
      }
    },
    "required": ["documentIds"],
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

- URL, method와 auth header 이름은 config에 고정된다.
- credential value는 process environment에서만 읽는다.
- `GET`과 `POST` JSON만 지원한다.
- redirect는 따르지 않는다.
- JSON content type, byte limit와 output schema를 모두 검사한다.
- HTTP endpoint가 꼭 필요하지 않으면 browser Capability보다 HTTP proxy를 추가하지 않는다.
- 사내 개발 HTTP가 필요할 때만 전체 `connectors.allowInsecureHttp:true`를 명시하고, production에서는 HTTPS로 되돌린다.

## 5. Token 배포

```bash
node scripts/generate-token.mjs connector
```

권장 lifecycle:

1. 서비스마다 다른 token을 발급한다.
2. Bridge host에는 secret manager로 `tokenEnv` 값을 주입한다.
3. 웹서비스에는 승인된 runtime config 또는 사용자별 local enrollment로 전달한다.
4. source, Git, query string, browser `localStorage`, audit에 저장하지 않는다.
5. 유출이 의심되면 서비스 token만 회전하고 Bridge를 재시작한다.

Connector token은 `/mcp`, `/bridge/approvals`, `/api/v1/*`의 인증에 사용할 수 없다. Control token으로도 connector client HMAC proof를 만들 수 없다.

## 6. 승인 UX

사용자는 `/admin/`에서 Capability의 service, effect, opaque session key, argument digest를 보고 승인한다.

- 반복 조회는 `현재 세션` 또는 `항상 허용`으로 매번 묻지 않게 할 수 있다.
- schema, effect, Origin, page/resource binding, connector version 또는 `policyEpoch`가 바뀌면 새 scope가 되어 다시 승인한다.
- UI/data mutation은 `operationId` 없이는 dispatch하지 않는다.
- mutation timeout/실패 응답/invalid result는 결과가 모호한 상태다. 자동 retry나 새 탭 우회를 하지 말고 `/admin/`의 변경 작업 원장에서 실제 서비스 상태를 확인한 뒤 별도 local approval로 판정한다.

## 7. 검증 체크리스트

서비스를 반입하기 전에 다음을 자동화한다.

- 정확한 Origin만 상호 인증 성공, 다른 service token/origin 조합 실패
- 잘못된 server/client proof, 다른 연결의 nonce replay와 5초 timeout이 fail-closed
- server proof 전 wire message에 raw token, Context, reconnect secret이 없음
- connector token으로 admin/MCP 호출 시 401
- unknown Capability, client 주장 effect/schema 무시 또는 거부
- input/output additional property, oversized string/array, 깊은 JSON 거부
- token/cookie/raw result가 dataDir audit/session에 기록되지 않음
- handler timeout과 AbortSignal 처리
- 최대 검색량·행 수·page size·내부 연산량 제한
- mutation `operationId`, idempotency와 ambiguous timeout 처리
- 두 탭의 Context와 approval가 서로 섞이지 않음
- 같은 resource를 연 두 탭과 process 재시작 뒤에도 operationId/ambiguous ledger가 우회되지 않음
- 승인 직후 host Context만 바뀐 경우 SDK handler 실행 횟수가 0임
- 서비스 reload/계정 전환 후 이전 approval가 자동 승계되지 않음

Repository 검증:

```bash
node ./scripts/check-syntax.mjs
node --test test/config.test.mjs test/connectors.test.mjs test/sdk.test.mjs
```
