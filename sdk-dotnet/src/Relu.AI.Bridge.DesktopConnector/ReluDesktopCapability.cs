using System.Text.Json;
using System.Text.RegularExpressions;

namespace Relu.AI.Bridge.DesktopConnector;

public delegate ValueTask<JsonElement> ReluDesktopCapabilityHandler(
    ReluCapabilityInvocation invocation,
    CancellationToken cancellationToken);

/// <summary>
/// Binary에 컴파일된 embedded capability 이름과 기존 분석 구현을 연결합니다.
/// schema, effect와 timeout은 <see cref="ReluEmbeddedServiceDefinition"/>이 소유합니다.
/// </summary>
public sealed class ReluDesktopCapability
{
    private static readonly Regex NamePattern = new(
        "^[a-z][a-z0-9_.-]{0,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public ReluDesktopCapability(string name, ReluDesktopCapabilityHandler handler)
    {
        if (string.IsNullOrEmpty(name) || !NamePattern.IsMatch(name))
        {
            throw new ArgumentException("Capability name is invalid.", nameof(name));
        }

        Name = name;
        Handler = handler ?? throw new ArgumentNullException(nameof(handler));
    }

    public string Name { get; }

    internal ReluDesktopCapabilityHandler Handler { get; }
}
