import assert from "node:assert/strict";
import test from "node:test";

import { AlignmentError, extractFeatures, normalizeSeries, resolveLimits, validateTimeSeries } from "../index.mjs";

test("row 입력을 검증하고 scalar value를 1차원 벡터로 변환한다", () => {
  const series = validateTimeSeries([
    { timestamp: 0, value: 1 },
    { timestamp: 5, value: 3 },
    { timestamp: 9, value: 5 },
  ]);
  assert.deepEqual(series.timestamps, [0, 5, 9]);
  assert.deepEqual(series.values, [[1], [3], [5]]);
  assert.equal(series.dimensions, 1);
});

test("timestamp 단조성, 유한수, 차원 불일치를 거부한다", () => {
  const invalidInputs = [
    [
      { timestamp: 0, value: 1 },
      { timestamp: 0, value: 2 },
    ],
    [
      { timestamp: 0, value: [1, 2] },
      { timestamp: 1, value: [3] },
    ],
    [
      { timestamp: 0, value: 1 },
      { timestamp: 1, value: Number.NaN },
    ],
  ];
  for (const input of invalidInputs) {
    assert.throws(() => validateTimeSeries(input), AlignmentError);
  }
});

test("정규화는 평균을 0에 가깝게 만들고 constant channel을 기록한다", () => {
  const normalized = normalizeSeries({
    timestamps: [0, 1, 2, 3],
    values: [[10, 5], [12, 5], [14, 5], [16, 5]],
  });
  const firstMean = normalized.values.reduce((sum, row) => sum + row[0], 0) / normalized.values.length;
  assert.ok(Math.abs(firstMean) < 1e-12);
  assert.deepEqual(normalized.normalization.constantChannels, [1]);
});

test("feature 추출은 raw, delta, activity 채널을 생성한다", () => {
  const features = extractFeatures({
    timestamps: [0, 1, 2, 3, 4],
    values: [[0], [1], [1], [3], [2]],
  });
  assert.equal(features.dimensions, 1);
  assert.equal(features.featureDimensions, 3);
  assert.equal(features.values.length, 5);
  assert.ok(features.values.flat().every(Number.isFinite));
});

test("알고리즘에 필요한 최소치보다 작은 limit을 거부한다", () => {
  assert.throws(
    () => resolveLimits({ maxMappingPoints: 1 }),
    (error) => error instanceof AlignmentError && error.code === "INVALID_OPTIONS",
  );
  assert.throws(
    () => resolveLimits({ maxCoarseSamples: 7 }),
    (error) => error instanceof AlignmentError && error.code === "INVALID_OPTIONS",
  );
});
