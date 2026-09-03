using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Relu.AI.Bridge.DesktopConnector;

public enum ReluAgentRegistrationState
{
    Registered,
    AlreadyRegistered,
    Conflict,
    Unavailable,
    Failed,
}

public sealed record ReluAgentClientRegistration(
    string Client,
    ReluAgentRegistrationState State,
    string Message);

public sealed record ReluAgentRegistrationResult(
    IReadOnlyList<ReluAgentClientRegistration> Clients,
    bool RestartRequired);

public sealed class ReluAgentRegistrationOptions
{
    public string ServerName { get; init; } = "relu-endviewer";
    public bool RegisterCodex { get; init; } = true;
    public bool RegisterClaude { get; init; } = true;
    public string CodexCommand { get; init; } = "codex";
    public string ClaudeCommand { get; init; } = "claude";
    public TimeSpan CommandTimeout { get; init; } = TimeSpan.FromSeconds(15);

    internal void Validate()
    {
        if (!Regex.IsMatch(ServerName, "^[a-zA-Z][a-zA-Z0-9_-]{2,63}$", RegexOptions.CultureInvariant))
        {
            throw new ArgumentException("ServerName is invalid.", nameof(ServerName));
        }
        if (!RegisterCodex && !RegisterClaude)
        {
            throw new ArgumentException("At least one agent client must be selected.");
        }
        ValidateCommand(CodexCommand, nameof(CodexCommand));
        ValidateCommand(ClaudeCommand, nameof(ClaudeCommand));
        if (CommandTimeout < TimeSpan.FromSeconds(1) || CommandTimeout > TimeSpan.FromMinutes(2))
        {
            throw new ArgumentOutOfRangeException(nameof(CommandTimeout));
        }
    }

    private static void ValidateCommand(string command, string name)
    {
        if (string.IsNullOrWhiteSpace(command) || command != command.Trim())
        {
            throw new ArgumentException("Agent command must not be empty or padded.", name);
        }
        if (Path.IsPathFullyQualified(command))
        {
            if (!File.Exists(command))
            {
                throw new ArgumentException("Absolute agent command does not exist.", name);
            }
            return;
        }
        if (command.IndexOfAny([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar]) >= 0)
        {
            throw new ArgumentException("Relative agent command paths are not allowed.", name);
        }
    }
}

/// <summary>
/// 같은 EndViewer.exe의 stdio mode를 Claude/Codex user scope에 idempotent하게 등록합니다.
/// 이미 같은 이름의 다른 등록이 있으면 덮어쓰지 않습니다.
/// Windows에서는 임의 PATH/bare command를 실행하지 않고, 공식 고정 위치 또는 실행 중인
/// 클라이언트에서 찾은 Authenticode/publisher 검증 완료 절대 경로만 실행합니다.
/// </summary>
public sealed class ReluAiClientRegistrar
{
    private enum RegistrationInspection
    {
        Conflict,
        Ready,
        Unhealthy,
    }

    private static readonly SemaphoreSlim RegistrationGate = new(1, 1);
    private readonly IReluRegistrationProcessRunner _runner;
    private readonly IReluAgentCommandLocator _locator;
    private readonly Func<string?> _currentExecutablePath;

    public ReluAiClientRegistrar() : this(
        new ReluRegistrationProcessRunner(),
        new ReluAgentCommandLocator(),
        () => Environment.ProcessPath)
    {
    }

    internal ReluAiClientRegistrar(
        IReluRegistrationProcessRunner runner,
        IReluAgentCommandLocator? locator = null,
        Func<string?>? currentExecutablePath = null)
    {
        _runner = runner ?? throw new ArgumentNullException(nameof(runner));
        _locator = locator ?? new ReluAgentCommandLocator();
        _currentExecutablePath = currentExecutablePath ?? (() => Environment.ProcessPath);
    }

