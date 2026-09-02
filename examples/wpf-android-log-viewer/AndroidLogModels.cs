namespace WpfAndroidLogViewer.Integration;

public sealed record LogSelection(
    string LogResourceId,
    string DatasetRevision,
    string SelectionId,
    string SelectionRevision,
    long StartMs,
    long EndMs);

public sealed record SelectionMetric(string Name, double Value, string Unit);

public sealed record SelectionStatistics(
    long DurationMs,
    int SampleCount,
    int WarningCount,
    int ErrorCount,
    IReadOnlyList<SelectionMetric> Metrics);

public sealed record ChartPoint(long TimestampMs, double Value);

public sealed record ChartSeries(string Name, string Unit, IReadOnlyList<ChartPoint> Points);

public sealed record LogExcerptLine(long TimestampMs, string Level, string Tag, string Message);

public sealed record ExtractedTextSection(
    string Kind,
    long StartMs,
    long EndMs,
    string Text);

public sealed record LogAnomaly(
    long TimestampMs,
    string Severity,
    string Summary,
    IReadOnlyList<string> Evidence);
