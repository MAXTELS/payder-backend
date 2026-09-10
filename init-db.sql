-- Creates the payder role and database used by backend/.env.example's
-- DATABASE_URL (postgresql://payder:payder@localhost:5432/payder).
-- Safe to re-run: skips creation if the role/database already exist.

DO
$$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'payder') THEN
      CREATE ROLE payder WITH LOGIN PASSWORD 'payder';
   END IF;
END
$$;

SELECT 'CREATE DATABASE payder OWNER payder'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'payder')\gexec

GRANT ALL PRIVILEGES ON DATABASE payder TO payder;
