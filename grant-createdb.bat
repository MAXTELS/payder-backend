@echo off
cd /d "%~dp0"
set PGPASSWORD=23102003
set PSQL="C:\Program Files\PostgreSQL\18\bin\psql.exe"
%PSQL% -U postgres -h localhost -p 5432 -c "ALTER ROLE payder CREATEDB;" > grant-result.txt 2>&1
echo EXITCODE=%errorlevel% >> grant-result.txt
echo done >> grant-result.txt
