@echo off
cd /d "%~dp0"
echo ================================================
echo PAYDER database setup (native PostgreSQL)
echo ================================================
echo.
echo Creating the "payder" role and database (matches DATABASE_URL in .env)...
echo.

set PGPASSWORD=23102003
set PSQL="C:\Program Files\PostgreSQL\18\bin\psql.exe"

%PSQL% -U postgres -h localhost -p 5432 -f "init-db.sql"

if %errorlevel% neq 0 (
  echo.
  echo Something went wrong. Common causes:
  echo  - Wrong postgres password
  echo  - PostgreSQL service not running yet ^(wait a few seconds after install and retry^)
  pause
  exit /b 1
)

echo.
echo Done. The "payder" role and database are ready.
echo Next: run setup-and-run.bat to install deps, generate Prisma client, migrate, and start the backend.
pause
