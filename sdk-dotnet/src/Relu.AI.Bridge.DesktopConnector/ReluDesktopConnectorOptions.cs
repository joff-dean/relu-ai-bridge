using System.Text.RegularExpressions;

namespace Relu.AI.Bridge.DesktopConnector;

public sealed class ReluDesktopConnectorOptions
{
    private static readonly Regex IdentifierPattern = new(
        "^[a-zA-Z0-9_-]{3,128}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex AppIdPattern = new(
        "^[a-zA-Z][a-zA-Z0-9._-]{2,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public Uri Endpoint { get; init; } = new("ws://127.0.0.1:5746/relu/desktop/ws");

    public required string ServiceId { get; init; }

    public required string AppId { get; init; }

    /// <summary>설치별로 안정적이지만 토큰이나 사용자명을 포함하지 않는 opaque ID입니다.</summary>
    public required string InstanceId { get; init; }

    public string ConnectorVersion { get; init; } = "0.6.0";

    public required IReluConnectorSecretProvider SecretProvider { get; init; }

    public required IReluDesktopContextProvider ContextProvider { get; init; }

    public required IReadOnlyCollection<ReluDesktopCapability> Capabilities { get; init; }

    /// <summary>
    /// 모든 capability 요청의 contextGuard에 반드시 포함해야 하는 최상위 필드입니다.
    /// WPF 구간 분석은 selectionRevision을 유지해야 합니다.
    /// </summary>
    public IReadOnlyCollection<string> RequiredContextGuardFields { get; init; } =
        ["logResourceId", "datasetRevision", "selectionId", "selectionRevision", "selection"];

    /// <summary>
    /// 연결 생성 시점의 활성 상태입니다. 이후 상태는 UI event에서 SetActiveAsync로 전달합니다.
    /// background connector가 WPF UI property를 직접 읽지 않도록 delegate를 받지 않습니다.
    /// </summary>
    public bool InitialActive { get; init; } = true;

    public TimeSpan HandshakeTimeout { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan MinimumReconnectDelay { get; init; } = TimeSpan.FromMilliseconds(500);

    public TimeSpan MaximumReconnectDelay { get; init; } = TimeSpan.FromSeconds(30);

    public int MaximumInboundMessageBytes { get; init; } = 1024 * 1024;

    public int MaximumOutboundMessageBytes { get; init; } = 1024 * 1024;

    internal void Validate()
    {
        ValidateEndpoint(Endpoint);
        ValidateServiceId(ServiceId);
        ValidateAppId(AppId);
        ValidateIdentifier(InstanceId, nameof(InstanceId));
        ArgumentNullException.ThrowIfNull(SecretProvider);
        ArgumentNullException.ThrowIfNull(ContextProvider);
        ArgumentNullException.ThrowIfNull(Capabilities);
        if (ConnectorVersion.Length is < 1 or > 100)
        {
            throw new ArgumentException("ConnectorVersion is invalid.", nameof(ConnectorVersion));
        }

        if (Capabilities.Count is < 1 or > 64 || Capabilities.Select(item => item.Name).Distinct(StringComparer.Ordinal).Count() != Capabilities.Count)
        {
            throw new ArgumentException("Capabilities must contain 1 to 64 unique entries.", nameof(Capabilities));
        }

        if (RequiredContextGuardFields.Count is < 1 or > 8
            || !RequiredContextGuardFields.Contains("selectionRevision", StringComparer.Ordinal)
            || RequiredContextGuardFields.Any(field => !IsContextField(field))
            || RequiredContextGuardFields.Distinct(StringComparer.Ordinal).Count() != RequiredContextGuardFields.Count)
        {
            throw new ArgumentException(
                "RequiredContextGuardFields must contain unique safe fields including selectionRevision.",
                nameof(RequiredContextGuardFields));
        }

        ValidateDuration(HandshakeTimeout, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(30), nameof(HandshakeTimeout));
        ValidateDuration(MinimumReconnectDelay, TimeSpan.FromMilliseconds(100), TimeSpan.FromMinutes(1), nameof(MinimumReconnectDelay));
        ValidateDuration(MaximumReconnectDelay, MinimumReconnectDelay, TimeSpan.FromMinutes(5), nameof(MaximumReconnectDelay));
        if (MaximumInboundMessageBytes is < 4096 or > 16 * 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumInboundMessageBytes));
        }
        if (MaximumOutboundMessageBytes is < 4096 or > 16 * 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumOutboundMessageBytes));
        }
    }

    internal static void ValidateEndpoint(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (!endpoint.IsAbsoluteUri
            || !string.Equals(endpoint.Scheme, "ws", StringComparison.Ordinal)
            || endpoint.UserInfo.Length != 0
            || endpoint.Query.Length != 0
            || endpoint.Fragment.Length != 0
            || !string.Equals(endpoint.AbsolutePath, "/relu/desktop/ws", StringComparison.Ordinal)
            || !IsLoopbackHost(endpoint.Host))
        {
            throw new ArgumentException(
                "Endpoint must be an exact loopback ws:// URL ending in /relu/desktop/ws.",
                nameof(endpoint));
        }
    }

    private static bool IsLoopbackHost(string host) =>
        string.Equals(host, "127.0.0.1", StringComparison.Ordinal)
        || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
        || string.Equals(host, "::1", StringComparison.Ordinal)
        || string.Equals(host, "[::1]", StringComparison.Ordinal);

    private static bool IsContextField(string field) => field.Length is >= 1 and <= 64
        && char.IsAsciiLetter(field[0])
        && field.All(character => char.IsAsciiLetterOrDigit(character) || character is '_' or '.' or '-');

    private static void ValidateIdentifier(string value, string parameterName)
    {
        if (string.IsNullOrEmpty(value) || !IdentifierPattern.IsMatch(value))
        {
            throw new ArgumentException($"{parameterName} is invalid.", parameterName);
        }
    }

    private static void ValidateAppId(string value)
    {
        if (string.IsNullOrEmpty(value) || !AppIdPattern.IsMatch(value))
        {
            throw new ArgumentException("AppId is invalid.", nameof(AppId));
        }
    }

    private static void ValidateServiceId(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length is < 2 or > 64
            || !char.IsAsciiLetterLower(value[0])
            || value.Any(character => !(char.IsAsciiLetterLower(character)
                || char.IsAsciiDigit(character)
                || character is '_' or '-')))
        {
            throw new ArgumentException("ServiceId is invalid.", nameof(ServiceId));
        }
    }

    private static void ValidateDuration(TimeSpan value, TimeSpan minimum, TimeSpan maximum, string name)
    {
        if (value < minimum || value > maximum)
        {
            throw new ArgumentOutOfRangeException(name);
        }
    }
}

public enum ReluDesktopConnectorState
{
    Stopped,
    Connecting,
    Authenticating,
    Connected,
    Reconnecting,
    AuthenticationRejected,
}

public sealed record ReluDesktopConnectorStatus(
    ReluDesktopConnectorState State,
    int ReconnectAttempt,
    string? SessionId = null,
    string? Detail = null);
