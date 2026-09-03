using Relu.AI.Bridge.DesktopConnector;

namespace WpfAndroidLogViewer.Integration;

public sealed record ReluWpfIntegrationStartResult(
    bool BridgeStarted,
    ReluAgentRegistrationResult? Registration,
    string Message);

/// <summary>WPF composition root에서 한 번 생성해 애플리케이션 수명과 함께 유지합니다.</summary>
public sealed class ReluWpfIntegration : IAsyncDisposable
{
    private readonly SelectionContextStore _contextStore;
    private readonly ReluAiClientRegistrar _registrar = new();

    public ReluWpfIntegration(
        IAndroidLogAnalysisEngine analysisEngine,
        LogSelection? initialSelection = null,
        bool initiallyActive = true)
    {
        ArgumentNullException.ThrowIfNull(analysisEngine);
        _contextStore = new SelectionContextStore(initialSelection);
        Host = new ReluEmbeddedBridgeHost(new ReluEmbeddedBridgeOptions
        {
            Service = AndroidLogCapabilities.CreateDefinition(),
            ContextProvider = _contextStore,
            Handlers = AndroidLogCapabilities.Create(analysisEngine),
            InitialActive = initiallyActive,
        });
    }

    public ReluEmbeddedBridgeHost Host { get; }

    public ReluAgentRegistrationResult? Registration { get; private set; }

    /// <summary>
    /// WPF를 만들기 전에 호출합니다. stdio mode이면 GUI를 열지 않고 nullable exit code를 반환합니다.
    /// </summary>
    public static async Task<int?> RunMcpModeIfRequestedAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        if (!ReluMcpStdioEntryPoint.IsStdioMode(arguments))
        {
            return null;
        }
        return await ReluMcpStdioEntryPoint.RunAsync(
            AndroidLogCapabilities.CreateDefinition(),
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Host를 먼저 연 뒤 설치된 Claude/Codex에 동일한 EndViewer.exe를 자동 등록합니다.</summary>
    public async Task<ReluWpfIntegrationStartResult> StartAsync(
        CancellationToken cancellationToken = default)
    {
        if (!await Host.TryStartAsync(cancellationToken).ConfigureAwait(false))
        {
            Registration = null;
            return new ReluWpfIntegrationStartResult(
                BridgeStarted: false,
                Registration: null,
                Message: "Another EndViewer GUI already owns this user's embedded AI bridge.");
        }
        Registration = await _registrar.RegisterUserScopeAsync(
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return new ReluWpfIntegrationStartResult(
            BridgeStarted: true,
            Registration,
            Message: "The embedded AI bridge is running.");
    }

    /// <summary>차트의 selection-completed 이벤트에서 호출합니다.</summary>
    public Task UpdateSelectionAsync(LogSelection selection, CancellationToken cancellationToken = default) =>
        Host.NotifyContextChangedAsync(
            () => _contextStore.Update(selection),
            cancellationToken);

    /// <summary>로그를 닫거나 확정 선택이 사라졌을 때 stale context 재사용을 막습니다.</summary>
    public Task ClearSelectionAsync(CancellationToken cancellationToken = default) =>
        Host.NotifyContextChangedAsync(
            _contextStore.Clear,
            cancellationToken);

    public Task WindowActivationChangedAsync(bool active, CancellationToken cancellationToken = default) =>
        Host.SetActiveAsync(active, cancellationToken);

    public ValueTask DisposeAsync() => Host.DisposeAsync();
}
