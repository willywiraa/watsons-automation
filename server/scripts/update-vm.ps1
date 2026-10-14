# Updates the hosted WatsonsTester on the VM to the latest version in Git, in one go:
# stops the service, gets the new files (git pull), starts the service again and checks it.
# Run it in an administrator PowerShell on the VM:
#   powershell -ExecutionPolicy Bypass -File C:\WatsonsAutomation\app\server\scripts\update-vm.ps1
# (docs/server-deployment.md, "Updating the app"; set up with Git as in that section.)

$app = 'C:\WatsonsAutomation\app'
$nssm = 'C:\WatsonsAutomation\nssm.exe'
Set-Location $app

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
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 15
  Write-Host "The service is up: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Host 'The service did not answer: look in C:\WatsonsAutomation\logs\service.log' -ForegroundColor Red
}
Write-Host "Running now: $(git log -1 --format='%h %s (%cr)')"
