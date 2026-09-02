using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using Relu.AI.Bridge.DesktopConnector;

namespace WpfAndroidLogViewer.Integration;

/// <summary>기존 차트 selection 이벤트와 RELU Connector를 잇는 최소 ViewModel 예제입니다.</summary>
public sealed class AndroidLogViewerViewModel : INotifyPropertyChanged
{
    private readonly ReluWpfIntegration _relu;
    private readonly SynchronizationContext _uiContext;
    private string _connectionStatus = "Stopped";

    public AndroidLogViewerViewModel(ReluWpfIntegration relu, SynchronizationContext uiContext)
    {
        _relu = relu ?? throw new ArgumentNullException(nameof(relu));
        _uiContext = uiContext ?? throw new ArgumentNullException(nameof(uiContext));
        _relu.Connector.StatusChanged += OnConnectorStatusChanged;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public string ConnectionStatus
    {
        get => _connectionStatus;
        private set
        {
            if (_connectionStatus == value)
            {
                return;
            }
            _connectionStatus = value;
            OnPropertyChanged();
        }
    }

    /// <summary>
    /// 기존 chart control의 구간 선택 완료 이벤트에서 await하여 호출합니다.
    /// Claude/Codex 실행은 사람이 기존 도구에서 요청하며 이 메서드는 context만 갱신합니다.
    /// </summary>
    public Task OnChartSelectionCompletedAsync(
        string logResourceId,
        string datasetRevision,
        long startMs,
        long endMs,
        CancellationToken cancellationToken = default)
    {
        var selection = new LogSelection(
            logResourceId,
            datasetRevision,
            CreateOpaqueId("selection"),
            CreateOpaqueId("selection-revision"),
            startMs,
            endMs);
        return _relu.UpdateSelectionAsync(selection, cancellationToken);
    }

    private static string CreateOpaqueId(string prefix) =>
        $"{prefix}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant()}";

    public Task OnWindowActivationChangedAsync(bool active, CancellationToken cancellationToken = default) =>
        _relu.WindowActivationChangedAsync(active, cancellationToken);

    private void OnConnectorStatusChanged(ReluDesktopConnectorStatus status)
    {
        _uiContext.Post(_ => ConnectionStatus = status.State.ToString(), null);
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
