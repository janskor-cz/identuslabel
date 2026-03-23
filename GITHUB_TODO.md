# GitHub Multi-Repo Migration TODO

**Context**: Alice Wallet is being phased out. Repository structure needs to be reorganized into 5 separate repos with SDK as published npm package.

**Target Structure**:
```
1. identuslabel-core (main repo)
   ├── infrastructure/
   ├── docs/
   └── config files

2. identuslabel-sdk (npm package)
   └── Published to npm registry

3. identuslabel-idl-wallet (primary wallet)
   └── Depends on published SDK

4. identuslabel-ca (separate)
   └── Certification Authority service

5. identuslabel-company-admin (separate)
   └── Company Admin Portal service
```

---

## Phase 1: Preparation & Planning

- [ ] **Analyze SDK dependencies** - Map all imports across modules to understand coupling
- [ ] **Audit Alice Wallet usage** - Find all references to Alice in tests, docs, scripts
- [ ] **Review CI/CD setup** - Understand current GitHub Actions/deployment pipelines
- [ ] **Decide npm registry** - Public npm.js vs private registry for SDK package
- [ ] **Create npm package naming convention** - e.g., `@identuslabel/sdk`, `identuslabel-sdk`
- [ ] **Plan git history** - Decide if using git subtree split or fresh repos with file history

---

## Phase 2: SDK Extraction & Publishing

### 2.1 Prepare SDK as Publishable Package
- [ ] Extract `/services/edge-wallets/sdk-ts` to separate directory structure
- [ ] Create standalone `package.json` with proper npm metadata
- [ ] Update build process for npm publishing
- [ ] Configure TypeScript compilation for npm distribution
- [ ] Create `README.md` for SDK package
- [ ] Add license headers if needed

### 2.2 Create New `identuslabel-sdk` Repository
- [ ] Create new GitHub repo `janskor-cz/identuslabel-sdk`
- [ ] Migrate SDK source code to new repo
- [ ] Set up build/test CI pipeline
- [ ] Configure npm publish workflow (GitHub Actions)
- [ ] Document SDK development process
- [ ] Create CONTRIBUTING guide for SDK

### 2.3 Publish SDK to npm Registry
- [ ] Create npm account / configure private registry access
- [ ] Set up authentication tokens in CI/CD
- [ ] Publish initial SDK version (v0.1.0 or similar)
- [ ] Test installation: `npm install @identuslabel/sdk`
- [ ] Document installation in README

### 2.4 Update Main Repo
- [ ] Remove `/services/edge-wallets/sdk-ts` from monorepo
- [ ] Update root `package.json` workspaces
- [ ] Update build scripts (remove SDK build references)
- [ ] Update CI/CD pipelines
- [ ] Update CLAUDE.md with new SDK workflow
- [ ] Commit: "refactor: remove SDK from monorepo (migrated to separate package)"

---

## Phase 3: IDL Wallet as Primary

### 3.1 Update IDL Wallet Dependencies
- [ ] Update `idl-wallet/package.json` to depend on published SDK
  ```json
  "dependencies": {
    "@identuslabel/sdk": "^0.1.0"
  }
  ```
- [ ] Remove local SDK workspace reference
- [ ] Test wallet builds with published SDK
- [ ] Verify all SDK imports still work
- [ ] Update `tsconfig.json` if needed

### 3.2 Create New `identuslabel-idl-wallet` Repository
- [ ] Create new GitHub repo `janskor-cz/identuslabel-idl-wallet`
- [ ] Migrate `/idl-wallet` to new repo
- [ ] Update build/dev scripts in new repo
- [ ] Set up CI/CD for wallet
- [ ] Create wallet-specific documentation
- [ ] Test deployment process

### 3.3 Update Documentation
- [ ] Update README - IDL is now primary wallet
- [ ] Create IDL Wallet setup guide
- [ ] Remove Alice Wallet development docs
- [ ] Update architecture diagrams
- [ ] Add migration note: "Alice Wallet deprecated, use IDL Wallet"

---

## Phase 4: Extract Certification Authority

### 4.1 Prepare CA for Separation
- [ ] Audit CA dependencies (database, external services)
- [ ] Document CA API contracts/endpoints
- [ ] Check for hardcoded references to other services
- [ ] Review security configurations
- [ ] List environment variables CA needs

