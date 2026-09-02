using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector.Internal;

namespace Relu.AI.Bridge.DesktopConnector;

/// <summary>
/// 사람이 실행해 둔 RELU AI Bridge와 WPF 분석 엔진을 연결하는 상호 인증 desktop client입니다.
/// </summary>
public sealed class ReluDesktopConnector : IAsyncDisposable
{
    private const int MaximumConcurrentRequests = 16;
    private const int MaximumResetReconnects = 1;
    private readonly ReluDesktopConnectorOptions _options;
    private readonly IReadOnlyDictionary<string, ReluDesktopCapability> _capabilities;
    private readonly string[] _requiredContextGuardFields;
    private readonly object _stateGate = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly BoundedHandlerSlots _handlerSlots = new(MaximumConcurrentRequests);
    private CancellationTokenSource _contextChanged = new();
    private CancellationTokenSource? _lifetime;
    private ClientWebSocket? _socket;
    private Task? _runTask;
    // Deliberately process-memory only. Never persist this reconnect capability.
    private string? _resumeSecret;
    private ReluDesktopConnectorStatus _status = new(ReluDesktopConnectorState.Stopped, 0);
    private long _contextGeneration;
    private int _activeState;
    private bool _disposed;

    public ReluDesktopConnector(ReluDesktopConnectorOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _options.Validate();
        _capabilities = options.Capabilities.ToDictionary(item => item.Name, StringComparer.Ordinal);
        // Never retain a caller-owned mutable collection for security decisions.
        _requiredContextGuardFields = options.RequiredContextGuardFields.ToArray();
        _activeState = options.InitialActive ? 1 : 0;
    }

    public event Action<ReluDesktopConnectorStatus>? StatusChanged;

    public ReluDesktopConnectorStatus Status
    {
        get
        {
            lock (_stateGate)
            {
                return _status;
            }
        }
    }

