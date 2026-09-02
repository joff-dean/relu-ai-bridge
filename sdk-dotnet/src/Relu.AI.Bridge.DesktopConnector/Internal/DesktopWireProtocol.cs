using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

internal static class DesktopWireProtocol
{
    internal const string ProtocolVersion = "1.0";
    internal const string ClientKind = "desktop";
    internal const string Audience = "relu-ai-bridge://loopback/relu/desktop/ws";
    private const string AuthDomain = "RELU_DESKTOP_CONNECTOR_AUTH";

    private static readonly Regex Hex64Pattern = new(
        "^[a-f0-9]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex SessionPattern = new(
        "^[a-zA-Z0-9_-]{3,128}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex ResumeSecretPattern = new(
        "^[a-zA-Z0-9_-]{24,256}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex RequestIdPattern = new(
        "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex OperationIdPattern = new(
        "^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex CapabilityPattern = new(
        "^[a-z][a-z0-9_.-]{0,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex ContextFieldPattern = new(
        "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    internal static string CreateNonce() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    internal static string CreateProof(
        ReluConnectorSecret secret,
        string role,
        ReluDesktopConnectorOptions options,
        string clientNonce,
        string serverNonce,
        string registrationDigest = "")
    {
        var transcript = CreateAuthTranscript(
            role,
            options.ServiceId,
            options.AppId,
            options.InstanceId,
            clientNonce,
            serverNonce,
            registrationDigest);
        var key = secret.Bytes.ToArray();
        try
        {
            using var hmac = new HMACSHA256(key);
            return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(transcript))).ToLowerInvariant();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    internal static string CreateAuthTranscript(
        string role,
        string serviceId,
        string appId,
        string instanceId,
        string clientNonce,
        string serverNonce,
        string registrationDigest = "") => JsonSerializer.Serialize(new[]
        {
            AuthDomain,
            ProtocolVersion,
            Audience,
            role,
            serviceId,
            appId,
            instanceId,
            clientNonce,
            serverNonce,
            registrationDigest,
        });

    internal static bool VerifyProof(string supplied, string expected)
    {
        if (!Hex64Pattern.IsMatch(supplied) || !Hex64Pattern.IsMatch(expected))
        {
            return false;
        }

        var suppliedBytes = Convert.FromHexString(supplied);
        var expectedBytes = Convert.FromHexString(expected);
        return CryptographicOperations.FixedTimeEquals(suppliedBytes, expectedBytes);
    }

