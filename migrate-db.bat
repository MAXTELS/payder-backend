@echo off
cd /d "%~dp0"
echo ================================================
echo PAYDER Prisma migration
echo ================================================
echo.
set DATABASE_URL=postgresql://payder:payder@localhost:5432/payder?schema=public
call npx prisma migrate dev --name init > migrate-result.txt 2>&1
echo EXITCODE=%errorlevel% >> migrate-result.txt
echo done >> migrate-result.txt
