using System;

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

