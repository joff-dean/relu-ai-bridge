using System.Text.Json;

namespace Relu.AI.Bridge.DesktopConnector;

/// <summary>현재 WPF 분석 화면이 공개하기로 한 제한된 JSON context를 제공합니다.</summary>
public interface IReluDesktopContextProvider
{
    ValueTask<JsonElement> GetContextAsync(CancellationToken cancellationToken);
}

/// <summary>
/// 분석 대상이나 선택 구간이 아직 없어 context를 만들 수 없을 때 provider가 던지는 고정 예외입니다.
/// Bridge는 이를 <c>CONTEXT_UNAVAILABLE</c> 응답으로 안전하게 변환합니다.
/// </summary>
public sealed class ReluContextUnavailableException() :
    Exception("No analysis context is currently selected.");

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
