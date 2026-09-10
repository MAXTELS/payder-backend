@echo off
cd /d "%~dp0"
set PGPASSWORD=23102003
set PSQL="C:\Program Files\PostgreSQL\18\bin\psql.exe"
%PSQL% -U postgres -h localhost -p 5432 -t -c "SELECT 'role_exists=' || EXISTS(SELECT 1 FROM pg_roles WHERE rolname='payder');" > verify-result.txt 2>&1
%PSQL% -U postgres -h localhost -p 5432 -t -c "SELECT 'db_exists=' || EXISTS(SELECT 1 FROM pg_database WHERE datname='payder');" >> verify-result.txt 2>&1
echo done >> verify-result.txt
