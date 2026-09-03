using System.Text.Json;
using System.Text;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

/// <summary>
/// Small, deliberately closed JSON Schema subset for compiled embedded manifests. Unsupported
/// keywords are rejected at startup so a capability can never advertise constraints it does not
/// enforce.
/// </summary>
internal static class EmbeddedJsonSchema
{
    private static readonly HashSet<string> SupportedKeywords = new(StringComparer.Ordinal)
    {
        "$schema",
        "$id",
        "title",
        "description",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "enum",
        "const",
    };

    private static readonly HashSet<string> SupportedTypes = new(StringComparer.Ordinal)
    {
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
    };

    internal static void ValidateSchema(JsonElement schema, string name)
    {
        try
        {
            ValidateSchemaNode(schema, name, 0);
        }
        catch (InvalidDataException exception)
        {
            throw new ArgumentException($"{name} is not a supported embedded JSON schema.", name, exception);
        }
    }

    internal static void ValidateInstance(JsonElement value, JsonElement schema, string name)
    {
        if (!Matches(value, schema))
        {
            throw new InvalidDataException($"{name} does not match its compiled JSON schema.");
        }
    }

    private static void ValidateSchemaNode(JsonElement schema, string name, int depth)
    {
        if (depth > BoundedJson.MaximumDepth || schema.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException($"{name} contains an invalid schema node.");
        }
        foreach (var property in schema.EnumerateObject())
        {
            if (!SupportedKeywords.Contains(property.Name))
            {
                throw new InvalidDataException($"{name} contains an unsupported schema keyword.");
            }
        }

        var type = RequiredType(schema, name);
        ValidateOptionalMetadata(schema, "$schema", name);
        ValidateOptionalMetadata(schema, "$id", name);
        ValidateOptionalMetadata(schema, "title", name);
        ValidateOptionalMetadata(schema, "description", name);

        if (type == "object"
            && (!schema.TryGetProperty("properties", out var closedProperties)
                || closedProperties.ValueKind != JsonValueKind.Object
                || !schema.TryGetProperty("additionalProperties", out var closedAdditionalProperties)
                || closedAdditionalProperties.ValueKind != JsonValueKind.False))
        {
            throw new InvalidDataException(
                $"{name} object schemas require properties and additionalProperties:false.");
        }

        if (schema.TryGetProperty("properties", out var properties))
        {
            if (type != "object" || properties.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException($"{name}.properties is invalid.");
            }
            foreach (var property in properties.EnumerateObject())
            {
                ValidateSchemaNode(property.Value, name, depth + 1);
            }
        }
        if (schema.TryGetProperty("required", out var required))
        {
            if (type != "object" || required.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException($"{name}.required is invalid.");
            }
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in required.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String
                    || string.IsNullOrEmpty(item.GetString())
                    || !names.Add(item.GetString()!))
                {
                    throw new InvalidDataException($"{name}.required is invalid.");
                }
                if (!schema.TryGetProperty("properties", out properties)
                    || !properties.TryGetProperty(item.GetString()!, out _))
                {
                    throw new InvalidDataException($"{name}.required references an unknown property.");
                }
            }
        }
        if (schema.TryGetProperty("additionalProperties", out var additionalProperties)
            && (type != "object" || additionalProperties.ValueKind != JsonValueKind.False))
        {
            throw new InvalidDataException($"{name}.additionalProperties is invalid.");
        }
        if (schema.TryGetProperty("items", out var items))
        {
            if (type != "array")
            {
                throw new InvalidDataException($"{name}.items is invalid.");
            }
            ValidateSchemaNode(items, name, depth + 1);
        }
        else if (type == "array")
        {
            throw new InvalidDataException($"{name} array schemas require items.");
        }

        ValidateIntegerRange(schema, "minItems", "maxItems", type == "array", name);
        ValidateIntegerRange(schema, "minLength", "maxLength", type == "string", name);
        ValidateNumberRange(schema, "minimum", "maximum", type is "number" or "integer", name);

        if (schema.TryGetProperty("enum", out var enumValues))
        {
            if (enumValues.ValueKind != JsonValueKind.Array || enumValues.GetArrayLength() is < 1 or > 100)
            {
                throw new InvalidDataException($"{name}.enum is invalid.");
            }
            foreach (var item in enumValues.EnumerateArray())
            {
                if (!TypeMatches(item, type))
                {
                    throw new InvalidDataException($"{name}.enum contains a value of the wrong type.");
                }
            }
        }
        if (schema.TryGetProperty("const", out var constant) && !TypeMatches(constant, type))
        {
            throw new InvalidDataException($"{name}.const has the wrong type.");
        }
    }

    private static bool Matches(JsonElement value, JsonElement schema)
    {
        var type = schema.GetProperty("type").GetString()!;
        if (!TypeMatches(value, type))
        {
            return false;
        }
        if (schema.TryGetProperty("enum", out var enumValues)
            && !enumValues.EnumerateArray().Any(item => EmbeddedContextProtocol.SemanticallyEquals(item, value)))
        {
            return false;
        }
        if (schema.TryGetProperty("const", out var constant)
            && !EmbeddedContextProtocol.SemanticallyEquals(constant, value))
        {
            return false;
        }

        if (type == "object")
        {
            if (schema.TryGetProperty("required", out var required)
                && required.EnumerateArray().Any(item => !value.TryGetProperty(item.GetString()!, out _)))
            {
                return false;
            }
            var hasProperties = schema.TryGetProperty("properties", out var properties);
            foreach (var property in value.EnumerateObject())
            {
                if (hasProperties && properties.TryGetProperty(property.Name, out var propertySchema))
                {
                    if (!Matches(property.Value, propertySchema))
                    {
                        return false;
                    }
                }
                else if (schema.TryGetProperty("additionalProperties", out var additional)
                    && additional.ValueKind == JsonValueKind.False)
                {
                    return false;
                }
            }
        }
        else if (type == "array")
        {
            var count = value.GetArrayLength();
            if (!WithinIntegerRange(count, schema, "minItems", "maxItems"))
            {
                return false;
            }
            if (schema.TryGetProperty("items", out var itemSchema)
                && value.EnumerateArray().Any(item => !Matches(item, itemSchema)))
            {
                return false;
            }
        }
        else if (type == "string")
        {
            var length = value.GetString()!.EnumerateRunes().Count();
            if (!WithinIntegerRange(length, schema, "minLength", "maxLength"))
            {
                return false;
            }
        }
        else if (type is "number" or "integer")
        {
            if (schema.TryGetProperty("minimum", out var minimum)
                && EmbeddedContextProtocol.CompareNumbers(value, minimum) < 0)
            {
                return false;
            }
            if (schema.TryGetProperty("maximum", out var maximum)
                && EmbeddedContextProtocol.CompareNumbers(value, maximum) > 0)
            {
                return false;
            }
        }
        return true;
    }

    private static string RequiredType(JsonElement schema, string name)
    {
        if (!schema.TryGetProperty("type", out var typeProperty)
            || typeProperty.ValueKind != JsonValueKind.String
            || !SupportedTypes.Contains(typeProperty.GetString() ?? string.Empty))
        {
            throw new InvalidDataException($"{name}.type is required and must be supported.");
        }
        return typeProperty.GetString()!;
    }

    private static bool TypeMatches(JsonElement value, string type) => type switch
    {
        "object" => value.ValueKind == JsonValueKind.Object,
        "array" => value.ValueKind == JsonValueKind.Array,
        "string" => value.ValueKind == JsonValueKind.String,
        "number" => value.ValueKind == JsonValueKind.Number,
        "integer" => EmbeddedContextProtocol.IsInteger(value),
        "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "null" => value.ValueKind == JsonValueKind.Null,
        _ => false,
    };

    private static void ValidateOptionalMetadata(JsonElement schema, string propertyName, string name)
    {
        if (schema.TryGetProperty(propertyName, out var value)
            && (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString())))
        {
            throw new InvalidDataException($"{name}.{propertyName} is invalid.");
        }
    }

    private static void ValidateIntegerRange(
        JsonElement schema,
        string minimumName,
        string maximumName,
        bool applicable,
        string name)
    {
        var minimum = OptionalNonNegativeInteger(schema, minimumName, applicable, name);
        var maximum = OptionalNonNegativeInteger(schema, maximumName, applicable, name);
        if (minimum.HasValue && maximum.HasValue && minimum.Value > maximum.Value)
        {
            throw new InvalidDataException($"{name} contains an inverted range.");
        }
    }

    private static int? OptionalNonNegativeInteger(
        JsonElement schema,
        string propertyName,
        bool applicable,
        string name)
    {
        if (!schema.TryGetProperty(propertyName, out var value))
        {
            return null;
        }
        if (!applicable || !value.TryGetInt32(out var result) || result < 0)
        {
            throw new InvalidDataException($"{name}.{propertyName} is invalid.");
        }
        return result;
    }

    private static void ValidateNumberRange(
        JsonElement schema,
        string minimumName,
        string maximumName,
        bool applicable,
        string name)
    {
        var minimum = OptionalNumber(schema, minimumName, applicable, name);
        var maximum = OptionalNumber(schema, maximumName, applicable, name);
        if (minimum.HasValue
            && maximum.HasValue
            && EmbeddedContextProtocol.CompareNumbers(minimum.Value, maximum.Value) > 0)
        {
            throw new InvalidDataException($"{name} contains an inverted numeric range.");
        }
    }

    private static JsonElement? OptionalNumber(
        JsonElement schema,
        string propertyName,
        bool applicable,
        string name)
    {
        if (!schema.TryGetProperty(propertyName, out var value))
        {
            return null;
        }
        if (!applicable || value.ValueKind != JsonValueKind.Number)
        {
            throw new InvalidDataException($"{name}.{propertyName} is invalid.");
        }
        return value;
    }

    private static bool WithinIntegerRange(int value, JsonElement schema, string minimumName, string maximumName) =>
        (!schema.TryGetProperty(minimumName, out var minimum) || value >= minimum.GetInt32())
        && (!schema.TryGetProperty(maximumName, out var maximum) || value <= maximum.GetInt32());
}
