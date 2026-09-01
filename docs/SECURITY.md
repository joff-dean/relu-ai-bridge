# RELU AI Bridge 보안 모델

RELU는 모델, browser content, trace/API 응답과 imported artifact를 모두 신뢰하지 않는다. Local Bridge가 사내 서비스의 만능 proxy가 되지 않는 것이 최우선 invariant다.

## 기본 위협 모델

공격자는 다음 중 하나일 수 있다.

- prompt injection을 포함한 모델 입력·출력
- 손상된 사내 웹페이지 또는 제3자 script
- 악성/과대 Context, Capability parameter와 result
- 유출된 한 서비스의 connector token
- 응답이 늦거나 취소를 지원하지 않는 Data Plane
- 변조되거나 추가 object를 포함한 release bundle
- 다른 탭/session/account의 grant를 재사용하려는 caller
- Bridge가 중지된 사이 loopback port를 선점해 connector/Companion credential이나 Context를 받으려는 같은 장비 process

OS account 전체 탈취, 악성 Node binary, 회사 secret manager 자체 침해는 이 process 내부만으로 방어하지 못한다.

## 네트워크 경계

- Server bind는 `127.0.0.1` 또는 `::1`만 허용한다.
- Host header도 `localhost`, `127.0.0.1`, `[::1]`과 유효 port만 허용한다.
- `/relu/ws`와 `/perfetto/ws`는 exact Origin이 반드시 있어야 한다.
- Generic connector Origin은 service별로 다시 일치시킨다.
- HTTP control CORS, generic connector Origin, Perfetto Origin은 서로 다른 목록이다.
- Generic/Perfetto WebSocket은 client/server fresh nonce와 audience·Origin에 묶인 HMAC proof를 먼저 교환한다. Raw connector token은 wire에 보내지 않으며, Context·reconnect secret·Perfetto trace descriptor는 server proof 검증 전에는 보내지 않는다.
- MCP/admin/control API는 Bearer control token이 필요하다.
- 허용된 Chrome Companion은 요청마다 `/bridge/challenge`의 server proof를 먼저 검증하고 path/method/body digest에 묶인 one-shot client proof를 보낸다. Raw control token은 Companion HTTP request에 포함하지 않는다.
- HTTP Data Plane은 exact config URL에만 연결하고 redirect를 따르지 않는다.
- RELU port를 LAN/인터넷에 직접 publish하지 않는다.

`mcpAuth:path`는 제한된 client 호환용이다. Token이 URL path·proxy log·history에 남을 위험이 있으므로 Bearer를 기본으로 사용한다.

표준 Streamable HTTP MCP와 browser Admin UI의 Bearer 방식은 plain loopback 위에서
server certificate pinning을 제공하지 않는다. 이 두 client는 관리형 service가 먼저
정확한 port를 소유했음을 supervisor/PID로 확인하고 `/health`가 기대한 제품/version인지 확인된 상태에서만
연결한다. RELU가 중지되었는데 다른 local process가 그 port를 점유하면 MCP/Admin에
token을 입력하거나 재연결하지 말고 process를 조사한 뒤 token을 회전한다. 같은 OS
사용자 권한으로 악성 process를 실행할 수 있는 상황 자체는 application 내부
sandbox 경계 밖이다. Connector와 packaged Chrome Companion에는 이 잔여 위험을
줄이는 별도 HMAC server proof가 있다.

## Credential 분리

| Credential | 허용 audience | 금지 |
| --- | --- | --- |
| `RELU_AI_BRIDGE_TOKEN` | MCP, admin/control API | 모든 connector proof, 외부 API |
| `perfetto.tokenEnv` | `/perfetto/ws` + exact Perfetto Origin/plugin HMAC proof | MCP, admin, generic service, 외부 API |
| service `tokenEnv` | 해당 service ID + exact Origin generic HMAC proof | MCP, 승인 API, 다른 service |
| HTTP `auth.env` | 해당 고정 Data Plane request header | MCP/browser/result/audit |

