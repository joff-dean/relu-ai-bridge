import assert from "node:assert/strict";
import test from "node:test";

import {
  AlignmentAbortError,
  AlignmentError,
  alignSelection,
  alignTimeSeries,
  constrainedDtw,
  extractFeatures,
  findCoarseCandidates,
  mapRefToDut,
} from "../index.mjs";
import { createSyntheticTracePair } from "./fixtures/synthetic-trace.mjs";

test("coarse correlation은 실제 DUT 구간과 가까운 후보를 찾는다", () => {
  const fixture = createSyntheticTracePair();
  const selection = { start: 400, end: 2_400 };
  const selectedRows = fixture.referenceRows.filter((row) => row.timestamp >= selection.start && row.timestamp <= selection.end);
  const referenceFeatures = extractFeatures(selectedRows);
  const dutFeatures = extractFeatures(fixture.dutRows);
  const result = findCoarseCandidates(referenceFeatures, dutFeatures, { probeCount: 96 });
  const best = result.candidates[0];
  assert.ok(Math.abs(best.dutStart - fixture.expectedMap(selection.start)) < 180, JSON.stringify(best));
  assert.ok(Math.abs(best.dutEnd - fixture.expectedMap(selection.end)) < 220, JSON.stringify(best));
  assert.ok(best.score > 0.65, `coarse score=${best.score}`);
});

test("constrained DTW path는 두 시간축에서 단조 증가한다", () => {
  const fixture = createSyntheticTracePair();
  const reference = extractFeatures(fixture.referenceRows);
  const dut = extractFeatures(fixture.dutRows);
  const candidate = {
    dutStart: fixture.expectedMap(0) - 25,
    dutEnd: fixture.expectedMap(fixture.metadata.referenceDuration) + 25,
  };
  const result = constrainedDtw(reference, dut, candidate);
  assert.ok(result.path.length >= reference.timestamps.length);
  for (let index = 1; index < result.path.length; index += 1) {
    assert.ok(result.path[index].referenceTime >= result.path[index - 1].referenceTime);
    assert.ok(result.path[index].dutTime >= result.path[index - 1].dutTime);
  }
  assert.ok(result.normalizedCost < 1.2, `DTW cost=${result.normalizedCost}`);
});

test("alignSelection은 REF 선택 범위를 DUT 범위로 자동 매핑한다", () => {
  const fixture = createSyntheticTracePair();
  const selection = { start: 400, end: 2_400 };
  const result = alignSelection({
    referenceRows: fixture.referenceRows,
    dutRows: fixture.dutRows,
    selection,
  });
  const expectedStart = fixture.expectedMap(selection.start);
  const expectedEnd = fixture.expectedMap(selection.end);
  assert.ok(Math.abs(result.mappedRange.start - expectedStart) < 85, JSON.stringify({ result: result.mappedRange, expectedStart }));
  assert.ok(Math.abs(result.mappedRange.end - expectedEnd) < 85, JSON.stringify({ result: result.mappedRange, expectedEnd }));
  assert.ok(result.confidence >= 0.55, `confidence=${result.confidence}`);
  assert.ok(result.diagnostics.coarse.candidates.length >= 1);
  assert.ok(result.mapping.points.length >= 2);
  assert.ok(Math.abs(mapRefToDut(result.mapping, 1_400) - fixture.expectedMap(1_400)) < 100);
});

test("alignTimeSeries는 scalar column 입력도 처리한다", () => {
  const timestamps = Array.from({ length: 80 }, (_, index) => index * 5);
  const reference = { timestamps, values: timestamps.map((time) => Math.sin(time * 0.04) + 0.2 * Math.cos(time * 0.13)) };
  const dutTimestamps = Array.from({ length: 120 }, (_, index) => 1_000 + index * 5);
  const dut = {
    timestamps: dutTimestamps,
    values: dutTimestamps.map((time, index) => {
      if (index >= 20 && index < 100) return reference.values[index - 20] * 1.4 + 0.5;
      return 0.2 * Math.sin(index * 0.9);
    }),
  };
  const result = alignTimeSeries(reference, dut, { features: { mode: "raw+delta" } });
  assert.ok(Math.abs(result.mappedRange.start - 1_100) < 30);
  assert.ok(Math.abs(result.mappedRange.end - 1_495) < 30);
});

test("사전 취소된 AbortSignal을 즉시 거부한다", () => {
  const fixture = createSyntheticTracePair({ referenceSamples: 40 });
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => alignTimeSeries(fixture.referenceRows, fixture.dutRows, { signal: controller.signal }),
    (error) => error instanceof AlignmentAbortError && error.code === "ALIGNMENT_ABORTED",
  );
});

test("DTW cell 제한을 넘으면 명시적 오류를 반환한다", () => {
  const fixture = createSyntheticTracePair({ referenceSamples: 100 });
  assert.throws(
    () => alignTimeSeries(fixture.referenceRows, fixture.dutRows, {
      limits: { maxDtwCells: 32 },
      fineCandidateCount: 1,
    }),
    (error) => error instanceof AlignmentError && error.code === "LIMIT_EXCEEDED",
  );
});

test("상수 신호는 높은 confidence로 오인하지 않는다", () => {
  const reference = Array.from({ length: 30 }, (_, index) => ({ timestamp: index, value: 7 }));
  const dut = Array.from({ length: 50 }, (_, index) => ({ timestamp: 100 + index, value: 11 }));
  const result = alignTimeSeries(reference, dut, { fineCandidateCount: 1 });
  assert.equal(result.confidence, 0);
  assert.ok(result.diagnostics.warnings.includes("CONSTANT_CHANNELS"));
  assert.ok(result.diagnostics.warnings.includes("LOW_CONFIDENCE"));
});
