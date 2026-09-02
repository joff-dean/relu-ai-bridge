using System.Text.Json;

namespace Relu.AI.Bridge.DesktopConnector;

/// <summary>현재 WPF 분석 화면이 공개하기로 한 제한된 JSON context를 제공합니다.</summary>
public interface IReluDesktopContextProvider
{
    ValueTask<JsonElement> GetContextAsync(CancellationToken cancellationToken);
}

/// <summary>Bridge가 요청한 context projection입니다.</summary>
public sealed record ReluContextGuard(
    IReadOnlyList<string> Fields,
    JsonElement Projection,
    string Binding);

/// <summary>Capability handler에 전달되는 변하지 않는 실행 snapshot입니다.</summary>
public sealed record ReluCapabilityInvocation(
    JsonElement Parameters,
    JsonElement ContextSnapshot,
    ReluContextGuard ContextGuard,
    string? OperationId);
