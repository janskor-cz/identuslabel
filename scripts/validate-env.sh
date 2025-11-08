#!/bin/bash

# Hyperledger Identus SSI Infrastructure - Environment Validation Script
# Validates that all required environment variables are set

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Environment Configuration Validation${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}✗ .env file not found!${NC}"
    echo ""
    echo -e "${YELLOW}Please create .env file from template:${NC}"
    echo "  cp .env.example .env"
    echo "  nano .env  # Edit with your values"
    echo ""
    exit 1
fi

# Load .env file
set -a
source .env
set +a

echo -e "${BLUE}=== Required Environment Variables ===${NC}"
echo ""

# Function to check required variable
check_required() {
    local var_name="$1"
    local var_value="${!var_name}"
    local example_value="$2"

    echo -n "Checking $var_name... "

    if [ -z "$var_value" ]; then
        echo -e "${RED}✗ NOT SET${NC}"
        return 1
    elif [ "$var_value" = "$example_value" ]; then
        echo -e "${YELLOW}⚠ USING EXAMPLE VALUE${NC}"
        return 2
    else
        echo -e "${GREEN}✓ SET${NC}"
        return 0
    fi
}

# Function to check optional variable
check_optional() {
    local var_name="$1"
    local var_value="${!var_name}"
    local default_value="$2"

    echo -n "Checking $var_name... "

    if [ -z "$var_value" ]; then
        echo -e "${YELLOW}⚠ NOT SET (will use default: $default_value)${NC}"
        return 1
    else
        echo -e "${GREEN}✓ SET${NC}"
        return 0
    fi
}

missing_vars=0
example_vars=0
optional_missing=0

echo -e "${BLUE}--- Server Configuration ---${NC}"
check_required "SERVER_IP" "91.99.4.54" || ((missing_vars++))
check_required "SERVER_DOMAIN" "identuslabel.cz" || ((missing_vars++))

echo ""
echo -e "${BLUE}--- Cloud Agent Configuration ---${NC}"
check_required "CLOUD_AGENT_ADMIN_TOKEN" "your-secure-admin-token-here"
result=$?
if [ $result -eq 1 ]; then ((missing_vars++)); elif [ $result -eq 2 ]; then ((example_vars++)); fi

check_required "TOP_LEVEL_ISSUER_ADMIN_TOKEN" "your-secure-top-level-token-here"
result=$?
if [ $result -eq 1 ]; then ((missing_vars++)); elif [ $result -eq 2 ]; then ((example_vars++)); fi

check_required "DEFAULT_WALLET_PASSPHRASE" "your-wallet-passphrase-here"
result=$?
if [ $result -eq 1 ]; then ((missing_vars++)); elif [ $result -eq 2 ]; then ((example_vars++)); fi

echo ""
echo -e "${BLUE}--- Database Configuration ---${NC}"
check_required "POSTGRES_PASSWORD" "your-secure-postgres-password-here"
result=$?
if [ $result -eq 1 ]; then ((missing_vars++)); elif [ $result -eq 2 ]; then ((example_vars++)); fi

check_required "TOP_LEVEL_POSTGRES_PASSWORD" "your-secure-top-level-postgres-password-here"
result=$?
if [ $result -eq 1 ]; then ((missing_vars++)); elif [ $result -eq 2 ]; then ((example_vars++)); fi

check_optional "MONGODB_PASSWORD" "your-secure-mongodb-password-here" || ((optional_missing++))

echo ""
echo -e "${BLUE}--- Service Ports ---${NC}"
check_optional "CA_PORT" "3005" || ((optional_missing++))
check_optional "ALICE_WALLET_PORT" "3001" || ((optional_missing++))
check_optional "BOB_WALLET_PORT" "3002" || ((optional_missing++))
check_optional "MEDIATOR_PORT" "8080" || ((optional_missing++))

echo ""
echo -e "${BLUE}--- PRISM Node Configuration ---${NC}"
check_required "PRISM_NODE_HOST" "91.99.4.54" || ((missing_vars++))
check_required "PRISM_NODE_PORT" "50053" || ((missing_vars++))

echo ""
echo -e "${BLUE}--- Security Configuration ---${NC}"
check_optional "SESSION_SECRET" "your-secure-session-secret-here" || ((optional_missing++))
check_optional "ACME_EMAIL" "admin@identuslabel.cz" || ((optional_missing++))

echo ""
echo -e "${BLUE}=== Security Validation ===${NC}"
echo ""