Perfetto와 generic service token은 최소 24자이며 audience마다 다르게 발급한다. Token을 Git, config JSON, URL, `localStorage`, transcript와 audit에 넣지 않는다. Perfetto plugin은 전용 token을 setting에 등록하지 않고 현재 페이지의 JavaScript 메모리에만 두므로 reload 뒤 다시 입력해야 한다. Admin UI는 control token을 해당 탭의 `sessionStorage`에, 선택형 Chrome companion은 `chrome.storage.session`에만 두므로 브라우저 재시작 뒤 다시 입력해야 한다. Companion 저장 token은 HMAC key로만 사용되고 bearer 값 자체는 loopback request에 실리지 않는다.

Startup은 Perfetto/service token과 HTTP auth env 값을 normalized in-memory config에 로드해 audience 검사와 redaction에 함께 사용한다. 이 normalized config 객체를 API, 오류, diagnostic dump나 JSON 파일로 직렬화하면 안 된다. Public Capability 변환은 HTTP credential value를 제거한다. Control, Perfetto, generic service, HTTP API와 remote Goal credential은 값과 audience를 재사용할 수 없다.

## Registry authority와 no-proxy invariant

Capability의 이름, schema, effect, transport, endpoint, method, auth header env, timeout과 concurrency는 server config가 결정한다. Browser는 handler 구현 목록만 알린다.

다음 기능은 의도적으로 없다.

```text
execute_http(url, method, headers, body)
execute_sql(connection, sql)
run_script(code)
navigate(url)
click(selector)
read_cookie()
load_manifest(url)
```

Input schema는 proxy-shaped field를 startup에서 거부한다. HTTP destination은 AI parameter로 조합되지 않는다. GET query value/POST JSON body만 schema에 따라 전달한다.

## Schema와 resource 제한

Config schema는 지원 keyword whitelist를 사용한다. 미지원 keyword를 조용히 무시하지 않는다.

- object: `properties`, `required`, `additionalProperties:false`
- array: `items`, 필수 `maxItems`, 선택 `minItems`
- string: 필수 `maxLength`, 선택 `minLength` (`pattern`은 ReDoS 경계를 피하기 위해 지원하지 않음)
- integer/number: finite value와 minimum/maximum
- boolean과 bounded enum

Runtime은 input/context/result 양쪽에 다음 상한을 적용한다.

- WebSocket message bytes
- Context/result/request bytes
- JSON depth/node/key/string 크기
- Session 수, session당 outstanding request, capability concurrency
- Capability timeout
- HTTP response stream bytes

`read`는 integrity effect가 없다는 뜻이지 CPU/availability-safe라는 뜻이 아니다. Connector handler/API도 query cardinality, page size, scan 범위, regex/aggregation과 내부 CPU budget을 별도로 제한해야 한다.

## 승인

모든 generic Context read와 Capability execute는 기본적으로 local approval을 거친다. MCP annotation의 `readOnlyHint`는 설명용이며 dispatch gate가 아니다.

Approval scope tuple:

```text
version + kind + connectorId + exact server-observed Origin
+ random page-instance binding + bindingFields resource binding
+ connector version + capabilityId + transport + fixed HTTP descriptor
+ input/output schema hash + server-owned effect + policyEpoch
```

Tuple은 key 정렬 canonical JSON 후 SHA-256으로 scope를 만든다. Delimiter·Unicode 문자열 조립 충돌이나 prefix match를 사용하지 않는다.

- `once`: 같은 MCP session의 scope + arguments digest + operation ID가 같은 요청 한 번
- `session`: pending 생성 시 서버가 검증한 Claude/Codex MCP session ID
- `always`: exact scope
- `deny`: grant 없음