    public async Task<ReluAgentRegistrationResult> RegisterUserScopeAsync(
        ReluAgentRegistrationOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new ReluAgentRegistrationOptions();
        options.Validate();

        var executablePath = ResolveCurrentExecutablePath();
        if (executablePath is null)
        {
            return UnavailableResult(
                options,
                "The current EndViewer executable path is unavailable or no longer exists.");
        }

        if (OperatingSystem.IsWindows() && ReluWindowsProcessSecurity.IsElevatedOrUnknown())
        {
            return UnavailableResult(
                options,
                "Automatic MCP registration is disabled for an elevated or unverifiable EndViewer process.");
        }

        await RegistrationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        ReluWindowsNamedMutexLease? windowsGate = null;
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var waitDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                waitDeadline.CancelAfter(options.CommandTimeout);
                try
                {
                    windowsGate = await ReluWindowsNamedMutexLease.AcquireAsync(
                        CreateWindowsMutexName(options.ServerName),
                        waitDeadline.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    return UnavailableResult(options, "Another EndViewer process is still registering MCP clients.");
                }
                catch (Exception exception) when (IsCommandLaunchFailure(exception)
                    || exception is ApplicationException)
                {
                    return UnavailableResult(options, "The cross-process MCP registration lock is unavailable.");
                }
            }

            var results = new List<ReluAgentClientRegistration>(2);
            if (options.RegisterCodex)
            {
                results.Add(await RegisterOneAsync(
                    "Codex",
                    options.CodexCommand,
                    ["mcp", "get", options.ServerName, "--json"],
                    ["mcp", "add", options.ServerName, "--", executablePath, ReluMcpStdioEntryPoint.StdioArgument],
                    options,
                    executablePath,
                    cancellationToken).ConfigureAwait(false));
            }
            if (options.RegisterClaude)
            {
                results.Add(await RegisterOneAsync(
                    "Claude",
                    options.ClaudeCommand,
                    ["mcp", "get", options.ServerName],
                    ["mcp", "add", "--scope", "user", options.ServerName, "--", executablePath, ReluMcpStdioEntryPoint.StdioArgument],
                    options,
                    executablePath,
                    cancellationToken).ConfigureAwait(false));
            }
            return new ReluAgentRegistrationResult(
                results,
                results.Any(item => item.State == ReluAgentRegistrationState.Registered));
        }
        finally
        {
            windowsGate?.Dispose();
            RegistrationGate.Release();
        }
    }

    private string? ResolveCurrentExecutablePath()
    {
        var executablePath = _currentExecutablePath();
        if (string.IsNullOrWhiteSpace(executablePath)
            || executablePath != executablePath.Trim()
            || !Path.IsPathFullyQualified(executablePath)
            || !File.Exists(executablePath))
        {
            return null;
        }
        try
        {
            return Path.GetFullPath(executablePath);
        }
        catch (Exception exception) when (exception is ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return null;
        }
    }

    private static ReluAgentRegistrationResult UnavailableResult(
        ReluAgentRegistrationOptions options,
        string message)
    {
        var results = new List<ReluAgentClientRegistration>(2);
        if (options.RegisterCodex)
        {
            results.Add(new("Codex", ReluAgentRegistrationState.Unavailable, message));
        }
        if (options.RegisterClaude)
        {
            results.Add(new("Claude", ReluAgentRegistrationState.Unavailable, message));
        }
        return new(results, RestartRequired: false);
    }

    private static string CreateWindowsMutexName(string serverName)
    {
        var userIdentity = ReluEmbeddedServiceDefinition.GetCurrentUserIdentity();
        var digest = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            $"relu-ai-bridge-registrar-mutex-v1\0{userIdentity}\0{serverName}"));
        // User-scope MCP configuration is shared by the account, so serialize registration
        // across Terminal Services sessions as well as processes in the current session.
        return $"Global\\Relu.AI.Bridge.EndViewer.McpRegistration.{Convert.ToHexString(digest.AsSpan(0, 12))}";
    }

    private async Task<ReluAgentClientRegistration> RegisterOneAsync(
        string client,
        string command,
        IReadOnlyList<string> getArguments,
        IReadOnlyList<string> addArguments,
        ReluAgentRegistrationOptions options,
        string executablePath,
        CancellationToken cancellationToken)
    {
        var candidates = (OperatingSystem.IsWindows()
                ? _locator.FindCandidates(client, command)
                : new[] { command }.Concat(_locator.FindCandidates(client, command)))
            .Distinct(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal)
            .ToArray();
        foreach (var candidate in candidates)
        {
            ReluRegistrationProcessResult current;
            try
            {
                current = await _runner.RunAsync(
                    candidate, getArguments, options.CommandTimeout, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (IsCommandLaunchFailure(exception))
            {
                continue;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} registration inspection timed out.");
            }

            if (current.ExitCode == 0)
            {
                return ExistingRegistrationResult(
                    client,
                    InspectRegistration(client, current.StandardOutput, options.ServerName, executablePath),
                    "The existing user-scope registration already matches EndViewer.",
                    "The server name is already registered to a different command; it was preserved.");
            }
            if (!IsMissingRegistration(client, current, options.ServerName))
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} could not inspect its MCP registration.");
            }

            // Recheck immediately before add. The client CLIs do not expose compare-and-set,
            // so an unrelated external writer can still race after this inspection.
            var preAdd = await TryRunAsync(
                candidate,
                getArguments,
                options.CommandTimeout,
                cancellationToken).ConfigureAwait(false);
            if (preAdd.Exception is not null)
            {
                return new(client, preAdd.TimedOut
                    ? ReluAgentRegistrationState.Failed
                    : ReluAgentRegistrationState.Unavailable,
                    preAdd.TimedOut
                        ? $"{client} registration recheck timed out."
                        : $"{client} command disappeared before registration.");
            }
            if (preAdd.Result!.ExitCode == 0)
            {
                return ExistingRegistrationResult(
                    client,
                    InspectRegistration(client, preAdd.Result.StandardOutput, options.ServerName, executablePath),
                    "Another EndViewer process registered the exact command first.",
                    "The server name changed before registration; the other registration was preserved.");
            }
            if (!IsMissingRegistration(client, preAdd.Result, options.ServerName))
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} could not recheck its MCP registration.");
            }

            ReluRegistrationProcessResult added;
            try
            {
                added = await _runner.RunAsync(
                    candidate, addArguments, options.CommandTimeout, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (IsCommandLaunchFailure(exception))
            {
                return new(client, ReluAgentRegistrationState.Unavailable, $"{client} command disappeared before registration.");
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} registration timed out.");
            }
            if (added.ExitCode != 0)
            {
                var afterRejectedAdd = await TryRunAsync(
                    candidate,
                    getArguments,
                    options.CommandTimeout,
                    cancellationToken).ConfigureAwait(false);
                if (afterRejectedAdd.Result?.ExitCode == 0)
                {
                    return ExistingRegistrationResult(
                        client,
                        InspectRegistration(client, afterRejectedAdd.Result.StandardOutput, options.ServerName, executablePath),
                        "The exact registration appeared while the client rejected a competing add.",
                        "A different registration won the concurrent add; it was preserved.");
                }
                return new(client, ReluAgentRegistrationState.Failed, $"{client} rejected the user-scope MCP registration.");
            }

            ReluRegistrationProcessResult verified;
            try
            {
                verified = await _runner.RunAsync(
                    candidate, getArguments, options.CommandTimeout, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (IsCommandLaunchFailure(exception))
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} registration could not be verified.");
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} registration verification timed out.");
            }
            if (verified.ExitCode != 0)
            {
                return new(client, ReluAgentRegistrationState.Failed, $"{client} registration could not be read back.");
            }
            return InspectRegistration(client, verified.StandardOutput, options.ServerName, executablePath) switch
            {
                RegistrationInspection.Ready => new(
                    client,
                    ReluAgentRegistrationState.Registered,
                    "EndViewer was registered; restart this agent client once to load it."),
                RegistrationInspection.Unhealthy => new(
                    client,
                    ReluAgentRegistrationState.Failed,
                    $"{client} stored the exact registration but could not connect to the running EndViewer."),
                _ => new(
                    client,
                    ReluAgentRegistrationState.Conflict,
                    $"{client} registration changed before verification; it was not overwritten."),
            };
        }
        return new(client, ReluAgentRegistrationState.Unavailable, $"{client} command is not installed or could not be located safely.");
    }

    private async Task<(ReluRegistrationProcessResult? Result, Exception? Exception, bool TimedOut)> TryRunAsync(
        string candidate,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        try
        {
            return (await _runner.RunAsync(candidate, arguments, timeout, cancellationToken).ConfigureAwait(false), null, false);
        }
        catch (Exception exception) when (IsCommandLaunchFailure(exception))
        {
            return (null, exception, false);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            return (null, exception, true);
        }
    }

    private static bool IsMissingRegistration(
        string client,
        ReluRegistrationProcessResult result,
        string serverName)
    {
        var expected = client switch
        {
            "Codex" => $"Error: No MCP server named '{serverName}' found.",
            "Claude" => $"No MCP server named \"{serverName}\". Run `claude mcp add` to add one.",
            _ => string.Empty,
        };
        if (expected.Length == 0)
        {
            return false;
        }
        if (result.ExitCode == 0)
        {
            return false;
        }
        var standardOutput = result.StandardOutput.Trim();
        var standardError = result.StandardError.Trim();
        return (standardOutput == expected && standardError.Length == 0)
            || (standardError == expected && standardOutput.Length == 0);
    }

    private static bool IsCommandLaunchFailure(Exception exception) => exception is Win32Exception
        or FileNotFoundException
        or DirectoryNotFoundException
        or UnauthorizedAccessException
        or IOException;

    private static ReluAgentClientRegistration ExistingRegistrationResult(
        string client,
        RegistrationInspection inspection,
        string readyMessage,
        string conflictMessage) => inspection switch
        {
            RegistrationInspection.Ready => new(
                client,
                ReluAgentRegistrationState.AlreadyRegistered,
                readyMessage),
            RegistrationInspection.Unhealthy => new(
                client,
                ReluAgentRegistrationState.Failed,
                $"{client} has the exact EndViewer registration but is not connected to the running app."),
            _ => new(client, ReluAgentRegistrationState.Conflict, conflictMessage),
        };

    private static RegistrationInspection InspectRegistration(
        string client,
        string output,
        string serverName,
        string executablePath)
    {
        return client switch
        {
            "Codex" => CodexRegistrationMatches(output, serverName, executablePath)
                ? RegistrationInspection.Ready
                : RegistrationInspection.Conflict,
            "Claude" => InspectClaudeRegistration(output, serverName, executablePath),
            _ => RegistrationInspection.Conflict,
        };
    }

    private static bool CodexRegistrationMatches(
        string output,
        string serverName,
        string executablePath)
    {
        try
        {
            using var document = JsonDocument.Parse(output, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16,
            });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || HasDuplicateProperties(root)
                || !HasOnlyProperties(root,
                    "name",
                    "enabled",
                    "disabled_reason",
                    "transport",
                    "enabled_tools",
                    "disabled_tools",
                    "startup_timeout_sec",
                    "tool_timeout_sec")
                || !TryGetRequiredString(root, "name", out var name)
                || name != serverName
                || !TryGetRequiredBoolean(root, "enabled", out var enabled)
                || !enabled
                || !IsMissingOrNull(root, "disabled_reason")
                || !IsMissingNullOrEmptyArray(root, "enabled_tools")
                || !IsMissingNullOrEmptyArray(root, "disabled_tools")
                || !IsMissingOrNull(root, "startup_timeout_sec")
                || !IsMissingOrNull(root, "tool_timeout_sec")
                || !TryGetUniqueProperty(root, "transport", out var transport)
                || transport.ValueKind != JsonValueKind.Object
                || HasDuplicateProperties(transport))
            {
                return false;
            }

            foreach (var property in transport.EnumerateObject())
            {
                if (property.Name is not ("type" or "command" or "args" or "env" or "env_vars" or "cwd")
                    && !IsNullOrEmpty(property.Value))
                {
                    return false;
                }
            }

            return TryGetRequiredString(transport, "type", out var type)
                && type == "stdio"
                && TryGetRequiredString(transport, "command", out var command)
                && PathsEqual(command, executablePath)
                && TryGetUniqueProperty(transport, "args", out var arguments)
                && arguments.ValueKind == JsonValueKind.Array
                && arguments.GetArrayLength() == 1
                && arguments[0].ValueKind == JsonValueKind.String
                && arguments[0].GetString() == ReluMcpStdioEntryPoint.StdioArgument
                && IsMissingNullOrEmptyObject(transport, "env")
                && IsMissingNullOrEmptyArray(transport, "env_vars")
                && IsMissingNullOrEmptyString(transport, "cwd");
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static RegistrationInspection InspectClaudeRegistration(
        string output,
        string serverName,
        string executablePath)
    {
        var lines = output.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var nonEmptyStart = Array.FindIndex(lines, line => !string.IsNullOrWhiteSpace(line));
        if (nonEmptyStart < 0 || lines[nonEmptyStart] != $"{serverName}:")
        {
            return RegistrationInspection.Conflict;
        }

        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var sawFooter = false;
        for (var index = nonEmptyStart + 1; index < lines.Length; index++)
        {
            var rawLine = lines[index];
            if (string.IsNullOrWhiteSpace(rawLine))
            {
                continue;
            }
            if (rawLine.StartsWith("To remove this server, run: ", StringComparison.Ordinal))
            {
                if (sawFooter || rawLine != $"To remove this server, run: claude mcp remove {serverName} -s user")
                {
                    return RegistrationInspection.Conflict;
                }
                sawFooter = true;
                continue;
            }
            if (sawFooter || !rawLine.StartsWith("  ", StringComparison.Ordinal))
            {
                return RegistrationInspection.Conflict;
            }
            var line = rawLine[2..];
            var separator = line.IndexOf(':');
            if (separator <= 0)
            {
                return RegistrationInspection.Conflict;
            }
            var field = line[..separator];
            var fieldValue = line[(separator + 1)..];
            if (fieldValue.StartsWith(' '))
            {
                fieldValue = fieldValue[1..];
            }
            if (field is not ("Scope" or "Status" or "Issue" or "Type" or "Command" or "Args" or "Environment")
                || !fields.TryAdd(field, fieldValue))
            {
                return RegistrationInspection.Conflict;
            }
        }

        if (fields.Count is < 6 or > 7
            || !fields.TryGetValue("Scope", out var scope)
            || scope != "User config (available in all your projects)"
            || !fields.TryGetValue("Status", out var status)
            || string.IsNullOrWhiteSpace(status)
            || status.Length > 256
            || !fields.TryGetValue("Type", out var type)
            || type != "stdio"
            || !fields.TryGetValue("Command", out var command)
            || !PathsEqual(command, executablePath)
            || !fields.TryGetValue("Args", out var arguments)
            || arguments != ReluMcpStdioEntryPoint.StdioArgument
            || !fields.TryGetValue("Environment", out var environment)
            || environment.Length != 0)
        {
            return RegistrationInspection.Conflict;
        }

        var connected = NormalizeClaudeStatus(status) == "Connected";
        return connected && !fields.ContainsKey("Issue")
            ? RegistrationInspection.Ready
            : RegistrationInspection.Unhealthy;
    }

    private static string NormalizeClaudeStatus(string status) => status.Trim()
        .TrimStart('✔', '✘', '✓', ' ')
        .Trim();

    private static bool TryGetRequiredString(JsonElement value, string name, out string result)
    {
        result = string.Empty;
        return TryGetUniqueProperty(value, name, out var property)
            && property.ValueKind == JsonValueKind.String
            && (result = property.GetString() ?? string.Empty).Length > 0;
    }

    private static bool TryGetRequiredBoolean(JsonElement value, string name, out bool result)
    {
        result = false;
        if (!TryGetUniqueProperty(value, name, out var property)
            || property.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return false;
        }
        result = property.GetBoolean();
        return true;
    }

    private static bool TryGetUniqueProperty(JsonElement value, string name, out JsonElement result)
    {
        result = default;
        var found = false;
        foreach (var property in value.EnumerateObject())
        {
            if (property.Name != name)
            {
                continue;
            }
            if (found)
            {
                return false;
            }
            result = property.Value;
            found = true;
        }
        return found;
    }

    private static bool HasDuplicateProperties(JsonElement value)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        return value.EnumerateObject().Any(property => !names.Add(property.Name));
    }

    private static bool HasOnlyProperties(JsonElement value, params string[] names)
    {
        var allowed = names.ToHashSet(StringComparer.Ordinal);
        return value.EnumerateObject().All(property => allowed.Contains(property.Name));
    }

    private static bool IsMissingOrNull(JsonElement value, string name) =>
        !TryGetUniqueProperty(value, name, out var property) || property.ValueKind == JsonValueKind.Null;

    private static bool IsMissingNullOrEmptyArray(JsonElement value, string name) =>
        !TryGetUniqueProperty(value, name, out var property)
        || property.ValueKind == JsonValueKind.Null
        || (property.ValueKind == JsonValueKind.Array && property.GetArrayLength() == 0);

    private static bool IsMissingNullOrEmptyObject(JsonElement value, string name) =>
        !TryGetUniqueProperty(value, name, out var property)
        || property.ValueKind == JsonValueKind.Null
        || (property.ValueKind == JsonValueKind.Object && !property.EnumerateObject().Any());

    private static bool IsMissingNullOrEmptyString(JsonElement value, string name) =>
        !TryGetUniqueProperty(value, name, out var property)
        || property.ValueKind == JsonValueKind.Null
        || (property.ValueKind == JsonValueKind.String && property.GetString()?.Length == 0);

    private static bool IsNullOrEmpty(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => true,
        JsonValueKind.String => value.GetString()?.Length == 0,
        JsonValueKind.Array => value.GetArrayLength() == 0,
        JsonValueKind.Object => !value.EnumerateObject().Any(),
        _ => false,
    };

    private static bool PathsEqual(string? left, string right)
    {
        if (string.IsNullOrWhiteSpace(left)
            || left != left.Trim()
            || right != right.Trim()
            || !Path.IsPathFullyQualified(left))
        {
            return false;
        }
        try
        {
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), comparison);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }
}

