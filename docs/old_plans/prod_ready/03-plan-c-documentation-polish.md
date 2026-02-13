# Plan C: Documentation & Polish

**Status:** Not Started  
**Priority:** LOW (nice-to-have, non-blocking)  
**Estimated Effort:** Small-Medium  
**Dependencies:** None (can be done anytime)

## Overview

Improve developer experience, repository metadata, and long-term maintainability through better documentation, standardized tooling, and clear contribution guidelines. These changes support open-source collaboration and professional presentation.

## Steps

### 1. Fix LICENSE year
**File:** [LICENSE](../../LICENSE)

Update copyright line:
```
Copyright (c) 2025-2026 cchamp-msft
```

Or use actual creation year if known.

**Verification:** File reads correctly on GitHub.

### 2. Expand CONTRIBUTING.md
**File:** [CONTRIBUTING.md](../../CONTRIBUTING.md)

Add comprehensive sections:

#### Security Vulnerabilities
```markdown
## Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

See [SECURITY.md](SECURITY.md) for our responsible disclosure process.
```

#### Code Style
```markdown
## Code Style

- Follow existing TypeScript conventions
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions focused (single responsibility)

We may add Prettier/ESLint in the future; for now, match the existing style.
```

#### Testing Requirements
```markdown
## Testing Requirements

All new features and bug fixes **must** include tests:
- Unit tests for utility functions
- Integration tests for API endpoints
- Update existing tests if behavior changes

Run tests before submitting: `npm test`
```

#### Commit Message Format
```markdown
## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description (max 50 chars)

- Detailed bullet point
- Another change in this commit
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`

See [.github/copilot-instructions.md](.github/copilot-instructions.md) for full guidelines.
```

#### Code of Conduct (expand)
```markdown
## Code of Conduct

- Be respectful and constructive in all interactions
- Welcome newcomers and help them get started
- Focus on what's best for the project and community
- Gracefully accept constructive criticism

Violations may result in removal from the project.
```

**Verification:** Review on GitHub renders correctly with all links working.

### 3. Complete package.json metadata
**File:** [package.json](../../package.json)

Add missing fields:

```json
{
  "name": "bob-bot-discord-app",
  "version": "1.0.0",
  "description": "Discord bot with ComfyUI, Ollama, AccuWeather, and NFL integration",
  "author": "cchamp-msft",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/cchamp-msft/bob-bot-discord-app.git"
  },
  "bugs": {
    "url": "https://github.com/cchamp-msft/bob-bot-discord-app/issues"
  },
  "homepage": "https://github.com/cchamp-msft/bob-bot-discord-app#readme",
  "engines": {
    "node": ">=20"
  },
  ...
}
```

**Note:** Replace `cchamp-msft/bob-bot-discord-app` with actual GitHub repo URL.

**Verification:** 
- `npm pack` succeeds without warnings
- GitHub automatically links issues/homepage

### 4. Add CHANGELOG.md
**File:** [CHANGELOG.md](../../CHANGELOG.md)

Create using [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Security baseline: LICENSE, CODEOWNERS, CONTRIBUTING.md, SECURITY.md
- GitHub Actions CI with CodeQL and Dependabot
- Separated configurator (port 3000) and outputs server (port 3003)
- Localhost-only binding for configurator with HTTP_HOST override
- Helmet security headers on configurator endpoints
- Production deployment guide with HTTPS/TLS setup
- Comprehensive security tests for localhostOnly middleware
- Rate limiting on configurator and outputs endpoints
- Integration tests with supertest
- Input validation hardening for file uploads

### Changed
- HTTP server now binds to 127.0.0.1 by default (was 0.0.0.0)
- OUTPUT_BASE_URL now defaults to http://localhost:3003 (was :3000)
- Static file serving moved from port 3000 → 3003

### Security
- Added helmet middleware for security headers (CSP, HSTS, X-Frame-Options)
- Added rate limiting to prevent DoS attacks
- Hardened file upload validation (filename sanitization, size limits)
- Separated public outputs from sensitive configurator endpoints

## [1.0.0] - 2025-XX-XX

Initial release.

### Added
- Discord bot with slash commands
- ComfyUI image generation integration
- Ollama LLM integration with conversation context
- AccuWeather API integration
- NFL/ESPN game data integration
- SerpAPI web search integration
- HTTP configurator for setup and testing
- Keyword-based API routing
- Context evaluation and prompt building
- File handler with organized output directories
- Request queue for API management
- Comprehensive test suite (Jest)

[Unreleased]: https://github.com/cchamp-msft/bob-bot-discord-app/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cchamp-msft/bob-bot-discord-app/releases/tag/v1.0.0
```

**Maintenance:** Update CHANGELOG.md with every PR that changes user-facing behavior.

### 5. Document versioning strategy
**File:** [CONTRIBUTING.md](../../CONTRIBUTING.md)

Add section:

