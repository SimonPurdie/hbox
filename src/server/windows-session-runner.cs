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

internal static partial class Program
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

}
