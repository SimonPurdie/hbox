using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal sealed class RunnerConfig
{
    public string token { get; set; }
    public string cwd { get; set; }
    public string[] command { get; set; }
    public string[] stopCommand { get; set; }
}

internal sealed class RunnerIdentity
{
    public string token { get; set; }
    public int supervisorPid { get; set; }
    public long supervisorStarted { get; set; }
    public int rootPid { get; set; }
    public long rootStarted { get; set; }
    public string pipeName { get; set; }
}

internal sealed class ExitRecord
{
    public int exitCode { get; set; }
}

internal sealed class ControlRequest
{
    public string token { get; set; }
    public string action { get; set; }
}

internal sealed class ManagedProcess : IDisposable
{
    public IntPtr job;
    public IntPtr process;
    public int processId;
    public long started;

    public void Dispose()
    {
        if (process != IntPtr.Zero)
        {
            Native.CloseHandle(process);
            process = IntPtr.Zero;
        }
        if (job != IntPtr.Zero)
        {
            Native.CloseHandle(job);
            job = IntPtr.Zero;
        }
    }
}

internal static class Program
{
    private static readonly JavaScriptSerializer Json =
        new JavaScriptSerializer();
    private static readonly Regex TokenPattern = new Regex(
        "^[0-9a-f]{64}$",
        RegexOptions.CultureInvariant
    );

    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.Length == 2 && arguments[0] == "supervise")
            {
                return Supervise(arguments[1]);
            }
            if (arguments.Length == 2 && arguments[0] == "inspect")
            {
                return Inspect(arguments[1]);
            }
            if (
                arguments.Length == 3 &&
                arguments[0] == "stop" &&
                (arguments[1] == "graceful" || arguments[1] == "force")
            )
            {
                return Stop(arguments[2], arguments[1] == "force");
            }
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 70;
        }
    }

    private static int Supervise(string configPath)
    {
        string stateDirectory = Path.GetDirectoryName(
            Path.GetFullPath(configPath)
        );
        RunnerConfig config = ReadJson<RunnerConfig>(configPath);
        ValidateConfig(config);

        string errorPath = Path.Combine(stateDirectory, "start-error.txt");
        TryDelete(errorPath);
        TryDelete(Path.Combine(stateDirectory, "identity.json"));
        TryDelete(Path.Combine(stateDirectory, "exit.json"));

        ManagedProcess target = null;
        try
        {
            target = LaunchManaged(
                config.command,
                config.cwd,
                Path.Combine(stateDirectory, "output.log"),
                JobName(config.token)
            );

            RunnerIdentity identity = new RunnerIdentity();
            identity.token = config.token;
            using (Process current = Process.GetCurrentProcess())
            {
                identity.supervisorPid = current.Id;
                identity.supervisorStarted =
                    current.StartTime.ToUniversalTime().ToFileTimeUtc();
            }
            identity.rootPid = target.processId;
            identity.rootStarted = target.started;
            identity.pipeName = PipeName(config.token);
            WriteJsonAtomically(
                Path.Combine(stateDirectory, "identity.json"),
                identity
            );

            Supervisor supervisor = new Supervisor(
                config,
                stateDirectory,
                identity,
                target
            );
            supervisor.StartControlThread();

            Native.WaitForSingleObject(target.process, Native.INFINITE);
            uint exitCode;
            if (!Native.GetExitCodeProcess(target.process, out exitCode))
            {
                exitCode = UInt32.MaxValue;
            }
            supervisor.CloseStopProcess();
            target.Dispose();
            target = null;
            WriteJsonAtomically(
                Path.Combine(stateDirectory, "exit.json"),
                new ExitRecord { exitCode = unchecked((int)exitCode) }
            );
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            File.WriteAllText(errorPath, error.ToString() + Environment.NewLine);
            WriteJsonAtomically(
                Path.Combine(stateDirectory, "exit.json"),
                new ExitRecord { exitCode = 70 }
            );
            return 70;
        }
        finally
        {
            if (target != null)
            {
                target.Dispose();
            }
        }
    }

    private static int Inspect(string stateDirectory)
    {
        string exitPath = Path.Combine(stateDirectory, "exit.json");
        if (File.Exists(exitPath))
        {
            ExitRecord exit = ReadJson<ExitRecord>(exitPath);
            Console.WriteLine("exited\t" + exit.exitCode);
            return 0;
        }
        if (File.Exists(Path.Combine(stateDirectory, "start-error.txt")))
        {
            Console.WriteLine("disconnected\tstart_failed");
            return 0;
        }

        RunnerIdentity identity;
        if (!TryReadIdentity(stateDirectory, out identity))
        {
            Console.WriteLine("pending");
            return 0;
        }

        bool jobExists = JobExists(identity.token);
        if (!VerifyProcess(identity.supervisorPid, identity.supervisorStarted))
        {
            Console.WriteLine(
                jobExists
                    ? "disconnected\tidentity_mismatch"
                    : "missing"
            );
            return 0;
        }

        string response;
        if (!TryControl(identity, "inspect", out response))
        {
            Console.WriteLine(
                JobExists(identity.token)
                    ? "disconnected\trunner_unavailable"
                    : "missing"
            );
            return 0;
        }
        if (response == "alive")
        {
            if (!VerifyProcess(identity.rootPid, identity.rootStarted))
            {
                Console.WriteLine("disconnected\tidentity_mismatch");
            }
            else
            {
                Console.WriteLine("alive\t" + identity.rootPid);
            }
            return 0;
        }
        if (response == "missing")
        {
            Console.WriteLine("missing");
            return 0;
        }
        Console.WriteLine("disconnected\trunner_unavailable");
        return 0;
    }

    private static int Stop(string stateDirectory, bool force)
    {
        RunnerIdentity identity;
        if (!TryReadIdentity(stateDirectory, out identity))
        {
            return 3;
        }
        if (
            !VerifyProcess(identity.supervisorPid, identity.supervisorStarted) ||
            !VerifyProcess(identity.rootPid, identity.rootStarted) ||
            !JobExists(identity.token)
        )
        {
            return 3;
        }

        string response;
        if (
            !TryControl(
                identity,
                force ? "force" : "graceful",
                out response
            ) ||
            response != "ok"
        )
        {
            return 3;
        }
        Console.WriteLine("verified");
        return 0;
    }

    private static bool TryControl(
        RunnerIdentity identity,
        string action,
        out string response
    )
    {
        response = null;
        try
        {
            using (
                NamedPipeClientStream pipe = new NamedPipeClientStream(
                    ".",
                    identity.pipeName,
                    PipeDirection.InOut,
                    PipeOptions.None
                )
            )
            {
                pipe.Connect(1500);
                pipe.ReadMode = PipeTransmissionMode.Byte;
                using (
                    StreamReader reader = new StreamReader(
                        pipe,
                        Encoding.UTF8,
                        false,
                        1024,
                        true
                    )
                )
                using (
                    StreamWriter writer = new StreamWriter(
                        pipe,
                        new UTF8Encoding(false),
                        1024,
                        true
                    )
                )
                {
                    writer.AutoFlush = true;
                    writer.WriteLine(
                        Json.Serialize(
                            new ControlRequest
                            {
                                token = identity.token,
                                action = action,
                            }
                        )
                    );
                    response = reader.ReadLine();
                    return response != null;
                }
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool TryReadIdentity(
        string stateDirectory,
        out RunnerIdentity identity
    )
    {
        identity = null;
        try
        {
            identity = ReadJson<RunnerIdentity>(
                Path.Combine(stateDirectory, "identity.json")
            );
            return
                identity != null &&
                TokenPattern.IsMatch(identity.token ?? "") &&
                identity.supervisorPid > 0 &&
                identity.supervisorStarted > 0 &&
                identity.rootPid > 0 &&
                identity.rootStarted > 0 &&
                identity.pipeName == PipeName(identity.token);
        }
        catch
        {
            return false;
        }
    }

    private static bool VerifyProcess(int processId, long expectedStarted)
    {
        try
        {
            using (Process process = Process.GetProcessById(processId))
            {
                return
                    process.StartTime.ToUniversalTime().ToFileTimeUtc() ==
                    expectedStarted;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool JobExists(string token)
    {
        if (!TokenPattern.IsMatch(token ?? ""))
        {
            return false;
        }
        IntPtr job = Native.OpenJobObject(
            Native.JOB_OBJECT_QUERY,
            false,
            JobName(token)
        );
        if (job == IntPtr.Zero)
        {
            return false;
        }
        Native.CloseHandle(job);
        return true;
    }

    private static ManagedProcess LaunchManaged(
        string[] command,
        string cwd,
        string outputPath,
        string jobName
    )
    {
        ResolvedCommand resolved = ResolveCommand(command, cwd);
        IntPtr job = Native.CreateJobObject(IntPtr.Zero, jobName);
        if (job == IntPtr.Zero)
        {
            throw Native.LastError("Could not create the Session Job Object");
        }
        try
        {
            Native.SetKillOnClose(job);
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
            IntPtr output = Native.OpenInheritedOutput(outputPath);
            IntPtr input = Native.OpenInheritedInput();
            try
            {
                Native.STARTUPINFO startup = new Native.STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
                startup.dwFlags =
                    Native.STARTF_USESHOWWINDOW |
                    Native.STARTF_USESTDHANDLES;
                startup.wShowWindow = Native.SW_HIDE;
                startup.hStdInput = input;
                startup.hStdOutput = output;
                startup.hStdError = output;

                Native.PROCESS_INFORMATION process;
                StringBuilder commandLine = new StringBuilder(
                    resolved.commandLine
                );
                bool created = Native.CreateProcess(
                    resolved.application,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    Native.CREATE_SUSPENDED |
                        Native.CREATE_NEW_CONSOLE |
                        Native.CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero,
                    cwd,
                    ref startup,
                    out process
                );
                if (!created)
                {
                    throw Native.LastError(
                        "Could not start " + command[0]
                    );
                }

                try
                {
                    if (!Native.AssignProcessToJobObject(job, process.hProcess))
                    {
                        throw Native.LastError(
                            "Could not assign the process to its Session Job"
                        );
                    }
                    long started = Native.ProcessCreationTime(process.hProcess);
                    if (Native.ResumeThread(process.hThread) == UInt32.MaxValue)
                    {
                        throw Native.LastError(
                            "Could not resume the Session process"
                        );
                    }
                    Native.CloseHandle(process.hThread);
                    process.hThread = IntPtr.Zero;
                    return new ManagedProcess
                    {
                        job = job,
                        process = process.hProcess,
                        processId = unchecked((int)process.dwProcessId),
                        started = started,
                    };
                }
                catch
                {
                    Native.TerminateProcess(process.hProcess, 70);
                    if (process.hThread != IntPtr.Zero)
                    {
                        Native.CloseHandle(process.hThread);
                    }
                    Native.CloseHandle(process.hProcess);
                    throw;
                }
            }
            finally
            {
                Native.CloseHandle(input);
                Native.CloseHandle(output);
            }
        }
        catch
        {
            Native.CloseHandle(job);
            throw;
        }
    }

    private static ResolvedCommand ResolveCommand(
        string[] command,
        string cwd
    )
    {
        if (
            command == null ||
            command.Length == 0 ||
            String.IsNullOrWhiteSpace(command[0])
        )
        {
            throw new InvalidOperationException(
                "The Session command is empty."
            );
        }

        string executable = FindExecutable(command[0], cwd);
        if (executable == null)
        {
            throw new FileNotFoundException(
                "Could not resolve the Session command: " + command[0]
            );
        }

        string extension = Path.GetExtension(executable);
        if (
            extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase) ||
            extension.Equals(".bat", StringComparison.OrdinalIgnoreCase)
        )
        {
            string commandProcessor =
                Environment.GetEnvironmentVariable("ComSpec") ??
                Path.Combine(
                    Environment.GetFolderPath(
                        Environment.SpecialFolder.System
                    ),
                    "cmd.exe"
                );
            string payload = BuildCmdPayload(executable, command);
            return new ResolvedCommand
            {
                application = commandProcessor,
                commandLine =
                    QuoteWindowsArgument(commandProcessor) +
                    " /d /s /c \"" +
                    payload +
                    "\"",
            };
        }

        string[] arguments = new string[command.Length];
        arguments[0] = executable;
        Array.Copy(command, 1, arguments, 1, command.Length - 1);
        return new ResolvedCommand
        {
            application = executable,
            commandLine = BuildWindowsCommandLine(arguments),
        };
    }

    private static string FindExecutable(string value, string cwd)
    {
        bool hasDirectory =
            Path.IsPathRooted(value) ||
            value.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
            value.IndexOf(Path.AltDirectorySeparatorChar) >= 0;
        List<string> roots = new List<string>();
        if (hasDirectory)
        {
            roots.Add(
                Path.IsPathRooted(value)
                    ? value
                    : Path.GetFullPath(Path.Combine(cwd, value))
            );
        }
        else
        {
            roots.Add(Path.Combine(cwd, value));
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (
                string directory in pathValue.Split(
                    new[] { Path.PathSeparator },
                    StringSplitOptions.RemoveEmptyEntries
                )
            )
            {
                string trimmed = directory.Trim().Trim('"');
                if (trimmed.Length > 0)
                {
                    roots.Add(Path.Combine(trimmed, value));
                }
            }
        }

        string pathExtensions =
            Environment.GetEnvironmentVariable("PATHEXT") ??
            ".COM;.EXE;.BAT;.CMD";
        string[] extensions = pathExtensions.Split(
            new[] { ';' },
            StringSplitOptions.RemoveEmptyEntries
        );
        foreach (string root in roots)
        {
            if (Path.HasExtension(root))
            {
                if (File.Exists(root))
                {
                    return Path.GetFullPath(root);
                }
                continue;
            }
            foreach (string extension in extensions)
            {
                string candidate = root + extension.Trim();
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            if (File.Exists(root))
            {
                return Path.GetFullPath(root);
            }
        }
        return null;
    }

    private static string BuildCmdPayload(
        string executable,
        string[] command
    )
    {
        StringBuilder result = new StringBuilder();
        result.Append(QuoteCmdArgument(executable));
        for (int index = 1; index < command.Length; index += 1)
        {
            result.Append(' ');
            result.Append(QuoteCmdArgument(command[index]));
        }
        return result.ToString();
    }

    private static string QuoteCmdArgument(string value)
    {
        return "\"" +
            value
                .Replace("%", "%%")
                .Replace("\"", "\\\"") +
            "\"";
    }

    private static string BuildWindowsCommandLine(string[] values)
    {
        string[] quoted = new string[values.Length];
        for (int index = 0; index < values.Length; index += 1)
        {
            quoted[index] = QuoteWindowsArgument(values[index]);
        }
        return String.Join(" ", quoted);
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (
            value.Length > 0 &&
            value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) == -1
        )
        {
            return value;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static T ReadJson<T>(string path)
    {
        return Json.Deserialize<T>(File.ReadAllText(path, Encoding.UTF8));
    }

    private static void WriteJsonAtomically(string path, object value)
    {
        string temporary = path +
            "." +
            Process.GetCurrentProcess().Id +
            "." +
            Guid.NewGuid().ToString("N") +
            ".tmp";
        File.WriteAllText(
            temporary,
            Json.Serialize(value) + Environment.NewLine,
            new UTF8Encoding(false)
        );
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        File.Move(temporary, path);
    }

    private static void ValidateConfig(RunnerConfig config)
    {
        if (
            config == null ||
            !TokenPattern.IsMatch(config.token ?? "") ||
            String.IsNullOrWhiteSpace(config.cwd) ||
            !Directory.Exists(config.cwd) ||
            !IsCommand(config.command) ||
            (config.stopCommand != null && !IsCommand(config.stopCommand))
        )
        {
            throw new InvalidDataException(
                "The Windows Session configuration is invalid."
            );
        }
    }

    private static bool IsCommand(string[] command)
    {
        if (command == null || command.Length == 0)
        {
            return false;
        }
        foreach (string part in command)
        {
            if (String.IsNullOrEmpty(part))
            {
                return false;
            }
        }
        return true;
    }

    private static string JobName(string token)
    {
        return "Local\\HBOX.Session." + token;
    }

    private static string StopJobName(string token)
    {
        return "Local\\HBOX.SessionStop." + token;
    }

    private static string PipeName(string token)
    {
        return "HBOX.Session." + token;
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // A later identity check will expose stale state.
        }
    }

    private sealed class ResolvedCommand
    {
        public string application;
        public string commandLine;
    }

    private sealed class Supervisor
    {
        private readonly RunnerConfig config;
        private readonly string stateDirectory;
        private readonly RunnerIdentity identity;
        private readonly ManagedProcess target;
        private readonly object stopLock = new object();
        private ManagedProcess stopProcess;

        internal Supervisor(
            RunnerConfig config,
            string stateDirectory,
            RunnerIdentity identity,
            ManagedProcess target
        )
        {
            this.config = config;
            this.stateDirectory = stateDirectory;
            this.identity = identity;
            this.target = target;
        }

        internal void StartControlThread()
        {
            Thread thread = new Thread(ControlLoop);
            thread.IsBackground = true;
            thread.Name = "HBOX Session control";
            thread.Start();
        }

        internal void CloseStopProcess()
        {
            lock (stopLock)
            {
                if (stopProcess != null)
                {
                    Native.TerminateJobObject(stopProcess.job, 1);
                    stopProcess.Dispose();
                    stopProcess = null;
                }
            }
        }

        private void ControlLoop()
        {
            while (true)
            {
                try
                {
                    using (
                        NamedPipeServerStream pipe =
                            new NamedPipeServerStream(
                                identity.pipeName,
                                PipeDirection.InOut,
                                1,
                                PipeTransmissionMode.Byte,
                                PipeOptions.None
                            )
                    )
                    {
                        pipe.WaitForConnection();
                        HandleControl(pipe);
                    }
                }
                catch
                {
                    Thread.Sleep(50);
                }
            }
        }

        private void HandleControl(Stream pipe)
        {
            using (
                StreamReader reader = new StreamReader(
                    pipe,
                    Encoding.UTF8,
                    false,
                    1024,
                    true
                )
            )
            using (
                StreamWriter writer = new StreamWriter(
                    pipe,
                    new UTF8Encoding(false),
                    1024,
                    true
                )
            )
            {
                writer.AutoFlush = true;
                ControlRequest request;
                try
                {
                    request = Json.Deserialize<ControlRequest>(
                        reader.ReadLine()
                    );
                }
                catch
                {
                    writer.WriteLine("invalid");
                    return;
                }
                if (
                    request == null ||
                    request.token != config.token ||
                    String.IsNullOrEmpty(request.action)
                )
                {
                    writer.WriteLine("invalid");
                    return;
                }

                bool alive =
                    Native.WaitForSingleObject(target.process, 0) ==
                    Native.WAIT_TIMEOUT;
                if (request.action == "inspect")
                {
                    writer.WriteLine(alive ? "alive" : "missing");
                    return;
                }
                if (!alive)
                {
                    writer.WriteLine("missing");
                    return;
                }
                if (request.action == "force")
                {
                    writer.WriteLine("ok");
                    CloseStopProcess();
                    Native.TerminateJobObject(target.job, 1);
                    return;
                }
                if (request.action == "graceful")
                {
                    writer.WriteLine("ok");
                    RequestGracefulStop();
                    return;
                }
                writer.WriteLine("invalid");
            }
        }

        private void RequestGracefulStop()
        {
            if (config.stopCommand != null)
            {
                lock (stopLock)
                {
                    if (stopProcess != null)
                    {
                        return;
                    }
                    try
                    {
                        stopProcess = LaunchManaged(
                            config.stopCommand,
                            config.cwd,
                            Path.Combine(
                                stateDirectory,
                                "stop-output.log"
                            ),
                            StopJobName(config.token)
                        );
                        return;
                    }
                    catch
                    {
                        // Fall back to the native console signal.
                    }
                }
            }
            Native.SendCtrlBreak(unchecked((uint)target.processId));
        }
    }
}

internal static class Native
{
    internal const uint CREATE_SUSPENDED = 0x00000004;
    internal const uint CREATE_NEW_CONSOLE = 0x00000010;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    internal const uint STARTF_USESHOWWINDOW = 0x00000001;
    internal const uint STARTF_USESTDHANDLES = 0x00000100;
    internal const short SW_HIDE = 0;
    internal const uint INFINITE = 0xffffffff;
    internal const uint WAIT_TIMEOUT = 258;
    internal const uint JOB_OBJECT_QUERY = 0x0004;

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint FILE_APPEND_DATA = 0x00000004;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint OPEN_ALWAYS = 4;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint CTRL_BREAK_EVENT = 1;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private static readonly ConsoleControlHandler IgnoreConsoleControl =
        delegate(uint controlType) { return true; };

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool ConsoleControlHandler(uint controlType);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO
    {
        internal int cb;
        internal string lpReserved;
        internal string lpDesktop;
        internal string lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal short wShowWindow;
        internal short cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        internal bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr OpenJobObject(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        string name
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(
        IntPtr job,
        uint exitCode
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(
        IntPtr handle,
        uint milliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(
        IntPtr process,
        out uint exitCode
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out long creationTime,
        out long exitTime,
        out long kernelTime,
        out long userTime
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleCtrlHandler(
        ConsoleControlHandler handlerRoutine,
        [MarshalAs(UnmanagedType.Bool)] bool add
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GenerateConsoleCtrlEvent(
        uint controlEvent,
        uint processGroupId
    );

    internal static void SetKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(
            typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
        );
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (
                !SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    buffer,
                    unchecked((uint)size)
                )
            )
            {
                throw LastError("Could not configure the Session Job Object");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    internal static long ProcessCreationTime(IntPtr process)
    {
        long creation;
        long exit;
        long kernel;
        long user;
        if (
            !GetProcessTimes(
                process,
                out creation,
                out exit,
                out kernel,
                out user
            )
        )
        {
            throw LastError("Could not read the process creation time");
        }
        return creation;
    }

    internal static IntPtr OpenInheritedOutput(string path)
    {
        SECURITY_ATTRIBUTES attributes = InheritedAttributes();
        IntPtr handle = CreateFile(
            path,
            FILE_APPEND_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ref attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero
        );
        if (handle == InvalidHandle)
        {
            throw LastError("Could not open the Session output log");
        }
        return handle;
    }

    internal static IntPtr OpenInheritedInput()
    {
        SECURITY_ATTRIBUTES attributes = InheritedAttributes();
        IntPtr handle = CreateFile(
            "NUL",
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ref attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero
        );
        if (handle == InvalidHandle)
        {
            throw LastError("Could not open the null input device");
        }
        return handle;
    }

    internal static void SendCtrlBreak(uint rootProcessId)
    {
        FreeConsole();
        if (!AttachConsole(rootProcessId))
        {
            return;
        }
        try
        {
            SetConsoleCtrlHandler(IgnoreConsoleControl, true);
            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
            Thread.Sleep(100);
        }
        finally
        {
            FreeConsole();
            SetConsoleCtrlHandler(IgnoreConsoleControl, false);
        }
    }

    internal static Exception LastError(string message)
    {
        int errorCode = Marshal.GetLastWin32Error();
        return new System.ComponentModel.Win32Exception(
            errorCode,
            message + " (Windows error " + errorCode + ")"
        );
    }

    private static SECURITY_ATTRIBUTES InheritedAttributes()
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        return attributes;
    }
}
