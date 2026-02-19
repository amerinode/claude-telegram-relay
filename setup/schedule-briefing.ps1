# Schedule Morning Briefing — Windows Task Scheduler
# Runs Mon-Fri at 8:00 AM

$TaskName = "claude-morning-briefing"
$ProjectDir = "C:\Users\boasg\OneDrive - Renew Telecom LLC\Sites\claude-telegram-relay"
$BunPath = "C:\Users\boasg\.bun\bin\bun.exe"

# Remove existing task if any
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Create the action
$Action = New-ScheduledTaskAction `
    -Execute $BunPath `
    -Argument "run examples/morning-briefing.ts" `
    -WorkingDirectory $ProjectDir

# Create trigger: Mon-Fri at 8:00 AM
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 8:00AM

# Create settings
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Register the task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Ona morning briefing - sends daily summary via Telegram"

Write-Host ""
Write-Host "Morning briefing scheduled: Mon-Fri at 8:00 AM" -ForegroundColor Green
Write-Host "Task name: $TaskName"
Write-Host ""
Write-Host "Verify: Get-ScheduledTask -TaskName '$TaskName' | Format-List"
