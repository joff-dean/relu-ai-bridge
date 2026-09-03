using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector.Internal;

namespace Relu.AI.Bridge.DesktopConnector;

public enum ReluEmbeddedBridgeState
{
    Stopped,
    Running,
}

public sealed record ReluEmbeddedBridgeStatus(ReluEmbeddedBridgeState State);

/// <summary>
/// EndViewer process 안에서 현재 context와 allowlisted handler를 same-user named pipe로 제공합니다.
/// Token, network endpoint 또는 외부 service config를 사용하지 않습니다.
/// </summary>
public sealed class ReluEmbeddedBridgeHost : IAsyncDisposable
{
    private const int MaximumConcurrentHandlers = 16;
    private const int MaximumConcurrentContextProviders = 8;
    private const int MaximumConcurrentConnections = 15;
    private const int MaximumPipeInstances = MaximumConcurrentConnections + 1;
    private readonly ReluEmbeddedBridgeOptions _options;
    private readonly IReadOnlyDictionary<string, ReluDesktopCapability> _handlers;
    private readonly IReadOnlyDictionary<string, ReluEmbeddedCapabilityDefinition> _capabilities;
    private readonly BoundedHandlerSlots _handlerSlots = new(MaximumConcurrentHandlers);
    private readonly BoundedHandlerSlots _contextProviderSlots = new(MaximumConcurrentContextProviders);
    private readonly SemaphoreSlim _connectionSlots = new(MaximumConcurrentConnections, MaximumConcurrentConnections);
    private readonly SemaphoreSlim _contextGate = new(1, 1);
    private readonly object _stateGate = new();
    private readonly HashSet<Task> _connections = [];
    private CancellationTokenSource _contextChanged = new();
    private CancellationTokenSource? _lifetime;
    private NamedPipeServerStream? _waitingPipe;
    private Task? _acceptTask;
    private long _contextGeneration;
    private int _active;
    private bool _disposed;

    public ReluEmbeddedBridgeHost(ReluEmbeddedBridgeOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _options.Validate();
        _handlers = options.Handlers.ToDictionary(item => item.Name, StringComparer.Ordinal);
        _capabilities = options.Service.Capabilities.ToDictionary(item => item.Name, StringComparer.Ordinal);
        _active = options.InitialActive ? 1 : 0;
    }

    public event Action<ReluEmbeddedBridgeStatus>? StatusChanged;

    private ReluEmbeddedBridgeStatus _status = new(ReluEmbeddedBridgeState.Stopped);

    public ReluEmbeddedBridgeStatus Status => Volatile.Read(ref _status);

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Task? acceptTask = null;
        CancellationTokenSource? lifetime = null;
        ReluEmbeddedBridgeStatus? status = null;
        lock (_stateGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_acceptTask is not null)
            {
                return Task.CompletedTask;
            }

