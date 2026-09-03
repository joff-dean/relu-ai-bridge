using System.Text;
using System.Text.Json;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

internal static class BoundedJson
{
    internal const int MaximumDepth = 16;
    internal const int MaximumNodes = 20_000;
    internal const int MaximumStringBytes = 64 * 1024;

    internal static JsonDocument Parse(ReadOnlyMemory<byte> utf8, int maximumBytes, string name)
    {
        if (utf8.Length == 0 || utf8.Length > maximumBytes)
        {
            throw new InvalidDataException($"{name} exceeds its byte limit.");
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(utf8, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = MaximumDepth,
            });
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException($"{name} is not valid JSON.", exception);
        }

        try
        {
            Validate(document.RootElement, name);
            return document;
        }
        catch
        {
            document.Dispose();
            throw;
        }
    }

    internal static JsonElement CloneAndValidate(JsonElement value, int maximumBytes, string name)
    {
        Validate(value, name);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        if (bytes.Length > maximumBytes)
        {
            throw new InvalidDataException($"{name} exceeds its byte limit.");
        }

        using var document = Parse(bytes, maximumBytes, name);
        return document.RootElement.Clone();
    }

    internal static void Validate(JsonElement root, string name)
    {
        var nodes = 0;
        ValidateNode(root, 0, ref nodes, name);
    }

    private static void ValidateNode(JsonElement value, int depth, ref int nodes, string name)
    {
        nodes += 1;
        if (nodes > MaximumNodes || depth > MaximumDepth)
        {
            throw new InvalidDataException($"{name} is too large or deeply nested.");
        }

        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)
                        || property.Name is "__proto__" or "constructor" or "prototype"
                        || Encoding.UTF8.GetByteCount(property.Name) > 200)
                    {
                        throw new InvalidDataException($"{name} contains an invalid or duplicate property.");
                    }
                    ValidateNode(property.Value, depth + 1, ref nodes, name);
                }
                break;
            }
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray())
                {
                    ValidateNode(item, depth + 1, ref nodes, name);
                }
                break;
            case JsonValueKind.String:
                if (Encoding.UTF8.GetByteCount(value.GetString() ?? string.Empty) > MaximumStringBytes)
                {
                    throw new InvalidDataException($"{name} contains an oversized string.");
                }
                break;
            case JsonValueKind.Number:
                if (!EmbeddedContextProtocol.TryCreateCanonicalNumberKey(value, out _))
                {
                    throw new InvalidDataException($"{name} contains an oversized or invalid number.");
                }
                break;
            case JsonValueKind.True:
            case JsonValueKind.False:
            case JsonValueKind.Null:
                break;
            default:
                throw new InvalidDataException($"{name} contains an unsupported JSON value.");
        }
    }
}
