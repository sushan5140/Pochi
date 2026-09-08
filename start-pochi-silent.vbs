' Launches start-pochi.bat with its console window fully hidden.
' Run via wscript.exe (the shortcut's target) -- wscript itself has no
' window of its own, and passing windowStyle 0 to WshShell.Run hides the
' batch file's cmd.exe window too, so no terminal ever becomes visible.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "start-pochi.bat")

' 0 = hidden window, False = don't wait for it to finish (Pochi keeps running)
shell.Run """" & batPath & """", 0, False
