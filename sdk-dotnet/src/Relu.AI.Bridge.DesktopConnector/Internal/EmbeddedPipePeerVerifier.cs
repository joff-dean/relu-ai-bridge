using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Relu.AI.Bridge.DesktopConnector.Internal;

/// <summary>
/// On Windows, CurrentUserOnly is supplemented with an exact executable-image check. The GUI
/// host and its stdio MCP child are two modes of the same signed EndViewer executable.
/// </summary>
internal static class EmbeddedPipePeerVerifier
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int MaximumWindowsPathLength = 32_767;

    internal static void VerifyClient(NamedPipeServerStream pipe)
    {
        ArgumentNullException.ThrowIfNull(pipe);
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var processId))
        {
            throw VerificationFailure();
        }
        VerifyProcessImage(processId);
    }

    internal static void VerifyServer(NamedPipeClientStream pipe)
    {
        ArgumentNullException.ThrowIfNull(pipe);
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var processId))
        {
            throw VerificationFailure();
        }
        VerifyProcessImage(processId);
    }

    private static void VerifyProcessImage(uint processId)
    {
        var expectedPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(expectedPath) || processId == 0)
        {
            throw VerificationFailure();
        }

        using var process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process.IsInvalid)
        {
            throw VerificationFailure();
        }
        var capacity = MaximumWindowsPathLength;
        var path = new StringBuilder(capacity);
        if (!QueryFullProcessImageName(process, 0, path, ref capacity) || capacity == 0)
        {
            throw VerificationFailure();
        }

        string expected;
        string actual;
        try
        {
            expected = Canonicalize(expectedPath);
            actual = Canonicalize(path.ToString(0, capacity));
        }
        catch (Exception exception) when (exception is ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            throw VerificationFailure();
        }
        if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
        {
            throw VerificationFailure();
        }
    }

    private static string Canonicalize(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (fullPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
        {
            fullPath = @"\\" + fullPath[8..];
        }
        else if (fullPath.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
        {
            fullPath = fullPath[4..];
        }
        return fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static IOException VerificationFailure() =>
        new("Named-pipe peer executable verification failed.");

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(
        SafePipeHandle pipe,
        out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(
        SafePipeHandle pipe,
        out uint serverProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        SafeProcessHandle process,
        uint flags,
        StringBuilder executableName,
        ref int size);
}
