@echo off
setlocal enabledelayedexpansion
cd /d C:\Users\Jayden\flock-app\backend
set LOG=scripts\ml\go_chain.log
echo [CHAIN] start %date% %time% > %LOG%

echo [CHAIN] STAGE 0: waiting out the BestTime 403 block (probe every 10 min) >> %LOG%
set UNBLOCKED=0
for /l %%i in (1,1,72) do (
  if "!UNBLOCKED!"=="0" (
    node scripts/ml/collectWeekly.js --city=philly --only-found --limit=1 --max-credits=5 > scripts\ml\probe.log 2>&1
    findstr /C:"FATAL" scripts\ml\probe.log >nul 2>&1
    if errorlevel 1 (
      set UNBLOCKED=1
      echo [CHAIN] probe %%i succeeded, block lifted >> %LOG%
    ) else (
      echo [CHAIN] probe %%i still blocked >> %LOG%
      powershell -NoProfile -Command "Start-Sleep -Seconds 600"
    )
  )
)
if "!UNBLOCKED!"=="0" (echo [CHAIN] FATAL: still blocked after 12 hours of probes >> %LOG% & exit /b 1)

echo [CHAIN] STAGE 1: philly weekly refresh by id >> %LOG%
node scripts/ml/collectWeekly.js --city=philly --only-found >> %LOG% 2>&1
if errorlevel 1 (echo [CHAIN] FATAL at philly refresh >> %LOG% & exit /b 1)

echo [CHAIN] STAGE 2: lehigh weekly refresh by id >> %LOG%
node scripts/ml/collectWeekly.js --city=lehigh --only-found >> %LOG% 2>&1
if errorlevel 1 (echo [CHAIN] FATAL at lehigh refresh >> %LOG% & exit /b 1)

echo [CHAIN] STAGE 3: live pilot night one, full PA corpus >> %LOG%
node scripts/ml/collectRealtime.js >> %LOG% 2>&1
if errorlevel 1 (echo [CHAIN] FATAL at live pilot >> %LOG% & exit /b 1)

echo [CHAIN] STAGE 4: waiting for the Places daily quota window (03:20 local) >> %LOG%
powershell -NoProfile -Command "while ((Get-Date).Hour -lt 3 -or ((Get-Date).Hour -eq 3 -and (Get-Date).Minute -lt 20)) { Start-Sleep -Seconds 120 }"

echo [CHAIN] STAGE 5: staging the demand want-list (3 tries, 10 min apart) >> %LOG%
set STAGED=0
for %%i in (1 2 3) do (
  if "!STAGED!"=="0" (
    node scripts/ml/addDemandVenues.js --commit > scripts\ml\stage5.log 2>&1
    type scripts\ml\stage5.log >> %LOG%
    findstr /C:"Inserted 0." scripts\ml\stage5.log >nul 2>&1
    if errorlevel 1 (set STAGED=1) else (powershell -NoProfile -Command "Start-Sleep -Seconds 600")
  )
)

echo [CHAIN] STAGE 6: admitting new venues to BestTime by name >> %LOG%
node scripts/ml/collectWeekly.js --city=philly --skip-attempted >> %LOG% 2>&1
node scripts/ml/collectWeekly.js --city=lehigh --skip-attempted >> %LOG% 2>&1

echo [CHAIN] CHAIN_ALL_DONE %date% %time% >> %LOG%
