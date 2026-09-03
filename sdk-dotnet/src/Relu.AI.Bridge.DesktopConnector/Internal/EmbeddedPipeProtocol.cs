using System.Buffers.Binary;
using System.Text.Json;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

internal static class EmbeddedPipeProtocol
{
    internal const string ProtocolVersion = "1.0";

    internal static async Task WriteAsync(
        Stream stream,
        JsonElement value,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length == 0 || payload.Length > maximumBytes)
        {
            throw new InvalidDataException("Embedded bridge message exceeds its byte limit.");
        }
        var prefix = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(prefix, payload.Length);
        await stream.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<JsonDocument> ReadAsync(
        Stream stream,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        var prefix = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, prefix, cancellationToken).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt32BigEndian(prefix);
        if (length <= 0 || length > maximumBytes)
        {
            throw new InvalidDataException("Embedded bridge frame length is invalid.");
        }
        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return BoundedJson.Parse(payload, maximumBytes, "embedded bridge message");
    }

    private static async Task ReadExactlyAsync(
        Stream stream,
        Memory<byte> destination,
        CancellationToken cancellationToken)
    {
        var read = 0;
        while (read < destination.Length)
        {
            var count = await stream.ReadAsync(destination[read..], cancellationToken).ConfigureAwait(false);
            if (count == 0)
            {
                throw new EndOfStreamException("Embedded bridge frame ended early.");
            }
            read += count;
        }
    }
}