            _lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            try
            {
                // Reserve the well-known pipe synchronously so two UI instances cannot both report success.
                _waitingPipe = CreatePipe(firstInstance: true);
            }
            catch
            {
                _lifetime.Dispose();
                _lifetime = null;
                throw;
            }
            lifetime = _lifetime;
            var waitingPipe = _waitingPipe;
            acceptTask = Task.Run(
                () => AcceptLoopAsync(waitingPipe, lifetime.Token),
                CancellationToken.None);
            _acceptTask = acceptTask;
            status = SetStatusLocked(ReluEmbeddedBridgeState.Running);
        }
        PublishStatus(status);
        _ = acceptTask.ContinueWith(
            completed => CompleteAcceptLoop(completed, lifetime),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        return Task.CompletedTask;
    }

    /// <summary>
    /// 일반 viewer UI가 pipe 예약 충돌 때문에 종료되지 않도록 예상 가능한 host 충돌을
    /// false로 변환합니다. 취소와 그 밖의 programming/runtime 오류는 그대로 전파합니다.
    /// </summary>
    public async Task<bool> TryStartAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await StartAsync(cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested
            && exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public async Task NotifyContextChangedAsync(
        Action updateContext,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(updateContext);
        await _contextGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        CancellationTokenSource? previous = null;
        try
        {
            updateContext();
            lock (_stateGate)
            {
                previous = _contextChanged;
                _contextChanged = new CancellationTokenSource();
                _contextGeneration = _contextGeneration == long.MaxValue ? 1 : _contextGeneration + 1;
            }
        }
        finally
        {
            _contextGate.Release();
        }
        if (previous is not null)
        {
            try
            {
                previous.Cancel();
            }
            finally
            {
                previous.Dispose();
            }
        }
    }

    public Task SetActiveAsync(bool active, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Volatile.Write(ref _active, active ? 1 : 0);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        Task? acceptTask;
        CancellationTokenSource? lifetime;
        NamedPipeServerStream? waitingPipe;
        lock (_stateGate)
        {
            acceptTask = _acceptTask;
            lifetime = _lifetime;
            waitingPipe = _waitingPipe;
        }
        // Cancellation and stream disposal can synchronously invoke arbitrary callbacks. Never
        // run either while holding the lifecycle lock.
        try
        {
            lifetime?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The accept-loop completion may have won the race and disposed this generation.
        }
        waitingPipe?.Dispose();

        if (acceptTask is not null)
        {
            try
            {
                await acceptTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (lifetime?.IsCancellationRequested == true
                && !cancellationToken.IsCancellationRequested)
            {
            }
        }
        Task[] connections;
        lock (_stateGate)
        {
            connections = _connections.ToArray();
        }
        if (connections.Length > 0)
        {
            await Task.WhenAll(connections).WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        if (acceptTask is not null)
        {
            CompleteAcceptLoop(acceptTask, null);
        }
    }

    public async ValueTask DisposeAsync()
    {
        lock (_stateGate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
        }
        await StopAsync().ConfigureAwait(false);
        CancellationTokenSource contextChanged;
        lock (_stateGate)
        {
            contextChanged = _contextChanged;
        }
        // A handler can register a synchronous context-cancellation callback that re-enters the
        // host. Publish cancellation only after releasing _stateGate.
        try
        {
            contextChanged.Cancel();
        }
        finally
        {
            contextChanged.Dispose();
        }
        _contextGate.Dispose();
        _connectionSlots.Dispose();
    }

    private async Task AcceptLoopAsync(NamedPipeServerStream firstPipe, CancellationToken cancellationToken)
    {
        var pipe = firstPipe;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                lock (_stateGate)
                {
                    _waitingPipe = pipe;
                }
                await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                await _connectionSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
                var connected = pipe;
                try
                {
                    pipe = CreatePipe(firstInstance: false);
                }
                catch
                {
                    connected.Dispose();
                    _connectionSlots.Release();
                    throw;
                }
                var task = HandleConnectionAndReleaseAsync(connected, cancellationToken);
                lock (_stateGate)
                {
                    _connections.Add(task);
                }
                _ = task.ContinueWith(
                    completed =>
                    {
                        lock (_stateGate)
                        {
                            _connections.Remove(completed);
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (System.Net.Sockets.SocketException) when (cancellationToken.IsCancellationRequested)
        {
            // Unix named-pipe emulation can surface socket teardown instead of ObjectDisposed.
        }
        finally
        {
            pipe.Dispose();
        }
    }

    private NamedPipeServerStream CreatePipe(bool firstInstance)
    {
        var pipeOptions = PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly;
        if (firstInstance && OperatingSystem.IsWindows())
        {
            pipeOptions |= PipeOptions.FirstPipeInstance;
        }
        return new NamedPipeServerStream(
            _options.Service.PipeName,
            PipeDirection.InOut,
            MaximumPipeInstances,
            PipeTransmissionMode.Byte,
            pipeOptions,
            8192,
            8192);
    }

    private async Task HandleConnectionAndReleaseAsync(
        NamedPipeServerStream pipe,
        CancellationToken cancellationToken)
    {
        try
        {
            await HandleConnectionAsync(pipe, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _connectionSlots.Release();
        }
    }

    private async Task HandleConnectionAsync(NamedPipeServerStream pipe, CancellationToken cancellationToken)
    {
        await using (pipe.ConfigureAwait(false))
        {
            try
            {
                EmbeddedPipePeerVerifier.VerifyClient(pipe);
            }
            catch (IOException)
            {
                return;
            }

            JsonElement response;
            CancellationTokenSource? requestDeadline = null;
            CancellationTokenSource? peerDisconnected = null;
            CancellationTokenSource? disconnectMonitorLifetime = null;
            Task? disconnectMonitor = null;
            var readCompleted = false;
            using var readDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            readDeadline.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                using var request = await EmbeddedPipeProtocol.ReadAsync(
                    pipe, _options.MaximumMessageBytes, readDeadline.Token).ConfigureAwait(false);
                readCompleted = true;
                readDeadline.CancelAfter(Timeout.InfiniteTimeSpan);
                peerDisconnected = new CancellationTokenSource();
                disconnectMonitorLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                disconnectMonitor = MonitorPeerDisconnectAsync(
                    pipe,
                    peerDisconnected,
                    disconnectMonitorLifetime.Token);
                requestDeadline = CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken,
                    peerDisconnected.Token);
                requestDeadline.CancelAfter(_options.Service.RequestTimeout);
                response = JsonSerializer.SerializeToElement(new
                {
                    ok = true,
                    result = await HandleRequestAsync(
                        request.RootElement, requestDeadline.Token).ConfigureAwait(false),
                });
            }
            catch (ReluEmbeddedBridgeException exception)
            {
                response = JsonSerializer.SerializeToElement(new
                {
                    ok = false,
                    errorCode = exception.Code,
                    error = exception.PublicMessage,
                });
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (OperationCanceledException) when (!readCompleted && readDeadline.IsCancellationRequested)
            {
                return;
            }
            catch (OperationCanceledException) when (peerDisconnected?.IsCancellationRequested == true)
            {
                return;
            }
            catch (OperationCanceledException) when (requestDeadline?.IsCancellationRequested == true)
            {
                response = JsonSerializer.SerializeToElement(new
                {
                    ok = false,
                    errorCode = "TIMEOUT",
                    error = "Embedded bridge request timed out.",
                });
            }
            catch
            {
                response = JsonSerializer.SerializeToElement(new
                {
                    ok = false,
                    errorCode = "INVALID_REQUEST",
                    error = "Embedded bridge request failed.",
                });
            }
            finally
            {
                requestDeadline?.Dispose();
                if (disconnectMonitorLifetime is not null)
                {
                    try
                    {
                        disconnectMonitorLifetime.Cancel();
                    }
                    catch
                    {
                    }
                    if (disconnectMonitor is not null)
                    {
                        try
                        {
                            await disconnectMonitor.ConfigureAwait(false);
                        }
                        catch
                        {
                        }
                    }
                    disconnectMonitorLifetime.Dispose();
                }
                peerDisconnected?.Dispose();
            }

            try
            {
                using var writeDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                writeDeadline.CancelAfter(TimeSpan.FromSeconds(5));
                await EmbeddedPipeProtocol.WriteAsync(
                    pipe, response, _options.MaximumMessageBytes, writeDeadline.Token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException
                or OperationCanceledException
                or InvalidDataException)
            {
            }
        }
    }

    private static async Task MonitorPeerDisconnectAsync(
        NamedPipeServerStream pipe,
        CancellationTokenSource peerDisconnected,
        CancellationToken monitorLifetime)
    {
        var probe = new byte[1];
        try
        {
            // One pipe connection carries exactly one request. EOF, an I/O failure, or extra
            // client bytes all invalidate that in-flight request and cancel its handler.
            _ = await pipe.ReadAsync(probe, monitorLifetime).ConfigureAwait(false);
            if (!monitorLifetime.IsCancellationRequested)
            {
                SignalPeerDisconnected(peerDisconnected);
            }
        }
        catch (OperationCanceledException) when (monitorLifetime.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (exception is IOException
            or ObjectDisposedException
            or OperationCanceledException)
        {
            if (!monitorLifetime.IsCancellationRequested)
            {
                SignalPeerDisconnected(peerDisconnected);
            }
        }
    }

    private static void SignalPeerDisconnected(CancellationTokenSource peerDisconnected)
    {
        try
        {
            peerDisconnected.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        catch (AggregateException)
        {
            // Cancellation is already observable even if application callbacks misbehave.
        }
    }

    private async Task<JsonElement> HandleRequestAsync(JsonElement request, CancellationToken cancellationToken)
    {
        if (request.ValueKind != JsonValueKind.Object
            || !request.TryGetProperty("protocolVersion", out var protocol)
            || protocol.ValueKind != JsonValueKind.String
            || protocol.GetString() != EmbeddedPipeProtocol.ProtocolVersion
            || !request.TryGetProperty("method", out var methodProperty)
            || methodProperty.ValueKind != JsonValueKind.String)
        {
            throw InvalidRequest();
        }
        var arguments = request.TryGetProperty("arguments", out var argumentsProperty)
            ? argumentsProperty
            : JsonSerializer.SerializeToElement(new { });
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            throw InvalidRequest();
        }
        var method = methodProperty.GetString();
        if (method == "list_sessions")
        {
            RequireOnlyProperties(arguments, "serviceId", "activeOnly");
            var serviceFilter = OptionalString(arguments, "serviceId", 64);
            var activeOnly = OptionalBoolean(arguments, "activeOnly");
            var include = (serviceFilter is null || serviceFilter == _options.Service.ServiceId)
                && (!activeOnly || Volatile.Read(ref _active) != 0);
            var sessions = include ? new[] { CreateSession() } : Array.Empty<object>();
            return JsonSerializer.SerializeToElement(new { sessions });
        }
        RequireSession(arguments);
        if (method == "get_context")
        {
            RequireOnlyProperties(arguments, "sessionId");
            await _contextGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var context = await ReadContextAsync(cancellationToken).ConfigureAwait(false);
                var projection = EmbeddedContextProtocol.Project(
                    context, _options.Service.ContextGuardFields.ToArray());
                var contextBinding = EmbeddedContextProtocol.CreateBinding(projection);
                return JsonSerializer.SerializeToElement(new
                {
                    session = CreateSession(),
                    context,
                    contextBinding,
                });
            }
            finally
            {
                _contextGate.Release();
            }
        }
        if (method == "list_capabilities")
        {
            RequireOnlyProperties(arguments, "sessionId");
            return JsonSerializer.SerializeToElement(new
            {
                sessionId = _options.Service.SessionId,
                capabilities = _options.Service.Capabilities.Select(item => new
                {
                    name = item.Name,
                    description = item.Description,
                    readOnly = item.ReadOnly,
                    effect = item.Effect,
                    transport = "embedded",
                    inputSchema = item.InputSchema,
                    outputSchema = item.OutputSchema,
                }),
            });
        }
        if (method == "execute")
        {
            RequireOnlyProperties(
                arguments, "sessionId", "action", "contextBinding", "parameters", "operationId");
            return await ExecuteAsync(arguments, cancellationToken).ConfigureAwait(false);
        }
        throw InvalidRequest();
    }

    private async Task<JsonElement> ExecuteAsync(JsonElement arguments, CancellationToken cancellationToken)
    {
        var action = RequiredString(arguments, "action", 64);
        if (!_capabilities.TryGetValue(action, out var capability)
            || !_handlers.TryGetValue(action, out var handler))
        {
            throw new ReluEmbeddedBridgeException("CAPABILITY_UNAVAILABLE", "Capability is not available.");
        }
        if (!arguments.TryGetProperty("parameters", out var parameters)
            || parameters.ValueKind != JsonValueKind.Object)
        {
            throw InvalidRequest();
        }
        var operationId = OptionalString(arguments, "operationId", 128, minimumLength: 8);
        var suppliedContextBinding = RequiredContextBinding(arguments);

        var requestId = Guid.NewGuid().ToString("N");
        if (!_handlerSlots.TryAcquire(requestId))
        {
            throw new ReluEmbeddedBridgeException("BUSY", "Embedded bridge handler capacity is exhausted.");
        }
        (CancellationToken Token, long Generation) lease = default;
        Task<JsonElement>? handlerTask = null;
        using var timeout = new CancellationTokenSource(_options.Service.RequestTimeout);
        CancellationTokenSource? execution = null;
        try
        {
            // Selection updates replace and dispose the context CTS. Create this linked
            // registration under the same lock so the old source cannot be disposed between
            // reading its token and registering for cancellation.
            lock (_stateGate)
            {
                lease = (_contextChanged.Token, _contextGeneration);
                execution = CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken, timeout.Token, lease.Token);
            }
            var executionToken = execution.Token;
            JsonElement context;
            JsonElement projection;
            var fields = _options.Service.ContextGuardFields.ToArray();
            await _contextGate.WaitAsync(executionToken).ConfigureAwait(false);
            try
            {
                if (lease.Generation != CurrentContextLease().Generation)
                {
                    throw new ReluEmbeddedBridgeException(
                        "CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
                }
                context = await ReadContextAsync(executionToken).ConfigureAwait(false);
                projection = EmbeddedContextProtocol.Project(context, fields);
                if (!string.Equals(
                    suppliedContextBinding, EmbeddedContextProtocol.CreateBinding(projection), StringComparison.Ordinal))
                {
                    throw new ReluEmbeddedBridgeException(
                        "CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
                }
            }
            finally
            {
                _contextGate.Release();
            }

            JsonElement boundedParameters;
            try
            {
                boundedParameters = BoundedJson.CloneAndValidate(
                    parameters, ApplicationPayloadLimit, "capability parameters");
                EmbeddedJsonSchema.ValidateInstance(
                    boundedParameters, capability.InputSchema, "capability parameters");
            }
            catch (InvalidDataException)
            {
                throw new ReluEmbeddedBridgeException(
                    "INVALID_PARAMETERS", "Capability parameters do not match the compiled schema.");
            }
            var guard = new ReluContextGuard(fields, projection, suppliedContextBinding);
            var invocation = new ReluCapabilityInvocation(boundedParameters, context, guard, operationId);
            handlerTask = Task.Run(
                async () => await handler.Handler(invocation, executionToken).ConfigureAwait(false),
                CancellationToken.None);
            var result = await handlerTask.WaitAsync(executionToken).ConfigureAwait(false);
            JsonElement bounded;
            try
            {
                bounded = BoundedJson.CloneAndValidate(
                    result, ApplicationPayloadLimit, "capability result");
                EmbeddedJsonSchema.ValidateInstance(
                    bounded, capability.OutputSchema, "capability result");
            }
            catch (InvalidDataException)
            {
                throw new ReluEmbeddedBridgeException(
                    "INVALID_CAPABILITY_RESULT", "Capability result does not match the compiled schema.");
            }

            await _contextGate.WaitAsync(executionToken).ConfigureAwait(false);
            try
            {
                if (lease.Generation != CurrentContextLease().Generation)
                {
                    throw new ReluEmbeddedBridgeException("CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
                }
                var current = await ReadContextAsync(executionToken).ConfigureAwait(false);
                var currentProjection = EmbeddedContextProtocol.Project(current, fields);
                if (!EmbeddedContextProtocol.SemanticallyEquals(projection, currentProjection))
                {
                    throw new ReluEmbeddedBridgeException("CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
                }
                if (!string.Equals(
                    suppliedContextBinding, EmbeddedContextProtocol.CreateBinding(currentProjection), StringComparison.Ordinal))
                {
                    throw new ReluEmbeddedBridgeException("CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
                }
                return bounded;
            }
            finally
            {
                _contextGate.Release();
            }
        }
        catch (ReluEmbeddedBridgeException)
        {
            throw;
        }
        catch (OperationCanceledException) when (lease.Token.IsCancellationRequested)
        {
            throw new ReluEmbeddedBridgeException("CONTEXT_CHANGED", "Selection context changed; retry from get_context.");
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            throw new ReluEmbeddedBridgeException("TIMEOUT", "Embedded capability execution timed out.");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            throw new ReluEmbeddedBridgeException("CAPABILITY_FAILED", "Embedded capability execution failed.");
        }
        finally
        {
            execution?.Dispose();
            _handlerSlots.ReleaseWhenCompleted(requestId, handlerTask ?? Task.CompletedTask);
        }
    }

    private async Task<JsonElement> ReadContextAsync(CancellationToken cancellationToken)
    {
        var requestId = Guid.NewGuid().ToString("N");
        if (!_contextProviderSlots.TryAcquire(requestId))
        {
            throw new ReluEmbeddedBridgeException(
                "BUSY", "Embedded context-provider capacity is exhausted.");
        }
        Task<JsonElement>? pending = null;
        try
        {
            pending = Task.Run(
                async () => await _options.ContextProvider
                    .GetContextAsync(cancellationToken).ConfigureAwait(false),
                CancellationToken.None);
            JsonElement value;
            try
            {
                value = await pending.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                if (!pending.IsCompleted)
                {
                    _ = pending.ContinueWith(
                        static completed => _ = completed.Exception,
                        CancellationToken.None,
                        TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted,
                        TaskScheduler.Default);
                }
            }
            var context = BoundedJson.CloneAndValidate(value, ApplicationPayloadLimit, "embedded context");
            if (context.ValueKind != JsonValueKind.Object
                || _options.Service.ContextGuardFields.Any(field => !context.TryGetProperty(field, out _)))
            {
                throw new ReluEmbeddedBridgeException("INVALID_CONTEXT", "Embedded application context is invalid.");
            }
            return context;
        }
        catch (ReluEmbeddedBridgeException)
        {
            throw;
        }
        catch (ReluContextUnavailableException)
        {
            throw new ReluEmbeddedBridgeException(
                "CONTEXT_UNAVAILABLE", "No analysis context is currently selected.");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            throw new ReluEmbeddedBridgeException("INVALID_CONTEXT", "Embedded application context is invalid.");
        }
        finally
        {
            _contextProviderSlots.ReleaseWhenCompleted(requestId, pending ?? Task.CompletedTask);
        }
    }

    private void CompleteAcceptLoop(Task acceptTask, CancellationTokenSource? expectedLifetime)
    {
        CancellationTokenSource? lifetimeToDispose = null;
        ReluEmbeddedBridgeStatus? status = null;
        lock (_stateGate)
        {
            if (!ReferenceEquals(_acceptTask, acceptTask)
                || (expectedLifetime is not null && !ReferenceEquals(_lifetime, expectedLifetime)))
            {
                return;
            }
            _acceptTask = null;
            _waitingPipe = null;
            lifetimeToDispose = _lifetime;
            _lifetime = null;
            status = SetStatusLocked(ReluEmbeddedBridgeState.Stopped);
        }
        if (acceptTask.IsFaulted)
        {
            _ = acceptTask.Exception;
        }
        if (lifetimeToDispose is not null)
        {
            try
            {
                // An unexpected accept-loop failure must retire the entire generation. Disposing
                // a CTS does not cancel tokens already handed to connected requests.
                lifetimeToDispose.Cancel();
            }
            catch (AggregateException)
            {
                // Cancellation is already observable even if an application callback failed.
            }
            catch (ObjectDisposedException)
            {
                // StopAsync may have disposed the same completed generation concurrently.
            }
            finally
            {
                lifetimeToDispose.Dispose();
            }
        }
        PublishStatus(status);
    }

    private object CreateSession() => new
    {
        id = _options.Service.SessionId,
        serviceId = _options.Service.ServiceId,
        serviceName = _options.Service.DisplayName,
        clientKind = "desktop",
        connectorVersion = _options.Service.Version,
        active = Volatile.Read(ref _active) != 0,
        capabilities = _options.Service.Capabilities.Select(item => item.Name).ToArray(),
    };

    private int ApplicationPayloadLimit => _options.MaximumMessageBytes - 16 * 1024;

    private void RequireSession(JsonElement arguments)
    {
        if (RequiredString(arguments, "sessionId", 200) != _options.Service.SessionId)
        {
            throw new ReluEmbeddedBridgeException("SESSION_NOT_FOUND", "Embedded session is not available.");
        }
    }

    private (CancellationToken Token, long Generation) CurrentContextLease()
    {
        lock (_stateGate)
        {
            return (_contextChanged.Token, _contextGeneration);
        }
    }

    private static string RequiredContextBinding(JsonElement arguments)
    {
        var value = RequiredString(arguments, "contextBinding", 64);
        if (value.Length != 64 || value.Any(character => character is not (>= '0' and <= '9')
            and not (>= 'a' and <= 'f')))
        {
            throw InvalidRequest();
        }
        return value;
    }

    private ReluEmbeddedBridgeStatus SetStatusLocked(ReluEmbeddedBridgeState state)
    {
        var status = new ReluEmbeddedBridgeStatus(state);
        Volatile.Write(ref _status, status);
        return status;
    }

    private void PublishStatus(ReluEmbeddedBridgeStatus status)
    {
        try
        {
            StatusChanged?.Invoke(status);
        }
        catch
        {
        }
    }

    private static string RequiredString(JsonElement value, string propertyName, int maximumLength)
    {
        var result = OptionalString(value, propertyName, maximumLength);
        return result ?? throw InvalidRequest();
    }

    private static string? OptionalString(
        JsonElement value,
        string propertyName,
        int maximumLength,
        int minimumLength = 1)
    {
        if (!value.TryGetProperty(propertyName, out var property))
        {
            return null;
        }
        if (property.ValueKind != JsonValueKind.String)
        {
            throw InvalidRequest();
        }
        var result = property.GetString();
        var runeLength = result?.EnumerateRunes().Take(maximumLength + 1).Count() ?? 0;
        if (runeLength < minimumLength || runeLength > maximumLength)
        {
            throw InvalidRequest();
        }
        return result;
    }

    private static bool OptionalBoolean(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out var property))
        {
            return false;
        }
        if (property.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw InvalidRequest();
        }
        return property.GetBoolean();
    }

    private static void RequireOnlyProperties(JsonElement value, params string[] allowed)
    {
        var names = new HashSet<string>(allowed, StringComparer.Ordinal);
        if (value.EnumerateObject().Any(property => !names.Contains(property.Name)))
        {
            throw InvalidRequest();
        }
    }

    private static ReluEmbeddedBridgeException InvalidRequest() =>
        new("INVALID_REQUEST", "Embedded bridge request is invalid.");
}

internal sealed class ReluEmbeddedBridgeException(string code, string publicMessage) : Exception(publicMessage)
{
    internal string Code { get; } = code;
    internal string PublicMessage { get; } = publicMessage;
}
