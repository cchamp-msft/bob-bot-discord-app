# Plan A: Critical Security Hardening

**Status:** Not Started  
**Priority:** HIGH (blocking for production)  
**Estimated Effort:** Medium  
**Dependencies:** Architecture split (Plan 00) must be completed first

## Overview

Address the 3 remaining HIGH-severity security issues from code review that block production deployment. With the outputs server separation complete, this focuses on comprehensive security testing, security headers, and production deployment guidance.

## Steps

### 1. Add comprehensive security tests for `localhostOnly` middleware
**File:** [tests/httpServer.test.ts](../../tests/httpServer.test.ts)

Extend existing test file with comprehensive coverage of the security-critical middleware:

- **Test: Block remote IPs**
  - Mock `req.ip` to `192.168.1.100`, `10.0.0.1`, `172.16.0.1`
  - Verify response is 403 Forbidden with error message
  
- **Test: Allow all localhost variations**
  - Mock `req.ip` to `127.0.0.1`, `::1`, `::ffff:127.0.0.1`
  - Verify middleware calls `next()` (no 403)

- **Test: All protected routes use middleware**
  - Enumerate all `/api/config/*`, `/api/discord/*` routes
  - For each route, mock remote IP and verify 403
  - Ensures no route bypasses protection

- **Test: X-Forwarded-For headers ignored**
  - Set `req.headers['x-forwarded-for'] = '127.0.0.1'`
  - Set `req.ip = '192.168.1.1'`
  - Verify 403 (trusts `req.ip` only, not headers)

- **Test: Edge cases**
  - Empty `req.ip`
  - Malformed IPs
  - IPv6 edge cases

**Acceptance:** Coverage for `localhostOnly` function reaches 100%.

### 2. Add helmet security headers
**Files:** [package.json](../../package.json), [src/utils/httpServer.ts](../../src/utils/httpServer.ts)

Install and configure helmet middleware:

- **Install:** `npm install helmet` (add to dependencies)
- **Install types:** `npm install --save-dev @types/helmet`

Configure in `HttpServer` constructor (after `express.json()` middleware):

```typescript
import helmet from 'helmet';

// In setupRoutes():
this.app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // configurator SPA needs inline scripts
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  hsts: {
    maxAge: 31536000,  // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));
```

**Notes:**

-   HSTS applies even in dev (safe since localhost)
-   CSP allows inline scripts/styles for configurator.html
-   Document in code comments why `unsafe-inline` is needed

**Test:**

-   Add test verifying response headers include:
    -   `X-Content-Type-Options: nosniff`
    -   `X-Frame-Options: DENY`
    -   `Strict-Transport-Security` (if applicable)
    -   CSP header present

### 3. Create production deployment guide with HTTPS/TLS

**File:** docs/production-deployment.md

Create comprehensive guide covering:

#### Reverse Proxy Setup (nginx example)

#### Key Topics

-   **Certificate management:** Let's Encrypt (certbot) setup
-   **Renewal:** Automated via cron/systemd timer
-   **Environment variables:** Production-specific overrides
    -   [OUTPUT_BASE_URL=https://bot.example.com](vscode-file://vscode-app/c:/Users/charl/AppData/Local/Programs/Microsoft%20VS%20Code/591199df40/resources/app/out/vs/code/electron-browser/workbench/workbench.html)
    -   `OUTPUTS_HOST=127.0.0.1` (bind locally, nginx forwards)
-   **Firewall rules:**
    -   Allow 443 (HTTPS), 3003 (outputs)
    -   Block 3000 (configurator)
    -   Document using `ufw` or `firewalld`
-   **Security checklist:**
    -   Never expose port 3000 externally
    -   Test configurator unreachable from internet
    -   Verify Discord can fetch images via HTTPS

#### Warning Sections

-   **⚠️ HTTP-only deployments are NOT production-safe**
    -   Tokens transmitted in cleartext during config updates
    -   Man-in-the-middle risk
-   **⚠️ Configurator must remain localhost-only**
    -   Contains sensitive token management endpoints
    -   No authentication layer (by design)

#### Alternative: Cloudflare Tunnel

-   Document zero-config TLS option for hobbyists
-   `cloudflared tunnel` setup for outputs only

**Cross-reference:**

-   Link from SECURITY.md: "See production-deployment.md for TLS setup"
-   Link from README.md: "Deployment → Production best practices"

Verification
------------

### Phase 1: Tests

-   `npm test` passes
-   Coverage report shows [localhostOnly](vscode-file://vscode-app/c:/Users/charl/AppData/Local/Programs/Microsoft%20VS%20Code/591199df40/resources/app/out/vs/code/electron-browser/workbench/workbench.html) at 100%
-   Security headers present in test assertions

### Phase 2: Manual validation

-   Start servers locally
-   Check response headers with curl:
-   Attempt access from remote IP (use phone on cellular):
    -   Configurator → should fail (connection refused or 403)
    -   Outputs → should succeed

### Phase 3: Documentation review

-   docs/production-deployment.md reviewed for completeness
-   Nginx config tested in staging environment (if available)

Decisions
---------

-   **helmet defaults are acceptable** with CSP relaxed for configurator SPA
-   **HTTPS is required for production** (not optional)
-   **nginx is the documented proxy** (Apache/Caddy alternatives mentioned but not detailed)
-   **Skip outputs server helmet config** for now (lower risk, adds later if needed)

Out of Scope (deferred to Plan B)
---------------------------------

-   Rate limiting (less urgent with separation)
-   CORS policy (working as-is)
-   Integration tests (helpful but not blocking)

Commit Strategy
---------------

Suggest 3 commits:

1.  `test(security): add comprehensive localhostOnly middleware tests`
2.  `feat(security): add helmet security headers to configurator`
3.  `docs(security): add production deployment guide with TLS`