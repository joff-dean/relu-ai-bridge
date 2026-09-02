using Relu.AI.Bridge.DesktopConnector;

namespace WpfAndroidLogViewer.Integration;

/// <summary>WPF composition root에서 한 번 생성해 애플리케이션 수명과 함께 유지합니다.</summary>
public sealed class ReluWpfIntegration : IAsyncDisposable
{
    private readonly SelectionContextStore _contextStore;

    public ReluWpfIntegration(
        IAndroidLogAnalysisEngine analysisEngine,
        IReluConnectorSecretProvider secretProvider,
        string stableInstanceId,
        LogSelection initialSelection,
        bool initiallyActive,
        Uri? endpoint = null)
    {
        ArgumentNullException.ThrowIfNull(analysisEngine);
        ArgumentNullException.ThrowIfNull(secretProvider);
        _contextStore = new SelectionContextStore(initialSelection);
        Connector = new ReluDesktopConnector(new ReluDesktopConnectorOptions
        {
            Endpoint = endpoint ?? new Uri("ws://127.0.0.1:5746/relu/desktop/ws"),
            ServiceId = "android-log-viewer",
            AppId = "com.relu.AndroidLogViewer",
            InstanceId = stableInstanceId,
            SecretProvider = secretProvider,
            ContextProvider = _contextStore,
            Capabilities = AndroidLogCapabilities.Create(analysisEngine),
            RequiredContextGuardFields =
            [
                "logResourceId",
                "datasetRevision",
                "selectionId",
                "selectionRevision",
                "selection",
            ],
            InitialActive = initiallyActive,
        });
    }

    public ReluDesktopConnector Connector { get; }

    public Task StartAsync(CancellationToken cancellationToken = default) => Connector.StartAsync(cancellationToken);

    /// <summary>차트의 selection-completed 이벤트에서 호출합니다.</summary>
    public Task UpdateSelectionAsync(LogSelection selection, CancellationToken cancellationToken = default) =>
        Connector.NotifyContextChangedAsync(
            () => _contextStore.Update(selection),
            cancellationToken);

    public Task WindowActivationChangedAsync(bool active, CancellationToken cancellationToken = default) =>
        Connector.SetActiveAsync(active, cancellationToken);

    public ValueTask DisposeAsync() => Connector.DisposeAsync();
}
