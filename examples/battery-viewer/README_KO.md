# Battery Viewer 커넥터 예제

이 예제는 기존 Android 로그 시각화 서비스에 RELU AI Bridge의 Context Plane을 붙이는 최소 형태다. 실제 통계 함수와 UI 이동 함수는 기존 서비스가 제공하고, SDK는 연결·등록·heartbeat·context 갱신·요청 응답만 담당한다.

1. `config/battery-viewer.service.example.json`을 검토해 주 설정의 `connectors.services`에 추가한다.
2. `node scripts/generate-token.mjs connector`로 서비스 전용 token을 만들고 `RELU_BATTERY_CONNECTOR_TOKEN`에 주입한다.
3. 같은 token을 승인된 런타임 설정을 통해 브라우저 앱의 `installBatteryViewerConnector()`에 전달한다. Git, URL, `localStorage`에는 넣지 않는다.
4. `viewer` adapter에 `getPayloadId`, `getCurrentView`, `getSelection`, `getBoundedStats`, `focusRange`와 이벤트 hook을 구현한다.
5. 서비스의 정확한 scheme/host/port를 `origins`에 등록한다.

예제 registry의 `bindingFields:["payloadId"]`는 승인과 mutation 원장을 현재 payload에 묶는다. SDK는 각 handler 직전에 live payloadId를 승인 당시 projection과 비교하므로 payload 전환 직후의 stale 요청을 실행하지 않는다.

`search_logs`는 브라우저 handler가 아니라 Bridge의 고정 HTTP Data Plane 예제다. AI나 브라우저가 URL·method·header를 선택하지 못하며, API credential은 Bridge process 환경변수에만 존재한다.
