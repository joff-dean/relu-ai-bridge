# RELU AI Bridge · Perfetto Connector #1

이 디렉터리는 Google Perfetto `v58.2` (`add693d8b338ba9599dbcbc3e300b1ab8c000897`)
소스 트리에 overlay하는 in-tree UI 플러그인이다. 공식 UI는 임의의 외부
플러그인을 runtime side-load하지 않으므로 Perfetto UI와 함께 빌드해야 한다.

## Overlay 경로

```text
이 저장소                                      Perfetto v58.2
plugin/io.company.RELUPerfettoBridge/    ->   ui/src/plugins/io.company.RELUPerfettoBridge/
perfetto_adapter/                        ->   ui/src/perfetto_adapter/
```

`ui/vite.config.mjs`가 `ui/src/plugins/*/index.ts`를 자동 발견하므로 별도의 import
barrel 수정은 필요 없다. 다만 이 플러그인은 upstream 기본 플러그인 목록에 없기
때문에 다음 중 하나가 필요하다.

1. Perfetto의 Plugins 화면에서 `io.company.RELUPerfettoBridge`를 한 번 활성화한다.
2. 사내 integration overlay가 `ui/src/core/embedder/default_plugins.ts`의
   `defaultPlugins`에 같은 ID를 추가한다.

두 번째 방법은 사내 배포본에서 자동 활성화가 필요할 때만 사용한다.

## 사용자 명령

플러그인을 활성화하면 command palette에 다음 명령이 등록된다.

- `RELU AI Bridge 연결`: token을 입력하고 loopback WebSocket에 연결한다.
- `RELU AI Bridge 연결 해제`: 자동 재연결을 중지하고 연결을 닫는다.
- `현재 trace를 REF/DUT 세션에 연결`: session ID와 역할을 선택해 bridge에
  attach 요청을 보낸다.

token은 `RELU AI Bridge 연결` command에서 입력하며 현재 Perfetto 페이지의
JavaScript 메모리에만 둔다. localStorage나 Perfetto settings에는 쓰지 않으므로
페이지 reload 뒤 다시 입력해야 한다. 같은 페이지에서 token을 입력한 뒤
`RELU AI Bridge 자동 연결`이 켜져 있으면 새 trace를 열 때 자동 연결한다. 상태
표시줄의 RELU 항목에서 연결 상태와 session/role을 확인할 수 있다.

bridge의 durable session assignment가 page reload 뒤에도 복원되도록 trace별
client ID는 현재 열린 trace plugin instance의 메모리에만 저장한다. WebSocket
재연결 동안에는 유지되지만 page reload나 trace 재오픈 시 새 ID가 생성된다.
Perfetto trace UUID는 content hash가 아니므로 UUID를 key로 권한을 복원하지 않는다.
token이나 trace 내용은 이
client ID에 포함하지 않는다.

## 보안 경계

- endpoint는 `ws://127.0.0.1:<port>/perfetto/ws`만 허용한다.
- 기본값은 `ws://127.0.0.1:5746/perfetto/ws`이다.
- URL credential, query, fragment, `localhost`, LAN 주소, 외부 hostname은
  거부한다.
- 전용 Perfetto connector token(`RELU_PERFETTO_CONNECTOR_TOKEN`)은 control/MCP token과 다르게 발급하며, source code·setting·localStorage에 저장하지 않고 현재 페이지 메모리에만 둔다.
- token 원문은 WebSocket으로 전송하지 않는다. 양쪽 fresh 256-bit nonce, exact page
  Origin, plugin ID 및 client/trace descriptor에 domain-separated HMAC-SHA-256
  proof를 계산하는 데만 사용한다.
- plugin은 server proof를 검증하기 전에는 client ID와 trace metadata도 보내지
  않는다. 따라서 Bridge가 중지된 사이 loopback port를 선점한 process가 token이나
  trace context를 수집할 수 없다.
- trace 원본 blob은 bridge로 보내지 않는다. trace 정보, 선택 구간 및 제한된
  query 결과만 전송한다.
- timestamp와 bigint는 JavaScript number로 바꾸지 않고 10진 문자열로 보낸다.
- SQL은 64 KiB, 결과는 기본 1,000행/최대 5,000행으로 제한한다. 결과 JSON은
  약 1 MB, 단일 string/blob cell은 384 KiB를 넘을 수 없다.

## WebSocket 계약 요약

인증은 socket open 직후 secret/context가 없는 `auth_challenge`로 시작한다. server와
client는 각각 fresh nonce와 HMAC proof를 증명하며, server proof가 성공한 뒤에만
`auth_response`에 client/trace descriptor를 싣는다. 전체 순서나 nonce/audience/proof가
다르거나 5초 안에 완료되지 않으면 socket을 닫고 인증 실패를 자동 재시도하지 않는다.

```text
client -> server: auth_challenge (client nonce, exact Origin/plugin audience)
server -> client: auth_challenge_ack (fresh server nonce, server proof)
client -> server: auth_response (client proof, client/trace descriptor; raw token 없음)
server -> client: hello_ack
client -> server: response, event
server -> client: request, ping
protocolVersion: "1.0"
```

지원 request method:

- `trace.getInfo`
- `selection.getArea`
- `trace.query`
- `selection.selectMappedArea`
- `session.attach`

정확한 payload 타입은 `perfetto_adapter/protocol.ts`가 단일 기준이다. request의
`id`는 성공·실패 response에 그대로 보존한다. 네트워크 단절은 500 ms부터 최대
30초까지 exponential backoff로 재연결하며, 인증 거부는 자동 재시도하지 않는다.

운영 상태 확인용 HTTP endpoint는 `GET http://127.0.0.1:5746/health`이며, trace
요청과 응답은 위 WebSocket만 사용한다. Perfetto UI를 HTTPS origin으로 제공하면
브라우저 mixed-content 정책이 `ws:`를 차단할 수 있으므로 사내 배포 가이드의
loopback HTTP UI 실행 방식을 사용해야 한다.

## upstream 자체 검증

overlay 후 Python 3.10 이상인 공식 환경에서 다음 검증을 실행한다. macOS ARM64에서는
Rosetta 2 또는 Java 11 이상 runtime도 준비한다.

```bash
tools/install-build-deps --ui
ui/run-unittests
ui/build
```

이 저장소의 테스트 파일은 overlay 시 Perfetto Vitest가 자동 발견하는
`*_unittest.ts` 형식을 사용한다.
