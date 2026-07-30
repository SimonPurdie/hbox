using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

internal static partial class Program
{
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
