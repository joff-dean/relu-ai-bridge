using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Relu.AI.Bridge.DesktopConnector;

namespace Relu.AI.Bridge.PerfettoNativeHost;

internal static partial class Program
{
    private const int ProtocolVersion = 1;
    private const int MaximumNativeMessageBytes = 64 * 1024;
    private const int MaximumReadyLineBytes = 8192;
    private const string RegisterArgument = "--relu-register-ai-clients";
    private const string ConfigurationFileName = "relu-perfetto-native-host.json";

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (ReluMcpStdioEntryPoint.IsStdioMode(args))
            {
                return await RunNodeProxyAsync().ConfigureAwait(false);
            }
            if (args.Length == 1 && args[0] == RegisterArgument)
            {
                return await RegisterAiClientsAsync().ConfigureAwait(false);
            }
            return await RunNativeMessagingAsync(args).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            await Console.Error.WriteLineAsync($"RELU Perfetto Native Host failed: {exception.Message}")
                .ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task<int> RunNativeMessagingAsync(string[] args)
    {
        var configuration = await NativeHostConfiguration.LoadAsync(ConfigurationPath()).ConfigureAwait(false);
        var expectedCaller = $"chrome-extension://{configuration.ExtensionId}/";
        if (args.Length < 1 || !string.Equals(args[0], expectedCaller, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The Native Messaging caller is not the configured Extension.");
        }

        await using var input = Console.OpenStandardInput();
        await using var output = Console.OpenStandardOutput();
        await using var bridge = new ExtensionBridgeProcess(configuration);
        while (true)
        {
            var request = await ReadNativeMessageAsync(input).ConfigureAwait(false);
            if (request is null) break;
            NativeResponse response;
            try
            {
                var value = await HandleRequestAsync(request.Value, configuration, bridge).ConfigureAwait(false);
                response = new NativeResponse(request.Value.Id, true, value, null);
            }
            catch (Exception)
            {
                response = new NativeResponse(request.Value.Id, false, null, "REQUEST_REJECTED");
            }
            await WriteNativeMessageAsync(output, response).ConfigureAwait(false);
        }
        return 0;
    }

    private static async Task<BridgeBootstrap> HandleRequestAsync(
        NativeRequest request,
        NativeHostConfiguration configuration,
        ExtensionBridgeProcess bridge)
    {
        if (request.Type != "bridge.bootstrap" || request.Version != ProtocolVersion
            || !string.Equals(configuration.PerfettoOrigin, request.PageOrigin, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The bootstrap request is invalid.");
        }
        return await bridge.StartAsync().ConfigureAwait(false);
    }

    private static async Task<NativeRequest?> ReadNativeMessageAsync(Stream input)
    {
        var lengthBytes = new byte[4];
        var lengthRead = await ReadExactlyOrEofAsync(input, lengthBytes).ConfigureAwait(false);
        if (!lengthRead) return null;
        var length = BinaryPrimitives.ReadUInt32LittleEndian(lengthBytes);
        if (length is 0 or > MaximumNativeMessageBytes)
        {
            throw new InvalidDataException("Native Messaging frame length is invalid.");
        }
        var payload = new byte[checked((int)length)];
        await input.ReadExactlyAsync(payload).ConfigureAwait(false);
        using var document = JsonDocument.Parse(payload, new JsonDocumentOptions
        {
            MaxDepth = 8,
            CommentHandling = JsonCommentHandling.Disallow,
            AllowTrailingCommas = false,
        });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 4
            || !TryRequiredString(root, "id", out var id, 128)
            || !TryRequiredString(root, "type", out var type, 64)
            || !TryRequiredString(root, "pageOrigin", out var pageOrigin, 2048)
            || !root.TryGetProperty("version", out var versionElement)
            || !versionElement.TryGetInt32(out var version))
        {
            throw new InvalidDataException("Native Messaging request is invalid.");
        }
        return new NativeRequest(id, type, version, pageOrigin);
    }

    private static async Task<bool> ReadExactlyOrEofAsync(Stream input, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var count = await input.ReadAsync(buffer.AsMemory(offset)).ConfigureAwait(false);
            if (count == 0)
            {
                if (offset == 0) return false;
                throw new EndOfStreamException("Native Messaging frame was truncated.");
            }
            offset += count;
        }
        return true;
    }

