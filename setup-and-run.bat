@echo off
cd /d "%~dp0"
echo ================================================
echo PAYDER backend setup
echo ================================================
echo.
echo --- Versions ---
node --version
call npm --version
where docker >nul 2>nul
if %errorlevel% neq 0 (
  echo Docker not found on PATH - will skip "docker compose up" below.
  echo Postgres/Redis will need to be reachable another way for migrate/start to work.
) else (
  docker --version
)
echo.

if not exist ".env" (
  echo Creating .env from .env.example ...
  copy .env.example .env >nul
)
echo.

where docker >nul 2>nul
if %errorlevel% equ 0 (
  echo --- Starting Postgres + Redis via docker compose ---
  docker compose up -d
  echo.
)

echo --- Installing npm dependencies ---
call npm install
echo.

echo --- Generating Prisma client ---
call npm run prisma:generate
echo.

echo --- Running prisma migrate (needs Postgres reachable) ---
call npm run prisma:migrate
echo.

echo --- Starting backend dev server (this window stays open - Ctrl+C to stop) ---
call npm run start:dev

echo.
echo Backend process exited.
pause
