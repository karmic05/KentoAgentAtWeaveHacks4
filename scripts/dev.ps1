# Starts the hive API (port 8010) and the dashboard (port 3000) in two windows.
# Uses ./.venv or ../venv when present, otherwise the python on PATH.
$root = Split-Path -Parent $PSScriptRoot
$python = @("$root\.venv\Scripts\python.exe", "$root\..\venv\Scripts\python.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $python) { $python = "python" }

$env:PYTHONUTF8 = "1"
Start-Process powershell -WorkingDirectory $root -ArgumentList "-NoExit", "-Command", "& '$python' -m uvicorn api_server:app --port 8010"
Start-Process powershell -WorkingDirectory $root -ArgumentList "-NoExit", "-Command", "npm run dev"
Write-Host "API      http://localhost:8010/docs"
Write-Host "Dashboard http://localhost:3000"