security_issues=0

# Check for weak passwords/tokens
echo -e "${BLUE}Checking for weak credentials...${NC}"

if [ ${#CLOUD_AGENT_ADMIN_TOKEN} -lt 32 ] && [ "$CLOUD_AGENT_ADMIN_TOKEN" != "your-secure-admin-token-here" ]; then
    echo -e "${YELLOW}⚠ CLOUD_AGENT_ADMIN_TOKEN is shorter than 32 characters${NC}"
    ((security_issues++))
fi

if [ ${#POSTGRES_PASSWORD} -lt 16 ] && [ "$POSTGRES_PASSWORD" != "your-secure-postgres-password-here" ]; then
    echo -e "${YELLOW}⚠ POSTGRES_PASSWORD is shorter than 16 characters${NC}"
    ((security_issues++))
fi

if [ ${#SESSION_SECRET} -lt 32 ] && [ "$SESSION_SECRET" != "your-secure-session-secret-here" ]; then
    echo -e "${YELLOW}⚠ SESSION_SECRET is shorter than 32 characters${NC}"
    ((security_issues++))
fi

# Check for common weak values
weak_values=("password" "123456" "admin" "test" "changeme")

for weak in "${weak_values[@]}"; do
    if [[ "${POSTGRES_PASSWORD,,}" == *"$weak"* ]]; then
        echo -e "${RED}✗ POSTGRES_PASSWORD contains weak pattern: $weak${NC}"
        ((security_issues++))
    fi
done

if [ $security_issues -eq 0 ]; then
    echo -e "${GREEN}✓ No obvious security issues detected${NC}"
fi

echo ""
echo -e "${BLUE}=== Recommendations ===${NC}"
echo ""

if [ $example_vars -gt 0 ]; then
    echo -e "${YELLOW}⚠ You are using example values for sensitive variables!${NC}"
    echo ""
    echo "Generate secure random values:"
    echo ""
    echo "  # Generate admin token (32 bytes)"
    echo "  openssl rand -hex 32"
    echo ""
    echo "  # Generate postgres password (32 bytes)"
    echo "  openssl rand -hex 32"
    echo ""
    echo "  # Generate session secret (32 bytes)"
    echo "  openssl rand -hex 32"
    echo ""
fi

if [ $security_issues -gt 0 ]; then
    echo -e "${YELLOW}Security recommendations:${NC}"
    echo "- Use passwords at least 16 characters long"
    echo "- Use tokens at least 32 characters long"
    echo "- Avoid common words and patterns"
    echo "- Use truly random values (openssl rand)"
    echo "- Never commit .env file to git"
    echo ""
fi

echo -e "${BLUE}=== Port Conflict Check ===${NC}"
echo ""

ports_to_check=(
    "$CA_PORT"
    "$ALICE_WALLET_PORT"
    "$BOB_WALLET_PORT"
    "$MEDIATOR_PORT"
    "8000"
    "8100"
    "5432"
    "5433"
    "50053"
)

port_conflicts=0

for port in "${ports_to_check[@]}"; do
    if [ -n "$port" ]; then
        echo -n "Checking port $port... "
        if netstat -tuln 2>/dev/null | grep -q ":$port "; then
            echo -e "${YELLOW}⚠ IN USE${NC}"
            ((port_conflicts++))
        else
            echo -e "${GREEN}✓ AVAILABLE${NC}"
        fi
    fi
done

echo ""
echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Summary${NC}"
echo -e "${BLUE}======================================${NC}"
echo "Required variables missing: $missing_vars"
echo "Variables using example values: $example_vars"
echo "Optional variables missing: $optional_missing"
echo "Security issues: $security_issues"
echo "Port conflicts: $port_conflicts"
echo ""

if [ $missing_vars -eq 0 ] && [ $example_vars -eq 0 ] && [ $security_issues -eq 0 ]; then
    echo -e "${GREEN}✓ Environment configuration is valid and secure!${NC}"
    echo ""
    echo "You can now start the infrastructure:"
    echo "  cd infrastructure/scripts"
    echo "  ./install.sh"
    exit 0
else
    echo -e "${RED}✗ Please fix the issues above before proceeding!${NC}"
    echo ""
    if [ $missing_vars -gt 0 ] || [ $example_vars -gt 0 ]; then
        echo "Edit .env file:"
        echo "  nano .env"
    fi
    exit 1
fi
