using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

internal static partial class Program
{
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

    private sealed class ResolvedCommand
    {
        public string application;
        public string commandLine;
    }

}