    /// <summary>백그라운드 연결과 재연결 loop를 시작합니다.</summary>
    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (_stateGate)
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(nameof(ReluDesktopConnector));
            }
            if (_runTask is not null)
            {
                return Task.CompletedTask;
            }

            var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _lifetime = lifetime;
            _runTask = Task.Run(() => RunAsync(lifetime.Token), CancellationToken.None);
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// 차트 선택, 열린 로그 또는 filter의 thread-safe Context 저장소 갱신과 전송을
    /// success response gate에 직렬화합니다. Callback 안에서 UI property를 읽지 마십시오.
    /// </summary>
    public async Task NotifyContextChangedAsync(
        Action updateContext,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(updateContext);
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var generation = AdvanceContextGeneration();
            updateContext();
            var context = await ReadCurrentContextAsync(cancellationToken).ConfigureAwait(false);
            ClientWebSocket? socket;
            lock (_stateGate)
            {
                socket = _status.State == ReluDesktopConnectorState.Connected ? _socket : null;
            }
            if (socket is null)
            {
                return;
            }

            var message = JsonSerializer.SerializeToUtf8Bytes(new
            {
                type = "event",
                @event = "context.update",
                context,
                active = GetCachedActiveState(),
            });
            try
            {
                await SendSerializedWhileGateHeldAsync(
                    socket,
                    message,
                    generation,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
                // Reconnect registration will carry the newest context snapshot.
            }
        }
        finally
        {
            _sendGate.Release();
        }
    }

    /// <summary>WPF 창 활성화 상태를 Bridge session 선택 hint로 전달합니다.</summary>
    public async Task SetActiveAsync(bool active, CancellationToken cancellationToken = default)
    {
        Volatile.Write(ref _activeState, active ? 1 : 0);
        ClientWebSocket? socket;
        lock (_stateGate)
        {
            socket = _status.State == ReluDesktopConnectorState.Connected ? _socket : null;
        }
        if (socket is null)
        {
            return;
        }
        var message = JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "event",
            @event = "session.active",
            active,
        });
        try
        {
            await SendAsync(socket, message, cancellationToken).ConfigureAwait(false);
        }
        catch (WebSocketException)
        {
            // Active state is only a hint and will be refreshed on reconnect.
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        Task? runTask;
        CancellationTokenSource? lifetime;
        ClientWebSocket? socket;
        lock (_stateGate)
        {
            runTask = _runTask;
            lifetime = _lifetime;
            socket = _socket;
        }
        if (runTask is null)
        {
            return;
        }

        lifetime?.Cancel();
        socket?.Abort();
        try
        {
            await runTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (
            lifetime?.IsCancellationRequested == true
            && !cancellationToken.IsCancellationRequested)
        {
            // Expected connector shutdown.
        }
        finally
        {
            if (runTask.IsCompleted)
            {
                lock (_stateGate)
                {
                    _runTask = null;
                    _lifetime?.Dispose();
                    _lifetime = null;
                    _socket = null;
                }
                UpdateStatus(ReluDesktopConnectorState.Stopped, 0);
            }
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
        _sendGate.Dispose();
        lock (_stateGate)
        {
            _contextChanged.Cancel();
            _contextChanged.Dispose();
        }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var reconnectAttempt = 0;
        var resetReconnects = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            var connectedThisAttempt = false;
            try
            {
                UpdateStatus(
                    reconnectAttempt == 0 ? ReluDesktopConnectorState.Connecting : ReluDesktopConnectorState.Reconnecting,
                    reconnectAttempt);
                await ConnectAndRunAsync(
                    reconnectAttempt,
                    () => connectedThisAttempt = true,
                    cancellationToken).ConfigureAwait(false);
                reconnectAttempt = 1;
                resetReconnects = 0;
            }
            catch (ReluResetRequiredException) when (resetReconnects < MaximumResetReconnects)
            {
                resetReconnects += 1;
                _resumeSecret = null;
                reconnectAttempt = 0;
                continue;
            }
            catch (AuthenticationException exception)
            {
                UpdateStatus(
                    ReluDesktopConnectorState.AuthenticationRejected,
                    reconnectAttempt,
                    detail: SafeDetail(exception.Message));
                break;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception) when (exception is WebSocketException or IOException or OperationCanceledException)
            {
                reconnectAttempt = connectedThisAttempt ? 1 : reconnectAttempt + 1;
                if (connectedThisAttempt)
                {
                    resetReconnects = 0;
                }
                UpdateStatus(
                    ReluDesktopConnectorState.Reconnecting,
                    reconnectAttempt,
                    detail: SafeDetail(exception.Message));
            }
            catch
            {
                reconnectAttempt = connectedThisAttempt ? 1 : reconnectAttempt + 1;
                if (connectedThisAttempt)
                {
                    resetReconnects = 0;
                }
                UpdateStatus(
                    ReluDesktopConnectorState.Reconnecting,
                    reconnectAttempt,
                    detail: "Desktop connector failed before reconnect.");
            }

            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            var delay = ReconnectDelay(reconnectAttempt);
            try
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async Task ConnectAndRunAsync(
        int reconnectAttempt,
        Action onConnected,
        CancellationToken cancellationToken)
    {
        using var socket = new ClientWebSocket();
        // Do not set an Origin header. The desktop endpoint rejects browser-originated upgrades.
        // A loopback-only connector must never inherit a corporate/system proxy route.
        socket.Options.Proxy = null;
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        using var connectionLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        lock (_stateGate)
        {
            _socket = socket;
        }
        try
        {
            using var handshakeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            handshakeTimeout.CancelAfter(_options.HandshakeTimeout);
            await socket.ConnectAsync(_options.Endpoint, handshakeTimeout.Token).ConfigureAwait(false);
            UpdateStatus(ReluDesktopConnectorState.Authenticating, reconnectAttempt);
            DesktopHelloAck ack;
            try
            {
                ack = await AuthenticateAsync(socket, handshakeTimeout.Token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is InvalidDataException or CryptographicException)
            {
                throw new AuthenticationException("Desktop connector mutual authentication message is invalid.", exception);
            }
            if (!ack.Accepted)
            {
                if (ack.ErrorCode == "RESET_REQUIRED")
                {
                    throw new ReluResetRequiredException();
                }
                throw new AuthenticationException(ack.Error ?? "Bridge rejected desktop connector authentication.");
            }

            _resumeSecret = ack.ResumeSecret;
            UpdateStatus(ReluDesktopConnectorState.Connected, 0, ack.SessionId);
            // A selection may change while authentication is in flight. Always publish a
            // latest snapshot after ack so a skipped pre-connected update cannot strand the
            // server on the registration snapshot until another user action or reconnect.
            await SendCurrentContextUpdateAsync(socket, connectionLifetime.Token).ConfigureAwait(false);
            // A completed mutual-authentication handshake starts a fresh backoff series.
            onConnected();
            await ReceiveLoopAsync(socket, connectionLifetime.Token).ConfigureAwait(false);
        }
        finally
        {
            connectionLifetime.Cancel();
            lock (_stateGate)
            {
                if (ReferenceEquals(_socket, socket))
                {
                    _socket = null;
                }
            }
        }
    }

    private async Task<DesktopHelloAck> AuthenticateAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var clientNonce = DesktopWireProtocol.CreateNonce();
        var authInit = JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "auth_init",
            protocolVersion = DesktopWireProtocol.ProtocolVersion,
            serviceId = _options.ServiceId,
            clientKind = DesktopWireProtocol.ClientKind,
            appId = _options.AppId,
            instanceId = _options.InstanceId,
            audience = DesktopWireProtocol.Audience,
            clientNonce,
        });
        await SendAsync(socket, authInit, cancellationToken).ConfigureAwait(false);

        using var challengeMessage = await ReceiveJsonAsync(socket, cancellationToken).ConfigureAwait(false);
        var challenge = DesktopWireProtocol.ParseChallenge(challengeMessage.RootElement, _options, clientNonce);
        using var secret = await _options.SecretProvider.GetSecretAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new AuthenticationException("The connector secret provider returned no secret.");
        var expectedServerProof = DesktopWireProtocol.CreateProof(
            secret,
            "server",
            _options,
            clientNonce,
            challenge.ServerNonce);
        if (!DesktopWireProtocol.VerifyProof(challenge.Proof, expectedServerProof))
        {
            throw new AuthenticationException("Bridge server proof is invalid.");
        }

        var context = await ReadCurrentContextAsync(cancellationToken).ConfigureAwait(false);
        var registrationJson = CreateRegistrationJson(context);
        var registrationDigest = DesktopWireProtocol.RegistrationDigest(registrationJson);
        var clientProof = DesktopWireProtocol.CreateProof(
            secret,
            "client",
            _options,
            clientNonce,
            challenge.ServerNonce,
            registrationDigest);
        var authResponse = CreateAuthResponse(clientNonce, challenge.ServerNonce, registrationJson, clientProof);
        await SendAsync(socket, authResponse, cancellationToken).ConfigureAwait(false);

        using var ackMessage = await ReceiveJsonAsync(socket, cancellationToken).ConfigureAwait(false);
        return DesktopWireProtocol.ParseHelloAck(ackMessage.RootElement);
    }

    private string CreateRegistrationJson(JsonElement context)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("client");
            writer.WriteStartObject();
            writer.WriteString("serviceId", _options.ServiceId);
            writer.WriteString("clientKind", DesktopWireProtocol.ClientKind);
            writer.WriteString("appId", _options.AppId);
            writer.WriteString("instanceId", _options.InstanceId);
            writer.WriteString("connectorVersion", _options.ConnectorVersion);
            writer.WritePropertyName("capabilities");
            writer.WriteStartArray();
            foreach (var capability in _capabilities.Keys.OrderBy(item => item, StringComparer.Ordinal))
            {
                writer.WriteStringValue(capability);
            }
            writer.WriteEndArray();
            if (_resumeSecret is not null)
            {
                writer.WriteString("resumeSecret", _resumeSecret);
            }
            writer.WriteEndObject();
            writer.WritePropertyName("context");
            context.WriteTo(writer);
            writer.WriteBoolean("active", GetCachedActiveState());
            writer.WriteEndObject();
        }
        var bytes = stream.ToArray();
        using var document = BoundedJson.Parse(bytes, _options.MaximumOutboundMessageBytes, "registrationJson");
        return System.Text.Encoding.UTF8.GetString(bytes);
    }

    private byte[] CreateAuthResponse(
        string clientNonce,
        string serverNonce,
        string registrationJson,
        string proof)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("type", "auth_response");
            writer.WriteString("protocolVersion", DesktopWireProtocol.ProtocolVersion);
            writer.WriteString("serviceId", _options.ServiceId);
            writer.WriteString("clientKind", DesktopWireProtocol.ClientKind);
            writer.WriteString("appId", _options.AppId);
            writer.WriteString("instanceId", _options.InstanceId);
            writer.WriteString("audience", DesktopWireProtocol.Audience);
            writer.WriteString("clientNonce", clientNonce);
            writer.WriteString("serverNonce", serverNonce);
            writer.WriteString("registrationJson", registrationJson);
            writer.WriteString("proof", proof);
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var running = new HashSet<Task>();
        using var requestLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        try
        {
            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                using var document = await ReceiveJsonAsync(socket, cancellationToken).ConfigureAwait(false);
                var message = DesktopWireProtocol.ParseConnectedMessage(
                    document.RootElement,
                    _requiredContextGuardFields);
                if (message is DesktopPing ping)
                {
                    var pong = JsonSerializer.SerializeToUtf8Bytes(new { type = "pong", nonce = ping.Nonce });
                    await SendAsync(socket, pong, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                var request = (DesktopRequest)message;
                foreach (var completed in running.Where(item => item.IsCompleted).ToArray())
                {
                    running.Remove(completed);
                    await IgnoreCompletedRequestAsync(completed).ConfigureAwait(false);
                }
                if (!_handlerSlots.TryAcquire(request.Id))
                {
                    throw new InvalidDataException("Bridge exceeded the bounded desktop handler set.");
                }
                var task = ProcessRequestAsync(socket, request, requestLifetime.Token);
                running.Add(task);
            }
        }
        finally
        {
            requestLifetime.Cancel();
            if (running.Count > 0)
            {
                try
                {
                    await Task.WhenAll(running).ConfigureAwait(false);
                }
                catch
                {
                    // Individual request failures are converted to bounded response objects.
                }
            }
        }
    }

    private async Task ProcessRequestAsync(
        ClientWebSocket socket,
        DesktopRequest request,
        CancellationToken connectionCancellationToken)
    {
        var contextLease = CurrentContextLease();
        var contextToken = contextLease.Token;
        Task<JsonElement>? handlerTask = null;
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(request.TimeoutMs));
        using var execution = CancellationTokenSource.CreateLinkedTokenSource(
            connectionCancellationToken,
            timeout.Token,
            contextToken);
        try
        {
            if (!_capabilities.TryGetValue(request.Action, out var capability))
            {
                await SendFailureAsync(socket, request.Id, "CAPABILITY_UNAVAILABLE", "Capability is not implemented.", connectionCancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            var context = await ReadCurrentContextAsync(execution.Token).ConfigureAwait(false);
            AssertContextGuard(context, request.ContextGuard);
            var invocation = new ReluCapabilityInvocation(
                request.Parameters,
                context,
                request.ContextGuard,
                request.OperationId);
            handlerTask = capability.Handler(invocation, execution.Token).AsTask();
            var result = await handlerTask.WaitAsync(execution.Token).ConfigureAwait(false);
            execution.Token.ThrowIfCancellationRequested();

            var boundedResult = BoundedJson.CloneAndValidate(
                result,
                _options.MaximumOutboundMessageBytes,
                "capability result");
            var response = JsonSerializer.SerializeToUtf8Bytes(new
            {
                type = "response",
                id = request.Id,
                ok = true,
                result = boundedResult,
            });
            await SendGuardedSuccessAsync(
                socket,
                response,
                request.ContextGuard,
                contextLease.Generation,
                execution.Token).ConfigureAwait(false);
        }
        catch (ReluContextChangedException)
        {
            await TrySendFailureAsync(socket, request.Id, "CONTEXT_CHANGED", "Selection context changed before completion.", connectionCancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (contextToken.IsCancellationRequested)
        {
            await TrySendFailureAsync(socket, request.Id, "CONTEXT_CHANGED", "Selection context changed before completion.", connectionCancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            await TrySendFailureAsync(socket, request.Id, "TIMEOUT", "Capability execution timed out.", connectionCancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (connectionCancellationToken.IsCancellationRequested)
        {
            // Connection is already gone; no response can be delivered.
        }
        catch
        {
            // Never reflect exception details because they can contain a raw log line or company path.
            await TrySendFailureAsync(socket, request.Id, "CAPABILITY_FAILED", "Capability execution failed.", connectionCancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            // A handler may ignore cancellation. Keep both its global slot and request ID
            // until the actual task completes, including across timeout and reconnect.
            _handlerSlots.ReleaseWhenCompleted(request.Id, handlerTask ?? Task.CompletedTask);
        }
    }

    private void AssertContextGuard(JsonElement context, ReluContextGuard guard)
    {
        var projection = DesktopWireProtocol.ProjectContext(context, guard.Fields);
        if (!DesktopWireProtocol.JsonSemanticallyEquals(projection, guard.Projection))
        {
            throw new ReluContextChangedException();
        }
    }

    private async Task<JsonElement> ReadCurrentContextAsync(CancellationToken cancellationToken)
    {
        var value = await _options.ContextProvider.GetContextAsync(cancellationToken).ConfigureAwait(false);
        var context = BoundedJson.CloneAndValidate(value, _options.MaximumOutboundMessageBytes, "desktop context");
        if (context.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Desktop context must be an object.");
        }
        foreach (var required in _requiredContextGuardFields)
        {
            if (!context.TryGetProperty(required, out _))
            {
                throw new InvalidDataException($"Desktop context is missing required field {required}.");
            }
        }
        return context;
    }

    private async Task<JsonDocument> ReceiveJsonAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        using var stream = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                throw new WebSocketException("Bridge closed the desktop connector socket.");
            }
            if (result.MessageType != WebSocketMessageType.Text)
            {
                throw new InvalidDataException("Bridge messages must be text JSON.");
            }
            if (stream.Length + result.Count > _options.MaximumInboundMessageBytes)
            {
                socket.Abort();
                throw new InvalidDataException("Bridge message exceeds the configured byte limit.");
            }
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return BoundedJson.Parse(stream.ToArray(), _options.MaximumInboundMessageBytes, "bridge message");
            }
        }
    }

    private Task SendAsync(ClientWebSocket socket, byte[] message, CancellationToken cancellationToken) =>
        SendSerializedAsync(socket, message, null, cancellationToken);

    private async Task SendCurrentContextUpdateAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var contextLease = CurrentContextLease();
            var context = await ReadCurrentContextAsync(cancellationToken).ConfigureAwait(false);
            var message = JsonSerializer.SerializeToUtf8Bytes(new
            {
                type = "event",
                @event = "context.update",
                context,
                active = GetCachedActiveState(),
            });
            await SendSerializedWhileGateHeldAsync(
                socket,
                message,
                contextLease.Generation,
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private async Task SendGuardedSuccessAsync(
        ClientWebSocket socket,
        byte[] message,
        ReluContextGuard contextGuard,
        long contextGeneration,
        CancellationToken cancellationToken)
    {
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var currentContext = await ReadCurrentContextAsync(cancellationToken).ConfigureAwait(false);
            AssertContextGuard(currentContext, contextGuard);
            await SendSerializedWhileGateHeldAsync(
                socket,
                message,
                contextGeneration,
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Cancellation during a WebSocket send can leave delivery ambiguous.
            // Abort before a context.update/reconnect can make a stale success observable.
            socket.Abort();
            throw;
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private async Task SendSerializedAsync(
        ClientWebSocket socket,
        byte[] message,
        long? requiredContextGeneration,
        CancellationToken cancellationToken)
    {
        await _sendGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await SendSerializedWhileGateHeldAsync(
                socket,
                message,
                requiredContextGeneration,
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private async Task SendSerializedWhileGateHeldAsync(
        ClientWebSocket socket,
        byte[] message,
        long? requiredContextGeneration,
        CancellationToken cancellationToken)
    {
        if (message.Length == 0 || message.Length > _options.MaximumOutboundMessageBytes)
        {
            throw new InvalidDataException("Desktop connector message exceeds the configured byte limit.");
        }
        lock (_stateGate)
        {
            if (!ReferenceEquals(_socket, socket) || socket.State != WebSocketState.Open)
            {
                throw new WebSocketException("Desktop connector socket is not open.");
            }
            if (requiredContextGeneration.HasValue
                && requiredContextGeneration.Value != _contextGeneration)
            {
                throw new ReluContextChangedException();
            }
        }
        await socket.SendAsync(
            message.AsMemory(),
            WebSocketMessageType.Text,
            true,
            cancellationToken).ConfigureAwait(false);
    }

    private Task SendFailureAsync(
        ClientWebSocket socket,
        string requestId,
        string errorCode,
        string error,
        CancellationToken cancellationToken)
    {
        var response = JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "response",
            id = requestId,
            ok = false,
            errorCode,
            error,
        });
        return SendAsync(socket, response, cancellationToken);
    }

    private async Task TrySendFailureAsync(
        ClientWebSocket socket,
        string requestId,
        string errorCode,
        string error,
        CancellationToken cancellationToken)
    {
        try
        {
            await SendFailureAsync(socket, requestId, errorCode, error, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OperationCanceledException or WebSocketException)
        {
            // A disconnected caller cannot receive the bounded error response.
        }
    }

    private long AdvanceContextGeneration()
    {
        CancellationTokenSource previous;
        long generation;
        lock (_stateGate)
        {
            previous = _contextChanged;
            _contextChanged = new CancellationTokenSource();
            _contextGeneration += 1;
            if (_contextGeneration <= 0)
            {
                _contextGeneration = 1;
            }
            generation = _contextGeneration;
        }
        previous.Cancel();
        previous.Dispose();
        return generation;
    }

    private (CancellationToken Token, long Generation) CurrentContextLease()
    {
        lock (_stateGate)
        {
            return (_contextChanged.Token, _contextGeneration);
        }
    }

    private bool GetCachedActiveState() => Volatile.Read(ref _activeState) != 0;

    private TimeSpan ReconnectDelay(int attempt)
    {
        var exponent = Math.Min(Math.Max(attempt - 1, 0), 16);
        var rawMilliseconds = _options.MinimumReconnectDelay.TotalMilliseconds * Math.Pow(2, exponent);
        var capped = Math.Min(rawMilliseconds, _options.MaximumReconnectDelay.TotalMilliseconds);
        var jitter = RandomNumberGenerator.GetInt32(80, 121) / 100d;
        return TimeSpan.FromMilliseconds(Math.Min(capped * jitter, _options.MaximumReconnectDelay.TotalMilliseconds));
    }

    private void UpdateStatus(
        ReluDesktopConnectorState state,
        int reconnectAttempt,
        string? sessionId = null,
        string? detail = null)
    {
        ReluDesktopConnectorStatus status;
        lock (_stateGate)
        {
            status = new ReluDesktopConnectorStatus(state, reconnectAttempt, sessionId, detail);
            _status = status;
        }
        try
        {
            StatusChanged?.Invoke(status);
        }
        catch
        {
            // Consumer UI callbacks cannot change the connector state machine.
        }
    }

    private static async Task IgnoreCompletedRequestAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch
        {
            // ProcessRequestAsync converts failures into responses; this is a fail-safe.
        }
    }

    private static string SafeDetail(string value) => value.Length <= 500 ? value : value[..500];
}

internal sealed class ReluResetRequiredException : AuthenticationException
{
    internal ReluResetRequiredException() : base("Desktop connector resume state must be reset.")
    {
    }
}
