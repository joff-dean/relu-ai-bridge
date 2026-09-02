import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

function hmac(token, payload) {
  return crypto.createHmac('sha256', token).update(payload).digest('hex');
}

test('desktop .NET SDK consumes the shared raw registration HMAC vectors', async () => {
  const vector = JSON.parse(await read('compat/desktop-auth-v1.json'));
  assert.match(vector.description, /TEST-ONLY/u);
  assert.equal(
    crypto.createHash('sha256').update(vector.registrationJson, 'utf8').digest('hex'),
    vector.registrationDigest,
  );
  assert.equal(hmac(vector.token, vector.serverPayload), vector.serverProof);
  assert.equal(hmac(vector.token, vector.clientPayload), vector.clientProof);
  assert.ok(vector.rawRegistrationCases.length > 0);
  for (const edge of vector.rawRegistrationCases) {
    assert.match(edge.registrationJson, /분석/u);
    assert.match(edge.registrationJson, /1\.0/u);
    assert.match(edge.registrationJson, /1e3/u);
    assert.equal(
      crypto.createHash('sha256').update(edge.registrationJson, 'utf8').digest('hex'),
      edge.registrationDigest,
    );
    assert.equal(hmac(vector.token, edge.clientPayload), edge.clientProof);
  }

  const wire = await read('sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/DesktopWireProtocol.cs');
  const connector = await read('sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluDesktopConnector.cs');
  assert.match(wire, /relu-ai-bridge:\/\/loopback\/relu\/desktop\/ws/u);
  assert.match(wire, /RELU_DESKTOP_CONNECTOR_AUTH/u);
  assert.match(wire, /SHA256\.HashData\(Encoding\.UTF8\.GetBytes\(registrationJson\)\)/u);
  assert.match(connector, /writer\.WriteString\("registrationJson", registrationJson\)/u);
  assert.doesNotMatch(connector, /writer\.WritePropertyName\("registration"\)/u);
});

test('desktop .NET SDK and WPF sample preserve local security boundaries', async () => {
  const sourceRoot = path.join(ROOT, 'sdk-dotnet');
  const exampleRoot = path.join(ROOT, 'examples/wpf-android-log-viewer');
  async function collect(directory) {
    const output = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'bin' || entry.name === 'obj')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await collect(absolute));
      else output.push(absolute);
    }
    return output;
  }
  const files = [...await collect(sourceRoot), ...await collect(exampleRoot)];
  const text = (await Promise.all(files.filter((file) => /\.(?:cs|csproj)$/u.test(file)).map((file) => readFile(file, 'utf8')))).join('\n');

  assert.match(text, /\/relu\/desktop\/ws/u);
  assert.match(text, /socket\.Options\.Proxy = null/u);
  assert.match(text, /selectionRevision/u);
  assert.match(text, /selectionId/u);
  assert.match(text, /RandomNumberGenerator\.GetBytes\(16\)/u);
  assert.match(text, /WaitAsync\(execution\.Token\)/u);
  assert.match(text, /ReleaseWhenCompleted/u);
  assert.match(text, /NotifyContextChangedAsync\(\s*Action updateContext/u);
  assert.match(text, /SendCurrentContextUpdateAsync/u);
  assert.match(text, /await SendCurrentContextUpdateAsync\(socket, connectionLifetime\.Token\)/u);
  assert.match(text, /SendGuardedSuccessAsync/u);
  assert.match(text, /SendSerializedWhileGateHeldAsync/u);
  assert.match(text, /requiredContextGeneration\.Value != _contextGeneration/u);
  assert.match(text, /Volatile\.(?:Read|Write)/u);
  assert.match(text, /<PackageReadmeFile>NUGET_README_KO\.md<\/PackageReadmeFile>/u);
  assert.match(text, /<PackageLicenseFile>LICENSE<\/PackageLicenseFile>/u);
  assert.match(text, /<RepositoryUrl>https:\/\/github\.com\/joff-dean\/relu-ai-bridge<\/RepositoryUrl>/u);
  assert.match(text, /<IsPackable>false<\/IsPackable>/u);
  assert.doesNotMatch(text, /Func<bool>\s+IsActive/u);
  assert.match(text, /CryptographicOperations\.ZeroMemory/u);
  assert.match(text, /Deliberately process-memory only/u);
  assert.doesNotMatch(text, /SetRequestHeader\s*\(/u);
  assert.doesNotMatch(text, /System\.Windows\.Automation|UIAutomation|Process\.Start/u);
  assert.doesNotMatch(text, /Environment\.GetCommandLineArgs|GetEnvironmentVariable/u);
  assert.doesNotMatch(text, /File\.(?:Write|Append)|FileStream/u);
  assert.doesNotMatch(text, /<PackageReference\b/u);

  const service = JSON.parse(await read('config/android-log-viewer.desktop.service.example.json'));
  assert.deepEqual(service.clientKinds, ['desktop']);
  assert.deepEqual(service.origins, []);
  assert.deepEqual(service.desktopAppIds, ['com.relu.AndroidLogViewer']);
  assert.deepEqual(service.bindingFields, ['logResourceId', 'datasetRevision']);
  assert.deepEqual(service.executionGuardFields, [
    'logResourceId', 'datasetRevision', 'selectionId', 'selectionRevision', 'selection',
  ]);
  assert.ok(service.capabilities.every((capability) => capability.transport === 'desktop'));
  assert.ok(service.capabilities.every((capability) => capability.effect === 'read'));
  assert.deepEqual(service.capabilities.map(({ name }) => name).sort(), [
    'find_anomalies',
    'get_extracted_sections',
    'get_log_excerpt',
    'get_selection_series',
    'get_selection_stats',
  ]);
  const series = service.capabilities.find(({ name }) => name === 'get_selection_series');
  assert.equal(series.outputSchema.properties.series.maxItems, 6);
  assert.equal(series.outputSchema.properties.series.items.properties.points.maxItems, 1000);
});