Approval decision body가 session ID를 바꿀 수 없다. Pending은 TTL과 총 개수 상한이 있다. `once` grant는 소비와 동시에 제거되고 `session` grant는 MCP session 종료·만료 또는 process 재시작 때 제거된다. Grant는 `/admin/`에서 철회할 수 있다. Schema/effect/Origin/page/resource binding/connector version/policy epoch 변경은 기존 grant를 자동으로 무효화한다. 파일은 canonical root·read-only·protected pattern 정책, command는 해당 root와 정규화된 profile 전체가 scope 지문에 들어가므로 같은 ID/이름으로 설정 대상을 교체해도 영구 grant를 재사용할 수 없다.

승인 전에 input을 byte/depth/node/schema로 검증하고 target snapshot을 만든다. 승인 뒤에는 같은 connection generation, Context version, page/resource binding과 capability인지 다시 검사한다. Browser request에는 `bindingFields` projection guard가 포함되며 SDK는 handler 호출 직전 live `getContext()`와 비교한다. 불일치하면 handler를 한 번도 실행하지 않고 `CONTEXT_CHANGED`로 거부한다.

보안 때문에 browser reload는 새 page instance다. 반복 호출 중 `현재 세션` 또는 `항상 허용`은 매번 묻지 않지만 다른 탭·reload에 자동 승계하지 않는다.

## Mutation과 timeout

`ui_mutation`, `data_mutation`, `external_side_effect`에는 안전한 ASCII 8~128자의 `operationId`가 필요하다. HTTP transport에는 `Idempotency-Key`로 전달한다. Bridge와 SDK는 timed-out 요청을 자동 재전송하지 않는다.

Operation key는 탭 ID가 아니라 `policyEpoch + service + Origin + bindingFields resource + capability + operationId`다. Perfetto 선택 변경에서는 exact Origin과 stable trace resource binding이 resource를 구성하며 generic `select_range`, 전용 `perfetto_select_area`, 선택을 반영하는 `perfetto_align`이 같은 원장을 사용한다. 같은 ID/같은 argument는 한 번만 dispatch하고, 같은 ID/다른 argument는 거부한다. Applied alignment는 SQL/DTW 전에 pending을 영속화하므로 concurrent duplicate도 expensive query를 반복하지 않는다. Pending/ambiguous/completed metadata는 private atomic `connector-operations.json`에 저장되며 process 재시작 시 pending은 ambiguous로 복구된다. Raw result는 영속 원장에 저장하지 않고 메모리 결과 cache도 총 16 MiB로 제한한다.

Perfetto read/query/select/align은 승인 전에 client/trace/connection과 REF/DUT role assignment snapshot을 잡고 승인 직후 다시 검사한다. 같은 client ID가 다른 connection이나 trace로 교체되었거나 durable role이 재배정되면 전송하지 않는다.

Browser/HTTP mutation의 timeout, disconnect, invalid result와 실패 응답은 side effect 발생 여부를 증명하지 못하므로 ambiguous다. 같은 resource/capability의 새 operation도 차단한다. `/admin/`에서 실제 상태를 확인한 뒤 별도의 local once approval로 `confirmed_applied` 또는 `confirmed_not_applied`를 선택해야 한다. Reconciliation 중 남은 browser tombstone은 연결을 닫아 재접속 전에는 다시 dispatch할 수 없다.

원장 capacity를 비우기 위해 record를 자동 만료하거나 파일을 삭제하지 않는다. 모든
미해결 작업을 판정하고 Bridge를 중지한 뒤, 더 큰 `policyEpoch`가 들어 있는 검토된
config로 `archive-ledger`를 실행해야 한다. 명령은 daemon lock, terminal-only 상태,
schema/ID, epoch 증가와 archive 재읽기를 확인한 뒤에만 빈 새 세대로 교체한다.
`policyEpoch`는 rollback 때도 감소시키지 않는다. Archive의 canonical ledger digest는
Bridge 밖의 변경 티켓에 기록해야 이후 파일 변조를 독립적으로 대조할 수 있다. 이
검사는 OS account나 dataDir을 장악한 공격자에 대한 암호학적 서명/MAC을 대신하지 않는다.

