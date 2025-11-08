-- Multitenancy Test Cloud Agent - PostgreSQL Database Initialization
-- Custom user: identus_multitenancy (NOT default postgres user)
-- Generated: 2025-11-08

-- Create custom database user
CREATE USER identus_multitenancy WITH PASSWORD 'Nza3a9SwAfmP#%7oTZ8$!X#0Ydzfb3TY';

-- Create application user required by Cloud Agent migrations
CREATE USER "pollux-application-user" WITH PASSWORD 'Nza3a9SwAfmP#%7oTZ8$!X#0Ydzfb3TY';
CREATE USER "connect-application-user" WITH PASSWORD 'Nza3a9SwAfmP#%7oTZ8$!X#0Ydzfb3TY';
CREATE USER "agent-application-user" WITH PASSWORD 'Nza3a9SwAfmP#%7oTZ8$!X#0Ydzfb3TY';

-- Create databases for Cloud Agent
CREATE DATABASE pollux_multitenancy OWNER identus_multitenancy;
CREATE DATABASE connect_multitenancy OWNER identus_multitenancy;
CREATE DATABASE agent_multitenancy OWNER identus_multitenancy;
CREATE DATABASE node_multitenancy OWNER identus_multitenancy;

-- Grant all privileges to custom user
GRANT ALL PRIVILEGES ON DATABASE pollux_multitenancy TO identus_multitenancy;
GRANT ALL PRIVILEGES ON DATABASE connect_multitenancy TO identus_multitenancy;
GRANT ALL PRIVILEGES ON DATABASE agent_multitenancy TO identus_multitenancy;
GRANT ALL PRIVILEGES ON DATABASE node_multitenancy TO identus_multitenancy;

-- Grant privileges to application users (required by Cloud Agent migrations)
GRANT ALL PRIVILEGES ON DATABASE pollux_multitenancy TO "pollux-application-user";
GRANT ALL PRIVILEGES ON DATABASE connect_multitenancy TO "connect-application-user";
GRANT ALL PRIVILEGES ON DATABASE agent_multitenancy TO "agent-application-user";

-- Security: Revoke public access
REVOKE ALL ON DATABASE pollux_multitenancy FROM PUBLIC;
REVOKE ALL ON DATABASE connect_multitenancy FROM PUBLIC;
REVOKE ALL ON DATABASE agent_multitenancy FROM PUBLIC;
REVOKE ALL ON DATABASE node_multitenancy FROM PUBLIC;
