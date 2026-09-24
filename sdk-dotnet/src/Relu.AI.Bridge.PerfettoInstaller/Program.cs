using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Relu.AI.Bridge.PerfettoInstaller;

internal static partial class Program
{
    private const string ProductName = "RELU Perfetto Connector";
    private const string NativeHostName = "com.relu_ai_bridge.perfetto";
    private const string NativeHostExecutable = "Relu.AI.Bridge.PerfettoNativeHost.exe";
    private const string NativeHostManifest = "com.relu_ai_bridge.perfetto.json";
    private const string NativeHostConfiguration = "relu-perfetto-native-host.json";
    private const string NativeHostRegistryPath = @"Software\Google\Chrome\NativeMessagingHosts\com.relu_ai_bridge.perfetto";
    private const string ChromeForcelistRegistryPath = @"Software\Policies\Google\Chrome\ExtensionInstallForcelist";
    private const string ChromeExtensionSettingsRegistryPath = @"Software\Policies\Google\Chrome";
    private const int MaximumProcessOutputChars = 64 * 1024;

    [STAThread]
    public static async Task<int> Main(string[] args)
    {
        var quiet = args.Length == 1 && args[0] == "--quiet";
        if ((!quiet && args.Length != 0) || !OperatingSystem.IsWindows())
        {
            return Finish(false, "이 설치 파일은 Windows에서 인자 없이 한 번 실행해야 합니다.", quiet);
        }

        try
        {
            if (IsElevatedOrUnknown())
            {
                throw new InvalidOperationException(
                    "관리자 권한으로 실행하지 마세요. 현재 Windows 사용자 범위에 안전하게 설치해야 합니다.");
            }

            var executable = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(executable) || !Path.IsPathFullyQualified(executable))
            {
                throw new InvalidOperationException("설치 파일의 실행 경로를 확인할 수 없습니다.");
            }

            using var bundle = InstallerBundle.Open(executable);
            var layout = InstallLayout.Create(bundle.Contract);
            var chromePlan = ChromeExtensionPolicy.Preflight(bundle.Contract);
            var nativePlan = NativeHostRegistration.Preflight(layout, bundle.Contract);
            await layout.InstallPayloadAsync(bundle).ConfigureAwait(false);
            ChromeExtensionPolicy.Apply(bundle.Contract, chromePlan);
            NativeHostRegistration.Apply(layout, bundle.Contract, nativePlan);
            await RegisterDesktopAiClientsAsync(layout.NativeHostPath).ConfigureAwait(false);

            return Finish(true,
                "설치가 완료되었습니다.\n\nChrome과 Codex/Claude를 한 번 종료 후 다시 실행하세요. " +
                "이후에는 회사 Perfetto 페이지를 열고 AI 앱에서 바로 분석을 요청하면 됩니다.\n\n" +
                "토큰 입력이나 브리지 수동 실행은 필요하지 않습니다.", quiet);
        }
        catch (Exception exception)
        {
            return Finish(false, $"설치하지 못했습니다.\n\n{exception.Message}\n\n기존 정책과 등록은 덮어쓰지 않았습니다.", quiet);
        }
    }

    private static int Finish(bool success, string message, bool quiet)
    {
        if (quiet)
        {
            var writer = success ? Console.Out : Console.Error;
            writer.WriteLine(message.Replace("\n", " ", StringComparison.Ordinal));
        }
        else if (OperatingSystem.IsWindows())
        {
            _ = MessageBoxW(IntPtr.Zero, message, ProductName,
                success ? 0x00000040u : 0x00000010u);
        }
        return success ? 0 : 1;
    }

    [SupportedOSPlatform("windows")]
    private static bool IsElevatedOrUnknown()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return true;
        }
    }

    private static async Task RegisterDesktopAiClientsAsync(string nativeHostPath)
    {
        var start = new ProcessStartInfo
        {
            FileName = nativeHostPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("--relu-register-ai-clients");
        using var process = Process.Start(start)
            ?? throw new InvalidOperationException("AI 클라이언트 등록 프로세스를 시작하지 못했습니다.");
        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("AI 클라이언트 등록 시간이 초과되었습니다.");
        }
        var output = await standardOutput.ConfigureAwait(false);
        var error = await standardError.ConfigureAwait(false);
        if (output.Length + error.Length > MaximumProcessOutputChars)
        {
            throw new InvalidDataException("AI 클라이언트 등록 출력이 제한을 초과했습니다.");
        }
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException("기존 Codex/Claude MCP 등록과 충돌하거나 등록을 확인하지 못했습니다.");
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    [SupportedOSPlatform("windows")]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);

    internal sealed record InstallerFile(
        string Path,
        long Offset,
        int CompressedBytes,
        int Bytes,
        string Sha256);

    internal sealed record InstallerContract(
        int SchemaVersion,
        string Product,
        string ProductVersion,
        string RuntimeIdentifier,
        string ExtensionId,
        string PerfettoOrigin,
        string ExtensionUpdateUrl,
        int BridgePort,
        long PayloadBytes,
        string PayloadSha256,
        IReadOnlyList<InstallerFile> Files)
    {
        private const int MaximumContractBytes = 1024 * 1024;
        private const int MaximumFiles = 512;
        private const int MaximumFileBytes = 256 * 1024 * 1024;
        private const long MaximumPayloadBytes = 512L * 1024 * 1024;

        internal static InstallerContract Parse(ReadOnlySpan<byte> utf8)
        {
            if (utf8.Length is < 2 or > MaximumContractBytes)
                throw new InvalidDataException("설치 계약 크기가 올바르지 않습니다.");
            try
            {
                _ = new UTF8Encoding(false, true).GetString(utf8);
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("설치 계약이 올바른 UTF-8이 아닙니다.");
            }
            using var document = JsonDocument.Parse(utf8.ToArray(), new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 12,
            });
            var root = document.RootElement;
            RequireProperties(root,
            [
                "schemaVersion", "product", "productVersion", "runtimeIdentifier", "extensionId",
                "perfettoOrigin", "extensionUpdateUrl", "bridgePort", "payloadBytes",
                "payloadSha256", "files",
            ], "설치 계약");
            var schemaVersion = RequiredInt(root, "schemaVersion");
            var product = RequiredString(root, "product", 64);
            var productVersion = RequiredString(root, "productVersion", 32);
            var runtimeIdentifier = RequiredString(root, "runtimeIdentifier", 32);
            var extensionId = RequiredString(root, "extensionId", 32);
            var perfettoOrigin = RequiredString(root, "perfettoOrigin", 2048);
            var extensionUpdateUrl = RequiredString(root, "extensionUpdateUrl", 2048);
            var bridgePort = RequiredInt(root, "bridgePort");
            var payloadBytes = RequiredLong(root, "payloadBytes");
            var payloadSha256 = RequiredString(root, "payloadSha256", 64);
            if (schemaVersion != 1 || product != "relu-perfetto-connector"
                || !VersionPattern().IsMatch(productVersion)
                || runtimeIdentifier is not ("win-x64" or "win-arm64")
                || !ExtensionIdPattern().IsMatch(extensionId)
                || bridgePort is < 1 or > 65535
                || payloadBytes is < 1 or > MaximumPayloadBytes
                || !Sha256Pattern().IsMatch(payloadSha256)
                || !IsExactHttpOrigin(perfettoOrigin)
                || !IsExactHttpsUrl(extensionUpdateUrl))
            {
                throw new InvalidDataException("설치 계약 정책이 올바르지 않습니다.");
            }

            var fileElements = root.GetProperty("files");
            if (fileElements.ValueKind != JsonValueKind.Array
                || fileElements.GetArrayLength() is < 1 or > MaximumFiles)
                throw new InvalidDataException("설치 파일 목록이 올바르지 않습니다.");
            var files = new List<InstallerFile>(fileElements.GetArrayLength());
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long expectedOffset = 0;
            foreach (var element in fileElements.EnumerateArray())
            {
                RequireProperties(element, ["path", "offset", "compressedBytes", "bytes", "sha256"], "설치 파일");
                var relativePath = RequiredString(element, "path", 240);
                var offset = RequiredLong(element, "offset");
                var compressedBytes = RequiredInt(element, "compressedBytes");
                var bytes = RequiredInt(element, "bytes");
                var sha256 = RequiredString(element, "sha256", 64);
                ValidateRelativePath(relativePath);
                if (!paths.Add(relativePath) || offset != expectedOffset
                    || compressedBytes is < 1 or > MaximumFileBytes
                    || bytes is < 1 or > MaximumFileBytes
                    || !Sha256Pattern().IsMatch(sha256))
                {
                    throw new InvalidDataException("설치 파일 레코드가 올바르지 않습니다.");
                }
                expectedOffset = checked(offset + compressedBytes);
                files.Add(new(relativePath, offset, compressedBytes, bytes, sha256));
            }
            if (expectedOffset != payloadBytes
                || !files.Any(item => item.Path == NativeHostExecutable)
                || !files.Any(item => item.Path == "runtime/node.exe")
                || !files.Any(item => item.Path == "app/scripts/perfetto/run-extension-bridge.mjs")
                || !files.Any(item => item.Path == "app/scripts/perfetto/desktop-mcp-proxy.mjs")
                || !files.Any(item => item.Path == "app/scripts/skills/manage-skills.mjs")
                || !files.Any(item => item.Path == "app/skills/manifest.json"))
            {
                throw new InvalidDataException("설치 payload 필수 파일이 누락되었거나 범위가 올바르지 않습니다.");
            }
            return new(schemaVersion, product, productVersion, runtimeIdentifier, extensionId,
                perfettoOrigin, extensionUpdateUrl, bridgePort, payloadBytes, payloadSha256,
                files.AsReadOnly());
        }

        private static bool IsExactHttpOrigin(string value) =>
            Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme is "http" or "https"
            && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0
            && uri.GetLeftPart(UriPartial.Authority) == value;

        private static bool IsExactHttpsUrl(string value) =>
            Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme == "https" && uri.Host.Length > 0
            && uri.UserInfo.Length == 0 && uri.Fragment.Length == 0;

        private static void ValidateRelativePath(string value)
        {
            if (value.Contains('\\') || value[0] == '/' || value[^1] == '/')
                throw new InvalidDataException("설치 파일 경로가 올바르지 않습니다.");
            var parts = value.Split('/');
            if (parts.Any(part => part.Length == 0 || part is "." or ".."
                || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
                throw new InvalidDataException("설치 파일 경로 구성요소가 올바르지 않습니다.");
        }

        private static void RequireProperties(JsonElement element, IReadOnlyList<string> expected, string label)
        {
            if (element.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException($"{label} 형식이 올바르지 않습니다.");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw new InvalidDataException($"{label}에 중복 필드가 있습니다.");
            }
            if (names.Count != expected.Count || expected.Any(name => !names.Contains(name)))
                throw new InvalidDataException($"{label} 필드가 올바르지 않습니다.");
        }

        private static string RequiredString(JsonElement element, string name, int maximumBytes)
        {
            var value = element.GetProperty(name);
            if (value.ValueKind != JsonValueKind.String) throw new InvalidDataException($"{name} 형식이 올바르지 않습니다.");
            var result = value.GetString() ?? string.Empty;
            if (result.Length == 0 || Encoding.UTF8.GetByteCount(result) > maximumBytes)
                throw new InvalidDataException($"{name} 값이 올바르지 않습니다.");
            return result;
        }

        private static int RequiredInt(JsonElement element, string name)
        {
            var value = element.GetProperty(name);
            if (!value.TryGetInt32(out var result)) throw new InvalidDataException($"{name} 형식이 올바르지 않습니다.");
            return result;
        }

        private static long RequiredLong(JsonElement element, string name)
        {
            var value = element.GetProperty(name);
            if (!value.TryGetInt64(out var result)) throw new InvalidDataException($"{name} 형식이 올바르지 않습니다.");
            return result;
        }
    }

    internal sealed class InstallerBundle : IDisposable
    {
        private static readonly byte[] Magic = "RELU-PERFETTO-V1"u8.ToArray();
        private const int FooterBytes = 16 + sizeof(long) + sizeof(int);
        private readonly FileStream _stream;
        internal InstallerContract Contract { get; }
        internal long PayloadOffset { get; }

        private InstallerBundle(FileStream stream, InstallerContract contract, long payloadOffset)
        {
            _stream = stream;
            Contract = contract;
            PayloadOffset = payloadOffset;
        }

        internal static InstallerBundle Open(string executablePath)
        {
            var stream = new FileStream(executablePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                128 * 1024, FileOptions.SequentialScan);
            try
            {
                if (stream.Length <= FooterBytes) throw new InvalidDataException("설치 payload가 없습니다.");
                stream.Position = stream.Length - FooterBytes;
                Span<byte> footer = stackalloc byte[FooterBytes];
                stream.ReadExactly(footer);
                var payloadBytes = BinaryPrimitives.ReadInt64LittleEndian(footer[..8]);
                var contractBytes = BinaryPrimitives.ReadInt32LittleEndian(footer.Slice(8, 4));
                if (!footer[12..].SequenceEqual(Magic) || payloadBytes < 1
                    || contractBytes is < 2 or > 1024 * 1024)
                    throw new InvalidDataException("설치 footer가 올바르지 않습니다.");
                var payloadOffset = checked(stream.Length - FooterBytes - contractBytes - payloadBytes);
                if (payloadOffset < 1) throw new InvalidDataException("설치 payload 범위가 올바르지 않습니다.");
                stream.Position = payloadOffset + payloadBytes;
                var contractData = new byte[contractBytes];
                stream.ReadExactly(contractData);
                var contract = InstallerContract.Parse(contractData);
                if (contract.PayloadBytes != payloadBytes)
                    throw new InvalidDataException("설치 payload 길이가 계약과 다릅니다.");
                stream.Position = payloadOffset;
                var payloadHash = HashSegment(stream, payloadBytes);
                if (!string.Equals(payloadHash, contract.PayloadSha256, StringComparison.Ordinal))
                    throw new InvalidDataException("설치 payload checksum이 일치하지 않습니다.");
                return new InstallerBundle(stream, contract, payloadOffset);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        internal async Task ExtractFileAsync(InstallerFile file, string destination)
        {
            _stream.Position = checked(PayloadOffset + file.Offset);
            await using var segment = new BoundedReadStream(_stream, file.CompressedBytes, leaveOpen: true);
            await using var brotli = new BrotliStream(segment, CompressionMode.Decompress, leaveOpen: true);
            await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                128 * 1024, FileOptions.WriteThrough);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[128 * 1024];
            var total = 0;
            while (true)
            {
                var count = await brotli.ReadAsync(buffer).ConfigureAwait(false);
                if (count == 0) break;
                total = checked(total + count);
                if (total > file.Bytes) throw new InvalidDataException("설치 파일 압축 해제 크기가 제한을 초과했습니다.");
                hash.AppendData(buffer, 0, count);
                await output.WriteAsync(buffer.AsMemory(0, count)).ConfigureAwait(false);
            }
            await output.FlushAsync().ConfigureAwait(false);
            if (total != file.Bytes || segment.Remaining != 0
                || Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != file.Sha256)
                throw new InvalidDataException("설치 파일 checksum 또는 크기가 일치하지 않습니다.");
        }

        private static string HashSegment(Stream stream, long bytes)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[128 * 1024];
            var remaining = bytes;
            while (remaining > 0)
            {
                var count = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                if (count == 0) throw new EndOfStreamException("설치 payload가 잘렸습니다.");
                hash.AppendData(buffer, 0, count);
                remaining -= count;
            }
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }

        public void Dispose() => _stream.Dispose();
    }

    internal sealed class BoundedReadStream : Stream
    {
        private readonly Stream _inner;
        private readonly bool _leaveOpen;
        internal long Remaining { get; private set; }

        internal BoundedReadStream(Stream inner, long length, bool leaveOpen)
        {
            _inner = inner;
            Remaining = length;
            _leaveOpen = leaveOpen;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (Remaining == 0) return 0;
            var read = _inner.Read(buffer, offset, (int)Math.Min(count, Remaining));
            if (read == 0) throw new EndOfStreamException();
            Remaining -= read;
            return read;
        }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Remaining == 0) return 0;
            var read = await _inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, Remaining)], cancellationToken)
                .ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException();
            Remaining -= read;
            return read;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing && !_leaveOpen) _inner.Dispose();
            base.Dispose(disposing);
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    internal sealed record InstallLayout(string Root, string VersionDirectory)
    {
        internal string NativeHostPath => Path.Combine(VersionDirectory, NativeHostExecutable);
        internal string NativeManifestPath => Path.Combine(VersionDirectory, NativeHostManifest);
        internal string NativeConfigurationPath => Path.Combine(VersionDirectory, NativeHostConfiguration);

        internal static InstallLayout Create(InstallerContract contract)
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
                throw new InvalidOperationException("LOCALAPPDATA 경로를 확인할 수 없습니다.");
            var root = Path.Combine(local, "RELU", "PerfettoConnector");
            var version = $"{contract.ProductVersion}-{contract.PayloadSha256[..16]}";
            return new(root, Path.Combine(root, "versions", version));
        }

        internal async Task InstallPayloadAsync(InstallerBundle bundle)
        {
            EnsureDirectory(Root);
            EnsureDirectory(Path.Combine(Root, "versions"));
            if (Directory.Exists(VersionDirectory))
            {
                VerifyInstalled(bundle.Contract);
                return;
            }

            var staging = Path.Combine(Root, $"staging-{Guid.NewGuid():N}");
            Directory.CreateDirectory(staging);
            try
            {
                EnsureNotReparsePoint(staging);
                foreach (var file in bundle.Contract.Files)
                {
                    var target = ContainedPath(staging, file.Path);
                    var parent = Path.GetDirectoryName(target)
                        ?? throw new InvalidDataException("설치 파일 부모 경로가 없습니다.");
                    EnsureDirectory(parent);
                    await bundle.ExtractFileAsync(file, target).ConfigureAwait(false);
                }
                await WriteGeneratedFilesAsync(staging, bundle.Contract).ConfigureAwait(false);
                VerifyInstalled(bundle.Contract, staging);
                Directory.Move(staging, VersionDirectory);
            }
            finally
            {
                if (Directory.Exists(staging)) DeleteInstallerOwnedTree(staging);
            }
            VerifyInstalled(bundle.Contract);
        }

        private async Task WriteGeneratedFilesAsync(string directory, InstallerContract contract)
        {
            var configuration = JsonSerializer.Serialize(new
            {
                version = 1,
                extensionId = contract.ExtensionId,
                perfettoOrigin = contract.PerfettoOrigin,
                bridgePort = contract.BridgePort,
            }, JsonOptions()) + Environment.NewLine;
            var manifest = JsonSerializer.Serialize(new
            {
                name = NativeHostName,
                description = "RELU Perfetto Connector Native Host",
                path = Path.Combine(VersionDirectory, NativeHostExecutable),
                type = "stdio",
                allowed_origins = new[] {$"chrome-extension://{contract.ExtensionId}/"},
            }, JsonOptions()) + Environment.NewLine;
            await File.WriteAllTextAsync(Path.Combine(directory, NativeHostConfiguration), configuration,
                new UTF8Encoding(false)).ConfigureAwait(false);
            await File.WriteAllTextAsync(Path.Combine(directory, NativeHostManifest), manifest,
                new UTF8Encoding(false)).ConfigureAwait(false);
        }

        private void VerifyInstalled(InstallerContract contract, string? directory = null)
        {
            directory ??= VersionDirectory;
            EnsureNotReparsePoint(directory);
            var expected = contract.Files.Select(item => item.Path.Replace('/', Path.DirectorySeparatorChar))
                .Append(NativeHostConfiguration).Append(NativeHostManifest)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var actual = WalkTreeNoReparse(directory)
                .Where(path => !Directory.Exists(path))
                .Select(path => Path.GetRelativePath(directory, path)).ToArray();
            if (actual.Length != expected.Count || actual.Any(path => !expected.Contains(path)))
                throw new InvalidDataException("기존 설치 디렉터리 파일 집합이 계약과 다릅니다.");
            foreach (var file in contract.Files)
            {
                var target = ContainedPath(directory, file.Path);
                EnsureNotReparsePoint(target);
                var info = new FileInfo(target);
                if (!info.Exists || info.Length != file.Bytes || Sha256File(target) != file.Sha256)
                    throw new InvalidDataException("기존 설치 파일 checksum이 계약과 다릅니다.");
            }
            var expectedConfiguration = JsonSerializer.Serialize(new
            {
                version = 1,
                extensionId = contract.ExtensionId,
                perfettoOrigin = contract.PerfettoOrigin,
                bridgePort = contract.BridgePort,
            }, JsonOptions()) + Environment.NewLine;
            if (File.ReadAllText(Path.Combine(directory, NativeHostConfiguration)) != expectedConfiguration)
                throw new InvalidDataException("기존 Native Host 설정이 계약과 다릅니다.");
            var manifestPath = Path.Combine(directory, NativeHostManifest);
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
            var root = manifest.RootElement;
            if (root.GetProperty("name").GetString() != NativeHostName
                || root.GetProperty("path").GetString() != Path.Combine(VersionDirectory, NativeHostExecutable)
                || root.GetProperty("type").GetString() != "stdio"
                || root.GetProperty("allowed_origins").GetArrayLength() != 1
                || root.GetProperty("allowed_origins")[0].GetString() != $"chrome-extension://{contract.ExtensionId}/")
                throw new InvalidDataException("기존 Native Host manifest가 계약과 다릅니다.");
        }

        private static JsonSerializerOptions JsonOptions() => new() {WriteIndented = true};

        private static string ContainedPath(string root, string relative)
        {
            var target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            var prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("설치 파일 경로가 설치 루트 밖을 가리킵니다.");
            return target;
        }

        private static void EnsureDirectory(string directory)
        {
            var full = Path.GetFullPath(directory);
            var root = Path.GetPathRoot(full) ?? throw new InvalidDataException("설치 루트가 올바르지 않습니다.");
            var current = root;
            foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, part);
                if (!Directory.Exists(current)) Directory.CreateDirectory(current);
                EnsureNotReparsePoint(current);
            }
        }

        private static void EnsureNotReparsePoint(string path)
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("설치 경로에 symlink 또는 junction이 있습니다.");
        }

        private static void DeleteInstallerOwnedTree(string root)
        {
            EnsureNotReparsePoint(root);
            var entries = WalkTreeNoReparse(root)
                .OrderByDescending(path => path.Length).ToArray();
            foreach (var entry in entries)
            {
                EnsureNotReparsePoint(entry);
                if (Directory.Exists(entry)) Directory.Delete(entry);
                else File.Delete(entry);
            }
            Directory.Delete(root);
        }

        private static IEnumerable<string> WalkTreeNoReparse(string directory)
        {
            EnsureNotReparsePoint(directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(
                directory, "*", SearchOption.TopDirectoryOnly))
            {
                EnsureNotReparsePoint(entry);
                yield return entry;
                if (Directory.Exists(entry))
                {
                    foreach (var child in WalkTreeNoReparse(entry)) yield return child;
                }
            }
        }

        private static string Sha256File(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
    }

    [SupportedOSPlatform("windows")]
    internal static class NativeHostRegistration
    {
        internal sealed record Plan(bool ReplaceOwnedRegistration);

        internal static Plan Preflight(InstallLayout layout, InstallerContract contract)
        {
            using var key = Registry.CurrentUser.OpenSubKey(NativeHostRegistryPath, writable: false);
            var current = key?.GetValue(null) as string;
            if (current is null || PathsEqual(current, layout.NativeManifestPath)) return new(false);
            if (!IsOwnedRegistration(current, layout.Root, contract.ExtensionId))
                throw new InvalidOperationException("같은 이름의 다른 Chrome Native Host 등록이 있어 보존했습니다.");
            return new(true);
        }

        internal static void Apply(InstallLayout layout, InstallerContract contract, Plan expected)
        {
            var currentPlan = Preflight(layout, contract);
            if (currentPlan != expected) throw new InvalidOperationException("설치 중 Native Host 등록이 변경되었습니다.");
            using var key = Registry.CurrentUser.CreateSubKey(NativeHostRegistryPath, writable: true)
                ?? throw new InvalidOperationException("Chrome Native Host 레지스트리를 열 수 없습니다.");
            key.SetValue(null, layout.NativeManifestPath, RegistryValueKind.String);
        }

        private static bool IsOwnedRegistration(string manifestPath, string installRoot, string extensionId)
        {
            try
            {
                var fullManifest = Path.GetFullPath(manifestPath);
                var rootPrefix = Path.GetFullPath(installRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (!fullManifest.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)
                    || !File.Exists(fullManifest)
                    || (File.GetAttributes(fullManifest) & FileAttributes.ReparsePoint) != 0) return false;
                using var document = JsonDocument.Parse(File.ReadAllBytes(fullManifest));
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 5
                    || root.GetProperty("name").GetString() != NativeHostName
                    || root.GetProperty("type").GetString() != "stdio"
                    || root.GetProperty("allowed_origins").GetArrayLength() != 1
                    || root.GetProperty("allowed_origins")[0].GetString() != $"chrome-extension://{extensionId}/") return false;
                var executable = root.GetProperty("path").GetString();
                return executable is not null
                    && Path.GetFileName(executable) == NativeHostExecutable
                    && Path.GetFullPath(executable).StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool PathsEqual(string left, string right)
        {
            try { return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }
    }

    [SupportedOSPlatform("windows")]
    internal static class ChromeExtensionPolicy
    {
        internal sealed record Plan(bool NeedsUserPolicy, string? ValueName);

        internal static Plan Preflight(InstallerContract contract)
        {
            var centrallyManaged = false;
            foreach (var hive in new[] {Registry.LocalMachine, Registry.CurrentUser})
            {
                using var chrome = hive.OpenSubKey(ChromeExtensionSettingsRegistryPath, writable: false);
                if (chrome?.GetValue("ExtensionSettings") is string settings)
                {
                    centrallyManaged |= ValidateExtensionSettings(settings, contract);
                }
            }
            var existingPolicy = FindForcelistEntry(Registry.LocalMachine, contract);
            if (existingPolicy == ForcelistState.Conflict)
                throw new InvalidOperationException("컴퓨터 범위 Chrome 확장 정책과 충돌하여 기존 정책을 보존했습니다.");
            if (centrallyManaged || existingPolicy == ForcelistState.Exact) return new(false, null);

            using var userKey = Registry.CurrentUser.OpenSubKey(ChromeForcelistRegistryPath, writable: false);
            var firstFree = 1;
            if (userKey is not null)
            {
                foreach (var name in userKey.GetValueNames())
                {
                    if (userKey.GetValue(name) is not string value) continue;
                    var state = InspectForcelistValue(value, contract);
                    if (state == ForcelistState.Exact) return new(false, null);
                    if (state == ForcelistState.Conflict)
                        throw new InvalidOperationException("사용자 범위 Chrome 확장 정책과 충돌하여 기존 정책을 보존했습니다.");
                }
                var names = userKey.GetValueNames().ToHashSet(StringComparer.OrdinalIgnoreCase);
                while (names.Contains(firstFree.ToString())) firstFree++;
            }
            if (firstFree > 10_000) throw new InvalidOperationException("Chrome 확장 정책 목록에 빈 항목이 없습니다.");
            return new(true, firstFree.ToString(CultureInfo.InvariantCulture));
        }

        internal static void Apply(InstallerContract contract, Plan expected)
        {
            var current = Preflight(contract);
            if (current != expected) throw new InvalidOperationException("설치 중 Chrome 확장 정책이 변경되었습니다.");
            if (!expected.NeedsUserPolicy) return;
            using var key = Registry.CurrentUser.CreateSubKey(ChromeForcelistRegistryPath, writable: true)
                ?? throw new InvalidOperationException("Chrome 확장 정책 레지스트리를 열 수 없습니다.");
            key.SetValue(expected.ValueName!, $"{contract.ExtensionId};{contract.ExtensionUpdateUrl}", RegistryValueKind.String);
        }

        private static bool ValidateExtensionSettings(string json, InstallerContract contract)
        {
            try
            {
                using var document = JsonDocument.Parse(json, new JsonDocumentOptions
                {
                    AllowTrailingCommas = false,
                    CommentHandling = JsonCommentHandling.Disallow,
                    MaxDepth = 16,
                });
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new JsonException();
                if (!root.TryGetProperty(contract.ExtensionId, out var entry))
                {
                    throw new InvalidOperationException(
                        "기존 Chrome ExtensionSettings 정책이 로컬 자동 설치보다 우선하므로 회사 IT 정책에 Extension ID를 추가해야 합니다.");
                }
                if (entry.ValueKind != JsonValueKind.Object
                    || !entry.TryGetProperty("installation_mode", out var mode)
                    || mode.GetString() is not ("force_installed" or "normal_installed")
                    || !entry.TryGetProperty("update_url", out var update)
                    || update.GetString() != contract.ExtensionUpdateUrl)
                {
                    throw new InvalidOperationException("기존 Chrome ExtensionSettings의 RELU 항목과 충돌하여 정책을 보존했습니다.");
                }
                return true;
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch
            {
                throw new InvalidOperationException("기존 Chrome ExtensionSettings를 안전하게 확인할 수 없어 정책을 보존했습니다.");
            }
        }

        private static ForcelistState FindForcelistEntry(RegistryKey hive, InstallerContract contract)
        {
            using var key = hive.OpenSubKey(ChromeForcelistRegistryPath, writable: false);
            if (key is null) return ForcelistState.Missing;
            var found = ForcelistState.Missing;
            foreach (var name in key.GetValueNames())
            {
                if (key.GetValue(name) is not string value) continue;
                var current = InspectForcelistValue(value, contract);
                if (current == ForcelistState.Conflict) return current;
                if (current == ForcelistState.Exact) found = current;
            }
            return found;
        }

        private static ForcelistState InspectForcelistValue(string value, InstallerContract contract)
        {
            var separator = value.IndexOf(';');
            var id = separator < 0 ? value : value[..separator];
            if (!string.Equals(id, contract.ExtensionId, StringComparison.Ordinal)) return ForcelistState.Missing;
            return value == $"{contract.ExtensionId};{contract.ExtensionUpdateUrl}"
                ? ForcelistState.Exact : ForcelistState.Conflict;
        }

        private enum ForcelistState { Missing, Exact, Conflict }
    }

    [GeneratedRegex("^[a-p]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdPattern();
    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();
    [GeneratedRegex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionPattern();
}