internal interface IReluAgentCommandLocator
{
    IReadOnlyList<string> FindCandidates(string client, string configuredCommand);
}

internal sealed class ReluAgentCommandLocator : IReluAgentCommandLocator
{
    private readonly IReluWindowsAgentExecutableVerifier _verifier;

    internal ReluAgentCommandLocator() : this(new ReluWindowsAgentExecutableVerifier())
    {
    }

    internal ReluAgentCommandLocator(IReluWindowsAgentExecutableVerifier verifier)
    {
        _verifier = verifier ?? throw new ArgumentNullException(nameof(verifier));
    }

    public IReadOnlyList<string> FindCandidates(string client, string configuredCommand)
    {
        if (!OperatingSystem.IsWindows() || client is not ("Codex" or "Claude"))
        {
            return Array.Empty<string>();
        }

        var candidates = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (Path.IsPathFullyQualified(configuredCommand))
        {
            AddIfTrusted(candidates, seen, client, configuredCommand);
            return candidates;
        }

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var isDefault = (client == "Codex" && configuredCommand == "codex")
            || (client == "Claude" && configuredCommand == "claude");
        if (isDefault)
        {
            foreach (var candidate in GetStaticWindowsCandidates(client, localAppData, userProfile))
            {
                AddIfTrusted(candidates, seen, client, candidate);
            }
        }

        if (isDefault)
        {
            var processNames = client == "Codex"
                ? new[] { "ChatGPT", "Codex", "codex" }
                : new[] { "Claude", "claude" };
            foreach (var processName in processNames)
            {
                Process[] processes;
                try
                {
                    processes = Process.GetProcessesByName(processName);
                }
                catch
                {
                    continue;
                }
                foreach (var process in processes)
                {
                    using (process)
                    {
                        try
                        {
                            var processPath = process.MainModule?.FileName;
                            if (client == "Claude")
                            {
                                AddIfTrusted(candidates, seen, client, processPath);
                            }
                            else
                            {
                                AddCodexProcessCandidates(candidates, seen, processPath);
                            }
                        }
                        catch (Exception exception) when (exception is Win32Exception
                            or InvalidOperationException
                            or NotSupportedException)
                        {
                        }
                    }
                }
            }
        }
        return candidates;
    }

