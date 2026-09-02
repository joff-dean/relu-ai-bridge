using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using Relu.AI.Bridge.DesktopConnector;
using Relu.AI.Bridge.DesktopConnector.Internal;

var vectorPath = Path.Combine(AppContext.BaseDirectory, "desktop-auth-v1.json");
using var vectorDocument = JsonDocument.Parse(await File.ReadAllBytesAsync(vectorPath));
var vector = vectorDocument.RootElement;

var options = ValidOptions(
    vector.GetProperty("serviceId").GetString()!,
    vector.GetProperty("appId").GetString()!,
    vector.GetProperty("instanceId").GetString()!);
var clientNonce = vector.GetProperty("clientNonce").GetString()!;
var serverNonce = vector.GetProperty("serverNonce").GetString()!;
var registrationJson = vector.GetProperty("registrationJson").GetString()!;
var registrationDigest = vector.GetProperty("registrationDigest").GetString()!;

Equal(registrationDigest, DesktopWireProtocol.RegistrationDigest(registrationJson), "registrationJson digest");
Equal(
    vector.GetProperty("serverPayload").GetString()!,
    DesktopWireProtocol.CreateAuthTranscript(
        "server", options.ServiceId, options.AppId, options.InstanceId, clientNonce, serverNonce),
    "server transcript");
Equal(
    vector.GetProperty("clientPayload").GetString()!,
    DesktopWireProtocol.CreateAuthTranscript(
        "client", options.ServiceId, options.AppId, options.InstanceId, clientNonce, serverNonce, registrationDigest),
    "client transcript");

using (var secret = new ReluConnectorSecret(Encoding.UTF8.GetBytes(vector.GetProperty("token").GetString()!)))
{
    Equal(
        vector.GetProperty("serverProof").GetString()!,
        DesktopWireProtocol.CreateProof(secret, "server", options, clientNonce, serverNonce),
        "server proof");
    Equal(
        vector.GetProperty("clientProof").GetString()!,
        DesktopWireProtocol.CreateProof(secret, "client", options, clientNonce, serverNonce, registrationDigest),
        "client proof");
}

foreach (var edge in vector.GetProperty("rawRegistrationCases").EnumerateArray())
{
    var name = edge.GetProperty("name").GetString()!;
    var edgeJson = edge.GetProperty("registrationJson").GetString()!;
    var edgeDigest = edge.GetProperty("registrationDigest").GetString()!;
    Equal(edgeDigest, DesktopWireProtocol.RegistrationDigest(edgeJson), $"{name} raw registration digest");
    Equal(
        edge.GetProperty("clientPayload").GetString()!,
        DesktopWireProtocol.CreateAuthTranscript(
            "client", options.ServiceId, options.AppId, options.InstanceId, clientNonce, serverNonce, edgeDigest),
        $"{name} client transcript");
    using var edgeSecret = new ReluConnectorSecret(Encoding.UTF8.GetBytes(vector.GetProperty("token").GetString()!));
    Equal(
        edge.GetProperty("clientProof").GetString()!,
        DesktopWireProtocol.CreateProof(edgeSecret, "client", options, clientNonce, serverNonce, edgeDigest),
        $"{name} client proof");
}

Reject(() => new ReluDesktopConnector(ValidOptions("a", options.AppId, options.InstanceId)), "one-character service id");
Reject(() => new ReluDesktopConnector(ValidOptions(options.ServiceId, "1.invalid.App", options.InstanceId)), "numeric-leading app id");
Reject(() => new ReluDesktopConnector(ValidOptions(
    options.ServiceId,
    options.AppId,
    options.InstanceId,
    new Uri("ws://192.0.2.1:5746/relu/desktop/ws"))), "non-loopback endpoint");

using (var duplicate = JsonDocument.Parse("{\"selectionRevision\":\"a\",\"selectionRevision\":\"b\"}"))
{
    Reject(() => BoundedJson.Validate(duplicate.RootElement, "duplicate fixture"), "duplicate JSON property");
}
using (var left = JsonDocument.Parse("{\"value\":1.0,\"label\":\"분석 구간\"}"))
using (var right = JsonDocument.Parse("{\"label\":\"분석 구간\",\"value\":1}"))
{
    True(DesktopWireProtocol.JsonSemanticallyEquals(left.RootElement, right.RootElement), "semantic Unicode/number equality");
}

var slots = new BoundedHandlerSlots(2);
True(slots.TryAcquire("request-a"), "first handler slot");
True(slots.TryAcquire("request-b"), "second handler slot");
True(!slots.TryAcquire("request-c"), "bounded handler slot rejection");
var cancellationIgnoringHandler = new TaskCompletionSource<bool>(
    TaskCreationOptions.RunContinuationsAsynchronously);
slots.ReleaseWhenCompleted("request-a", cancellationIgnoringHandler.Task);
True(slots.Contains("request-a"), "timed-out handler request ID retention");
True(!slots.TryAcquire("request-c"), "actual handler lifetime slot retention");
cancellationIgnoringHandler.SetResult(true);
await WaitUntilAsync(() => !slots.Contains("request-a"));
True(slots.TryAcquire("request-c"), "handler slot release after actual completion");
slots.ReleaseWhenCompleted("request-b", Task.CompletedTask);
slots.ReleaseWhenCompleted("request-c", Task.CompletedTask);
Equal("0", slots.InUse.ToString(System.Globalization.CultureInfo.InvariantCulture), "handler slot cleanup");

Console.WriteLine("RELU .NET desktop connector tests passed");

static ReluDesktopConnectorOptions ValidOptions(
    string serviceId,
    string appId,
    string instanceId,
    Uri? endpoint = null) => new()
{
    Endpoint = endpoint ?? new Uri("ws://127.0.0.1:5746/relu/desktop/ws"),
    ServiceId = serviceId,
    AppId = appId,
    InstanceId = instanceId,
    SecretProvider = new NeverSecretProvider(),
    ContextProvider = new StaticContextProvider(),
    Capabilities = [new ReluDesktopCapability("get_selection_stats", static (_, _) => ValueTask.FromResult(JsonSerializer.SerializeToElement(new { ok = true })))],
    RequiredContextGuardFields = ["selectionRevision"],
};

static void Equal(string expected, string actual, string name)
{
    if (!string.Equals(expected, actual, StringComparison.Ordinal))
    {
        throw new InvalidOperationException($"{name} mismatch");
    }
}

static void True(bool value, string name)
{
    if (!value)
    {
        throw new InvalidOperationException($"{name} failed");
    }
}

static void Reject(Action action, string name)
{
    try
    {
        action();
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidDataException or AuthenticationException)
    {
        return;
    }
    throw new InvalidOperationException($"{name} was not rejected");
}

static async Task WaitUntilAsync(Func<bool> condition)
{
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
    while (!condition())
    {
        await Task.Delay(10, timeout.Token);
    }
}

file sealed class NeverSecretProvider : IReluConnectorSecretProvider
{
    public ValueTask<ReluConnectorSecret> GetSecretAsync(CancellationToken cancellationToken) =>
        throw new NotSupportedException();
}

file sealed class StaticContextProvider : IReluDesktopContextProvider
{
    public ValueTask<JsonElement> GetContextAsync(CancellationToken cancellationToken) =>
        ValueTask.FromResult(JsonSerializer.SerializeToElement(new { selectionRevision = "fixture" }));
}