초기 사내 rollout은 `read`와 좁은 `ui_mutation`만 허용하고 data/external mutation은 별도 보안 검토를 권장한다.

## Privacy와 audit

Public session list는 service, opaque key, time, Capability 이름만 반환한다. `active`는 browser self-asserted hint이며 authorization이나 mutation target 자동 선택에 사용하지 않는다. Context, title, URL, payload ID와 selection은 `get_context` 승인 뒤에만 반환한다.

기본값:

```json
{
  "recordAudit": true,
  "recordSessions": false,
  "recordToolArguments": false,
  "recordToolResults": false
}
```

Audit는 category, action, service/capability ID, opaque binding, status, duration 같은 metadata만 남긴다. 자동 ChatGPT 대화 event는 `permissions.sessions`와 `privacy.recordSessions`가 모두 켜진 경우에만 session 파일에 기록되며, text와 metadata key/value에 bounded recursive redaction을 적용한다. 둘 중 하나라도 꺼지면 transcript는 Goal 판정에 필요한 동안 process memory에만 존재하고 재시작 시 폐기된다.

둘 중 하나라도 꺼진 private session의 durable 파일에는 opaque session ID, control token HMAC 기반 conversation key, 명시적 Goal과 Compact & Resume handoff text만 남는다. Raw title, conversation ID/URL, prime ID, browser event/metadata와 replacement ID/URL은 volatile binding이며 시작 시 legacy 파일에서도 scrub한다. HMAC은 원문 ID를 복원할 수 없고 동일 control token 아래에서 equality match만 제공한다. Control token 회전은 기존 자동 match를 끊으므로 opaque session ID를 사용한 명시적 Resume/rebind가 필요하다. Remote connector error text와 HTTP error body는 MCP/audit에 반사하지 않는다. Redactor는 token/secret/password/authorization/API-key 이름을 가린다.

Private session 조건은 browser multi-agent 상태에도 동일하게 적용된다. 이때
`agents.json`은 HMAC prime/conversation key, worker ID·상태·timestamp와 cursor만
허용한다. Worker task/label, 후속 message, result, raw prime/conversation ID·URL,
browser client ID와 pending command payload는 메모리에서만 사용한다. 프로세스가
재시작되면 pending command를 폐기하고 active worker를 sleeping 상태로 복원하므로
민감한 payload를 디스크에서 재구성하거나 빈 payload를 자동 전송하지 않는다.
Worker tab이 다시 register해 volatile binding을 복구하기 전에는 follow-up 전송을
거부한다. 초기화는 기존 평문 `agents.json`도 allowlist schema로 원자적으로
덮어쓴다. Retired worker ID는 같은 prime에서 영구 예약되어 교체 worker에 재사용할
수 없고, message/report/clear 승인은 승인 당시 worker 또는 worker-set snapshot에
결합된다. 늦은 register/report도 retired worker를 되살리지 못한다.

AI client가 Context/result를 읽으면 그 데이터는 해당 모델 제공자에 전달될 수 있다. RELU가 local-first라는 것은 모델 자체가 local이라는 뜻이 아니다. 회사가 승인한 Claude/AI workspace와 데이터 등급 정책을 적용한다.

Goal evaluator는 기본 `local` 모드이며 completion marker만 확인한다. 명시적으로 `goal.mode:remote`를 켜면 최근 bounded transcript가 설정에 고정된 credential-free HTTPS endpoint로 전송된다. 이 옵션은 별도 회사 승인과 전용 credential이 필요하고 redirect를 따르지 않으며 response도 64 KiB로 제한한다. Control/service/API credential과 같은 값을 재사용할 수 없다.

Bridge의 실제 `configPath`와 `dataDir` 전체는 approved root와 겹치더라도 예약 영역이다. 파일 list/search/read/diff/write 도구는 이 절대 경로를 항상 제외하거나 거부하므로, persistent grant로 설정·승인 원장·세션 상태를 수정해 다음 재시작 권한을 확대할 수 없다.