    internal static IReadOnlyList<string> GetStaticWindowsCandidates(
        string client,
        string localAppData,
        string userProfile)
    {
        if (client == "Claude")
        {
            return string.IsNullOrWhiteSpace(userProfile)
                ? Array.Empty<string>()
                : [Path.Combine(userProfile, ".local", "bin", "claude.exe")];
        }
        if (client != "Codex" || string.IsNullOrWhiteSpace(localAppData))
        {
            return Array.Empty<string>();
        }
        return
        [
            Path.Combine(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
            Path.Combine(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
            Path.Combine(localAppData, "Programs", "OpenAI", "ChatGPT", "resources", "codex.exe"),
            Path.Combine(localAppData, "Programs", "Codex", "codex.exe"),
            Path.Combine(localAppData, "Programs", "Codex", "resources", "codex.exe"),
        ];
    }

    private void AddCodexProcessCandidates(
        ICollection<string> output,
        ISet<string> seen,
        string? processPath)
    {
        if (string.IsNullOrWhiteSpace(processPath))
        {
            return;
        }
        if (Path.GetFileName(processPath).Equals("codex.exe", StringComparison.OrdinalIgnoreCase))
        {
            AddIfTrusted(output, seen, "Codex", processPath);
        }
        var directory = Path.GetDirectoryName(processPath);
        if (string.IsNullOrWhiteSpace(directory))
        {
            return;
        }
        AddIfTrusted(output, seen, "Codex", Path.Combine(directory, "codex.exe"));
        AddIfTrusted(output, seen, "Codex", Path.Combine(directory, "resources", "codex.exe"));
    }

    private void AddIfTrusted(
        ICollection<string> output,
        ISet<string> seen,
        string client,
        string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate))
        {
            return;
        }
        try
        {
            var fullPath = Path.GetFullPath(candidate);
            if (Path.IsPathFullyQualified(fullPath)
                && Path.GetExtension(fullPath).Equals(".exe", StringComparison.OrdinalIgnoreCase)
                && File.Exists(fullPath)
                && _verifier.IsTrusted(client, fullPath)
                && seen.Add(fullPath))
            {
                output.Add(fullPath);
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
        }
    }
}

internal interface IReluWindowsAgentExecutableVerifier
{
    bool IsTrusted(string client, string executablePath);
}

internal sealed class ReluWindowsAgentExecutableVerifier : IReluWindowsAgentExecutableVerifier
{
    // Authenticode leaf CNs observed in the official vendor artifacts on 2026-09-04:
    // @openai/codex@0.153.0-win32-x64 -> "OpenAI OpCo, LLC"
    // @anthropic-ai/claude-code-win32-x64@2.1.259 -> "Anthropic, PBC"
    // Do not accept unverified spelling variants: publisher text is checked only after WinVerifyTrust.
    private static readonly HashSet<string> OpenAiPublishers = new(StringComparer.OrdinalIgnoreCase)
    {
        "OpenAI OpCo, LLC",
    };
    private static readonly HashSet<string> AnthropicPublishers = new(StringComparer.OrdinalIgnoreCase)
    {
        "Anthropic, PBC",
    };

