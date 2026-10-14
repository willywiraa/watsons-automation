#Requires -RunAsAdministrator
# Updates the hosted WatsonsTester on the VM to the latest version in Git, in one go:
# stops the service, gets the new files (git pull), starts the service again and checks that the
# server answering now is the one just started.
# Run it in an administrator PowerShell on the VM (right-click Windows PowerShell -> Run as
# administrator; without that, Windows doesn't let it stop the service):
#   powershell -ExecutionPolicy Bypass -File C:\WatsonsAutomation\app\server\scripts\update-vm.ps1
# (docs/server-deployment.md, "Updating the app"; set up with Git as in that section.)

$app = 'C:\WatsonsAutomation\app'
$nssm = 'C:\WatsonsAutomation\nssm.exe'
$port = 3000
Set-Location $app

$updateStarted = Get-Date
$before = (git rev-parse HEAD)
Write-Host "Running now: $(git log -1 --format='%h %s')"

& $nssm stop WatsonsTester
try {
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'git pull did not work, so nothing was changed. "git status" shows files edited on the VM itself.' -ForegroundColor Red
  } else {
    $changed = @(git diff --name-only $before HEAD)
    if ($changed.Count -eq 0) {
      Write-Host 'Already up to date.'
    } else {
      Write-Host "$($changed.Count) file(s) updated."
      if ($changed -match 'package(-lock)?\.json$') {
        Write-Host 'The packages changed: run "npm install" in C:\WatsonsAutomation\app and in C:\WatsonsAutomation\app\server, then run this script again.' -ForegroundColor Yellow
      }
    }
  }
} finally {
  & $nssm start WatsonsTester
}

Start-Sleep -Seconds 5
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 15
  # Whatever answers must have started just now. An older program means the new files are not in
  # use: the service didn't restart, or another copy of the server holds the port (seen
  # 2026-10-14: the new page with the old rules).
  $old = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
      Where-Object { $_.StartTime -lt $updateStarted })
  if ($old.Count -gt 0) {
    foreach ($process in $old) {
      Write-Host "An OLD server is still answering: $($process.ProcessName) $($process.Id), started $($process.StartTime). The new version is NOT in use." -ForegroundColor Red
    }
    Write-Host "Stop it and start the service again, then run this script once more:" -ForegroundColor Red
    Write-Host "  Stop-Process -Id $(($old | ForEach-Object Id) -join ',') -Force; & $nssm restart WatsonsTester" -ForegroundColor Red
  } else {
    Write-Host "The service is up, started just now: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
  }
} catch {
  Write-Host 'The service did not answer: look in C:\WatsonsAutomation\logs\service.log' -ForegroundColor Red
}
Write-Host "Running now: $(git log -1 --format='%h %s (%cr)')"