### 4.2 Create New `identuslabel-ca` Repository
- [ ] Create new GitHub repo `janskor-cz/identuslabel-ca`
- [ ] Migrate `/certification-authority` to new repo
- [ ] Create standalone `package.json`
- [ ] Set up build/test CI pipeline
- [ ] Document CA API and architecture
- [ ] Create deployment guide

### 4.3 Update CA to Reference Services via APIs
- [ ] Replace local SDK usage with published npm package (if any)
- [ ] Ensure CA uses published IDL Wallet APIs only (not internal calls)
- [ ] Update environment variables for external service URLs
- [ ] Document API contracts with other services
- [ ] Create health check for external dependencies
- [ ] Update CLAUDE.md with CA deployment

### 4.4 Update Main Repo
- [ ] Remove `/certification-authority` directory
- [ ] Update root `package.json`
- [ ] Update CI/CD pipelines
- [ ] Update docker-compose files to reference CA repo/image
- [ ] Commit: "refactor: migrate Certification Authority to separate repo"

---

## Phase 5: Extract Company Admin Portal

### 5.1 Prepare Company Admin for Separation
- [ ] Document Company Admin dependencies
- [ ] Review all service integrations
- [ ] Check EmployeeWalletManager interactions with other services
- [ ] Document ReEncryptionService usage
- [ ] List all environment variables needed

### 5.2 Create New `identuslabel-company-admin` Repository
- [ ] Create new GitHub repo `janskor-cz/identuslabel-company-admin`
- [ ] Migrate `/company-admin-portal` to new repo
- [ ] Create standalone `package.json`
- [ ] Set up build/test CI pipeline
- [ ] Document portal API and features
- [ ] Create deployment guide

### 5.3 Update Company Admin to Use External Services
- [ ] Use published SDK npm package if needed
- [ ] Ensure all calls to other services use REST APIs/HTTP
- [ ] Update environment variables for external URLs
- [ ] Remove internal library dependencies
- [ ] Test with external services
- [ ] Update CLAUDE.md with Company Admin deployment

### 5.4 Update Main Repo
- [ ] Remove `/company-admin-portal` directory
- [ ] Update root `package.json`
- [ ] Update docker-compose files
- [ ] Update CI/CD pipelines
- [ ] Commit: "refactor: migrate Company Admin Portal to separate repo"

---

## Phase 6: Archive Alice Wallet

### 6.1 Clean Up Alice References
- [ ] Remove `/services/edge-wallets/alice-wallet` from repo
- [ ] Remove Alice from root `package.json` workspaces
- [ ] Remove Alice build scripts
- [ ] Remove Alice from CI/CD pipelines
- [ ] Remove Alice documentation

### 6.2 Update Project Documentation
- [ ] Update README.md - remove Alice references
- [ ] Create `MIGRATION_ALICE_DEPRECATION.md` (if needed)
- [ ] Update CLAUDE.md - remove Alice development instructions
- [ ] Archive Alice wiki/docs if any

### 6.3 Final Commit
- [ ] Commit: "chore: remove deprecated Alice Wallet (replaced by IDL Wallet)"

---

## Phase 7: Core Repo Restructuring

### 7.1 Reorganize Main Repo
- [ ] Clean up root directory:
  ```
  identuslabel/
  ├── infrastructure/          # Docker, Caddy, scripts
  ├── docs/                    # Project documentation
  ├── CLAUDE.md               # Updated with new structure
  ├── README.md               # Updated with new repos
  ├── CONTRIBUTING.md         # Updated
  ├── docker-compose files    # Updated to use separate repos
  ├── Caddyfile              # Reverse proxy config
  └── config files           # SQL init, nginx, etc.
  ```
- [ ] Remove `services/` directory completely
- [ ] Update all paths in CLAUDE.md

### 7.2 Update Docker Compose Files
- [ ] Update `cloud-agent-with-reverse-proxy.yml` - reference external services
- [ ] Update `enterprise-cloud-agent.yml`
- [ ] Update `test-multitenancy-cloud-agent.yml`
- [ ] Remove references to local SDK/wallet builds
- [ ] Update service deployment instructions

### 7.3 Update GitHub Workflows (CI/CD)
- [ ] Remove SDK build steps
- [ ] Remove Alice/IDL wallet build steps from main repo
- [ ] Update any health check workflows
- [ ] Create documentation for linking repos in deployments

---

