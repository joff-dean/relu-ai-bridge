namespace WpfAndroidLogViewer.Integration;

/// <summary>
/// 설치별 stable opaque instance ID를 제공하는 애플리케이션 경계입니다.
/// 현재 사용자에게만 읽기 가능한 local app-data ACL에 저장하고 토큰과는 분리하십시오.
/// </summary>
public interface IStableInstanceIdProvider
{
    ValueTask<string> GetStableInstanceIdAsync(CancellationToken cancellationToken);
}
