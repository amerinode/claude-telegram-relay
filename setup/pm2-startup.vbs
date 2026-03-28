' PM2 Startup Script — Runs PM2 resurrect invisibly (no terminal window)
' Registered via Windows Task Scheduler to run at logon
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\nodejs\npx.cmd"" pm2 resurrect", 0, False
