# Perfetto v58 Adapter

`PerfettoV58Adapter`는 RELU AI Bridge 기능이 Perfetto UI 내부 구현에 직접 의존하지
않도록 공개 API를 한곳에서 감싼다. 유일한 검증 기준은 공식 tag `v58.2`, commit
`add693d8b338ba9599dbcbc3e300b1ab8c000897`이다.

## 사용하는 v58.2 공개 API

- `Trace.traceInfo`: trace UUID, 제목, 시간 범위 및 trace 형식
- `Trace.engine.query(sql)`: Trace Processor SQL 실행
- `Trace.selection.selection`: 현재 area selection 조회
- `Trace.selection.selectArea(...)`: mapped DUT 구간 선택 및 focus
- `Time.fromRaw(bigint)`: 나노초 timestamp를 Perfetto branded time으로 변환

Perfetto source tree에서의 배치 경로는 `ui/src/perfetto_adapter/`이다. 따라서
adapter의 import `../../public/trace`, `../../base/time`,
`../../trace_processor/query_result`는 v58.2 실제 경로에 대응한다.

## 데이터 표현 규칙

- trace timestamp: 10진 문자열
- SQL bigint: `{ "type": "bigint", "value": "..." }`
- SQL blob: `{ "type": "blob", "base64": "..." }`
- SQL string/number/null: JSON primitive

이 규칙은 정밀도 손실과 `JSON.stringify(BigInt)` 오류를 방지한다.

## 상호 인증 계약

`protocol.ts`는 payload 타입뿐 아니라 Node broker와 browser plugin이 동일하게
계산하는 canonical HMAC transcript도 정의한다. 첫 `auth_challenge`에는 fresh client
nonce와 exact Origin/plugin audience만 있으며 token·client ID·trace metadata는 없다.
plugin은 fresh server nonce와 server proof를 확인한 뒤에만 client proof와 trace
descriptor를 보낸다. Raw token은 wire에 보내지 않으며 replay, 순서 변경, audience
변경, 잘못된 proof와 timeout은 모두 fail closed한다.

## 버전 업그레이드

Perfetto 기준선을 올릴 때는 하위 호환 alias를 남기지 않고 단일 버전 adapter를
교체한다. 새 기준선의 exact tag/commit에서 다음 항목을 모두 다시 검증한다.

1. `Trace`, `SelectionManager`, `Engine`, `QueryResult`, `Time` import 경로
2. area selection의 `kind`, `start`, `end`, `trackUris` 필드
3. `selectArea`의 `SelectionOpts`
4. query iterator의 `columns()`, `iter({})`, `get()` 동작
5. 전체 UI strict TypeScript build와 adapter/plugin 단위 테스트

사내 fork 전용 차이는 이 범용 adapter에 넣지 않고 사내 integration 계층의
별도 compatibility patch로 유지한다.
