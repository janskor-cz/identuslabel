-- Enterprise Cloud Agent Database Initialization Script
-- Creates custom database user and required databases for department multitenancy

-- Create custom database user for Cloud Agent
-- SECURITY: Using secure random password. Set ENTERPRISE_DB_PASSWORD environment variable.
CREATE USER identus_enterprise WITH PASSWORD '71e430bef6ab371e52b1ef4735eeff82010d11d50710185438343d39825e16bc';
-- Password required for external connections (via scram-sha-256 in pg_hba.conf)
-- Trust authentication used from Docker internal network (172.18.0.0/16)

-- Create application-specific users (required by Cloud Agent migrations)
CREATE USER "pollux-application-user" WITH PASSWORD 'dummy';
CREATE USER "connect-application-user" WITH PASSWORD 'dummy';
CREATE USER "agent-application-user" WITH PASSWORD 'dummy';

-- Grant necessary privileges
ALTER USER identus_enterprise WITH CREATEDB;

-- Create databases for Enterprise Cloud Agent
CREATE DATABASE pollux_enterprise OWNER identus_enterprise;
CREATE DATABASE connect_enterprise OWNER identus_enterprise;
CREATE DATABASE agent_enterprise OWNER identus_enterprise;
CREATE DATABASE node_enterprise OWNER identus_enterprise;

-- Grant all privileges on databases
GRANT ALL PRIVILEGES ON DATABASE pollux_enterprise TO identus_enterprise;
GRANT ALL PRIVILEGES ON DATABASE connect_enterprise TO identus_enterprise;
GRANT ALL PRIVILEGES ON DATABASE agent_enterprise TO identus_enterprise;
GRANT ALL PRIVILEGES ON DATABASE node_enterprise TO identus_enterprise;

-- Enable UUID extension in all databases
\c pollux_enterprise;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT ALL ON SCHEMA public TO identus_enterprise;

\c connect_enterprise;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT ALL ON SCHEMA public TO identus_enterprise;

\c agent_enterprise;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT ALL ON SCHEMA public TO identus_enterprise;

\c node_enterprise;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT ALL ON SCHEMA public TO identus_enterprise;
