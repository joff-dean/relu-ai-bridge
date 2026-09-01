# REF/DUT 자동 정렬 엔진

이 디렉터리는 Perfetto에서 추출한 REF 선택 구간과 DUT 검색 구간을 자동으로 대응시키는 순수 JavaScript(ESM) 모듈이다. 런타임 의존성이 없고 네트워크·파일·프로세스 API를 호출하지 않는다. Node.js에서 `alignment/index.mjs`를 직접 import할 수 있다.

## 가장 단순한 사용법

```js
import { alignSelection } from "./alignment/index.mjs";

const result = alignSelection({
  referenceRows: [
    { timestamp: 0, value: [12, 3] },
    { timestamp: 10, value: [18, 5] },
    // ...
  ],
  dutRows: [
    { timestamp: 50_000, value: [9, 1] },
    { timestamp: 50_010, value: [13, 4] },
    // ...
  ],
  selection: { start: 0, end: 10_000 },
}, {
  signal: abortController.signal,
});

console.log(result.mappedRange); // { start: DUT 시작 시각, end: DUT 종료 시각 }
console.log(result.confidence);  // 0~1
console.log(result.diagnostics);
```

`referenceRows`와 `dutRows`는 `{ timestamp, value }` row 배열이다. `value`에는 숫자 하나 또는 동일 차원의 숫자 배열을 넣는다. 저수준 `alignTimeSeries()`는 같은 row 배열뿐 아니라 `{ timestamps, values }` column 형식도 받는다.

반환값의 핵심 항목은 다음과 같다.

- `mappedRange`: REF 선택 범위에 대응하는 DUT 시작·끝 시각
- `mapping.points`: `{ refTime, dutTime }` piecewise linear 좌표
- `confidence`: coarse 유사도, DTW 비용, 후보 고유성, 경로 품질을 합친 0~1 점수
- `diagnostics`: 입력 크기, 후보, DTW cell/path 통계, 경고, 소요 시간과 연산량

`mapRefToDut()`, `mapDutToRef()`, `createTimeMapper()`로 선택 범위 내부의 임의 시각도 변환할 수 있다.

## 처리 단계

1. timestamp 엄격 증가, 유한수, 차원, 크기 제한을 검증한다.
2. 채널별 표준화 후 원본·시간 보정 delta·activity feature를 만든다.
3. 여러 시간 scale에서 정규화 cross-correlation을 계산해 DUT 후보 구간을 찾는다.
4. 상위 후보에 Sakoe-Chiba 형태의 제한 band와 열린 DUT 양 끝점을 적용한 DTW를 수행한다.
5. 단조 DTW path를 piecewise linear time mapping으로 축약한다.
6. 유사도와 모호성을 포함한 confidence 및 진단 정보를 반환한다.

## 공개 API

`index.mjs`는 다음 API를 export한다.

- 상위 API: `alignSelection`, `alignTimeSeries`
- 전처리: `validateTimeSeries`, `normalizeSeries`, `extractFeatures`, `selectTimeRange`
- 알고리즘: `findCoarseCandidates`, `constrainedDtw`, `buildTimeMapping`
- 시간 변환: `mapRefToDut`, `mapDutToRef`, `createTimeMapper`
- 제한·오류: `MIN_LIMITS`, `DEFAULT_LIMITS`, `HARD_LIMITS`, `resolveLimits`, `AlignmentError`, `AlignmentAbortError`

## 제한과 취소

기본 제한은 `DEFAULT_LIMITS`에 선언되어 있다. 샘플 수, 차원, feature 값 수, coarse 연산 수, DTW cell 수, mapping point 수, 총 연산량과 실행 시간을 제한한다. 호출자가 `options.limits`로 기본값을 조정할 수 있지만 `HARD_LIMITS`보다 크게 올릴 수 없다. 이 제한은 비정상적으로 큰 SQL 결과가 로컬 프로세스의 CPU와 메모리를 독점하지 못하게 하는 방어선이다.

`options.signal`에 `AbortSignal`을 전달하면 주요 반복 구간의 checkpoint에서 `AlignmentAbortError`가 발생한다. 이 API는 동기식이므로 이벤트 루프가 실행 중인 계산을 중간에 깨우지는 못한다. 다른 작업에서 취소해야 한다면 Worker thread 안에서 실행하고 signal 상태를 공유하거나 작업 시작 전에 abort해야 한다.

## 성능 특성

- feature 추출: `O((REF + DUT) × 채널 수)`
- coarse 탐색: 최대 `maxCoarseOperations`
- 제한 DTW: `O(REF 샘플 × band 폭)`, 최대 `maxDtwCells`
- path 및 mapping 메모리: DTW cell과 path 길이에 비례

입력이 기본 `maxDtwSamples`보다 크면 균일 시간축으로 downsample한다. 이 경우 `diagnostics.warnings`에 `DTW_DOWNSAMPLED`가 포함된다. 짧은 spike가 중요한 trace는 Perfetto SQL 단계에서 의미 있는 bucket 통계(max, count, running/runnable 등)를 여러 채널로 제공하는 편이 안전하다.

## 정확도와 보안 주의사항

- timestamp는 `Number`이며 절댓값이 `Number.MAX_SAFE_INTEGER` 이하여야 한다. Perfetto의 큰 나노초 값을 직접 넣기보다 trace 시작 시각을 빼서 상대 시간으로 변환하고, 결과에 origin을 다시 더한다.
- REF와 DUT의 value 차원 및 채널 의미·순서는 같아야 한다.
- 기본 scale 탐색 범위는 0.7~1.4다. 실제 시간 차이가 더 크면 `options.coarse.minScale/maxScale`을 명시한다.
- 반복 패턴, 상수 신호, 지나치게 짧은 선택은 유일한 대응 구간을 보장하지 않는다. `confidence`만 믿지 말고 `AMBIGUOUS_COARSE_MATCH`, `LOW_CONFIDENCE`, `DTW_BAND_CONTACT` 경고를 함께 확인한다.
- 이 엔진은 데이터 유사도를 계산할 뿐 선택을 승인하거나 로컬 권한을 확대하지 않는다. SQL row는 신뢰하지 않는 입력으로 취급되며 문자열을 실행하지 않는다.

## 테스트

```bash
node --test alignment/test/*.test.mjs
```

fixture는 offset, 선형 scale, 비선형 시간 warp, 진폭 변화와 결정적 noise를 포함한다.
