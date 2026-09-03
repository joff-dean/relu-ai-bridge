import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

test('desktop .NET SDK embeds the same-executable MCP and current-user pipe contract', async () => {
  const definition = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedServiceDefinition.cs',
  );
  const host = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedBridgeHost.cs',
  );
  const stdio = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluMcpStdioEntryPoint.cs',
  );
  const registrar = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs',
  );
  const pipePeerVerifier = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedPipePeerVerifier.cs',
  );
  const integration = await read('examples/wpf-android-log-viewer/ReluWpfIntegration.cs');
  const project = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj',
  );

  assert.match(definition, /string version = "0\.7\.0",/u);
  assert.match(definition, /if \(effect != "read"\)/u);
  assert.match(definition, /public string Effect => "read";/u);
  assert.match(definition, /relu-ai-bridge-pipe-v1\\0\{userIdentity\}\\0\{serviceId\}/u);
  assert.match(definition, /WindowsIdentity\.GetCurrent\(\)/u);
  assert.match(definition, /identity\.User\?\.Value/u);
  assert.match(definition, /PipeName = CreatePipeName\(serviceId, GetCurrentUserIdentity\(\)\)/u);

  assert.match(host, /PipeOptions\.Asynchronous \| PipeOptions\.CurrentUserOnly/u);
  assert.match(host, /pipeOptions \|= PipeOptions\.FirstPipeInstance/u);
  assert.match(host, /new NamedPipeServerStream\(/u);
  assert.match(host, /OptionalString\(arguments, "operationId", 128, minimumLength: 8\)/u);
  assert.doesNotMatch(host, /ClientWebSocket|HttpClient|TcpListener|Socket\s*\(/u);

  assert.match(stdio, /public const string StdioArgument = "--relu-mcp-stdio";/u);
  assert.match(stdio, /arguments\.Count == 1 && arguments\[0\] == StdioArgument/u);
  assert.match(stdio, /private const string ProtocolVersion = "2025-06-18";/u);
  assert.match(stdio, /method == "initialize"/u);
  assert.match(stdio, /method == "notifications\/initialized"/u);
  assert.match(stdio, /McpSessionState\.AwaitingInitializedNotification/u);
  assert.doesNotMatch(
    stdio,
    /2026-\d{2}-\d{2}|server\/discover|resultType|cacheScope|ttlMs|-32022/u,
  );
  assert.match(stdio, /new BoundedUtf8LineReader\(standardInput, MaximumMessageBytes\)/u);
  for (const tool of ['list_sessions', 'get_context', 'list_capabilities', 'execute']) {
    assert.match(stdio, new RegExp(`name = "${tool}"`, 'u'));
  }
  assert.match(stdio, /annotations = new \{ readOnlyHint = true \}/u);
  assert.match(stdio, /instructions = service\.Instructions/u);

  assert.match(registrar, /\["mcp", "add", options\.ServerName, "--", executablePath, ReluMcpStdioEntryPoint\.StdioArgument\]/u);
  assert.match(registrar, /\["mcp", "add", "--scope", "user", options\.ServerName, "--", executablePath, ReluMcpStdioEntryPoint\.StdioArgument\]/u);
  assert.doesNotMatch(registrar, /public string ExecutablePath/u);
  assert.match(registrar, /var executablePath = ResolveCurrentExecutablePath\(\);/u);
  assert.match(registrar, /ReluAgentRegistrationState\.Conflict/u);
  assert.match(registrar, /RegistrationInspection\.Unhealthy => new\(/u);
  assert.match(registrar, /UseShellExecute = false/u);
  assert.match(registrar, /startInfo\.ArgumentList\.Add\(argument\)/u);
  assert.match(registrar, /SensitiveEnvironmentName\.IsMatch\(name\)/u);
  assert.match(registrar, /startInfo\.Environment\.Remove\(name\)/u);
  assert.match(registrar, /InspectRegistration\(client, verified\.StandardOutput, options\.ServerName, executablePath\)/u);
  assert.match(registrar, /ReluWindowsProcessSecurity\.IsElevatedOrUnknown\(\)/u);
  assert.match(registrar, /relu-ai-bridge-registrar-mutex-v1\\0\{userIdentity\}\\0\{serverName\}/u);
  assert.match(registrar, /ReluEmbeddedServiceDefinition\.GetCurrentUserIdentity\(\)/u);
  assert.match(registrar, /Global\\\\Relu\.AI\.Bridge\.EndViewer\.McpRegistration/u);
  assert.match(registrar, /"Programs", "OpenAI", "Codex", "bin", "codex\.exe"/u);
  assert.match(registrar, /ReluWindowsAuthenticode\.Verify\(executablePath\)/u);
  assert.match(registrar, /"OpenAI OpCo, LLC"/u);
  assert.match(registrar, /"Anthropic, PBC"/u);
  assert.doesNotMatch(registrar, /"OpenAI, LLC"|"Anthropic PBC"/u);

  assert.match(pipePeerVerifier, /GetNamedPipeClientProcessId/u);
  assert.match(pipePeerVerifier, /GetNamedPipeServerProcessId/u);
  assert.match(pipePeerVerifier, /QueryFullProcessImageName/u);
  assert.match(pipePeerVerifier, /Environment\.ProcessPath/u);
  assert.match(stdio, /EmbeddedPipePeerVerifier\.VerifyServer\(pipe\)/u);
  assert.match(host, /EmbeddedPipePeerVerifier\.VerifyClient\(pipe\)/u);

  assert.match(integration, /ReluMcpStdioEntryPoint\.IsStdioMode\(arguments\)/u);
  assert.match(integration, /ReluMcpStdioEntryPoint\.RunAsync\(/u);
  assert.match(integration, /await Host\.TryStartAsync\(cancellationToken\)/u);
  assert.match(integration, /ReluWpfIntegrationStartResult/u);
  assert.match(integration, /_registrar\.RegisterUserScopeAsync\(/u);
  assert.match(integration, /LogSelection\? initialSelection = null/u);
  assert.match(integration, /_contextStore\.Clear/u);
  assert.doesNotMatch(
    integration,
    /ReluConnectorSecret|SecretProvider|desktopWebsocketPath|\.mcp\.json|\bEndpoint\s*=/u,
  );

  assert.match(project, /<Version>0\.7\.0<\/Version>/u);
  assert.match(project, /<PackageReadmeFile>NUGET_README_KO\.md<\/PackageReadmeFile>/u);
  assert.match(project, /<PackageLicenseFile>LICENSE<\/PackageLicenseFile>/u);
  assert.match(project, /<RepositoryUrl>https:\/\/github\.com\/joff-dean\/relu-ai-bridge<\/RepositoryUrl>/u);
  assert.match(project, /<IsPackable>true<\/IsPackable>/u);
  assert.doesNotMatch(project, /<PackageReference\b/u);
});

test('embedded WPF capabilities remain bounded, schema-checked, and selection-bound', async () => {
  const host = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedBridgeHost.cs',
  );
  const framing = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedPipeProtocol.cs',
  );
  const schemas = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedJsonSchema.cs',
  );
  const contextProtocol = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedContextProtocol.cs',
  );
  const pipePeerVerifier = await read(
    'sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedPipePeerVerifier.cs',
  );
  const capabilities = await read('examples/wpf-android-log-viewer/AndroidLogCapabilities.cs');
  const allSources = `${host}\n${framing}\n${schemas}\n${contextProtocol}\n${pipePeerVerifier}\n${capabilities}`;

  assert.match(host, /RequiredContextBinding\(arguments\)/u);
  assert.match(host, /EmbeddedContextProtocol\.CreateBinding\(projection\)/u);
  assert.match(allSources, /SHA256\.HashData/u);
  assert.match(allSources, /EnumerateObject\(\)\.OrderBy/u);
  assert.match(host, /lease\.Generation != CurrentContextLease\(\)\.Generation/u);
  assert.match(host, /lease\.Token\.IsCancellationRequested/u);
  assert.match(host, /EmbeddedContextProtocol\.SemanticallyEquals\(projection, currentProjection\)/u);
  assert.match(host, /EmbeddedJsonSchema\.ValidateInstance\(\s*boundedParameters, capability\.InputSchema/u);
  assert.match(host, /EmbeddedJsonSchema\.ValidateInstance\(\s*bounded, capability\.OutputSchema/u);
  assert.match(host, /_handlerSlots\.ReleaseWhenCompleted\(requestId, handlerTask \?\? Task\.CompletedTask\)/u);

  assert.match(framing, /BinaryPrimitives\.WriteInt32BigEndian/u);
  assert.match(framing, /length <= 0 \|\| length > maximumBytes/u);
  assert.match(schemas, /additionalProperties/u);
  assert.match(schemas, /ValidateInstance/u);

  const capabilityNames = [
    'get_selection_stats',
    'get_selection_series',
    'get_log_excerpt',
    'get_extracted_sections',
    'find_anomalies',
  ];
  for (const name of capabilityNames) {
    assert.match(capabilities, new RegExp(`"${name}"`, 'u'));
  }
  assert.match(capabilities, /maxItems = 6/u);
  assert.match(capabilities, /maxItems = 1000/u);
  assert.match(capabilities, /maxItems = 200/u);
  assert.match(capabilities, /contextGuardFields:/u);
  assert.match(capabilities, /"selectionRevision"/u);
  assert.match(capabilities, /prompt-like[\s\S]*untrusted data/u);

  assert.doesNotMatch(allSources, /SetRequestHeader\s*\(|System\.Windows\.Automation|UIAutomation/u);
  assert.doesNotMatch(allSources, /Environment\.GetEnvironmentVariable|File\.(?:Write|Append)/u);
});