    public bool IsTrusted(string client, string executablePath)
    {
        if (!OperatingSystem.IsWindows()
            || client is not ("Codex" or "Claude")
            || !Path.IsPathFullyQualified(executablePath)
            || !File.Exists(executablePath)
            || !ReluWindowsAuthenticode.Verify(executablePath))
        {
            return false;
        }

        try
        {
#pragma warning disable SYSLIB0057 // X509Certificate.CreateFromSignedFile is the net8 Authenticode API.
            using var certificate = X509Certificate.CreateFromSignedFile(executablePath);
            using var certificate2 = new X509Certificate2(certificate);
#pragma warning restore SYSLIB0057
            var publisher = certificate2.GetNameInfo(X509NameType.SimpleName, forIssuer: false);
            return IsExpectedPublisher(client, publisher);
        }
        catch (Exception exception) when (exception is CryptographicException
            or ArgumentException
            or InvalidOperationException)
        {
            return false;
        }
    }

    internal static bool IsExpectedPublisher(string client, string publisher) => client switch
    {
        "Codex" => OpenAiPublishers.Contains(publisher),
        "Claude" => AnthropicPublishers.Contains(publisher),
        _ => false,
    };
}

[SupportedOSPlatform("windows")]
internal static class ReluWindowsAuthenticode
{
    private const uint WtdUiNone = 2;
    private const uint WtdRevokeNone = 0;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionIgnore = 0;
    private const uint WtdCacheOnlyUrlRetrieval = 0x00001000;
    private static readonly Guid GenericVerifyV2 = new(
        0x00AAC56B,
        0xCD44,
        0x11D0,
        0x8C,
        0xC2,
        0x00,
        0xC0,
        0x4F,
        0xC2,
        0x95,
        0xEE);