    private static async Task WriteNativeMessageAsync(Stream output, NativeResponse response)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(response, NativeJsonContext.Default.NativeResponse);
        if (payload.Length > MaximumNativeMessageBytes) throw new InvalidDataException("Native response is too large.");
        var length = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(length, checked((uint)payload.Length));
        await output.WriteAsync(length).ConfigureAwait(false);
        await output.WriteAsync(payload).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
    }

    private static bool TryRequiredString(JsonElement root, string name, out string value, int maximumBytes)
    {
        value = string.Empty;
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String) return false;
        value = element.GetString() ?? string.Empty;
        return value.Length > 0 && Encoding.UTF8.GetByteCount(value) <= maximumBytes;
    }

    private static bool IsBridgeEndpoint(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "ws"
        && uri.Host == "127.0.0.1"
        && !uri.IsDefaultPort
        && uri.Port is >= 1 and <= 65535
        && uri.AbsolutePath == "/perfetto/extension-ws"
        && uri.UserInfo.Length == 0
        && uri.Query.Length == 0
        && uri.Fragment.Length == 0;

    private static async Task<int> RunNodeProxyAsync()
    {
        using var process = StartNodeProcess(DesktopProxyPath(), []);
        var input = Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream);
        var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var errors = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        await input.ConfigureAwait(false);
        process.StandardInput.Close();
        await Task.WhenAll(output, errors, process.WaitForExitAsync()).ConfigureAwait(false);
        return process.ExitCode;
    }

    private static async Task<int> RegisterAiClientsAsync()
    {
        var result = await new ReluAiClientRegistrar().RegisterUserScopeAsync(new ReluAgentRegistrationOptions
        {
            ServerName = "relu-perfetto",
            RegisterClaude = true,
            RegisterCodex = true,
        }).ConfigureAwait(false);
        foreach (var client in result.Clients)
        {
            await Console.Error.WriteLineAsync($"{client.Client}: {client.State} - {client.Message}")
                .ConfigureAwait(false);
        }
        if (!result.Clients.All(item => item.State is ReluAgentRegistrationState.Registered
            or ReluAgentRegistrationState.AlreadyRegistered)) return 2;
        return await RunNodeUtilityAsync(
            SkillsScriptPath(), ["install", "--scope", "user", "--target", "both"])
            .ConfigureAwait(false);
    }

    private static async Task<int> RunNodeUtilityAsync(string script, IReadOnlyList<string> arguments)
    {
        using var process = StartNodeProcess(script, arguments);
        process.StandardInput.Close();
        var standardOutput = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardError());
        var standardError = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        await Task.WhenAll(standardOutput, standardError, process.WaitForExitAsync()).ConfigureAwait(false);
        return process.ExitCode;
    }

    private static Process StartNodeProcess(string script, IReadOnlyList<string> arguments)
    {
        var node = Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
        if (!File.Exists(node) || !File.Exists(script)) throw new FileNotFoundException("The installed Native Host runtime is incomplete.");
        var start = new ProcessStartInfo
        {
            FileName = node,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        var inherited = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in new[] {"SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"})
        {
            inherited[name] = Environment.GetEnvironmentVariable(name);
        }
        start.Environment.Clear();
        foreach (var (name, value) in inherited)
        {
            if (!string.IsNullOrEmpty(value)) start.Environment[name] = value;
        }
        start.ArgumentList.Add(script);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        var process = Process.Start(start) ?? throw new InvalidOperationException("The installed Node runtime did not start.");
        return process;
    }

    private static string ConfigurationPath() => Path.Combine(AppContext.BaseDirectory, ConfigurationFileName);
    private static string BridgeScriptPath() => Path.Combine(AppContext.BaseDirectory, "app", "scripts", "perfetto", "run-extension-bridge.mjs");
    private static string DesktopProxyPath() => Path.Combine(AppContext.BaseDirectory, "app", "scripts", "perfetto", "desktop-mcp-proxy.mjs");
    private static string SkillsScriptPath() => Path.Combine(AppContext.BaseDirectory, "app", "scripts", "skills", "manage-skills.mjs");

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();

    private readonly record struct NativeRequest(string Id, string Type, int Version, string PageOrigin);
    internal sealed record NativeResponse(string Id, bool Ok, BridgeBootstrap? Value, string? Error);
    internal sealed record BridgeBootstrap(string Endpoint, string Token);

    internal sealed class ExtensionBridgeProcess : IAsyncDisposable
    {
        private readonly NativeHostConfiguration _configuration;
        private Process? _process;
        private BridgeBootstrap? _bootstrap;

        public ExtensionBridgeProcess(NativeHostConfiguration configuration) => _configuration = configuration;

        public async Task<BridgeBootstrap> StartAsync()
        {
            if (_bootstrap is not null)
            {
                if (_process?.HasExited == false) return _bootstrap;
                throw new InvalidOperationException("The Extension bridge stopped.");
            }
            var arguments = new List<string> {"--extension-id", _configuration.ExtensionId, "--bridge-port", _configuration.BridgePort.ToString()};
            arguments.Add("--origin");
            arguments.Add(_configuration.PerfettoOrigin);
            _process = StartNodeProcess(BridgeScriptPath(), arguments);
            _ = DrainErrorsAsync(_process.StandardError);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var line = await _process.StandardOutput.ReadLineAsync(timeout.Token).ConfigureAwait(false);
            if (line is null || Encoding.UTF8.GetByteCount(line) > MaximumReadyLineBytes) throw new InvalidDataException("The Extension bridge did not publish a valid bootstrap.");
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 3
                || !root.TryGetProperty("version", out var version) || version.GetInt32() != ProtocolVersion
                || !TryRequiredString(root, "endpoint", out var endpoint, 256)
                || !TryRequiredString(root, "token", out var token, 4096)
                || !IsBridgeEndpoint(endpoint)
                || token.Length < 24)
            {
                throw new InvalidDataException("The Extension bridge bootstrap is invalid.");
            }
            _bootstrap = new BridgeBootstrap(endpoint, token);
            return _bootstrap;
        }

        private static async Task DrainErrorsAsync(StreamReader error)
        {
            var buffer = new char[4096];
            while (await error.ReadAsync(buffer).ConfigureAwait(false) > 0) { }
        }

        public async ValueTask DisposeAsync()
        {
            if (_process is null) return;
            try
            {
                _process.StandardInput.Close();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await _process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch
            {
                if (!_process.HasExited) _process.Kill(entireProcessTree: true);
            }
            finally
            {
                _process.Dispose();
            }
        }
    }

    internal sealed record NativeHostConfiguration(int Version, string ExtensionId, string PerfettoOrigin, int BridgePort)
    {
        public static async Task<NativeHostConfiguration> LoadAsync(string path)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length is < 2 or > MaximumNativeMessageBytes) throw new InvalidDataException("Native Host configuration is missing or invalid.");
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var document = await JsonDocument.ParseAsync(stream, new JsonDocumentOptions {MaxDepth = 8}).ConfigureAwait(false);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 4
                || !root.TryGetProperty("version", out var versionValue) || !versionValue.TryGetInt32(out var version)
                || !TryRequiredString(root, "extensionId", out var extensionId, 32)
                || !ExtensionIdPattern().IsMatch(extensionId)
                || !root.TryGetProperty("bridgePort", out var portValue) || !portValue.TryGetInt32(out var port) || port is < 1 or > 65535
                || !TryRequiredString(root, "perfettoOrigin", out var origin, 2048))
            {
                throw new InvalidDataException("Native Host configuration fields are invalid.");
            }
            if (version != ProtocolVersion || !Uri.TryCreate(origin, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
                || uri.GetLeftPart(UriPartial.Authority) != origin)
            {
                throw new InvalidDataException("Native Host configuration policy is invalid.");
            }
            return new NativeHostConfiguration(version, extensionId, origin, port);
        }
    }
}

[System.Text.Json.Serialization.JsonSourceGenerationOptions(
    PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
[System.Text.Json.Serialization.JsonSerializable(typeof(Program.NativeResponse))]
internal partial class NativeJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
