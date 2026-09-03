using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Collections.ObjectModel;
using Relu.AI.Bridge.DesktopConnector.Internal;

namespace Relu.AI.Bridge.DesktopConnector;

public sealed class ReluEmbeddedCapabilityDefinition
{
    private static readonly Regex NamePattern = new(
        "^[a-z][a-z0-9_.-]{0,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public ReluEmbeddedCapabilityDefinition(
        string name,
        string description,
        JsonElement inputSchema,
        JsonElement outputSchema,
        string effect = "read")
    {
        if (string.IsNullOrEmpty(name) || !NamePattern.IsMatch(name))
        {
            throw new ArgumentException("Capability name is invalid.", nameof(name));
        }
        if (string.IsNullOrWhiteSpace(description) || Encoding.UTF8.GetByteCount(description) > 1000)
        {
            throw new ArgumentException("Capability description is invalid.", nameof(description));
        }
        if (effect != "read")
        {
            throw new ArgumentException("Embedded capabilities are read-only in protocol version 0.7.0.", nameof(effect));
        }

        Name = name;
        Description = description;
        InputSchema = CloneSchema(inputSchema, nameof(inputSchema));
        OutputSchema = CloneSchema(outputSchema, nameof(outputSchema));
        EmbeddedJsonSchema.ValidateSchema(InputSchema, nameof(inputSchema));
        EmbeddedJsonSchema.ValidateSchema(OutputSchema, nameof(outputSchema));
    }

    public string Name { get; }
    public string Description { get; }
    public JsonElement InputSchema { get; }
    public JsonElement OutputSchema { get; }
    public string Effect => "read";
    public bool ReadOnly => true;

    private static JsonElement CloneSchema(JsonElement schema, string name)
    {
        var value = BoundedJson.CloneAndValidate(schema, 128 * 1024, name);
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("Capability schema must be an object.", name);
        }
        if (!value.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String
            || type.GetString() != "object")
        {
            throw new ArgumentException("Capability schema root type must be object.", name);
        }
        return value;
    }
}

