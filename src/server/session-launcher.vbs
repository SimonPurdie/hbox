Option Explicit

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 64
End If

Dim shell
Dim commandLine
Dim encodedCommandLine
Dim index

encodedCommandLine = WScript.Arguments.Item(0)
commandLine = ""
For index = 1 To Len(encodedCommandLine) Step 4
  commandLine = commandLine & ChrW(CLng("&H" & Mid(encodedCommandLine, index, 4)))
Next
Set shell = CreateObject("WScript.Shell")
shell.Run commandLine, 0, False
