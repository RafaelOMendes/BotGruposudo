' Inicia o bot sem abrir janela (usado pelo atalho em shell:startup).
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & pasta & "\start.cmd""", 0, False
