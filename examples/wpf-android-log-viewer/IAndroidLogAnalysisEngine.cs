namespace WpfAndroidLogViewer.Integration;

/// <summary>
/// 기존 WPF 애플리케이션의 분석 계층이 구현하는 경계입니다.
/// Connector는 UI Automation, 화면 캡처 또는 임의 reflection을 사용하지 않습니다.
/// </summary>
public interface IAndroidLogAnalysisEngine
{
    ValueTask<SelectionStatistics> GetSelectionStatisticsAsync(
        LogSelection selection,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<ChartSeries>> GetSelectionSeriesAsync(
        LogSelection selection,
        int maximumPointsPerSeries,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<LogExcerptLine>> GetLogExcerptAsync(
        LogSelection selection,
        int maximumLines,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<ExtractedTextSection>> GetExtractedSectionsAsync(
        LogSelection selection,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<LogAnomaly>> FindAnomaliesAsync(
        LogSelection selection,
        CancellationToken cancellationToken);
}
