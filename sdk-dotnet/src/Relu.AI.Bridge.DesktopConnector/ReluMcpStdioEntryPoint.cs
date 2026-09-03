using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector.Internal;

namespace Relu.AI.Bridge.DesktopConnector;

/// <summary>
/// Claude/Codex가 같은 EndViewer.exe를 child process로 실행할 때 사용하는 stdio MCP entry point입니다.
/// </summary>
public static class ReluMcpStdioEntryPoint
{
    public const string StdioArgument = "--relu-mcp-stdio";
    private const int MaximumMessageBytes = 1024 * 1024;
    private const int MaximumConcurrentRequests = 16;
    private const string ProtocolVersion = "2025-06-18";

    public static bool IsStdioMode(IReadOnlyList<string> arguments) =>
        arguments.Count == 1 && arguments[0] == StdioArgument;

    public static async Task<int> RunAsync(
        ReluEmbeddedServiceDefinition service,
        Stream? standardInput = null,
        Stream? standardOutput = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(service);
        standardInput ??= Console.OpenStandardInput();
        standardOutput ??= Console.OpenStandardOutput();
        var reader = new BoundedUtf8LineReader(standardInput, MaximumMessageBytes);
        using var writer = new StreamWriter(
            standardOutput,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            bufferSize: 8192,
            leaveOpen: true)
        {
            AutoFlush = true,
            NewLine = "\n",
        };
        using var shutdown = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var writerGate = new SemaphoreSlim(1, 1);
        using var requestSlots = new SemaphoreSlim(MaximumConcurrentRequests, MaximumConcurrentRequests);
        var pending = new ConcurrentDictionary<string, PendingRequest>(StringComparer.Ordinal);
        var taskGate = new object();
        var activeTasks = new HashSet<Task>();
        var sessionState = McpSessionState.AwaitingInitialize;

        try
        {
            while (!shutdown.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(shutdown.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
                {
                    break;
                }
                catch (InvalidDataException)
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(null, -32700, "Parse error"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }
                if (line is null)
                {
                    break;
                }
                if (Encoding.UTF8.GetByteCount(line) is 0 or > MaximumMessageBytes)
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(null, -32600, "Invalid Request"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                JsonElement root;
                try
                {
                    using var message = BoundedJson.Parse(
                        Encoding.UTF8.GetBytes(line), MaximumMessageBytes, "MCP stdio message");
                    root = message.RootElement.Clone();
                }
                catch (Exception exception) when (exception is JsonException
                    or InvalidDataException
                    or DecoderFallbackException)
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(null, -32700, "Parse error"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                if (!TryReadEnvelope(root, out var hasId, out var id, out var method))
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32600, "Invalid Request"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                if (!hasId)
                {
                    if (method == "notifications/initialized")
                    {
                        if (sessionState == McpSessionState.AwaitingInitializedNotification
                            && HasValidInitializedNotification(root))
                        {
                            sessionState = McpSessionState.Operational;
                        }
                    }
                    else if (method == "notifications/cancelled")
                    {
                        HandleNotification(root, method, pending);
                    }
                    continue;
                }
                if (method.StartsWith("notifications/", StringComparison.Ordinal))
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32600, "Invalid Request"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                if (method == "initialize")
                {
                    if (pending.ContainsKey(RequestKey(id!.Value)))
                    {
                        await WriteResponseAsync(
                            writer, writerGate, Error(id, -32600, "Duplicate request id"),
                            shutdown.Token).ConfigureAwait(false);
                        continue;
                    }
                    if (sessionState != McpSessionState.AwaitingInitialize)
                    {
                        await WriteResponseAsync(
                            writer, writerGate, Error(id, -32600, "MCP session is already initialized"),
                            shutdown.Token).ConfigureAwait(false);
                        continue;
                    }
                    var initialization = ValidateInitialize(root);
                    if (initialization != InitializeValidation.Valid)
                    {
                        await WriteResponseAsync(
                            writer, writerGate, Error(id, -32602, "Invalid initialize params"),
                            shutdown.Token).ConfigureAwait(false);
                        continue;
                    }
                    await WriteResponseAsync(
                        writer, writerGate, Result(id, InitializeResult(service)), shutdown.Token)
                        .ConfigureAwait(false);
                    sessionState = McpSessionState.AwaitingInitializedNotification;
                    continue;
                }
                if (sessionState != McpSessionState.Operational && method != "ping")
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32002, "MCP server is not initialized"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }
                if (!HasValidMethodParameters(root, method))
                {
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32602, "Invalid params"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                var requestKey = RequestKey(id!.Value);
                var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);
                var pendingRequest = new PendingRequest(requestCancellation);
                if (!pending.TryAdd(requestKey, pendingRequest))
                {
                    requestCancellation.Dispose();
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32600, "Duplicate request id"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }
                if (!requestSlots.Wait(0))
                {
                    pending.TryRemove(requestKey, out _);
                    requestCancellation.Dispose();
                    await WriteResponseAsync(
                        writer, writerGate, Error(id, -32000, "MCP request capacity is exhausted"), shutdown.Token)
                        .ConfigureAwait(false);
                    continue;
                }

                var task = ProcessRequestAsync(
                    service,
                    id,
                    root,
                    method,
                    requestKey,
                    pendingRequest,
                    pending,
                    requestSlots,
                    writer,
                    writerGate,
                    shutdown);
                lock (taskGate)
                {
                    activeTasks.Add(task);
                }
                _ = task.ContinueWith(
                    completed =>
                    {
                        lock (taskGate)
                        {
                            activeTasks.Remove(completed);
                        }
                        if (completed.IsFaulted)
                        {
                            _ = completed.Exception;
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        finally
        {
            shutdown.Cancel();
            foreach (var request in pending.Values)
            {
                request.Cancel();
            }
            Task[] tasks;
            lock (taskGate)
            {
                tasks = activeTasks.ToArray();
            }
            if (tasks.Length > 0)
            {
                try
                {
                    await Task.WhenAll(tasks).ConfigureAwait(false);
                }
                catch
                {
                }
            }
        }
        return 0;
    }

    private static async Task ProcessRequestAsync(
        ReluEmbeddedServiceDefinition service,
        JsonElement? id,
        JsonElement message,
        string method,
        string requestKey,
        PendingRequest request,
        ConcurrentDictionary<string, PendingRequest> pending,
        SemaphoreSlim requestSlots,
        StreamWriter writer,
        SemaphoreSlim writerGate,
        CancellationTokenSource shutdown)
    {
        await Task.Yield();
        try
        {
            JsonElement response;
            try
            {
                response = method switch
                {
                    "ping" => Result(id, new { }),
                    "tools/list" => Result(id, ToolsListResult()),
                    "tools/call" => await HandleToolCallAsync(
                        service, id, message, request.Token).ConfigureAwait(false),
                    _ => Error(id, -32601, "Method not found"),
                };
            }
            catch (OperationCanceledException) when (request.IsCancellationRequested)
            {
                return;
            }
            catch
            {
                response = Error(id, -32603, "Internal error");
            }

            await WritePendingResponseAsync(
                writer, writerGate, response, request, shutdown.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            shutdown.Cancel();
        }
        finally
        {
            pending.TryRemove(requestKey, out _);
            requestSlots.Release();
            request.Dispose();
        }
    }

    private static bool TryReadEnvelope(
        JsonElement root,
        out bool hasId,
        out JsonElement? id,
        out string method)
    {
        hasId = false;
        id = null;
        method = string.Empty;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        hasId = root.TryGetProperty("id", out var idProperty);
        var idIsValid = !hasId
            || (idProperty.ValueKind == JsonValueKind.String
                && idProperty.GetString()!.Length <= 200)
            || EmbeddedContextProtocol.TryCreateCanonicalNumberKey(idProperty, out _);
        if (hasId && idIsValid)
        {
            id = idProperty.Clone();
        }
        if (!root.TryGetProperty("jsonrpc", out var jsonrpc)
            || jsonrpc.ValueKind != JsonValueKind.String
            || jsonrpc.GetString() != "2.0"
            || !idIsValid
            || !root.TryGetProperty("method", out var methodProperty)
            || methodProperty.ValueKind != JsonValueKind.String
            || string.IsNullOrEmpty(methodProperty.GetString())
            || methodProperty.GetString()!.Length > 200)
        {
            return false;
        }
        method = methodProperty.GetString()!;
        return true;
    }

    private static void HandleNotification(
        JsonElement message,
        string method,
        ConcurrentDictionary<string, PendingRequest> pending)
    {
        if (method != "notifications/cancelled"
            || !message.TryGetProperty("params", out var parameters)
            || parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("requestId", out var requestId)
            || (!IsBoundedString(requestId, 200, allowEmpty: true)
                && !EmbeddedContextProtocol.TryCreateCanonicalNumberKey(requestId, out _))
            || (parameters.TryGetProperty("reason", out var reason)
                && !IsBoundedString(reason, 2_048, allowEmpty: true))
            || (parameters.TryGetProperty("_meta", out var metadata)
                && metadata.ValueKind != JsonValueKind.Object))
        {
            return;
        }
        if (pending.TryGetValue(RequestKey(requestId), out var request))
        {
            request.Cancel();
        }
    }

    private static string RequestKey(JsonElement id) => id.ValueKind switch
    {
        JsonValueKind.String => $"s:{id.GetString()}",
        JsonValueKind.Number when EmbeddedContextProtocol.TryCreateCanonicalNumberKey(id, out var number) =>
            $"n:{number}",
        _ => throw new InvalidOperationException("A validated request id is required."),
    };

    private static bool HasBoundedString(JsonElement value, string propertyName, int maximumLength) =>
        value.TryGetProperty(propertyName, out var property)
        && property.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(property.GetString())
        && property.GetString()!.Length <= maximumLength;

    private static async Task<JsonElement> HandleToolCallAsync(
        ReluEmbeddedServiceDefinition service,
        JsonElement? id,
        JsonElement message,
        CancellationToken cancellationToken)
    {
        if (!message.TryGetProperty("params", out var parameters)
            || parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("name", out var nameProperty)
            || nameProperty.ValueKind != JsonValueKind.String)
        {
            return Error(id, -32602, "Invalid params");
        }
        var name = nameProperty.GetString();
        if (name is not ("list_sessions" or "get_context" or "list_capabilities" or "execute"))
        {
            return Error(id, -32602, "Unknown tool");
        }
        var arguments = parameters.TryGetProperty("arguments", out var argumentsProperty)
            ? argumentsProperty
            : JsonSerializer.SerializeToElement(new { });
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return Error(id, -32602, "Invalid params");
        }

        try
        {
            var result = await ReluEmbeddedPipeClient.CallAsync(
                service, name, arguments, MaximumMessageBytes, cancellationToken).ConfigureAwait(false);
            return BoundedToolResult(id, ToolSuccess(result));
        }
        catch (ReluEmbeddedUnavailableException)
        {
            if (name == "list_sessions")
            {
                return BoundedToolResult(id, ToolSuccess(
                    JsonSerializer.SerializeToElement(new { sessions = Array.Empty<object>() })));
            }
            return BoundedToolResult(id, ToolFailure(
                "APPLICATION_NOT_RUNNING",
                "EndViewer is not running for this Windows user."));
        }
        catch (ReluEmbeddedTimeoutException)
        {
            return BoundedToolResult(id, ToolFailure("TIMEOUT", "EndViewer did not answer in time."));
        }
        catch (ReluEmbeddedRemoteException exception)
        {
            return BoundedToolResult(id, ToolFailure(exception.Code, exception.PublicMessage));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return BoundedToolResult(id, ToolFailure("TIMEOUT", "EndViewer did not answer in time."));
        }
    }

    private static object[] CreateToolDefinitions()
    {
        static object ObjectSchema(object? properties = null, string[]? required = null) => new
        {
            type = "object",
            properties = properties ?? new { },
            required = required ?? Array.Empty<string>(),
            additionalProperties = false,
        };
        return
        [
            new
            {
                name = "list_sessions",
                description = "Start here: list the live embedded EndViewer session.",
                inputSchema = ObjectSchema(new
                {
                    serviceId = new { type = "string", maxLength = 64 },
                    activeOnly = new { type = "boolean" },
                }),
                annotations = new { readOnlyHint = true },
            },
            new
            {
                name = "get_context",
                description = "Read the current EndViewer resource and selection context.",
                inputSchema = ObjectSchema(new { sessionId = new { type = "string", maxLength = 200 } }, ["sessionId"]),
                annotations = new { readOnlyHint = true },
            },
            new
            {
                name = "list_capabilities",
                description = "List compiled EndViewer capabilities and their JSON schemas.",
                inputSchema = ObjectSchema(new { sessionId = new { type = "string", maxLength = 200 } }, ["sessionId"]),
                annotations = new { readOnlyHint = true },
            },
            new
            {
                name = "execute",
                description = "Execute one compiled EndViewer capability against the guarded current selection.",
                inputSchema = ObjectSchema(new
                {
                    sessionId = new { type = "string", maxLength = 200 },
                    action = new { type = "string", maxLength = 64 },
                    contextBinding = new { type = "string", minLength = 64, maxLength = 64 },
                    parameters = new { type = "object" },
                    operationId = new { type = "string", minLength = 8, maxLength = 128 },
                }, ["sessionId", "action", "contextBinding", "parameters"]),
                annotations = new { readOnlyHint = true },
            },
        ];
    }

    private static object ToolSuccess(JsonElement value) => new
        {
            content = new[] { new { type = "text", text = JsonSerializer.Serialize(value) } },
            structuredContent = value,
            isError = false,
        };

    private static object ToolFailure(
        string code,
        string message)
    {
        var value = new { error = code, message };
        return new
        {
            content = new[] { new { type = "text", text = JsonSerializer.Serialize(value) } },
            structuredContent = value,
            isError = true,
        };
    }

    private static JsonElement BoundedToolResult(JsonElement? id, object toolResult)
    {
        var response = Result(id, toolResult);
        if (JsonSerializer.SerializeToUtf8Bytes(response).Length <= MaximumMessageBytes)
        {
            return response;
        }
        return Result(id, ToolFailure(
            "RESULT_TOO_LARGE",
            "EndViewer result exceeded the MCP stdio message limit. Narrow or downsample the selection."));
    }

    private static object InitializeResult(ReluEmbeddedServiceDefinition service) => new
    {
        protocolVersion = ProtocolVersion,
        capabilities = new { tools = new { listChanged = false } },
        serverInfo = ServerInfo(service),
        instructions = service.Instructions,
    };

    private static object ToolsListResult() => new
    {
        tools = CreateToolDefinitions(),
    };

    private static object ServerInfo(ReluEmbeddedServiceDefinition service) => new
    {
        name = $"relu-{service.ServiceId}",
        version = service.Version,
    };

    private static InitializeValidation ValidateInitialize(JsonElement message)
    {
        if (!message.TryGetProperty("params", out var parameters)
            || parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("protocolVersion", out var version)
            || version.ValueKind != JsonValueKind.String
            || string.IsNullOrEmpty(version.GetString())
            || version.GetString()!.Length > 32
            || !parameters.TryGetProperty("capabilities", out var capabilities)
            || !ValidateClientCapabilities(capabilities)
            || !parameters.TryGetProperty("clientInfo", out var clientInfo)
            || !ValidateClientInfo(clientInfo)
            || (parameters.TryGetProperty("_meta", out var metadata)
                && !ValidateRequestMetadata(metadata)))
        {
            return InitializeValidation.Invalid;
        }
        return InitializeValidation.Valid;
    }

    private static bool ValidateClientCapabilities(JsonElement capabilities)
    {
        if (capabilities.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        foreach (var property in capabilities.EnumerateObject())
        {
            switch (property.Name)
            {
                case "experimental":
                    if (!IsObjectMapOfObjects(property.Value))
                    {
                        return false;
                    }
                    break;
                case "roots":
                    if (property.Value.ValueKind != JsonValueKind.Object
                        || property.Value.EnumerateObject().Any(item =>
                            item.Name != "listChanged"
                            || item.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)))
                    {
                        return false;
                    }
                    break;
                case "sampling":
                case "elicitation":
                    if (property.Value.ValueKind != JsonValueKind.Object)
                    {
                        return false;
                    }
                    break;
                // ClientCapabilities is extensible. Unknown capability keys are preserved by
                // the wire contract even though this bridge does not consume them.
                default:
                    break;
            }
        }
        return true;
    }

    private static bool IsObjectMapOfObjects(JsonElement map) =>
        map.ValueKind == JsonValueKind.Object
        && map.EnumerateObject().All(property => property.Value.ValueKind == JsonValueKind.Object);

    private static bool ValidateClientInfo(JsonElement clientInfo)
    {
        if (clientInfo.ValueKind != JsonValueKind.Object
            || !HasBoundedString(clientInfo, "name", 200)
            || !HasBoundedString(clientInfo, "version", 100))
        {
            return false;
        }
        foreach (var property in clientInfo.EnumerateObject())
        {
            switch (property.Name)
            {
                case "name":
                case "version":
                    break;
                case "title":
                    if (!IsBoundedString(property.Value, 200, allowEmpty: true))
                    {
                        return false;
                    }
                    break;
                // Client implementation objects from a newer offer can contain fields unknown
                // to the negotiated 2025-06-18 contract. They are informational and ignored.
                default:
                    break;
            }
        }
        return true;
    }

    private static bool IsValidProgressToken(JsonElement value) =>
        IsBoundedString(value, 200, allowEmpty: true)
        || EmbeddedContextProtocol.TryCreateCanonicalNumberKey(value, out _);

    private static bool ValidateRequestMetadata(JsonElement metadata) =>
        metadata.ValueKind == JsonValueKind.Object
        && (!metadata.TryGetProperty("progressToken", out var progressToken)
            || IsValidProgressToken(progressToken));

    private static bool IsBoundedString(JsonElement value, int maximumRunes, bool allowEmpty)
    {
        if (value.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        var text = value.GetString()!;
        return (allowEmpty || text.Length > 0)
            && text.EnumerateRunes().Take(maximumRunes + 1).Count() <= maximumRunes;
    }

    private static bool HasValidMethodParameters(JsonElement message, string method)
    {
        if (!message.TryGetProperty("params", out var parameters))
        {
            return method is not "tools/call";
        }
        if (parameters.ValueKind != JsonValueKind.Object
            || (parameters.TryGetProperty("_meta", out var metadata)
                && !ValidateRequestMetadata(metadata)))
        {
            return false;
        }
        if (method == "tools/call"
            && (!parameters.TryGetProperty("name", out var name)
                || !IsBoundedString(name, 200, allowEmpty: false)
                || (parameters.TryGetProperty("arguments", out var arguments)
                    && arguments.ValueKind != JsonValueKind.Object)))
        {
            return false;
        }
        if (method == "tools/list" && parameters.TryGetProperty("cursor", out var cursor))
        {
            // This static list never emits nextCursor, so it cannot recognize any cursor. Still
            // validate the official cursor shape and bound it before returning Invalid params.
            if (!IsBoundedString(cursor, 1_024, allowEmpty: false))
            {
                return false;
            }
            return false;
        }
        return true;
    }

    private static bool HasValidInitializedNotification(JsonElement message)
    {
        if (!message.TryGetProperty("params", out var parameters))
        {
            return true;
        }
        return parameters.ValueKind == JsonValueKind.Object
            && (!parameters.TryGetProperty("_meta", out var metadata)
                || metadata.ValueKind == JsonValueKind.Object);
    }

    private static JsonElement Result(JsonElement? id, object result) => JsonSerializer.SerializeToElement(new
    {
        jsonrpc = "2.0",
        id = id ?? JsonSerializer.SerializeToElement((object?)null),
        result,
    });

    private static JsonElement Error(JsonElement? id, int code, string message) => JsonSerializer.SerializeToElement(new
    {
        jsonrpc = "2.0",
        id = id ?? JsonSerializer.SerializeToElement((object?)null),
        error = new { code, message },
    });

    private static async Task WriteResponseAsync(
        StreamWriter writer,
        SemaphoreSlim writerGate,
        JsonElement response,
        CancellationToken cancellationToken)
    {
        var serialized = SerializeBoundedResponse(response);
        await writerGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await writer.WriteLineAsync(
                serialized.AsMemory(), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            writerGate.Release();
        }
    }

    private static async Task WritePendingResponseAsync(
        StreamWriter writer,
        SemaphoreSlim writerGate,
        JsonElement response,
        PendingRequest request,
        CancellationToken cancellationToken)
    {
        var serialized = SerializeBoundedResponse(response);
        await writerGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!request.TryCommitResponse())
            {
                return;
            }
            await writer.WriteLineAsync(
                serialized.AsMemory(), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            writerGate.Release();
        }
    }

    private static string SerializeBoundedResponse(JsonElement response)
    {
        var serialized = JsonSerializer.Serialize(response);
        if (Encoding.UTF8.GetByteCount(serialized) <= MaximumMessageBytes)
        {
            return serialized;
        }

        JsonElement? id = response.TryGetProperty("id", out var responseId)
            ? responseId.Clone()
            : null;
        return JsonSerializer.Serialize(Error(id, -32603, "MCP response exceeded its byte limit"));
    }

    private enum McpSessionState
    {
        AwaitingInitialize,
        AwaitingInitializedNotification,
        Operational,
    }

    private enum InitializeValidation
    {
        Invalid,
        Valid,
    }

    private sealed class PendingRequest(CancellationTokenSource cancellation) : IDisposable
    {
        private const int Active = 0;
        private const int ResponseCommitted = 1;
        private const int Cancelled = 2;
        private int _state;

        internal CancellationToken Token => cancellation.Token;
        internal bool IsCancellationRequested => Volatile.Read(ref _state) == Cancelled
            || cancellation.IsCancellationRequested;

        internal bool TryCommitResponse() =>
            Interlocked.CompareExchange(ref _state, ResponseCommitted, Active) == Active;

        internal void Cancel()
        {
            if (Interlocked.CompareExchange(ref _state, Cancelled, Active) != Active)
            {
                return;
            }
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        public void Dispose() => cancellation.Dispose();
    }
}

internal sealed class BoundedUtf8LineReader
{
    private static readonly UTF8Encoding StrictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);
    private readonly Stream _stream;
    private readonly int _maximumBytes;
    private readonly byte[] _buffer = new byte[8192];
    private int _offset;
    private int _count;

    internal BoundedUtf8LineReader(Stream stream, int maximumBytes)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
        if (maximumBytes < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }
        _maximumBytes = maximumBytes;
    }

    internal async Task<string?> ReadLineAsync(CancellationToken cancellationToken)
    {
        using var line = new MemoryStream(Math.Min(_maximumBytes, _buffer.Length));
        var oversized = false;
        while (true)
        {
            if (_offset == _count)
            {
                _count = await _stream.ReadAsync(_buffer, cancellationToken).ConfigureAwait(false);
                _offset = 0;
                if (_count == 0)
                {
                    if (line.Length == 0)
                    {
                        return null;
                    }
                    if (oversized)
                    {
                        throw new InvalidDataException("MCP stdio line exceeds its byte limit.");
                    }
                    return Decode(line);
                }
            }

            var newline = Array.IndexOf(_buffer, (byte)'\n', _offset, _count - _offset);
            var segmentLength = newline >= 0 ? newline - _offset : _count - _offset;
            if (!oversized)
            {
                if (line.Length + segmentLength > _maximumBytes)
                {
                    oversized = true;
                }
                else
                {
                    line.Write(_buffer, _offset, segmentLength);
                }
            }
            _offset += segmentLength;
            if (newline < 0)
            {
                continue;
            }

            _offset += 1;
            if (oversized)
            {
                throw new InvalidDataException("MCP stdio line exceeds its byte limit.");
            }
            return Decode(line);
        }
    }

    private static string Decode(MemoryStream line)
    {
        var bytes = line.GetBuffer().AsSpan(0, checked((int)line.Length));
        if (bytes.Length > 0 && bytes[^1] == (byte)'\r')
        {
            bytes = bytes[..^1];
        }
        try
        {
            return StrictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException exception)
        {
            throw new InvalidDataException("MCP stdio line is not valid UTF-8.", exception);
        }
    }
}

internal static class ReluEmbeddedPipeClient
{
    internal static async Task<JsonElement> CallAsync(
        ReluEmbeddedServiceDefinition service,
        string method,
        JsonElement arguments,
        int maximumMessageBytes,
        CancellationToken cancellationToken,
        TimeSpan? connectTimeout = null,
        TimeSpan? responseTimeout = null)
    {
        await using var pipe = new NamedPipeClientStream(
            ".",
            service.PipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            using (var connectDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                connectDeadline.CancelAfter(connectTimeout ?? TimeSpan.FromSeconds(5));
                try
                {
                    await pipe.ConnectAsync(connectDeadline.Token).ConfigureAwait(false);
                    EmbeddedPipePeerVerifier.VerifyServer(pipe);
                }
                catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new ReluEmbeddedUnavailableException(exception);
                }
            }

            var request = JsonSerializer.SerializeToElement(new
            {
                protocolVersion = EmbeddedPipeProtocol.ProtocolVersion,
                method,
                arguments,
            });
            using var responseDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            responseDeadline.CancelAfter(
                responseTimeout ?? service.RequestTimeout + TimeSpan.FromSeconds(5));
            JsonDocument response;
            try
            {
                await EmbeddedPipeProtocol.WriteAsync(
                    pipe, request, maximumMessageBytes, responseDeadline.Token).ConfigureAwait(false);
                response = await EmbeddedPipeProtocol.ReadAsync(
                    pipe, maximumMessageBytes, responseDeadline.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
            {
                throw new ReluEmbeddedTimeoutException(exception);
            }
            using (response)
            {
                if (response.RootElement.ValueKind != JsonValueKind.Object
                    || !response.RootElement.TryGetProperty("ok", out var ok)
                    || ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    throw new ReluEmbeddedRemoteException("INVALID_RESPONSE", "EndViewer returned an invalid response.");
                }
                if (ok.GetBoolean())
                {
                    if (!response.RootElement.TryGetProperty("result", out var result)
                        || result.ValueKind != JsonValueKind.Object)
                    {
                        throw new ReluEmbeddedRemoteException("INVALID_RESPONSE", "EndViewer returned an invalid response.");
                    }
                    return result.Clone();
                }
                if (!response.RootElement.TryGetProperty("errorCode", out var codeProperty)
                    || codeProperty.ValueKind != JsonValueKind.String
                    || !response.RootElement.TryGetProperty("error", out var errorProperty)
                    || errorProperty.ValueKind != JsonValueKind.String)
                {
                    throw new ReluEmbeddedRemoteException(
                        "INVALID_RESPONSE", "EndViewer returned an invalid response.");
                }
                var code = codeProperty.GetString();
                var error = errorProperty.GetString();
                throw new ReluEmbeddedRemoteException(
                    string.IsNullOrEmpty(code) ? "EMBEDDED_ERROR" : code,
                    string.IsNullOrEmpty(error) ? "EndViewer rejected the request." : error);
            }
        }
        catch (Exception exception) when (exception is IOException or TimeoutException)
        {
            throw new ReluEmbeddedUnavailableException(exception);
        }
    }
}

internal sealed class ReluEmbeddedUnavailableException(Exception innerException) :
    Exception("Embedded EndViewer host is unavailable.", innerException);

internal sealed class ReluEmbeddedTimeoutException(Exception innerException) :
    Exception("Embedded EndViewer host did not answer in time.", innerException);

internal sealed class ReluEmbeddedRemoteException(string code, string publicMessage) : Exception(publicMessage)
{
    internal string Code { get; } = code;
    internal string PublicMessage { get; } = publicMessage;
}
