using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class LaunchDefinition
{
    public string command { get; set; }
    public string[] args { get; set; }
}

internal static class Program
{
    private static readonly Regex TicketPattern = new Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [STAThread]
    private static int Main(string[] arguments)
    {
        Uri activationUri;
        if (
            arguments.Length != 1 ||
            !Uri.TryCreate(arguments[0], UriKind.Absolute, out activationUri) ||
            !activationUri.Scheme.Equals(
                "hbox-launch",
                StringComparison.OrdinalIgnoreCase
            ) ||
            !activationUri.Host.Equals(
                "launch",
                StringComparison.OrdinalIgnoreCase
            )
        )
        {
            return 2;
        }

        string ticket = activationUri.AbsolutePath.Trim('/');
        if (!TicketPattern.IsMatch(ticket))
        {
            return 2;
        }

        LaunchDefinition launch;
        try
        {
            string endpoint =
                "http://127.0.0.1:4269/api/native-launch/" + ticket;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = "GET";
            request.Proxy = null;
            request.Timeout = 3000;
            request.ReadWriteTimeout = 3000;
            request.Headers.Add("X-HBOX-Native-Launcher", "1");

            using (WebResponse response = request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream))
            {
                string json = reader.ReadToEnd();
                launch = new JavaScriptSerializer()
                    .Deserialize<LaunchDefinition>(json);
            }
        }
        catch
        {
            return 1;
        }

        if (!IsAllowedLaunch(launch))
        {
            return 2;
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = launch.command;
            startInfo.Arguments = BuildCommandLine(launch.args);
            startInfo.UseShellExecute = false;

            Process process = Process.Start(startInfo);
            if (process == null)
            {
                return 1;
            }

            AllowSetForegroundWindow((uint)process.Id);
            try
            {
                process.WaitForInputIdle(2000);
                process.Refresh();
                if (process.MainWindowHandle != IntPtr.Zero)
                {
                    SetForegroundWindow(process.MainWindowHandle);
                }
            }
            catch
            {
                // Explorer and Terminal can pass work to an existing process.
            }
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static bool IsAllowedLaunch(LaunchDefinition launch)
    {
        if (
            launch == null ||
            launch.command == null ||
            (
                !launch.command.Equals(
                    "explorer.exe",
                    StringComparison.OrdinalIgnoreCase
                ) &&
                !launch.command.Equals(
                    "wt.exe",
                    StringComparison.OrdinalIgnoreCase
                )
            ) ||
            launch.args == null
        )
        {
            return false;
        }

        foreach (string argument in launch.args)
        {
            if (argument == null)
            {
                return false;
            }
        }
        return true;
    }

    private static string BuildCommandLine(string[] arguments)
    {
        string[] quoted = new string[arguments.Length];
        for (int index = 0; index < arguments.Length; index += 1)
        {
            quoted[index] = QuoteArgument(arguments[index]);
        }
        return string.Join(" ", quoted);
    }

    private static string QuoteArgument(string argument)
    {
        if (
            argument.Length > 0 &&
            argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) == -1
        )
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
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
}
