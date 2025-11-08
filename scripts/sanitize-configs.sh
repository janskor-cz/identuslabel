#!/bin/bash

# Hyperledger Identus SSI Infrastructure - Config Sanitization Script
# Removes sensitive data from configuration files before committing

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Configuration Sanitization Check${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Function to check for sensitive patterns in files
check_sensitive_data() {
    local file="$1"
    local patterns=(
        "password="
        "PASSWORD="
        "apikey="
        "APIKEY="
        "api_key="
        "API_KEY="
        "secret="
        "SECRET="
        "token="
        "TOKEN="
        "POSTGRES_PASSWORD="
        "MONGODB_PASSWORD="
        "SESSION_SECRET="
        "CLOUD_AGENT_ADMIN_TOKEN="
        "WALLET_PASSPHRASE="
    )

    local found=0

    for pattern in "${patterns[@]}"; do
        if grep -q "$pattern[^=]*=[^$]" "$file" 2>/dev/null; then
            echo -e "${RED}✗ Found sensitive data in $file: $pattern${NC}"
            found=1
        fi
    done

    return $found
}

# Function to check if file should be ignored
should_ignore() {
    local file="$1"

    # Ignore list
    local ignore_patterns=(
        ".env.example"
        "*.md"
        "*.log"
        ".git/"
        "node_modules/"
        ".next/"
        "build/"
        "dist/"
    )

    for pattern in "${ignore_patterns[@]}"; do
        if [[ "$file" == *"$pattern"* ]]; then
            return 0
        fi
    done

    return 1
}

echo -e "${BLUE}Scanning for sensitive data in configuration files...${NC}"
echo ""

files_checked=0
files_with_issues=0

# Check common config file types
for ext in yml yaml env conf config; do
    while IFS= read -r -d '' file; do
        if ! should_ignore "$file"; then
            ((files_checked++))
            if ! check_sensitive_data "$file"; then
                ((files_with_issues++))
            fi
        fi
    done < <(find . -type f -name "*.${ext}" -print0 2>/dev/null)
done

echo ""
echo -e "${BLUE}=== Checking for accidentally committed secrets ===${NC}"

secrets_found=0

# Check if .env exists (should not be committed)
if [ -f ".env" ] && git ls-files --error-unmatch .env >/dev/null 2>&1; then
    echo -e "${RED}✗ .env file is tracked by git! This should not be committed.${NC}"
    ((secrets_found++))
fi

# Check for credential files
if git ls-files | grep -E '\.(pem|key|cert|crt|p12|pfx)$' >/dev/null 2>&1; then
    echo -e "${RED}✗ Found certificate/key files tracked by git!${NC}"
    git ls-files | grep -E '\.(pem|key|cert|crt|p12|pfx)$'
    ((secrets_found++))
fi

# Check for backup files
if git ls-files | grep -E '\.tar\.gz$|\.zip$|-backup-' >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Warning: Found backup files tracked by git${NC}"
    git ls-files | grep -E '\.tar\.gz$|\.zip$|-backup-'
fi

echo ""
echo -e "${BLUE}=== Verifying .gitignore patterns ===${NC}"

gitignore_ok=1

# Check if essential .gitignore patterns exist
required_patterns=(
    "\.env$"
    "node_modules/"
    "\*\.log"
    "\*\.pem"
    "\*\.key"
)

if [ -f ".gitignore" ]; then
    for pattern in "${required_patterns[@]}"; do
        if ! grep -q "$pattern" .gitignore; then
            echo -e "${RED}✗ Missing .gitignore pattern: $pattern${NC}"
            gitignore_ok=0
        fi
    done

    if [ $gitignore_ok -eq 1 ]; then
        echo -e "${GREEN}✓ Essential .gitignore patterns present${NC}"
    fi
else
    echo -e "${RED}✗ .gitignore file not found!${NC}"
    gitignore_ok=0
fi

echo ""
echo -e "${BLUE}=== Sanitization Recommendations ===${NC}"

if [ $files_with_issues -gt 0 ]; then
    echo -e "${YELLOW}Recommendations:${NC}"
    echo "1. Remove sensitive values from configuration files"
    echo "2. Use .env.example with placeholder values"
    echo "3. Document required environment variables"
    echo "4. Never commit .env files"
fi

echo ""
echo -e "${BLUE}=== Quick Sanitization Commands ===${NC}"
echo ""
echo "Remove .env from git (if accidentally committed):"
echo -e "${YELLOW}  git rm --cached .env${NC}"
echo ""
echo "Remove all .env files from git:"
echo -e "${YELLOW}  git rm --cached '*.env'${NC}"
echo ""
echo "Remove certificate files:"
echo -e "${YELLOW}  git rm --cached *.pem *.key *.cert${NC}"
echo ""
echo "Update .gitignore and remove from index:"
echo -e "${YELLOW}  git rm -r --cached . && git add .${NC}"
echo ""

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Summary${NC}"
echo -e "${BLUE}======================================${NC}"
echo "Files checked: $files_checked"
echo "Files with sensitive data: $files_with_issues"
echo "Secrets in git: $secrets_found"

if [ $files_with_issues -eq 0 ] && [ $secrets_found -eq 0 ] && [ $gitignore_ok -eq 1 ]; then
    echo -e "${GREEN}✓ Configuration is sanitized and safe to commit!${NC}"
    exit 0
else
    echo -e "${RED}✗ Please sanitize configuration before committing!${NC}"
    exit 1
fi