## Local 파일·명령 도구

Optional coding 도구는 Connector와 독립된 기존 경계를 유지한다.

`init`이 만드는 설정은 root `readOnly:true`, `write:false`, `commands:false`,
`goalLoop:false`, `multiAgent:false`, 빈 command profile/사전 승인으로 시작한다.
승인 grant는 비활성 permission을 켜지 못한다.

- 승인 root canonical containment
- direct symlink 거부
- `.git`, workflow, env, secret/credential protected pattern
- read/write/search/output byte 상한
- exact-text atomic multi-file edit
- executable+argument array, `shell:false`
- arbitrary command 기본 비활성
- sanitized environment와 timeout
- batch/interactive 공통 timeout, `SIGTERM` 뒤 bounded grace와 `SIGKILL`
- 전역·root별 동시 실행 상한과 완료 interactive session TTL
- root/profile 정책 지문 단위 승인

Connector Capability가 이 도구를 호출하거나 권한을 확장할 수 없다.

중요하게, command의 root `cwd`는 OS filesystem sandbox가 아니다. 실행한 program은
RELU process 사용자에게 허용된 root 밖 파일·network·credential store에도 접근할
수 있다. 특히 `npm test`, `node <repo-script>`, build tool처럼 승인 root가 내용을
바꿀 수 있는 코드를 실행하는 profile은 해당 저장소 코드에 **OS account 전체
권한을 위임**한다. 이런 profile은 일반 persistent grant 대상으로 만들지 않는다.
필요하면 전용 low-privilege 계정/container/sandbox wrapper에서 root와 egress를
제한하고, immutable 절대경로 wrapper만 profile program으로 등록한다.

Bridge는 `dataDir/.instance-lock`으로 하나의 data directory에 한 process만 허용한다.
따라서 별도 process의 stale in-memory approval snapshot이 철회된 grant를 다시 쓰는
구성을 거부한다. Session/audit retention은 startup뿐 아니라 실행 중 6시간마다
적용된다.

## Perfetto 전용 방어

- `/perfetto/ws` exact Origin과 raw token 없는 nonce/HMAC 상호 인증
- server-owned closed method set
- page-load random client identity와 trace binding
- SELECT-only lexer, CTE 금지, forbidden keyword/macro/function
- pure function allowlist와 recursive CTE 금지
- outer SELECT row cap marker를 adapter가 재검증
- SQL 64 KiB, result 5,000행, WebSocket 2 MiB
- client당 one query, timeout late response 격리
- integer-string timestamp와 tagged bigint
- alignment Worker의 sample/dimension/cell/operation/time cap

Generic `execute(query_sql)`은 이 경로를 우회하지 않고 `perfetto_query`로 위임한다.

## 운영 hardening

- 전용 low-privilege OS account 또는 user service
- dataDir/config/secret file mode `0700/0600`
- Node와 release artifact hash 고정
- macOS launchd/systemd sandbox 예제 검토
- endpoint egress allowlist와 internal TLS
- service token/API credential 주기 회전
- 검토된 `policyEpoch` 단조 증가로 Connector grant 전체 재승인; 감소·재사용 금지
- default privacy 유지와 짧은 retention
- `/health`와 connection count 감시, raw Context/result 수집 금지

## 사고 대응

1. Bridge process와 관련 Connector를 중지한다.
2. 유출 범위에 맞춰 control/service/API credential을 각각 회전한다.
3. `approvals.json` grant를 철회하거나 안전하게 백업 후 제거한다.
4. audit에서 metadata 중심으로 service/capability/time 범위를 확인한다.
5. config, release tag/SHA와 internal mirror immutability를 재검증한다.
6. 원인을 synthetic fixture로 일반화해 외부 regression test에 추가한다. 회사 data/hostname/diff는 외부로 반출하지 않는다.
