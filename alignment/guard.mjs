import { AlignmentAbortError, AlignmentError } from "./errors.mjs";

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function createExecutionGuard({ signal, limits, now = monotonicNow } = {}) {
  const startedAt = now();
  let operations = 0;

  function checkpoint(operationDelta = 0) {
    if (signal?.aborted) {
      throw new AlignmentAbortError("정렬 작업이 AbortSignal에 의해 취소되었습니다.");
    }
    operations += operationDelta;
    if (operations > limits.maxOperations) {
      throw new AlignmentError("LIMIT_EXCEEDED", "정렬 연산량 제한을 초과했습니다.", {
        limit: "maxOperations",
        maximum: limits.maxOperations,
        observed: operations,
      });
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs > limits.timeBudgetMs) {
      throw new AlignmentError("TIME_BUDGET_EXCEEDED", "정렬 시간 제한을 초과했습니다.", {
        maximumMs: limits.timeBudgetMs,
        elapsedMs,
      });
    }
  }

  checkpoint();
  return {
    checkpoint,
    get elapsedMs() {
      return now() - startedAt;
    },
    get operations() {
      return operations;
    },
  };
}
