# Contributing to Hyperledger Identus SSI Infrastructure

Thank you for your interest in contributing to the Hyperledger Identus SSI Infrastructure project! This document provides guidelines and instructions for contributing.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Contribution Guidelines](#contribution-guidelines)
- [Coding Standards](#coding-standards)
- [Testing Requirements](#testing-requirements)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Community](#community)

---

## Code of Conduct

This project adheres to the [Hyperledger Code of Conduct](https://wiki.hyperledger.org/display/HYP/Hyperledger+Code+of+Conduct). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

### Our Standards

- **Be respectful**: Value diverse perspectives and experiences
- **Be collaborative**: Work together towards common goals
- **Be inclusive**: Welcome newcomers and help them succeed
- **Be constructive**: Provide helpful feedback and accept it gracefully
- **Focus on what's best**: Prioritize the community and project over individual interests

---

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- **Development Environment**:
  - Ubuntu 20.04+ or Debian 11+
  - Docker 20.10+ and Docker Compose 1.29+
  - Node.js 18+ and Yarn 1.22+
  - Git 2.25+

- **Knowledge Areas**:
  - Self-Sovereign Identity (SSI) concepts
  - W3C Verifiable Credentials
  - DIDComm messaging protocol
  - TypeScript/JavaScript
  - Docker containerization

### Initial Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/hyperledger-identus-ssi.git
   cd hyperledger-identus-ssi
   ```

3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/hyperledger-identus-ssi.git
   ```

4. **Install dependencies**:
   ```bash
   yarn install
   cd services/edge-wallets/sdk-ts && yarn install && yarn build
   ```

5. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

6. **Verify setup**:
   ```bash
   cd infrastructure/scripts
   ./health-check.sh
   ```

---

## Development Workflow

### Branching Strategy

We use a simplified Git Flow:

- **`main`**: Production-ready code
- **`develop`**: Integration branch for features
- **`feature/*`**: New features (branch from `develop`)
- **`fix/*`**: Bug fixes (branch from `develop`)
- **`hotfix/*`**: Urgent production fixes (branch from `main`)

### Creating a Feature Branch

```bash
# Update develop branch
git checkout develop
git pull upstream develop

# Create feature branch
git checkout -b feature/your-feature-name

# Make changes and commit
git add .
git commit -m "Add feature: description"

# Push to your fork
git push origin feature/your-feature-name
```

### Keeping Your Fork Updated

```bash
# Fetch upstream changes
git fetch upstream

# Update develop branch
git checkout develop
git merge upstream/develop

# Rebase your feature branch
git checkout feature/your-feature-name
git rebase develop
```

---

## Contribution Guidelines

### What to Contribute

**Welcome Contributions**:
- Bug fixes and issue resolutions
- New features aligned with project roadmap
- Documentation improvements
- Test coverage enhancements
- Performance optimizations
- Security improvements

**Please Discuss First** (open an issue):
- Major architectural changes
- New service dependencies
- Breaking changes to APIs
- Large refactoring efforts

### Issue Reporting

**Before creating an issue**:
1. Search existing issues to avoid duplicates
2. Check if it's addressed in recent commits
3. Verify the issue with latest `develop` branch

**Good issue reports include**:
- Clear, descriptive title
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Environment details (OS, Docker version, etc.)
- Relevant logs or error messages
- Proposed solution (if applicable)

### Issue Templates

**Bug Report**:
```markdown
**Description**: Brief description of the bug

**Steps to Reproduce**:
1. Step one
2. Step two
3. ...

**Expected Behavior**: What should happen

**Actual Behavior**: What actually happens

**Environment**:
- OS: Ubuntu 20.04
- Docker: 20.10.12
- Node.js: 18.16.0

**Logs**:
```
Paste relevant logs here
```

**Proposed Fix** (optional): Your idea for fixing it
```

**Feature Request**:
```markdown
**Feature Description**: Clear description of the feature

**Use Case**: Why is this needed?

**Proposed Solution**: How should it work?

**Alternatives Considered**: Other approaches you've thought about

**Additional Context**: Screenshots, mockups, references
```

---

## Coding Standards

### JavaScript/TypeScript

**Style Guide**:
- Use TypeScript for new code where possible
- Follow existing code style (we may add ESLint/Prettier configs)
- Use meaningful variable and function names
- Avoid deeply nested logic (max 3 levels)
- Prefer `const` over `let`, avoid `var`

**Example**:
```typescript
// Good
const fetchUserCredentials = async (userId: string): Promise<Credential[]> => {
  try {
    const response = await agent.pluto.getAllCredentials();
    return response.filter(cred => cred.subject === userId);
  } catch (error) {
    console.error('[fetchUserCredentials] Error:', error);
    throw new Error('Failed to fetch credentials');
  }
};

// Avoid
var getStuff = function(x) {
  var y = someFunction(x);
  if (y) {
    if (y.data) {
      if (y.data.items) {
        return y.data.items;
      }
    }
  }
  return null;
};
```

### Commit Messages

**Format**:
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions/changes
- `chore`: Build process, dependencies
- `perf`: Performance improvements
- `security`: Security fixes

**Examples**:
```
feat(wallet): Add X25519 key generation support

Implement client-side X25519 key pair generation for encrypted
messaging using libsodium. Keys are stored in localStorage with
wallet prefix isolation.

Closes #123
```

```
fix(sdk): Handle unsupported attachment types gracefully

Replace fatal exception with warning log and attachment filtering
when encountering unknown attachment types in DIDComm messages.
Prevents wallet crashes during message processing.

Fixes #456
```

### Documentation

**Code Comments**:
- Use JSDoc for functions and classes
- Explain "why", not "what" (code should be self-documenting)
- Mark TODOs, FIXMEs, and HACKs clearly

**Example**:
```typescript
/**
 * Decrypts an encrypted message using X25519 key agreement.
 *
 * Uses the recipient's private key and sender's public key to derive
 * a shared secret via ECDH, then decrypts with XSalsa20-Poly1305.
 *
 * @param encryptedContent - Encrypted message with nonce and keys
 * @param privateKeyBytes - Recipient's X25519 private key (32 bytes)
 * @param publicKeyBytes - Sender's X25519 public key (32 bytes)
 * @returns Decrypted plaintext
 * @throws Error if decryption fails or keys are invalid
 */
const decryptMessage = async (
  encryptedContent: EncryptedContent,
  privateKeyBytes: Uint8Array,
  publicKeyBytes: Uint8Array
): Promise<string> => {
  // Implementation...
};
```

---

## Testing Requirements

### Manual Testing

Before submitting a PR, test:

1. **DIDComm Connection**:
   - Create invitation from CA
   - Accept in wallet
   - Verify connection established (green status)

2. **Credential Issuance**:
   - Send credential offer
   - Accept in wallet
   - Approve in CA portal
   - Verify credential appears in wallet

3. **Encrypted Messaging** (if applicable):
   - Send encrypted message
   - Verify recipient can decrypt
   - Test bidirectional communication

4. **Edge Cases**:
   - Test with invalid inputs
   - Test error handling
   - Test browser refresh/reload
   - Test with different browsers (Chrome, Firefox, Safari)

### Automated Testing

**Future**: We plan to add automated testing. Contributions welcome!

**When automated tests exist**:
```bash
# Run all tests
yarn test

# Run specific test suite
yarn test:unit
yarn test:integration

# Run with coverage
yarn test:coverage
```

### Testing Checklist

- [ ] Feature works as expected
- [ ] Existing features not broken
- [ ] Error handling implemented
- [ ] Edge cases considered
- [ ] Browser compatibility verified
- [ ] Hard refresh tested (Ctrl+Shift+R)
- [ ] Console has no errors
- [ ] Documentation updated

---

## Documentation

### When to Update Documentation

**Always update documentation when**:
- Adding new features
- Changing APIs or configuration
- Fixing bugs that affect usage
- Adding new environment variables
- Changing deployment procedures

### Documentation Files

| File | Purpose |
|------|---------|
| **README.md** | High-level overview and quick start |
| **CLAUDE.md** | Complete technical documentation |
| **CHANGELOG.md** | Version history and updates |
| **API.md** | API reference (if created) |
| **services/\*/README.md** | Component-specific documentation |
| **CODE_COMMENTS** | Inline code documentation |

### Documentation Style

- Use clear, concise language
- Include code examples
- Provide context and rationale
- Link to external resources
- Use proper Markdown formatting
- Include diagrams where helpful

---

## Pull Request Process

### Before Submitting

1. **Update your branch**:
   ```bash
   git fetch upstream
   git rebase upstream/develop
   ```

2. **Self-review**:
   - Read through your changes
   - Remove debug code and console.logs
   - Ensure code follows style guide
   - Check for typos and formatting

3. **Test thoroughly**:
   - Run manual tests
   - Verify no regressions
   - Test in clean environment (new browser profile)

4. **Update documentation**:
   - Update README if needed
   - Add/update code comments
   - Update CHANGELOG.md
   - Add entry to relevant docs

### Submitting a Pull Request

1. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create PR on GitHub**:
   - Go to your fork on GitHub
   - Click "New Pull Request"
   - Select `develop` as base branch
   - Fill in PR template

3. **PR Template**:
   ```markdown
   ## Description
   Brief description of changes

   ## Related Issue
   Closes #123

   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update

   ## Testing
   - [ ] Manual testing completed
   - [ ] Existing tests pass
   - [ ] New tests added (if applicable)

   ## Checklist
   - [ ] Code follows project style
   - [ ] Documentation updated
   - [ ] CHANGELOG.md updated
   - [ ] No console errors
   - [ ] Hard refresh tested

   ## Screenshots (if applicable)
   ```

### PR Review Process

**What reviewers look for**:
- Code quality and style
- Test coverage
- Documentation completeness
- Security implications
- Performance impact
- Breaking changes

**Responding to feedback**:
- Address all comments
- Make requested changes
- Push new commits (don't force-push during review)
- Re-request review when ready

**After approval**:
- Maintainers will merge your PR
- Your contribution will be in the next release
- Delete your feature branch (optional)

---

## Community

### Communication Channels

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Questions, ideas, general discussion
- **Pull Requests**: Code contributions and reviews

### Getting Help

**Before asking for help**:
1. Read the documentation (README.md, CLAUDE.md)
2. Search existing issues and discussions
3. Check the troubleshooting section

**When asking for help**:
- Be specific about your issue
- Provide context (what you're trying to do)
- Include error messages and logs
- Mention what you've already tried

### Recognition

Contributors will be:
- Listed in CHANGELOG.md for their contributions
- Credited in release notes
- Acknowledged in the community

---

## Advanced Topics

### SDK Modifications

If you need to modify the Hyperledger Identus Edge Agent SDK:

1. **Make changes** in `services/edge-wallets/sdk-ts/src/`
2. **Build SDK**:
   ```bash
   cd services/edge-wallets/sdk-ts
   yarn build
   ```
3. **Copy to wallets**:
   ```bash
   cp -r build/* alice-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
   cp -r build/* bob-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
   ```
4. **Clear cache and restart**:
   ```bash
   cd alice-wallet && rm -rf .next && yarn dev
   cd bob-wallet && rm -rf .next && yarn dev
   ```
5. **Document changes** in `services/edge-wallets/SDK_MODIFICATIONS.md`

### Docker Image Updates

When updating Docker images:

1. Update `infrastructure/docker/*/docker-compose.yml`
2. Test with `docker-compose up -d`
3. Verify health checks pass
4. Document changes in CHANGELOG.md
5. Update version tags

### Database Migrations

When making database schema changes:

1. Create migration script in `infrastructure/docker/migrations/`
2. Test migration on clean database
3. Document rollback procedure
4. Update initialization scripts if needed

---

## License

By contributing to this project, you agree that your contributions will be licensed under the Apache License 2.0, the same license as the project.

---

## Questions?

If you have questions about contributing, please:
1. Check this guide thoroughly
2. Search existing issues and discussions
3. Open a new discussion with your question

Thank you for contributing to Hyperledger Identus SSI Infrastructure!
