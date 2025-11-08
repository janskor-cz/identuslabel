#!/bin/bash

# Hyperledger Identus SSI Infrastructure - Health Check Script
# Checks the health of all infrastructure components

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${SERVER_DOMAIN:-identuslabel.cz}"
SERVER_IP="${SERVER_IP:-91.99.4.54}"

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Hyperledger Identus SSI Health Check${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Function to check HTTP endpoint
check_http() {
    local name="$1"
    local url="$2"
    local expected_code="${3:-200}"

    echo -n "Checking $name... "

    response_code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

    if [ "$response_code" = "$expected_code" ]; then
        echo -e "${GREEN}✓ OK${NC} (HTTP $response_code)"
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (HTTP $response_code, expected $expected_code)"
        return 1
    fi
}

# Function to check JSON health endpoint
check_health_json() {
    local name="$1"
    local url="$2"

    echo -n "Checking $name... "

    response=$(curl -s "$url" 2>/dev/null || echo '{"status":"error"}')
    status=$(echo "$response" | jq -r '.status // "unknown"' 2>/dev/null || echo "error")
    version=$(echo "$response" | jq -r '.version // "N/A"' 2>/dev/null || echo "N/A")

    if [ "$status" = "healthy" ] || [ "$status" = "ok" ]; then
        echo -e "${GREEN}✓ OK${NC} (Status: $status, Version: $version)"
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (Status: $status)"
        return 1
    fi
}

# Function to check Docker container
check_docker() {
    local name="$1"
    local container_name="$2"

    echo -n "Checking Docker: $name... "

    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        status=$(docker inspect --format='{{.State.Status}}' "$container_name" 2>/dev/null || echo "unknown")
        if [ "$status" = "running" ]; then
            echo -e "${GREEN}✓ RUNNING${NC}"
            return 0
        else
            echo -e "${YELLOW}⚠ WARNING${NC} (Status: $status)"
            return 1
        fi
    else
        echo -e "${RED}✗ NOT FOUND${NC}"
        return 1
    fi
}

# Function to check TCP port
check_port() {
    local name="$1"
    local host="$2"
    local port="$3"

    echo -n "Checking Port: $name ($host:$port)... "

    if timeout 2 bash -c "echo > /dev/tcp/$host/$port" 2>/dev/null; then
        echo -e "${GREEN}✓ OPEN${NC}"
        return 0
    else
        echo -e "${RED}✗ CLOSED${NC}"
        return 1
    fi
}

# Counter for failures
failures=0

echo -e "${BLUE}=== Cloud Agent Services ===${NC}"
check_health_json "Main Cloud Agent" "https://$DOMAIN/_system/health" || ((failures++))
check_health_json "Top-Level Issuer" "http://$SERVER_IP:8100/_system/health" || ((failures++))

echo ""
echo -e "${BLUE}=== CA Server ===${NC}"
check_health_json "Certification Authority" "https://$DOMAIN/ca/api/health" || ((failures++))

echo ""
echo -e "${BLUE}=== Edge Wallets ===${NC}"
check_http "Alice Wallet" "https://$DOMAIN/alice/" || ((failures++))
check_http "Bob Wallet" "https://$DOMAIN/bob/" || ((failures++))

echo ""
echo -e "${BLUE}=== Mediator ===${NC}"
check_http "Mediator Service" "https://$DOMAIN/mediator/" || ((failures++))

echo ""
echo -e "${BLUE}=== Docker Containers ===${NC}"
check_docker "Cloud Agent Backend" "identus-cloud-agent-backend" || ((failures++))
check_docker "Cloud Agent DB" "identus-cloud-agent-db" || ((failures++))
check_docker "Top-Level Issuer Agent" "top-level-issuer-cloud-agent" || ((failures++))
check_docker "Top-Level Issuer DB" "top-level-issuer-db" || ((failures++))
check_docker "Mediator" "identus-mediator-identus-mediator-1" || ((failures++))
check_docker "PRISM Node" "prism-node" || ((failures++))

echo ""
echo -e "${BLUE}=== Network Ports ===${NC}"
check_port "PRISM Node (gRPC)" "$SERVER_IP" "50053" || ((failures++))
check_port "PostgreSQL (Main)" "127.0.0.1" "5432" || ((failures++))
check_port "PostgreSQL (Top-Level)" "127.0.0.1" "5433" || ((failures++))

echo ""
echo -e "${BLUE}=== Process Checks ===${NC}"
echo -n "Checking Caddy reverse proxy... "
if pgrep -f "caddy run" > /dev/null; then
    echo -e "${GREEN}✓ RUNNING${NC}"
else
    echo -e "${RED}✗ NOT RUNNING${NC}"
    ((failures++))
fi

echo -n "Checking CA Server (Node.js)... "
if pgrep -f "node server.js" > /dev/null; then
    echo -e "${GREEN}✓ RUNNING${NC}"
else
    echo -e "${RED}✗ NOT RUNNING${NC}"
    ((failures++))
fi

echo -n "Checking Alice Wallet (Next.js)... "
if lsof -ti:3001 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ RUNNING${NC}"
else
    echo -e "${RED}✗ NOT RUNNING${NC}"
    ((failures++))
fi

echo -n "Checking Bob Wallet (Next.js)... "
if lsof -ti:3002 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ RUNNING${NC}"
else
    echo -e "${RED}✗ NOT RUNNING${NC}"
    ((failures++))
fi

echo ""
echo -e "${BLUE}======================================${NC}"

if [ $failures -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo -e "${GREEN}Infrastructure is healthy.${NC}"
    exit 0
else
    echo -e "${RED}✗ $failures check(s) failed!${NC}"
    echo -e "${YELLOW}Please review the failed components above.${NC}"
    exit 1
fi
