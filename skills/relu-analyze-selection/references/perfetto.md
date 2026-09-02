# Perfetto 선택 구간 분석

이 파일은 대상 session의 `serviceId`가 `perfetto`일 때만 읽는다.

## 선택과 trace 고정

- `perfetto_trace_info`와 `perfetto_get_selection` 또는 같은 역할의 live generic Capability로 trace와 area selection을 확인한다.
- timestamp는 나노초 integer string일 수 있다. JavaScript number나 반올림된 표시 시간으로 바꾸어 경계를 손상하지 않는다.
- 빈 selection, trace 경계 밖 범위, 잘린 trace, clock domain 차이, 수집 중단 여부를 먼저 확인한다.
- 직접 Perfetto 도구의 selector는 `clientId` 또는 `sessionId + role` 중 현재 계약이 허용한 한 방식만 쓴다.

## 조사 순서

1. 질문과 관련된 thread/process/track/counter 후보를 metadata와 선택 구간 집계로 좁힌다.
2. 넓은 구간에서는 bucket 집계나 상위 항목을 먼저 조회한다. 고해상도 row는 이상 시점 주변의 최소 범위에서만 조회한다.
3. CPU scheduling, slice, counter, process/thread lifecycle 중 실제 trace에 존재하고 질문과 관련된 신호만 교차 확인한다.
4. 같은 시간에 발생했다는 이유만으로 원인이라고 단정하지 않는다. 선후관계, 반복성, 반대 사례와 누락된 신호를 함께 제시한다.

`perfetto_query`가 노출된 경우 한 번에 하나의 `SELECT`만 사용한다. `WITH`/CTE, mutation, DDL, PRAGMA, include, side-effect function, 여러 statement는 요청하지 않는다. 응답이 잘렸다면 limit을 키우지 말고 SQL 안에서 time bucket, aggregate 또는 조건을 사용해 5,000행 이하의 판별 가능한 결과로 줄인다. 테이블·column 존재를 추측해 연속 호출하지 말고 오류와 trace 종류를 바탕으로 쿼리를 좁힌다.

각 결론에는 사용한 시간 범위, Capability 또는 query의 의미, 핵심 수치와 표본 제한을 남긴다. raw cell이 tagged bigint이면 문자열 값을 그대로 보존한다.

## REF/DUT 비교

사용자가 두 trace 비교를 요청했을 때만 REF/DUT 흐름을 사용한다.

1. live `perfetto_sessions` 계약으로 REF와 DUT binding을 확인한다.
2. 의미와 단위가 같은 timestamp/value channel을 선택하고 두 query 모두 같은 집계 규칙을 사용한다.
3. `perfetto_align`은 먼저 `applySelection:false`로 preview한다.
4. confidence와 diagnostics를 함께 검토한다. `LOW_CONFIDENCE`, `AMBIGUOUS_COARSE_MATCH`, `CONSTANT_CHANNELS`, `DTW_BAND_CONTACT` 같은 경고가 있으면 정렬 결과를 확정된 대응으로 표현하지 않는다.
5. DUT 선택 반영은 사용자가 요청한 경우에만 새 `operationId`로 수행한다. preview와 적용 결과를 구분한다.

정렬된 시각은 계산된 대응 관계이지 동일 사건의 증명은 아니다. feature 선택, sampling, clock과 trace 누락이 만든 대안 설명을 보고한다.