```markdown
## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.x.x → 2.x.x): Breaking changes (API changes, removed features)
- **MINOR** (1.0.x → 1.1.x): New features, backward-compatible
- **PATCH** (1.0.0 → 1.0.1): Bug fixes, security patches

### Release Process

Maintainers will:
1. Update [CHANGELOG.md](CHANGELOG.md) with version number and date
2. Create git tag: `git tag -a v1.0.1 -m "Release 1.0.1"`
3. Push tag: `git push origin v1.0.1`
4. GitHub Actions (future) will create release artifacts

Contributors: no need to update version in PRs—maintainers handle releases.
```

**Verification:** Versioning policy is clear to contributors.

### 6. Add developer tooling
**Files:** [.nvmrc](../../.nvmrc), [.github/workflows/ci.yml](../../.github/workflows/ci.yml), optional linting configs

#### .nvmrc
```
20
```

Ensures `nvm use` picks Node 20 automatically.

#### npm audit in CI
Add step to [.github/workflows/ci.yml](../../.github/workflows/ci.yml):

```yaml
- name: Security Audit
  run: npm audit --audit-level=moderate
  continue-on-error: true  # Don't block CI on audit warnings
```

**Note:** `continue-on-error: true` prevents false positives from blocking PRs, but logs warnings for review.

#### Optional: Prettier + ESLint
**Defer unless team requests it.**

If added later:
- `npm install --save-dev prettier eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin`
- Create `.prettierrc.json`, `.eslintrc.json`
- Add npm scripts: `"lint": "eslint src/ tests/"`, `"format": "prettier --write ."`
- Add to CI: `npm run lint` step

**Decision:** Skip for now to avoid bikeshedding. Add when team grows or style drift becomes issue.

### 7. Second CODEOWNERS maintainer
**File:** [.github/CODEOWNERS](../../.github/CODEOWNERS) or [SECURITY.md](../../SECURITY.md)

**If backup maintainer available:**
```
* @cchamp-msft @backup-maintainer
```

**If not available:**
Document single-maintainer risk in [SECURITY.md](../../SECURITY.md):

```markdown
## Maintainer Availability

This project currently has one active maintainer (@cchamp-msft).

If you do not receive a response to a security report within 7 days,
please follow up by mentioning @cchamp-msft in the private advisory.

We are seeking additional maintainers—see [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.
```

**Verification:** Expectations are clear for security response times.

## Verification

### Phase 1: Metadata
- `npm pack` succeeds without warnings
- Visit GitHub repo page, verify:
  - License badge shows MIT
  - Topics/description visible
  - Issues/discussions links work

### Phase 2: Documentation
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for completeness
- Review [CHANGELOG.md](../../CHANGELOG.md) for accuracy
- Ensure all internal links work (run `markdown-link-check` or manual)

### Phase 3: Developer Tooling
- Fresh checkout: `nvm use` picks Node 20 automatically
- CI runs `npm audit`, logs visible in Actions
- (Optional) `npm run lint` passes if Prettier/ESLint added

## Decisions

- **CHANGELOG starts at 1.0.0** with "Unreleased" for current work
- **Prettier/ESLint deferred** until team requests standardization
- **npm audit in CI doesn't block** (warnings only) to avoid false positives
- **Single maintainer documented** rather than blocked (realistic for hobby project)
- **Versioning follows SemVer strictly** with clear examples in docs

## Out of Scope

- Automated release pipeline (GitHub Actions + release-please)
- Contributor guide for first-time contributors (beyond CONTRIBUTING.md)
- Localization/i18n documentation
- API reference documentation (Swagger/OpenAPI)

These can be added later as project grows.

## Commit Strategy

Suggest 2-3 commits:

1. **Metadata + docs:**
   ```
   docs: expand CONTRIBUTING, add CHANGELOG, complete package.json metadata
   
   - Add security reporting, code style, testing, commit format to CONTRIBUTING.md
   - Create CHANGELOG.md following Keep a Changelog format
   - Complete package.json: author, repository, bugs, homepage
   - Fix LICENSE copyright year
   - Document versioning strategy (SemVer)
   - Document single-maintainer risk in SECURITY.md
   ```

2. **Developer tooling:**
   ```
   chore: add .nvmrc and npm audit to CI
   
   - Add .nvmrc with Node 20 for nvm users
   - Add npm audit step to CI (continue-on-error for warnings)
   ```

3. **(Optional) Linting:**
   ```
   chore: add Prettier and ESLint
   
   - Configure Prettier for consistent formatting
   - Configure ESLint for TypeScript
   - Add npm scripts: lint, format
   - Add lint step to CI
   ```

## Maintenance

- **CHANGELOG.md:** Update with every PR (maintainer responsibility)
- **Versioning:** Bump on releases following SemVer
- **npm audit:** Review weekly/monthly, address high/critical vulnerabilities
- **CODEOWNERS:** Add backup when available
