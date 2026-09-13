@echo off
cd /d "%~dp0"
echo Applying the 2026-09-13 feature-batch migration (WALLET_TRANSFER type,
echo users.activeMobileDeviceId/tokenVersion, wallets.walletId,
echo admin_notification_settings table)...
call npx prisma migrate dev
if errorlevel 1 goto :error
call npx prisma generate
if errorlevel 1 goto :error
echo.
echo Done — migration applied and Prisma client regenerated.
pause
goto :eof

:error
echo.
echo Something failed above — scroll up for the error. Nothing further was run.
pause
