import { parentPort, workerData } from 'node:worker_threads';
import { alignSelection } from './index.mjs';

try {
  const result = alignSelection(workerData.input, workerData.options);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
    },
  });
}