    internal static bool Verify(string executablePath)
    {
        var fileInfo = new WinTrustFileInfo(executablePath);
        var fileInfoPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        var dataPointer = IntPtr.Zero;
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, fDeleteOld: false);
            var trustData = new WinTrustData(fileInfoPointer);
            dataPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustData>());
            Marshal.StructureToPtr(trustData, dataPointer, fDeleteOld: false);
            return WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, dataPointer) == 0;
        }
        finally
        {
            if (dataPointer != IntPtr.Zero)
            {
                Marshal.DestroyStructure<WinTrustData>(dataPointer);
                Marshal.FreeHGlobal(dataPointer);
            }
            Marshal.DestroyStructure<WinTrustFileInfo>(fileInfoPointer);
            Marshal.FreeHGlobal(fileInfoPointer);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo(string filePath)
    {
        internal uint StructureSize = (uint)Marshal.SizeOf<WinTrustFileInfo>();
        [MarshalAs(UnmanagedType.LPWStr)]
        internal string FilePath = filePath;
        internal IntPtr FileHandle = IntPtr.Zero;
        internal IntPtr KnownSubject = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData(IntPtr fileInfo)
    {
        internal uint StructureSize = (uint)Marshal.SizeOf<WinTrustData>();
        internal IntPtr PolicyCallbackData = IntPtr.Zero;
        internal IntPtr SipClientData = IntPtr.Zero;
        internal uint UiChoice = WtdUiNone;
        internal uint RevocationChecks = WtdRevokeNone;
        internal uint UnionChoice = WtdChoiceFile;
        internal IntPtr FileInfo = fileInfo;
        internal uint StateAction = WtdStateActionIgnore;
        internal IntPtr StateData = IntPtr.Zero;
        internal IntPtr UrlReference = IntPtr.Zero;
        internal uint ProviderFlags = WtdCacheOnlyUrlRetrieval;
        internal uint UiContext = 0;
        internal IntPtr SignatureSettings = IntPtr.Zero;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = true)]
    private static extern int WinVerifyTrust(
        IntPtr windowHandle,
        [MarshalAs(UnmanagedType.LPStruct)] Guid actionId,
        IntPtr trustData);
}

