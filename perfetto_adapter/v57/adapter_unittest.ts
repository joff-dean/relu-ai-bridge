// Copyright (c) 2026. All rights reserved.

import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {
  QueryResult,
  RowIteratorBase,
  SqlValue,
} from '../../trace_processor/query_result';
import {
  PerfettoV57Adapter,
  serializeQueryResult,
  serializeSqlValue,
} from './adapter';

describe('PerfettoV57Adapter', () => {
  test('현재 area selection을 정밀도 손실 없는 문자열로 반환한다', () => {
    const trace = createTrace({
      selection: {
        kind: 'area',
        start: Time.fromRaw(9_007_199_254_740_993n),
        end: Time.fromRaw(9_007_199_254_741_999n),
        trackUris: ['track://one'],
        tracks: [],
      },
    });
    const adapter = new PerfettoV57Adapter(trace);

    expect(adapter.getAreaSelection()).toEqual({
      startNs: '9007199254740993',
      endNs: '9007199254741999',
      trackUris: ['track://one'],
    });
  });

  test('mapped area를 검증하고 Perfetto selection API에 전달한다', () => {
    const selectArea = vi.fn();
    const trace = createTrace({selectArea});
    const adapter = new PerfettoV57Adapter(trace);

    adapter.selectMappedArea({
      startNs: '10',
      endNs: '20',
      trackUris: ['track://one', 'track://one'],
      focus: true,
    });

    expect(selectArea).toHaveBeenCalledWith(
      {
        start: Time.fromRaw(10n),
        end: Time.fromRaw(20n),
        trackUris: ['track://one'],
      },
      {
        clearSearch: true,
        switchToCurrentSelectionTab: true,
        scrollToSelection: true,
      },
    );
  });

  test('trace 범위를 벗어난 mapped area를 거부한다', () => {
    const adapter = new PerfettoV57Adapter(createTrace({}));
    expect(() =>
      adapter.selectMappedArea({
        startNs: '-1',
        endNs: '20',
        trackUris: [],
      }),
    ).toThrow(/범위/);
  });
});

describe('query serialization', () => {
  test('bigint와 blob을 tagged JSON value로 보존한다', () => {
    expect(serializeSqlValue(9_007_199_254_740_993n)).toEqual({
      type: 'bigint',
      value: '9007199254740993',
    });
    expect(serializeSqlValue(new Uint8Array([0, 1, 255]))).toEqual({
      type: 'blob',
      base64: 'AAH/',
    });
  });

  test('maxRows에서 결과를 자르고 truncated를 표시한다', () => {
    const result = createQueryResult([
      {id: 1, name: 'one'},
      {id: 2, name: 'two'},
    ]);
    expect(serializeQueryResult(result, 1)).toMatchObject({
      columns: ['id', 'name'],
      rows: [{id: 1, name: 'one'}],
      truncated: true,
    });
  });

  test('비정상적으로 큰 단일 cell을 거부한다', () => {
    const oversized = 'x'.repeat(384 * 1024 + 1);
    expect(() => serializeSqlValue(oversized)).toThrow(/SQL cell/);
  });
});

function createTrace(options: {
  readonly selection?: unknown;
  readonly selectArea?: ReturnType<typeof vi.fn>;
}): Trace {
  return {
    traceInfo: {
      uuid: 'trace-uuid',
      traceTitle: 'test trace',
      traceUrl: 'https://example.test/trace?secret=value',
      start: Time.fromRaw(0n),
      end: Time.fromRaw(1_000n),
      unixOffset: Time.fromRaw(0n),
      tzOffMin: 0,
      importErrors: 0,
      traceTypes: ['proto'],
      hasFtrace: true,
      cached: false,
      downloadable: false,
    },
    selection: {
      selection: options.selection ?? {kind: 'empty'},
      selectArea: options.selectArea ?? vi.fn(),
    },
    engine: {
      query: vi.fn(),
    },
  } as unknown as Trace;
}

function createQueryResult(
  rows: ReadonlyArray<Readonly<Record<string, SqlValue>>>,
): QueryResult {
  const columns = Object.keys(rows[0] ?? {});
  let rowIndex = 0;
  const iterator: RowIteratorBase = {
    valid: () => rowIndex < rows.length,
    next: () => {
      rowIndex += 1;
    },
    get: (columnName) => rows[rowIndex][columnName],
  };
  return {
    columns: () => columns,
    iter: () => iterator,
    elapsedTimeMs: () => 1,
    statementCount: () => 1,
    statementWithOutputCount: () => 1,
  } as unknown as QueryResult;
}