public sealed class ReluEmbeddedServiceDefinition
{
    private static readonly Regex ServiceIdPattern = new(
        "^[a-z][a-z0-9_-]{1,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex ContextFieldPattern = new(
        "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public ReluEmbeddedServiceDefinition(
        string serviceId,
        string displayName,
        IReadOnlyCollection<ReluEmbeddedCapabilityDefinition> capabilities,
        IReadOnlyCollection<string> contextGuardFields,
        string instructions,
        string version = "0.7.0",
        TimeSpan? requestTimeout = null)
    {
        if (string.IsNullOrEmpty(serviceId) || !ServiceIdPattern.IsMatch(serviceId))
        {
            throw new ArgumentException("Service id is invalid.", nameof(serviceId));
        }
        if (string.IsNullOrWhiteSpace(displayName) || Encoding.UTF8.GetByteCount(displayName) > 200)
        {
            throw new ArgumentException("Display name is invalid.", nameof(displayName));
        }
        ArgumentNullException.ThrowIfNull(capabilities);
        ArgumentNullException.ThrowIfNull(contextGuardFields);
        if (capabilities.Count is < 1 or > 64
            || capabilities.Select(item => item.Name).Distinct(StringComparer.Ordinal).Count() != capabilities.Count)
        {
            throw new ArgumentException("Capabilities must contain 1 to 64 unique entries.", nameof(capabilities));
        }
        if (contextGuardFields.Count is < 1 or > 8
            || contextGuardFields.Any(field => !ContextFieldPattern.IsMatch(field))
            || contextGuardFields.Distinct(StringComparer.Ordinal).Count() != contextGuardFields.Count)
        {
            throw new ArgumentException("Context guard fields are invalid.", nameof(contextGuardFields));
        }
        if (string.IsNullOrWhiteSpace(version) || version.Length > 100)
        {
            throw new ArgumentException("Version is invalid.", nameof(version));
        }
        if (string.IsNullOrWhiteSpace(instructions)
            || Encoding.UTF8.GetByteCount(instructions) > 8 * 1024)
        {
            throw new ArgumentException("Instructions must contain 1 to 8192 UTF-8 bytes.", nameof(instructions));
        }
        var effectiveTimeout = requestTimeout ?? TimeSpan.FromSeconds(30);
        if (effectiveTimeout < TimeSpan.FromMilliseconds(100)
            || effectiveTimeout > TimeSpan.FromMinutes(5))
        {
            throw new ArgumentOutOfRangeException(nameof(requestTimeout));
        }

        var capabilityArray = capabilities.ToArray();
        var manifestByteCount = JsonSerializer.SerializeToUtf8Bytes(capabilityArray).Length;
        if (manifestByteCount > 512 * 1024)
        {
            throw new ArgumentException("The compiled capability manifest exceeds 512 KiB.", nameof(capabilities));
        }

        ServiceId = serviceId;
        DisplayName = displayName;
        Capabilities = new ReadOnlyCollection<ReluEmbeddedCapabilityDefinition>(capabilityArray);
        ContextGuardFields = new ReadOnlyCollection<string>(contextGuardFields.ToArray());
        Version = version;
        Instructions = instructions;
        RequestTimeout = effectiveTimeout;
        ManifestByteCount = manifestByteCount;
        PipeName = CreatePipeName(serviceId, GetCurrentUserIdentity());
        var sessionSuffix = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"relu-ai-bridge-session-v1\0{serviceId}")))
            .ToLowerInvariant()[..24];
        SessionId = $"relu_embedded_{sessionSuffix}";
    }

    public string ServiceId { get; }
    public string DisplayName { get; }
    public string Version { get; }
    public string Instructions { get; }
    public TimeSpan RequestTimeout { get; }
    public IReadOnlyCollection<ReluEmbeddedCapabilityDefinition> Capabilities { get; }
    public IReadOnlyCollection<string> ContextGuardFields { get; }
    public string PipeName { get; }
    public string SessionId { get; }
    internal int ManifestByteCount { get; }

    internal static string CreatePipeName(string serviceId, string userIdentity)
    {
        if (string.IsNullOrWhiteSpace(serviceId))
        {
            throw new ArgumentException("Service id is required.", nameof(serviceId));
        }
        if (string.IsNullOrWhiteSpace(userIdentity))
        {
            throw new ArgumentException("User identity is required.", nameof(userIdentity));
        }

        var material = Encoding.UTF8.GetBytes(
            $"relu-ai-bridge-pipe-v1\0{userIdentity}\0{serviceId}");
        var suffix = Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant()[..24];
        return $"relu-ai-bridge-{suffix}";
    }

    internal static string GetCurrentUserIdentity()
    {
        if (OperatingSystem.IsWindows())
        {
            return GetCurrentWindowsUserSid();
        }

        var userName = Environment.UserName;
        if (string.IsNullOrWhiteSpace(userName))
        {
            throw new InvalidOperationException("The current user identity is unavailable.");
        }
        return $"non-windows:{userName}";
    }

    [SupportedOSPlatform("windows")]
    private static string GetCurrentWindowsUserSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value
            ?? throw new InvalidOperationException("The current Windows user SID is unavailable.");
    }
}

public sealed class ReluEmbeddedBridgeOptions
{
    public required ReluEmbeddedServiceDefinition Service { get; init; }
    public required IReluDesktopContextProvider ContextProvider { get; init; }
    public required IReadOnlyCollection<ReluDesktopCapability> Handlers { get; init; }
    public bool InitialActive { get; init; } = true;
    public int MaximumMessageBytes { get; init; } = 1024 * 1024;

    internal void Validate()
    {
        ArgumentNullException.ThrowIfNull(Service);
        ArgumentNullException.ThrowIfNull(ContextProvider);
        ArgumentNullException.ThrowIfNull(Handlers);
        if (Handlers.Count != Service.Capabilities.Count
            || !Handlers.Select(item => item.Name).Order(StringComparer.Ordinal)
                .SequenceEqual(Service.Capabilities.Select(item => item.Name).Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new ArgumentException("Handlers must exactly match the compiled capability manifest.", nameof(Handlers));
        }
        if (MaximumMessageBytes is < 64 * 1024 or > 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumMessageBytes));
        }
        if (Service.ManifestByteCount + 16 * 1024 > MaximumMessageBytes)
        {
            throw new ArgumentException(
                "MaximumMessageBytes is too small for the compiled capability manifest.",
                nameof(MaximumMessageBytes));
        }
    }
}