internal static class ReluWindowsProcessSecurity
{
    private const uint TokenQuery = 0x0008;
    private const int TokenElevation = 20;

    internal static bool IsElevatedOrUnknown()
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token))
            {
                return true;
            }
            var elevation = new TokenElevationInfo();
            return !GetTokenInformation(
                    token,
                    TokenElevation,
                    ref elevation,
                    Marshal.SizeOf<TokenElevationInfo>(),
                    out _)
                || elevation.TokenIsElevated != 0;
        }
        catch
        {
            return true;
        }
        finally
        {
            if (token != IntPtr.Zero)
            {
                _ = CloseHandle(token);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenElevationInfo
    {
        internal int TokenIsElevated;
    }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle,
        int tokenInformationClass,
        ref TokenElevationInfo tokenInformation,
        int tokenInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}

internal sealed class ReluWindowsNamedMutexLease : IDisposable
{
    private readonly ManualResetEventSlim _release;
    private readonly Thread _ownerThread;
    private int _disposed;

    private ReluWindowsNamedMutexLease(ManualResetEventSlim release, Thread ownerThread)
    {
        _release = release;
        _ownerThread = ownerThread;
    }

    internal static Task<ReluWindowsNamedMutexLease> AcquireAsync(
        string name,
        CancellationToken cancellationToken)
    {
        var acquired = new TaskCompletionSource<ReluWindowsNamedMutexLease>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        Thread? ownerThread = null;
        ownerThread = new Thread(() => OwnMutex(name, cancellationToken, acquired, ownerThread!))
        {
            IsBackground = true,
            Name = "RELU MCP registration mutex",
        };
        ownerThread.Start();
        return acquired.Task;
    }

    private static void OwnMutex(
        string name,
        CancellationToken cancellationToken,
        TaskCompletionSource<ReluWindowsNamedMutexLease> acquired,
        Thread ownerThread)
    {
        using var release = new ManualResetEventSlim(initialState: false);
        using var mutex = new Mutex(initiallyOwned: false, name);
        var ownsMutex = false;
        try
        {
            try
            {
                var waitResult = WaitHandle.WaitAny([mutex, cancellationToken.WaitHandle]);
                if (waitResult != 0 || cancellationToken.IsCancellationRequested)
                {
                    acquired.TrySetCanceled(cancellationToken);
                    return;
                }
                ownsMutex = true;
            }
            catch (AbandonedMutexException)
            {
                ownsMutex = true;
                if (cancellationToken.IsCancellationRequested)
                {
                    acquired.TrySetCanceled(cancellationToken);
                    return;
                }
            }

            var lease = new ReluWindowsNamedMutexLease(release, ownerThread);
            if (!acquired.TrySetResult(lease))
            {
                return;
            }
            release.Wait();
        }
        catch (Exception exception)
        {
            acquired.TrySetException(exception);
        }
        finally
        {
            if (ownsMutex)
            {
                try
                {
                    mutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                }
            }
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        _release.Set();
        if (Thread.CurrentThread != _ownerThread)
        {
            _ownerThread.Join();
        }
    }
}

internal sealed record ReluRegistrationProcessResult(int ExitCode, string StandardOutput, string StandardError);

internal interface IReluRegistrationProcessRunner
{
    Task<ReluRegistrationProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken);
}

internal sealed class ReluRegistrationProcessRunner : IReluRegistrationProcessRunner
{
    private const int MaximumOutputCharacters = 64 * 1024;
    private static readonly Regex SensitiveEnvironmentName = new(
        "token|secret|password|credential|authorization|auth|api[_-]?key|(^|_)key($|_)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public async Task<ReluRegistrationProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        foreach (var name in startInfo.Environment.Keys.ToArray())
        {
            if (SensitiveEnvironmentName.IsMatch(name))
            {
                startInfo.Environment.Remove(name);
            }
        }

        using var process = Process.Start(startInfo)
            ?? throw new Win32Exception($"Unable to start {fileName}.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        var standardOutput = ReadBoundedAsync(process.StandardOutput, deadline.Token);
        var standardError = ReadBoundedAsync(process.StandardError, deadline.Token);
        var allOutput = Task.WhenAll(standardOutput, standardError);
        try
        {
            await process.WaitForExitAsync(deadline.Token).ConfigureAwait(false);
            var output = await allOutput.WaitAsync(deadline.Token).ConfigureAwait(false);
            return new ReluRegistrationProcessResult(process.ExitCode, output[0], output[1]);
        }
        catch (OperationCanceledException)
        {
            deadline.Cancel();
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
            }
            _ = ObserveCompletionAsync(allOutput);
            throw;
        }
    }

    private static async Task ObserveCompletionAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch
        {
        }
    }

    private static async Task<string> ReadBoundedAsync(
        StreamReader reader,
        CancellationToken cancellationToken)
    {
        var output = new System.Text.StringBuilder(MaximumOutputCharacters);
        var buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
        {
            var remaining = MaximumOutputCharacters - output.Length;
            if (remaining > 0)
            {
                output.Append(buffer, 0, Math.Min(remaining, count));
            }
        }
        return output.ToString();
    }
}
