# RELU AI Bridge MCP 도구 계약

## 범용 도구

Claude/Codex는 서비스 종류를 가정하기 전에 이 네 도구로 discovery한다.

| Tool | 용도 | 민감 데이터 | 로컬 정책 |
| --- | --- | --- | --- |
| `list_sessions` | 연결된 서비스와 opaque session 조회 | Context 원문 없음 | 없음 |
| `get_context` | 현재 화면의 구조화 Context 조회 | payload/document/selection 가능 | context scope 검사 |
| `list_capabilities` | 서버가 허용한 action/schema/effect 조회 | 데이터 원문 없음 | 없음 |
| `execute` | 한 Capability 실행 | parameter/result 가능 | capability scope 검사 |

새 `init` 설정은 `approvals.policy:"trusted_always"`다. `always` 결정을 허용하는
일반 보호 호출은 같은 호출에서 즉시 실행되고 pending/grant를 만들지 않는다.
`manual` 설정에서는 미승인 호출이 `APPROVAL_REQUIRED`를 반환하며 Admin에서 결정한
뒤 같은 호출을 다시 실행한다. 결과 불명 mutation 판정처럼 `once/deny`만 허용한
안전 확인은 `trusted_always`에서도 자동 통과하지 않는다.

### `list_sessions`

```json
{
  "serviceId": "battery-viewer",
  "activeOnly": true
}
```

둘 다 생략할 수 있다. 반환 session에는 `id`, `serviceId`, `serviceName`, `clientKind`, 허용된 desktop app이면 `appId`, opaque client/page/resource/session key, `active`, timestamp와 Capability 이름만 있다. `active`는 connector self-asserted 정렬 hint이므로 변경 대상을 이것만 보고 자동 선택하지 않는다. Stable instance ID, page title, URL과 Context는 없다. Perfetto client는 `perfetto:<client-id>` session으로 함께 보인다.

### `get_context`

```json
{
  "sessionId": "relu_..."
}
```

`trusted_always`에서는 별도 승인 창 없이 현재 policy scope를 검사하고 반환한다.
`manual`에서는 첫 미승인 호출이 `APPROVAL_REQUIRED`다. Generic Context는 service
`contextSchema`를 통과한 값이고, Perfetto Context는 trace info와 현재 area selection이다.

### `list_capabilities`

```json
{
  "sessionId": "relu_..."
}
```

반환:

```json
{
  "sessionId": "relu_...",
  "capabilities": [
    {
      "name": "get_stats",
      "description": "현재 선택 구간 통계",
      "readOnly": true,
      "effect": "read",
      "inputSchema": {},
      "outputSchema": {}
    }
  ]
}
```

이 목록은 browser/desktop 광고가 아니라 server registry와 인증된 client 구현의 검증된 교집합이다.

### `execute`

```json
{
  "sessionId": "relu_...",
  "action": "get_stats",
  "parameters": {}
}
```

UI/data/external mutation은 unique `operationId`가 추가로 필요하다.

```json
{
  "sessionId": "relu_...",
  "action": "focus_range",
  "parameters": { "startMs": 1000, "endMs": 2000 },
  "operationId": "focus-20260902-0001"
}
```

Bridge는 정적 input schema를 호출 전, output schema를 반환 전 검사한다. `execute`에 임의 URL, method, headers, script, selector나 command를 넣는 것은 지원되지 않는다.
`connectors.maxResultBytes`는 항목별 제한이 아니라 직렬화한 Capability 결과 전체의
합산 byte 제한이므로, array의 `maxItems`·string의 `maxLength`와 함께 적용된다.

Desktop selection 분석에서는 `get_context`가 반환한 dataset/selection revision과 전체
selection 범위를 먼저 기록한다. Bridge는 server snapshot과 `executionGuardFields`
projection을 dispatch 직전
재검사하고 .NET SDK도 handler 전후의 live Context를 비교한다. 선택이 바뀌면
connector는 내부 failure code `CONTEXT_CHANGED`를 보낸다. Core는 connector가 보낸
raw detail을 반사하지 않고 이 allowlist code를 고정 MCP 오류 문구
`Connector selection context changed; call get_context and retry`로 변환한다. Read-only
분석에서 이 문구가 보이면 이전 구간 결과와 새 구간 결과를 합치지 말고 `get_context`부터
다시 시작한다. Mutation이면 결과가 ambiguous할 수 있으므로 자동 retry하지 않고
operation ledger 판정 절차를 따른다.
명시 guard가 없는 기존 browser service는 더 엄격한 전체 Context version 검사를 계속
사용한다.

