import assert from "node:assert/strict";
import test from "node:test";

import { AlignmentError, buildTimeMapping, createTimeMapper, mapDutToRef, mapRefToDut } from "../index.mjs";

const path = [
  { referenceTime: 0, dutTime: 100 },
  { referenceTime: 10, dutTime: 111 },
  { referenceTime: 20, dutTime: 124 },
  { referenceTime: 30, dutTime: 139 },
];

test("piecewise mapping은 양방향 보간과 clamp를 지원한다", () => {
  const mapping = buildTimeMapping(path, { tolerance: 0 });
  assert.equal(mapRefToDut(mapping, 15), 117.5);
  assert.equal(mapDutToRef(mapping, 117.5), 15);
  assert.equal(mapRefToDut(mapping, -10), 100);
  assert.equal(mapDutToRef(mapping, 999), 30);
});

test("mapper는 linear extrapolation과 범위 오류 정책을 지원한다", () => {
  const mapping = buildTimeMapping(path, { tolerance: 0 });
  const linear = createTimeMapper(mapping, { extrapolation: "linear" });
  assert.equal(linear.refToDut(-10), 89);
  assert.throws(
    () => mapRefToDut(mapping, -1, { extrapolation: "error" }),
    (error) => error instanceof AlignmentError && error.code === "OUTSIDE_MAPPING",
  );
});

test("중복 REF path point를 단조 mapping point로 축약한다", () => {
  const mapping = buildTimeMapping([
    { referenceTime: 0, dutTime: 10 },
    { referenceTime: 0, dutTime: 12 },
    { referenceTime: 1, dutTime: 12 },
    { referenceTime: 2, dutTime: 14 },
  ], { tolerance: 0 });
  assert.deepEqual(mapping.points[0], { refTime: 0, dutTime: 11 });
  assert.ok(mapping.points.every((point, index) => index === 0 || point.dutTime >= mapping.points[index - 1].dutTime));
});

test("비단조 또는 NaN mapping 입력을 거부한다", () => {
  assert.throws(
    () => buildTimeMapping([
      { referenceTime: 0, dutTime: 10 },
      { referenceTime: 1, dutTime: 9 },
    ]),
    (error) => error instanceof AlignmentError && error.code === "INVALID_MAPPING",
  );
  assert.throws(
    () => mapRefToDut([
      { refTime: 0, dutTime: 10 },
      { refTime: 1, dutTime: Number.NaN },
    ], 0.5),
    (error) => error instanceof AlignmentError && error.code === "INVALID_MAPPING",
  );
});
