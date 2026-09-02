using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector;

namespace WpfAndroidLogViewer.Integration;

public static class AndroidLogCapabilities
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static IReadOnlyCollection<ReluDesktopCapability> Create(IAndroidLogAnalysisEngine engine)
    {
        ArgumentNullException.ThrowIfNull(engine);
        return
        [
            new("get_selection_stats", async (invocation, cancellationToken) =>
            {
                var result = await engine.GetSelectionStatisticsAsync(
                    SelectionContextStore.FromContext(invocation.ContextSnapshot),
                    cancellationToken).ConfigureAwait(false);
                EnsureMaximum(result.Metrics.Count, 200, "metrics");
                return JsonSerializer.SerializeToElement(result, JsonOptions);
            }),

            new("get_selection_series", async (invocation, cancellationToken) =>
            {
                var maximumPoints = OptionalBoundedInt(invocation.Parameters, "maxPointsPerSeries", 1000, 10, 1000);
                var result = await engine.GetSelectionSeriesAsync(
                    SelectionContextStore.FromContext(invocation.ContextSnapshot),
                    maximumPoints,
                    cancellationToken).ConfigureAwait(false);
                EnsureMaximum(result.Count, 6, "series");
                if (result.Any(series => series.Points.Count > maximumPoints))
                {
                    throw new InvalidDataException("Analysis engine exceeded maxPointsPerSeries.");
                }
                return JsonSerializer.SerializeToElement(new { series = result }, JsonOptions);
            }),

            new("get_log_excerpt", async (invocation, cancellationToken) =>
            {
                var maximumLines = OptionalBoundedInt(invocation.Parameters, "maxLines", 100, 1, 200);
                var result = await engine.GetLogExcerptAsync(
                    SelectionContextStore.FromContext(invocation.ContextSnapshot),
                    maximumLines,
                    cancellationToken).ConfigureAwait(false);
                EnsureMaximum(result.Count, maximumLines, "lines");
                return JsonSerializer.SerializeToElement(new { lines = result }, JsonOptions);
            }),

            new("get_extracted_sections", async (invocation, cancellationToken) =>
            {
                var result = await engine.GetExtractedSectionsAsync(
                    SelectionContextStore.FromContext(invocation.ContextSnapshot),
                    cancellationToken).ConfigureAwait(false);
                EnsureMaximum(result.Count, 100, "sections");
                return JsonSerializer.SerializeToElement(new { sections = result }, JsonOptions);
            }),

            new("find_anomalies", async (invocation, cancellationToken) =>
            {
                var result = await engine.FindAnomaliesAsync(
                    SelectionContextStore.FromContext(invocation.ContextSnapshot),
                    cancellationToken).ConfigureAwait(false);
                EnsureMaximum(result.Count, 100, "anomalies");
                if (result.Any(anomaly => anomaly.Evidence.Count > 20))
                {
                    throw new InvalidDataException("Analysis engine exceeded the evidence limit.");
                }
                return JsonSerializer.SerializeToElement(new { anomalies = result }, JsonOptions);
            }),
        ];
    }

    private static int OptionalBoundedInt(JsonElement parameters, string name, int defaultValue, int minimum, int maximum)
    {
        if (!parameters.TryGetProperty(name, out var property))
        {
            return defaultValue;
        }
        if (!property.TryGetInt32(out var value) || value < minimum || value > maximum)
        {
            throw new InvalidDataException($"Parameter {name} is outside the allowlisted range.");
        }
        return value;
    }

    private static void EnsureMaximum(int actual, int maximum, string name)
    {
        if (actual > maximum)
        {
            throw new InvalidDataException($"Analysis engine exceeded the {name} limit.");
        }
    }
}