## Phase 8: Documentation Updates

### 8.1 Root Repository Documentation
- [ ] Update `README.md`:
  - [ ] Change overview to describe core + satellite repos
  - [ ] Add links to separate repos
  - [ ] Update architecture diagram
  - [ ] Update "Quick Start" section
  - [ ] Remove Alice references

- [ ] Update `CLAUDE.md`:
  - [ ] Remove SDK development workflow
  - [ ] Remove Alice Wallet dev commands
  - [ ] Update IDL Wallet dev commands to use published SDK
  - [ ] Add instructions for working with 5 repos
  - [ ] Update "Services" section with new URLs

- [ ] Create `REPOS.md` - Overview of all 5 repos:
  ```markdown
  # Identuslabel Repository Structure

  ## Core Infrastructure
  - **identuslabel** (main) - Docker orchestration, infrastructure, docs

  ## Services
  - **identuslabel-sdk** - Edge Agent SDK (npm package)
  - **identuslabel-idl-wallet** - Primary wallet application
  - **identuslabel-ca** - Certification Authority service
  - **identuslabel-company-admin** - Company Admin Portal

  ## Dependency Graph
  - IDL Wallet → SDK (npm)
  - CA → (uses REST APIs, no code deps)
  - Company Admin → (uses REST APIs, no code deps)
  - Core → orchestrates all via docker-compose
  ```

### 8.2 Update CONTRIBUTING.md
- [ ] Add multi-repo setup instructions
- [ ] Document how to clone all repos locally
- [ ] Update development environment setup
- [ ] Add notes about SDK publishing workflow

### 8.3 Create Migration Guide
- [ ] Document for developers how to work with new structure
- [ ] Provide scripts to clone all repos
- [ ] Document inter-service communication

---

## Phase 9: Testing & Validation

### 9.1 Local Development Testing
- [ ] Clone all 5 repos locally
- [ ] Test SDK npm package installation
- [ ] Test IDL Wallet dev environment
- [ ] Test CA standalone deployment
- [ ] Test Company Admin standalone deployment
- [ ] Test all services together with docker-compose

### 9.2 End-to-End Testing
- [ ] Run wallet tests against published SDK
- [ ] Test CA credential issuance flow
- [ ] Test Company Admin employee onboarding
- [ ] Test document access control
- [ ] Run health checks across all services
- [ ] Verify HTTPS/reverse proxy still works

### 9.3 CI/CD Validation
- [ ] Verify all GitHub Actions pipelines pass
- [ ] Test SDK npm publishing workflow
- [ ] Test docker image builds for services
- [ ] Validate deployment scripts

---

## Phase 10: Cleanup & Final Steps

- [ ] Remove any remnants of monorepo structure
- [ ] Update all internal links in documentation
- [ ] Create summary MIGRATION.md documenting what was done
- [ ] Archive any old branches
- [ ] Update GitHub repo settings (descriptions, topics, etc.)
- [ ] Create GitHub wiki if needed for architecture docs
- [ ] Post announcement about new repo structure

---

## Notes for Future Instances

### Key Files to Review
- `/home/user/identuslabel/CLAUDE.md` - Development instructions
- `/home/user/identuslabel/package.json` - Root workspace config
- `/home/user/identuslabel/docker-compose*.yml` - Service orchestration
- `/services/edge-wallets/` - Current monorepo structure (to be split)

### Important Context
- Alice Wallet is DEPRECATED and will be removed
- IDL Wallet is the PRIMARY wallet going forward
- SDK needs to be published as npm package for reusability
- Services should communicate via REST APIs, not internal dependencies
- Documentation must be updated for all 5 repos

### Potential Challenges
1. **SDK dependency versioning** - Need strategy for SDK updates across wallets
2. **CI/CD coordination** - Services deployed independently, need service discovery
3. **Database migrations** - CA/Company Admin have their own databases
4. **Reverse proxy updates** - Caddy config references services by URL
5. **Local dev experience** - Developers need easy way to set up all 5 repos

### Success Criteria
- ✅ All 5 repos exist and have CI/CD
- ✅ SDK published and installable from npm
- ✅ IDL Wallet uses published SDK (not local)
- ✅ Services deploy independently with docker-compose
- ✅ Alice Wallet completely removed
- ✅ Documentation updated for new structure
- ✅ All health checks pass
- ✅ E2E tests pass with external service calls
