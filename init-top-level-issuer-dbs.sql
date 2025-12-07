-- Initialize databases for top-level issuer Cloud Agent
CREATE DATABASE agent;
CREATE DATABASE connect;
CREATE DATABASE pollux;

-- Create application users (no password needed with trust authentication)
CREATE USER "pollux-application-user";
CREATE USER "connect-application-user";
CREATE USER "agent-application-user";

-- Grant all privileges
\c agent
GRANT ALL PRIVILEGES ON DATABASE agent TO "agent-application-user";
GRANT ALL PRIVILEGES ON SCHEMA public TO "agent-application-user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "agent-application-user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "agent-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "agent-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "agent-application-user";

\c connect
GRANT ALL PRIVILEGES ON DATABASE connect TO "connect-application-user";
GRANT ALL PRIVILEGES ON SCHEMA public TO "connect-application-user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "connect-application-user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "connect-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "connect-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "connect-application-user";

\c pollux
GRANT ALL PRIVILEGES ON DATABASE pollux TO "pollux-application-user";
GRANT ALL PRIVILEGES ON SCHEMA public TO "pollux-application-user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "pollux-application-user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "pollux-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "pollux-application-user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "pollux-application-user";
