using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static partial class Program
{
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

}
