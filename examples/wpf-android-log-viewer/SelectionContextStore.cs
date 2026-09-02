using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector;

namespace WpfAndroidLogViewer.Integration;

/// <summary>원문 로그가 아닌 opaque ID와 선택 범위만 보관하는 thread-safe context provider입니다.</summary>
public sealed class SelectionContextStore : IReluDesktopContextProvider
{
    private const long MaximumSafeJsonInteger = 9_007_199_254_740_991;
    private readonly object _gate = new();
    private LogSelection _selection;

    public SelectionContextStore(LogSelection initialSelection)
    {
        Validate(initialSelection);
        _selection = initialSelection;
    }

    public LogSelection Current
    {
        get
        {
            lock (_gate)
            {
                return _selection;
            }
        }
    }

    public void Update(LogSelection selection)
    {
        Validate(selection);
        lock (_gate)
        {
            _selection = selection;
        }
    }

    public ValueTask<JsonElement> GetContextAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var selection = Current;
        return ValueTask.FromResult(JsonSerializer.SerializeToElement(new
        {
            logResourceId = selection.LogResourceId,
            datasetRevision = selection.DatasetRevision,
            selectionId = selection.SelectionId,
            selectionRevision = selection.SelectionRevision,
            selection = new
            {
                startMs = selection.StartMs,
                endMs = selection.EndMs,
            },
        }));
    }

    public static LogSelection FromContext(JsonElement context)
    {
        var selection = new LogSelection(
            RequireString(context, "logResourceId"),
            RequireString(context, "datasetRevision"),
            RequireString(context, "selectionId"),
            RequireString(context, "selectionRevision"),
            RequireInt64(context.GetProperty("selection"), "startMs"),
            RequireInt64(context.GetProperty("selection"), "endMs"));
        Validate(selection);
        return selection;
    }

    private static string RequireString(JsonElement value, string name)
    {
        var result = value.GetProperty(name).GetString();
        return string.IsNullOrEmpty(result)
            ? throw new InvalidDataException($"Context field {name} is invalid.")
            : result;
    }

    private static long RequireInt64(JsonElement value, string name) =>
        value.GetProperty(name).TryGetInt64(out var result)
            ? result
            : throw new InvalidDataException($"Context field {name} is invalid.");

    private static void Validate(LogSelection selection)
    {
        ArgumentNullException.ThrowIfNull(selection);
        if (selection.StartMs < 0
            || selection.EndMs <= selection.StartMs
            || selection.StartMs > MaximumSafeJsonInteger
            || selection.EndMs > MaximumSafeJsonInteger)
        {
            throw new ArgumentOutOfRangeException(nameof(selection), "Selection range is invalid.");
        }
        ValidateOpaque(selection.LogResourceId, nameof(selection.LogResourceId));
        ValidateOpaque(selection.DatasetRevision, nameof(selection.DatasetRevision));
        ValidateOpaque(selection.SelectionId, nameof(selection.SelectionId));
        ValidateOpaque(selection.SelectionRevision, nameof(selection.SelectionRevision));
    }

    private static void ValidateOpaque(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128
            || value.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.')))
        {
            throw new ArgumentException($"{name} must be an opaque safe identifier.", name);
        }
    }
}
