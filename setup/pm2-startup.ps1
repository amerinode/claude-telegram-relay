$action = New-ScheduledTaskAction -Execute 'C:\Users\boasg\AppData\Roaming\npm\pm2.cmd' -Argument 'resurrect'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'PM2 Startup' -Action $action -Trigger $trigger -Settings $settings -Description 'Start PM2 processes on login' -Force