승인·변경 원장의 connector peer는 browser의 server-observed exact Origin 또는 allowlist의
desktop app ID에서 도출한 `relu-desktop://<sha256>` opaque trust-domain key다. 별도
page/application-instance binding이 실제 탭이나 desktop instance를 묶는다.
변경 operation은 policyEpoch+service+connector peer+resource+capability+operationId 원장에서 deduplicate된다. Timeout/실패처럼 결과가 모호하면 같은 resource의 후속 변경도 차단한다. `/admin/`의 변경 작업 원장에서 실제 상태를 확인하고 `once/deny` 전용 local approval을 거쳐야 해제할 수 있으며, `trusted_always`, reconnect나 새 탭으로 우회할 수 없다.

### Operation ledger 유지보수

`archive-ledger`는 MCP 도구가 아니며 AI가 실행 중 daemon을 통해 호출할 수 없다.
승인된 운영자가 모든 `pending`/`ambiguous` operation을 Admin에서 판정하고 Bridge를
중지한 뒤, 더 큰 `connectors.policyEpoch` config로 실행하는 offline CLI다.

```bash
node /absolute/path/to/relu-ai-bridge/bin/relu-ai-bridge.mjs archive-ledger
```

명령은 live `.instance-lock`, 미해결 record, 같거나 낮은 epoch, schema 또는 record ID
불일치를 거부한다. 성공 시 terminal metadata를 private archive로 옮기고 새 epoch의 빈 원장을
만든다. Raw parameter/result는 archive하지 않는다. Operation ID 중복 방어를 우회하므로
`connector-operations.json` 수동 삭제, epoch 감소, archive 없는 비어 있지 않은 원장
교체는 금지한다. 정확한 운영 순서는 [배포 가이드](DEPLOYMENT.md#connector-policyepoch과-operation-ledger-보관)를 따른다.

## Perfetto Connector #1 전용 도구

| Tool | 용도 | 변경 | 승인 |
| --- | --- | --- | --- |
| `perfetto_clients` | 연결된 탭·opaque trace key·배정 조회 | 없음 | 없음 |
| `perfetto_sessions` | REF/DUT list/get/create/attach/detach/remove | 일부 | mutation별 |
| `perfetto_trace_info` | bounded trace metadata | 없음 | trace read |
| `perfetto_get_selection` | 현재 area selection | 없음 | trace read |
| `perfetto_query` | bounded read-only PerfettoSQL | 없음 | trace read |
| `perfetto_select_area` | area 선택·focus (`operationId` 필수) | UI | trace binding |
| `perfetto_align` | REF/DUT query, 정렬, 선택적 DUT 반영 | 선택적 UI | read/apply 분리, 반영 시 `operationId` 필수 |

권장 순서:

1. `perfetto_clients`
2. `perfetto_sessions {"action":"create"}`
3. REF와 DUT 각각 `attach`
4. `perfetto_trace_info`, `perfetto_get_selection`
5. `perfetto_query`로 feature query 검증
6. `perfetto_align`을 `applySelection:false`
7. confidence/diagnostics 검토
8. 새 `operationId`와 `applySelection:true`로 DUT 반영

`perfetto_select_area`와 generic `execute(select_range)`는 같은 Perfetto trace resource와 `operationId` 원장을 공유한다. 같은 ID의 중복 dispatch, reconnect·process restart 우회가 차단되며 timeout은 `/admin/`에서 실제 선택 상태를 확인하고 판정할 때까지 ambiguous로 남는다.

`perfetto_align`은 `applySelection:false` preview에는 `operationId`가 필요 없다. 기본값을 포함해 DUT 선택을 반영할 때는 필수이며, operation을 SQL/DTW 전에 원장에 선점한다. 따라서 동일 ID의 concurrent/completed 호출은 expensive REF/DUT query를 다시 실행하지 않고, 재시작 뒤 raw 결과가 없는 completed ID도 재실행하지 않는다.

Client selector는 `clientId` 또는 `sessionId + role` 중 하나만 사용한다. 두 selector를 섞으면 거부한다.

```json
{
  "action": "attach",
  "sessionId": "trace_...",
  "role": "ref",
  "clientId": "client_..."
}
```

### PerfettoSQL

- statement 하나, 첫 keyword `SELECT`만 허용 (`WITH`/CTE는 SQLite의 암시적 재귀를 차단하기 위해 거부)
- mutation/DDL/PRAGMA/include/attach/recursive CTE 금지
- macro와 side-effect/unknown function 금지
- strict pure-function allowlist
- SQL 최대 64 KiB
- server outer SELECT가 최대 5,001행을 요청하고 5,000행 초과를 진단
- Adapter가 RELU bounded-read marker를 다시 확인
- client당 query 하나, timeout 뒤 late response 격리

Bigint cell:

```json
{
  "ts": { "type": "bigint", "value": "1234567890123" },
  "value": 42
}
```

### REF/DUT alignment

```json
{
  "sessionId": "trace_...",
  "refSql": "SELECT ts, dur AS value FROM sched WHERE utid = 101 ORDER BY ts",
  "dutSql": "SELECT ts, dur AS value FROM sched WHERE utid = 205 ORDER BY ts",
  "timestampColumn": "ts",
  "valueColumns": ["value"],
  "applySelection": false
}
```

두 결과의 timestamp는 증가하고 value channel의 순서·의미가 같아야 한다. 최대 5,000 sample/16 dimension이며 coarse/DTW/worker hard cap이 있다. Query가 잘렸으면 SQL에서 bucket/aggregate한다.

중요 결과:

```json
{
  "mappedRange": { "start": "...", "end": "..." },
  "applied": false,
  "confidence": 0.92,
  "diagnostics": { "warnings": [] }
}
```

`LOW_CONFIDENCE`, `AMBIGUOUS_COARSE_MATCH`, `CONSTANT_CHANNELS`, `DTW_BAND_CONTACT`는 사람이 검토한다.

## Optional local coding/agent 도구

| Tool | 용도 | 정책 scope |
| --- | --- | --- |
| `workspace_roots` | 승인 root 조회 | 없음 |
| `list_files` | bounded 파일 열거 | 없음 |
| `read_file` | bounded UTF-8 text read; binary는 secret redaction 우회를 막기 위해 거부 | 없음 |
| `search_files` | literal line 검색 | 없음 |
| `apply_edits` | exact-text atomic edit | `file.write:<root>:<root-policy-hash>` |
| `inspect_diff` | Git diff | 없음 |
| `run_command` | configured executable profile | `command.run:<root>:<profile>:<root-and-profile-policy-hash>` |
| `write_stdin` | interactive process 입력/종료 | command session |
| `session` | 기록, goal, compact/resume | session/action |
| `agents` | optional ChatGPT prime/worker | prime + action + immutable worker lifecycle/snapshot |
| `approval_status` | active policy와 예외 pending/manual grant 조회 | 없음 |

File 도구는 root containment와 symlink 경계를 강제한다. `protectedPaths`에 해당하는 항목은 목록·검색·읽기·diff에서 숨기거나 거부하며, edit는 protected path·byte limit과 모든 변경의 preflight를 통과한 뒤 원자적으로 적용한다. Command는 `shell:false` argument array이며 arbitrary executable은 기본 비활성이다. Named profile의 extra args와 interactive stdin은 config 작성자가 각각 명시적으로 허용한 경우에만 열리며 MCP caller가 그 값을 확대할 수 없다.

Multi-file edit는 bridge 내부 요청끼리 직렬화하고 각 파일을 commit 직전에 다시
읽어 승인 당시 내용이 유지되는지 확인한다. 다른 editor/process가 바꾼 파일은
덮어쓰지 않고 이미 적용한 bridge 변경을 가능한 범위에서 rollback한다. 이는 OS
전체 process를 잠그는 crash-atomic filesystem transaction을 의미하지 않으므로,
외부 writer와 rollback이 동시에 충돌하면 수동 diff 검토가 필요하다.

`init` 기본값에는 command profile이 없고 command 실행도 꺼져 있다. `cwd` containment는
실행 program의 OS filesystem 접근을 제한하지 않는다. Repository의 mutable script를
실행하는 `npm`/`node`/build profile은 전용 sandbox account 또는 회사 승인 wrapper
없이 등록하지 않는다. Batch와 interactive 모두 profile timeout이 강제되고 종료는
`SIGTERM → bounded grace → SIGKILL` 순서다. `maxConcurrentCommands`,
`maxConcurrentCommandsPerRoot`와 `commandSessionTtlMs`가 process/session 고갈을
제한한다.

## 승인 오류

아래 응답은 `manual`의 미승인 호출 또는 `trusted_always`에서도 자동화하지 않는
`once/deny` 전용 안전 확인에서 반환된다.

```json
{
  "error": "APPROVAL_REQUIRED",
  "approval": {
    "id": "approval_...",
    "scope": "relu.capability:<sha256>"
  }
}
```

`/admin/`에서 요청이 허용하는 `한 번`, `현재 세션`, `항상 허용`, `거부` 중 하나를
선택한 뒤 원래 호출을 재실행한다. `once`는 argument digest가 바뀌면 재사용되지 않고
소비 즉시 제거된다. `session` grant도 해당 MCP session 종료/만료 또는 Bridge 재시작
때 제거된다. `trusted_always`의 구성 기반 허용은 개별 grant가 아니어서 이 목록에서
철회하지 않으며, `manual`로 정책을 바꾸고 Bridge를 재시작하면 비활성화된다.
