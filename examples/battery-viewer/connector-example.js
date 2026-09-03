import { ReluWebConnector } from '../../sdk/relu-web-connector.js';

// 실제 서비스에서는 token을 소스에 넣지 말고 회사의 승인된 런타임 설정으로 주입한다.
export function installBatteryViewerConnector({ token, viewer }) {
  const connector = new ReluWebConnector({
    serviceId: 'battery-viewer',
    connectorVersion: '0.7.0',
    token,
    getContext: () => {
      const selection = viewer.getSelection();
      return {
        payloadId: viewer.getPayloadId(),
        view: viewer.getCurrentView(),
        ...(selection ? { selection: { startMs: selection.startMs, endMs: selection.endMs } } : {}),
      };
    },
    capabilities: {
      get_stats: async (_parameters, { signal }) => {
        const selection = viewer.getSelection();
        return viewer.getBoundedStats(selection, { signal, maxSamples: 1_000_000 });
      },
      focus_range: async ({ startMs, endMs }, { operationId, contextGuard }) => {
        if (!operationId) throw new Error('operationId is required');
        if (startMs >= endMs) throw new Error('startMs must be less than endMs');
        viewer.focusRange(startMs, endMs);
        return { focused: true };
      },
    },
    onStatus: (status) => viewer.setAiBridgeStatus(status.state),
  });

  viewer.onSelectionChanged(() => connector.updateContext());
  viewer.onPayloadChanged(() => connector.updateContext());
  void connector.start();
  return connector;
}
