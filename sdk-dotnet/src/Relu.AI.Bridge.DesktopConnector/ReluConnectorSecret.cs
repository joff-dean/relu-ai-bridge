using System.Security.Cryptography;

namespace Relu.AI.Bridge.DesktopConnector;

/// <summary>
/// 호출자가 공급하는 서비스 전용 인증 토큰입니다. SDK는 사용 후 내부 복사본을 즉시 지웁니다.
/// </summary>
public sealed class ReluConnectorSecret : IDisposable
{
    private byte[]? _bytes;

    public ReluConnectorSecret(ReadOnlySpan<byte> utf8Token)
    {
        if (utf8Token.Length is < 24 or > 4096)
        {
            throw new ArgumentOutOfRangeException(
                nameof(utf8Token),
                "Connector token must be 24 to 4096 UTF-8 bytes.");
        }

        _bytes = utf8Token.ToArray();
    }

    internal ReadOnlySpan<byte> Bytes => _bytes is null
        ? throw new ObjectDisposedException(nameof(ReluConnectorSecret))
        : _bytes;

    public void Dispose()
    {
        var bytes = Interlocked.Exchange(ref _bytes, null);
        if (bytes is not null)
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }
}

/// <summary>
/// Windows Credential Manager, DPAPI 또는 회사 Secret Agent가 구현하는 토큰 공급 경계입니다.
/// 명령행 인자나 소스 코드에서 토큰을 읽는 구현은 사용하지 마십시오.
/// </summary>
public interface IReluConnectorSecretProvider
{
    ValueTask<ReluConnectorSecret> GetSecretAsync(CancellationToken cancellationToken);
}
