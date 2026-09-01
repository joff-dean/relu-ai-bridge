// Copyright (c) 2026. All rights reserved.

import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {QueryResult, SqlValue} from '../../trace_processor/query_result';
import type {
  AreaSelectionDto,
  QueryCell,
  QueryResponse,
  SelectMappedAreaParams,
  TraceDescriptor,
} from '../protocol';
import {PERFETTO_BOUNDED_READ_MARKER} from '../protocol';

export const PERFETTO_ADAPTER_VERSION = 'v57' as const;
export const MAX_QUERY_SQL_BYTES = 64 * 1024;
export const DEFAULT_MAX_QUERY_ROWS = 1_000;
export const MAX_QUERY_ROWS = 5_000;
export const MAX_QUERY_CELL_BYTES = 384 * 1024;
export const MAX_QUERY_RESULT_BYTES = 1_000_000;

export class PerfettoV57Adapter {
  constructor(private readonly trace: Trace) {}

  getTraceInfo(): TraceDescriptor {
    const info = this.trace.traceInfo;
    return {
      traceId: info.uuid,
      title: info.traceTitle,
      // File names and URL paths can reveal internal project topology. The
      // bridge does not need them; explicit trace metadata reads use title/id.
      sourceUrl: '',
      startNs: info.start.toString(),
      endNs: info.end.toString(),
      traceTypes: [...info.traceTypes],
      hasFtrace: info.hasFtrace,
      importErrors: info.importErrors,
    };
  }

  getAreaSelection(): AreaSelectionDto | null {
    const selection = this.trace.selection.selection;
    if (selection.kind !== 'area') return null;
    return {
      startNs: selection.start.toString(),
      endNs: selection.end.toString(),
      trackUris: [...selection.trackUris],
    };
  }

  async executeQuery(
    sql: string,
    requestedMaxRows = DEFAULT_MAX_QUERY_ROWS,
  ): Promise<QueryResponse> {
    validateSql(sql);
    const maxRows = validateMaxRows(requestedMaxRows);
    const result = await this.trace.engine.query(sql);
    return serializeQueryResult(result, maxRows);
  }

  selectMappedArea(params: SelectMappedAreaParams): AreaSelectionDto {
    const start = parseNanoseconds(params.startNs, 'startNs');
    const end = parseNanoseconds(params.endNs, 'endNs');
    if (start >= end) {
      throw new Error('mapped area의 startNs는 endNs보다 작아야 합니다.');
    }

    const info = this.trace.traceInfo;
    if (start < info.start || end > info.end) {
      throw new Error('mapped area가 현재 trace 시간 범위를 벗어났습니다.');
    }

    const trackUris = validateTrackUris(params.trackUris);
    const area = {
      start: Time.fromRaw(start),
      end: Time.fromRaw(end),
      trackUris,
    };
    this.trace.selection.selectArea(area, {
      clearSearch: true,
      switchToCurrentSelectionTab: true,
      scrollToSelection: params.focus ?? true,
    });
    return {
      startNs: start.toString(),
      endNs: end.toString(),
      trackUris,
    };
  }
}

export function serializeQueryResult(
  result: QueryResult,
  maxRows: number,
): QueryResponse {
  const columns = result.columns();
  const rows: Array<Readonly<Record<string, QueryCell>>> = [];
  const iterator = result.iter({});
  let encodedRowBytes = 0;
  let truncated = false;

  while (iterator.valid()) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const row: Record<string, QueryCell> = {};
    for (const column of columns) {
      row[column] = serializeSqlValue(iterator.get(column));
    }
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (encodedRowBytes + rowBytes > MAX_QUERY_RESULT_BYTES) {
      truncated = true;
      break;
    }
    rows.push(row);
    encodedRowBytes += rowBytes;
    iterator.next();
  }

  return {
    columns,
    rows,
    truncated,
    elapsedTimeMs: result.elapsedTimeMs(),
    statementCount: result.statementCount(),
    statementWithOutputCount: result.statementWithOutputCount(),
  };
}

export function serializeSqlValue(value: SqlValue): QueryCell {
  if (
    typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength > MAX_QUERY_CELL_BYTES
  ) {
    throw new Error(
      `SQL cell은 ${MAX_QUERY_CELL_BYTES} bytes 이하여야 합니다.`,
    );
  }
  if (typeof value === 'bigint') {
    return {type: 'bigint', value: value.toString()};
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_QUERY_CELL_BYTES) {
      throw new Error(
        `SQL blob cell은 ${MAX_QUERY_CELL_BYTES} bytes 이하여야 합니다.`,
      );
    }
    return {type: 'blob', base64: bytesToBase64(value)};
  }
  return value;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function validateSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('SQL은 비어 있을 수 없습니다.');
  }
  if (new TextEncoder().encode(sql).byteLength > MAX_QUERY_SQL_BYTES) {
    throw new Error(`SQL은 ${MAX_QUERY_SQL_BYTES} bytes 이하여야 합니다.`);
  }
  if (!sql.startsWith(`${PERFETTO_BOUNDED_READ_MARKER} SELECT * FROM (`)) {
    throw new Error('서버가 검증한 bounded read query만 실행할 수 있습니다.');
  }
  // Defense in depth: the Node bridge performs the full tokenized allowlist.
  // These names are never valid in an approved read, even inside quoted form.
  if (/run_metric|load_extension|writefile|export_trace|export_json/i.test(sql)) {
    throw new Error('부작용이 있는 PerfettoSQL 함수는 실행할 수 없습니다.');
  }
}

function validateMaxRows(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_ROWS) {
    throw new Error(`maxRows는 1 이상 ${MAX_QUERY_ROWS} 이하여야 합니다.`);
  }
  return value;
}

function parseNanoseconds(value: string, fieldName: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(
      `${fieldName}는 나노초 단위의 10진 정수 문자열이어야 합니다.`,
    );
  }
  return BigInt(value);
}

function validateTrackUris(
  value: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('trackUris 형식 또는 개수가 올바르지 않습니다.');
  }
  const unique = new Set<string>();
  for (const uri of value) {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2_048) {
      throw new Error('track URI 형식이 올바르지 않습니다.');
    }
    unique.add(uri);
  }
  return [...unique];
}