    internal static string RegistrationDigest(string registrationJson) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(registrationJson))).ToLowerInvariant();

    internal static DesktopAuthChallenge ParseChallenge(JsonElement message, ReluDesktopConnectorOptions options, string clientNonce)
    {
        RequireObject(message, "auth_challenge");
        RequireExactProperties(message, new HashSet<string>(StringComparer.Ordinal)
        {
            "type", "protocolVersion", "serviceId", "clientKind", "appId", "instanceId",
            "audience", "clientNonce", "serverNonce", "proof",
        }, "auth_challenge");
        RequireExactString(message, "type", "auth_challenge");
        RequireExactString(message, "protocolVersion", ProtocolVersion);
        RequireExactString(message, "serviceId", options.ServiceId);
        RequireExactString(message, "clientKind", ClientKind);
        RequireExactString(message, "appId", options.AppId);
        RequireExactString(message, "instanceId", options.InstanceId);
        RequireExactString(message, "audience", Audience);
        RequireExactString(message, "clientNonce", clientNonce);
        var serverNonce = RequireString(message, "serverNonce", 64);
        var proof = RequireString(message, "proof", 64);
        if (!Hex64Pattern.IsMatch(serverNonce) || !Hex64Pattern.IsMatch(proof))
        {
            throw new AuthenticationException("Bridge authentication challenge is invalid.");
        }
        return new DesktopAuthChallenge(serverNonce, proof);
    }

    internal static DesktopHelloAck ParseHelloAck(JsonElement message)
    {
        RequireObject(message, "hello_ack");
        RequireExactString(message, "type", "hello_ack");
        RequireExactString(message, "protocolVersion", ProtocolVersion);
        if (!message.TryGetProperty("accepted", out var acceptedProperty)
            || acceptedProperty.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new AuthenticationException("hello_ack.accepted is invalid.");
        }

        var accepted = acceptedProperty.GetBoolean();
        if (accepted)
        {
            RequireExactProperties(message, new HashSet<string>(StringComparer.Ordinal)
            {
                "type", "protocolVersion", "accepted", "sessionId", "resumeSecret", "heartbeatMs",
            }, "hello_ack");
            var sessionId = RequireString(message, "sessionId", 128);
            var resumeSecret = RequireString(message, "resumeSecret", 256);
            if (!SessionPattern.IsMatch(sessionId) || !ResumeSecretPattern.IsMatch(resumeSecret))
            {
                throw new AuthenticationException("Accepted hello_ack identity is invalid.");
            }
            int? heartbeatMs = null;
            if (message.TryGetProperty("heartbeatMs", out var heartbeat))
            {
                if (!heartbeat.TryGetInt32(out var value) || value is < 1000 or > 300_000)
                {
                    throw new AuthenticationException("hello_ack.heartbeatMs is invalid.");
                }
                heartbeatMs = value;
            }
            return new DesktopHelloAck(true, sessionId, resumeSecret, heartbeatMs, null, null);
        }

        RequireExactProperties(message, new HashSet<string>(StringComparer.Ordinal)
        {
            "type", "protocolVersion", "accepted", "errorCode", "error",
        }, "hello_ack");
        var errorCode = OptionalString(message, "errorCode", 64);
        var error = OptionalString(message, "error", 1000);
        return new DesktopHelloAck(false, null, null, null, errorCode, error);
    }

    internal static DesktopConnectedMessage ParseConnectedMessage(
        JsonElement message,
        IReadOnlyCollection<string> requiredContextGuardFields)
    {
        RequireObject(message, "connected message");
        var type = RequireString(message, "type", 32);
        if (type == "ping")
        {
            RequireExactProperties(message, new HashSet<string>(StringComparer.Ordinal) { "type", "nonce" }, "ping");
            return new DesktopPing(RequireString(message, "nonce", 256));
        }
        if (type != "request")
        {
            throw new InvalidDataException("Unsupported desktop connector message type.");
        }

        RequireExactProperties(message, new HashSet<string>(StringComparer.Ordinal)
        {
            "type", "id", "action", "parameters", "timeoutMs", "operationId", "contextGuard",
        }, "request");
        var id = RequireString(message, "id", 128);
        var action = RequireString(message, "action", 64);
        if (!RequestIdPattern.IsMatch(id) || !CapabilityPattern.IsMatch(action))
        {
            throw new InvalidDataException("Desktop connector request identity is invalid.");
        }

        var parameters = message.TryGetProperty("parameters", out var parametersProperty)
            ? parametersProperty
            : EmptyObject;
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("request.parameters must be an object.");
        }

        var timeoutMs = 30_000;
        if (message.TryGetProperty("timeoutMs", out var timeoutProperty)
            && (!timeoutProperty.TryGetInt32(out timeoutMs) || timeoutMs is < 1 or > 60_000))
        {
            throw new InvalidDataException("request.timeoutMs is invalid.");
        }

        var operationId = OptionalString(message, "operationId", 128);
        if (operationId is not null && !OperationIdPattern.IsMatch(operationId))
        {
            throw new InvalidDataException("request.operationId is invalid.");
        }

        if (!message.TryGetProperty("contextGuard", out var guardProperty))
        {
            throw new InvalidDataException("request.contextGuard is required.");
        }
        var guard = ParseContextGuard(guardProperty, requiredContextGuardFields);
        return new DesktopRequest(id, action, parameters.Clone(), timeoutMs, operationId, guard);
    }

    private static ReluContextGuard ParseContextGuard(
        JsonElement guard,
        IReadOnlyCollection<string> requiredContextGuardFields)
    {
        RequireObject(guard, "request.contextGuard");
        RequireExactProperties(guard, new HashSet<string>(StringComparer.Ordinal)
        {
            "fields", "projection", "binding",
        }, "request.contextGuard");

        if (!guard.TryGetProperty("fields", out var fieldsProperty) || fieldsProperty.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("request.contextGuard.fields is invalid.");
        }
        var fields = fieldsProperty.EnumerateArray().Select(item =>
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                throw new InvalidDataException("request.contextGuard.fields is invalid.");
            }
            return item.GetString() ?? string.Empty;
        }).ToArray();
        if (fields.Length is < 1 or > 8
            || fields.Any(field => !ContextFieldPattern.IsMatch(field))
            || fields.Distinct(StringComparer.Ordinal).Count() != fields.Length
            || requiredContextGuardFields.Any(required => !fields.Contains(required, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("request.contextGuard.fields does not satisfy the desktop execution guard.");
        }

        if (!guard.TryGetProperty("projection", out var projection) || projection.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("request.contextGuard.projection is invalid.");
        }
        var projectionNames = projection.EnumerateObject().Select(property => property.Name).ToArray();
        if (projectionNames.Length != fields.Length || fields.Any(field => !projectionNames.Contains(field, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("request.contextGuard.projection does not match its fields.");
        }

        var binding = RequireString(guard, "binding", 64);
        if (!Hex64Pattern.IsMatch(binding))
        {
            throw new InvalidDataException("request.contextGuard.binding is invalid.");
        }
        return new ReluContextGuard(fields, projection.Clone(), binding);
    }

    internal static JsonElement ProjectContext(JsonElement context, IReadOnlyList<string> fields)
    {
        if (context.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Live desktop context must be an object.");
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var field in fields)
            {
                if (!context.TryGetProperty(field, out var value))
                {
                    throw new ReluContextChangedException();
                }
                writer.WritePropertyName(field);
                value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        using var projection = BoundedJson.Parse(stream.ToArray(), 1024 * 1024, "live context projection");
        return projection.RootElement.Clone();
    }

    internal static bool JsonSemanticallyEquals(JsonElement left, JsonElement right)
    {
        if (left.ValueKind == JsonValueKind.Number && right.ValueKind == JsonValueKind.Number)
        {
            return left.TryGetDouble(out var leftNumber)
                && right.TryGetDouble(out var rightNumber)
                && leftNumber.Equals(rightNumber);
        }
        if (left.ValueKind != right.ValueKind)
        {
            return false;
        }
        switch (left.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var leftProperties = left.EnumerateObject().ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal);
                var rightProperties = right.EnumerateObject().ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal);
                return leftProperties.Count == rightProperties.Count
                    && leftProperties.All(item => rightProperties.TryGetValue(item.Key, out var value)
                        && JsonSemanticallyEquals(item.Value, value));
            }
            case JsonValueKind.Array:
            {
                var leftItems = left.EnumerateArray().ToArray();
                var rightItems = right.EnumerateArray().ToArray();
                return leftItems.Length == rightItems.Length
                    && leftItems.Zip(rightItems).All(pair => JsonSemanticallyEquals(pair.First, pair.Second));
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

    private static readonly JsonElement EmptyObject = JsonSerializer.SerializeToElement(new Dictionary<string, object?>());

    private static void RequireObject(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException($"{name} must be an object.");
        }
    }

    private static void RequireExactProperties(JsonElement value, HashSet<string> allowed, string name)
    {
        foreach (var property in value.EnumerateObject())
        {
            if (!allowed.Contains(property.Name))
            {
                throw new InvalidDataException($"{name} contains an unsupported field.");
            }
        }
    }

    private static void RequireExactString(JsonElement value, string propertyName, string expected)
    {
        var actual = RequireString(value, propertyName, Encoding.UTF8.GetByteCount(expected));
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new AuthenticationException($"{propertyName} binding changed.");
        }
    }

    private static string RequireString(JsonElement value, string propertyName, int maximumBytes)
    {
        if (!value.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException($"{propertyName} is invalid.");
        }
        var result = property.GetString() ?? string.Empty;
        if (result.Length == 0 || Encoding.UTF8.GetByteCount(result) > maximumBytes)
        {
            throw new InvalidDataException($"{propertyName} is invalid.");
        }
        return result;
    }

    private static string? OptionalString(JsonElement value, string propertyName, int maximumBytes)
    {
        if (!value.TryGetProperty(propertyName, out _))
        {
            return null;
        }
        return RequireString(value, propertyName, maximumBytes);
    }
}

internal abstract record DesktopConnectedMessage;

internal sealed record DesktopPing(string Nonce) : DesktopConnectedMessage;

internal sealed record DesktopRequest(
    string Id,
    string Action,
    JsonElement Parameters,
    int TimeoutMs,
    string? OperationId,
    ReluContextGuard ContextGuard) : DesktopConnectedMessage;

internal sealed record DesktopAuthChallenge(string ServerNonce, string Proof);

internal sealed record DesktopHelloAck(
    bool Accepted,
    string? SessionId,
    string? ResumeSecret,
    int? HeartbeatMs,
    string? ErrorCode,
    string? Error);

internal sealed class ReluContextChangedException : Exception
{
    internal ReluContextChangedException() : base("Desktop connector context changed.")
    {
    }
}
