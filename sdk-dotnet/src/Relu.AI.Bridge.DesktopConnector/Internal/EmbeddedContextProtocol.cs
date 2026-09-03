using System.Text.Json;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

internal static class EmbeddedContextProtocol
{
    private const int MaximumJsonNumberCharacters = 256;

    internal static JsonElement Project(JsonElement context, IReadOnlyList<string> fields)
    {
        if (context.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Embedded application context must be an object.");
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var field in fields)
            {
                if (!context.TryGetProperty(field, out var value))
                {
                    throw new InvalidDataException("Embedded application context is missing a guard field.");
                }
                writer.WritePropertyName(field);
                value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        using var projection = BoundedJson.Parse(stream.ToArray(), 1024 * 1024, "embedded context projection");
        return projection.RootElement.Clone();
    }

    internal static bool SemanticallyEquals(JsonElement left, JsonElement right)
    {
        if (left.ValueKind == JsonValueKind.Number && right.ValueKind == JsonValueKind.Number)
        {
            return CompareNumbers(left, right) == 0;
        }
        if (left.ValueKind != right.ValueKind)
        {
            return false;
        }

        switch (left.ValueKind)
        {
            case JsonValueKind.Object:
                {
                    var leftProperties = left.EnumerateObject()
                        .ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal);
                    var rightProperties = right.EnumerateObject()
                        .ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal);
                    return leftProperties.Count == rightProperties.Count
                        && leftProperties.All(item => rightProperties.TryGetValue(item.Key, out var value)
                            && SemanticallyEquals(item.Value, value));
                }
            case JsonValueKind.Array:
                {
                    var leftItems = left.EnumerateArray().ToArray();
                    var rightItems = right.EnumerateArray().ToArray();
                    return leftItems.Length == rightItems.Length
                        && leftItems.Zip(rightItems).All(pair => SemanticallyEquals(pair.First, pair.Second));
                }
            case JsonValueKind.String:
                return string.Equals(left.GetString(), right.GetString(), StringComparison.Ordinal);
            case JsonValueKind.True:
            case JsonValueKind.False:
                return left.GetBoolean() == right.GetBoolean();
            case JsonValueKind.Null:
                return true;
            default:
                return false;
        }
    }

    internal static string CreateBinding(JsonElement projection)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer, projection);
        }
        return Convert.ToHexString(SHA256.HashData(stream.ToArray())).ToLowerInvariant();
    }

    internal static bool IsInteger(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !TryNormalize(value.GetRawText(), out var number))
        {
            return false;
        }
        return number.Digits == "0" || number.Scale >= BigInteger.Zero;
    }

    internal static bool TryCreateCanonicalNumberKey(JsonElement value, out string key)
    {
        key = string.Empty;
        if (value.ValueKind != JsonValueKind.Number
            || !TryNormalize(value.GetRawText(), out var number))
        {
            return false;
        }
        key = number.ToCanonicalJson();
        return true;
    }

    internal static int CompareNumbers(JsonElement left, JsonElement right)
    {
        if (left.ValueKind != JsonValueKind.Number
            || right.ValueKind != JsonValueKind.Number
            || !TryNormalize(left.GetRawText(), out var leftNumber)
            || !TryNormalize(right.GetRawText(), out var rightNumber))
        {
            throw new InvalidDataException("JSON numbers are invalid.");
        }
        if (leftNumber.Digits == "0" && rightNumber.Digits == "0")
        {
            return 0;
        }
        if (leftNumber.Negative != rightNumber.Negative)
        {
            return leftNumber.Negative ? -1 : 1;
        }

        var magnitudeComparison = (new BigInteger(leftNumber.Digits.Length) + leftNumber.Scale)
            .CompareTo(new BigInteger(rightNumber.Digits.Length) + rightNumber.Scale);
        var absoluteComparison = magnitudeComparison != 0
            ? magnitudeComparison
            : CompareCoefficientDigits(leftNumber.Digits, rightNumber.Digits);
        return leftNumber.Negative ? -absoluteComparison : absoluteComparison;
    }

    private static int CompareCoefficientDigits(string left, string right)
    {
        var length = Math.Max(left.Length, right.Length);
        for (var index = 0; index < length; index += 1)
        {
            var leftDigit = index < left.Length ? left[index] : '0';
            var rightDigit = index < right.Length ? right[index] : '0';
            if (leftDigit != rightDigit)
            {
                return leftDigit.CompareTo(rightDigit);
            }
        }
        return 0;
    }

    private static bool TryNormalize(string raw, out NormalizedNumber result)
    {
        result = default;
        if (raw.Length is 0 or > MaximumJsonNumberCharacters)
        {
            return false;
        }
        var index = 0;
        var negative = raw.Length > 0 && raw[0] == '-';
        if (negative)
        {
            index += 1;
        }
        var exponentIndex = raw.IndexOfAny(['e', 'E'], index);
        var significandEnd = exponentIndex < 0 ? raw.Length : exponentIndex;
        var decimalIndex = raw.IndexOf('.', index, significandEnd - index);
        var fractionalDigits = decimalIndex < 0 ? 0 : significandEnd - decimalIndex - 1;
        var digits = decimalIndex < 0
            ? raw[index..significandEnd]
            : string.Concat(raw.AsSpan(index, decimalIndex - index), raw.AsSpan(decimalIndex + 1, fractionalDigits));
        digits = digits.TrimStart('0');
        if (digits.Length == 0)
        {
            result = new NormalizedNumber(false, "0", BigInteger.Zero);
            return true;
        }

        var exponent = BigInteger.Zero;
        if (exponentIndex >= 0
            && !BigInteger.TryParse(
                raw.AsSpan(exponentIndex + 1),
                NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture,
                out exponent))
        {
            return false;
        }
        var scale = exponent - fractionalDigits;
        var trailingZeros = 0;
        while (trailingZeros < digits.Length - 1 && digits[^(trailingZeros + 1)] == '0')
        {
            trailingZeros += 1;
        }
        if (trailingZeros > 0)
        {
            digits = digits[..^trailingZeros];
            scale += trailingZeros;
        }
        result = new NormalizedNumber(negative, digits, scale);
        return true;
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                {
                    WriteCanonical(writer, item);
                }
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(value.GetString());
                break;
            case JsonValueKind.Number:
                if (!TryNormalize(value.GetRawText(), out var number))
                {
                    throw new InvalidDataException("JSON number is invalid.");
                }
                writer.WriteRawValue(number.ToCanonicalJson(), skipInputValidation: false);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidDataException("Context contains an unsupported JSON value.");
        }
    }

    private readonly record struct NormalizedNumber(bool Negative, string Digits, BigInteger Scale)
    {
        internal string ToCanonicalJson()
        {
            if (Digits == "0")
            {
                return "0";
            }
            var sign = Negative ? "-" : string.Empty;
            return string.Concat(
                sign,
                Digits,
                "e",
                Scale.ToString(CultureInfo.InvariantCulture));
        }
    }
}
