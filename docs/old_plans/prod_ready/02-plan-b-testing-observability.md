# Plan B: Testing & Observability

**Status:** Not Started  
**Priority:** MEDIUM (recommended before heavy production use)  
**Estimated Effort:** Large  
**Dependencies:** Plan 00 (architecture), Plan A (security tests baseline)

## Overview

Improve testing rigor, code quality automation, and operational safety through integration tests, enhanced CI, input validation hardening, and rate limiting. These changes reduce regression risk and improve production reliability.

## Steps

### 1. Enhance CodeQL analysis
**File:** [.github/workflows/codeql.yml](../../.github/workflows/codeql.yml)

Improve code scanning breadth and depth:

- Add `security-extended` query suite to `init` step:
  ```yaml
  - name: Initialize CodeQL
    uses: github/codeql-action/init@v3
    with:
      languages: javascript, typescript
      queries: security-extended
  ```

- Explicitly list both languages (currently only `javascript`)
- Verify SARIF upload succeeds (check Actions logs after push)

**Verification:** After merge, check Security → Code scanning for new alerts.

### 2. Add explicit CORS policy
**Files:** [package.json](../../package.json), [src/utils/httpServer.ts](../../src/utils/httpServer.ts), [src/utils/outputsServer.ts](../../src/utils/outputsServer.ts)

Install and configure CORS middleware:

- Install: `npm install cors @types/cors`
- Configure in `HttpServer` (configurator):
  ```typescript
  import cors from 'cors';
  
  // In setupRoutes(), before other middleware:
  this.app.use(cors({
    origin: `http://localhost:${this.port}`,
    credentials: true,
    maxAge: 86400,
  }));
  ```

- Configure in `OutputsServer` (outputs):
  ```typescript
  // Allow all origins for static files (Discord webhooks)
  this.app.use(cors({
    origin: '*',
    maxAge: 86400,
  }));
  ```

**Test:** Add tests verifying CORS headers present in responses.

### 3. Add environment variable validation to CI
**File:** [.github/workflows/ci.yml](../../.github/workflows/ci.yml)

Add smoke test step after "Install":

```yaml
- name: Smoke Test Config
  run: |
    # Create minimal .env from example
    cp .env.example .env.test
    # Validate all required vars exist
    node -e "
      require('dotenv').config({ path: '.env.test' });
      try {
        require('./dist/utils/config');
        console.log('✓ Config validation passed');
      } catch (err) {
        console.error('✗ Config validation failed:', err.message);
        process.exit(1);
      }
    "
```

**Note:** This catches missing env vars early, before tests run.

**Verification:** 
- Rename a required env var in code, verify CI fails
- Add it to `.env.example`, verify CI passes

### 4. Add integration tests with supertest
**Files:** [package.json](../../package.json), [tests/integration/httpServer.integration.test.ts](../../tests/integration/httpServer.integration.test.ts), [tests/integration/outputsServer.integration.test.ts](../../tests/integration/outputsServer.integration.test.ts)

Install: `npm install --save-dev supertest @types/supertest`

Create integration test suite:

#### Configurator Integration Tests
```typescript
import request from 'supertest';
import { httpServer } from '../../src/utils/httpServer';

describe('HttpServer Integration', () => {
  beforeAll(() => {
    httpServer.start();
  });

  afterAll(async () => {
    await httpServer.stop();
  });

  it('GET /health returns 200', async () => {
    const res = await request(httpServer.getApp())
      .get('/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /configurator serves HTML', async () => {
    await request(httpServer.getApp())
      .get('/configurator')
      .expect(200)
      .expect('Content-Type', /html/);
  });

  it('POST /api/config/save rejects without auth', async () => {
    // Mock remote IP
    await request(httpServer.getApp())
      .post('/api/config/save')
      .send({ DISCORD_TOKEN: 'test' })
      .expect(403);
  });
});
```

#### Outputs Server Integration Tests
```typescript
import request from 'supertest';
import { outputsServer } from '../../src/utils/outputsServer';

describe('OutputsServer Integration', () => {
  beforeAll(() => {
    outputsServer.start();
  });

  afterAll(async () => {
    await outputsServer.stop();
  });

  it('GET /health returns 200', async () => {
    const res = await request(outputsServer.getApp())
      .get('/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /logs returns 403', async () => {
    await request(outputsServer.getApp())
      .get('/logs')
      .expect(403);
  });

  it('serves static files from outputs/', async () => {
    // Assumes outputs/ has files (or mock)
    // Test actual file serving
  });
});
```

**Update jest.config.ts:**
```typescript
testMatch: ['**/*.test.ts', '**/*.integration.test.ts'],
```

**Verification:** 
- `npm test` runs both unit and integration tests
- Integration tests actually start servers and make HTTP requests

### 5. Harden file upload input validation
**File:** [src/utils/httpServer.ts](../../src/utils/httpServer.ts)

In `POST /api/config/upload-workflow` endpoint (around line 143):

```typescript
// Sanitize filename
const sanitizeFilename = (name: string): string => {
  // Remove path traversal sequences
  const cleaned = name.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  // Whitelist safe characters
  return cleaned.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const safeName = sanitizeFilename(filename || 'comfyui-workflow.json');

// Enforce .json extension
if (!safeName.endsWith('.json')) {
  logger.logError('configurator', 'Workflow upload FAILED: Invalid file extension');
  res.status(400).json({ success: false, error: 'Workflow must be a .json file' });
  return;
}

// Pre-check size before parsing
if (workflow.length > 10 * 1024 * 1024) {  // 10MB
  logger.logError('configurator', 'Workflow upload FAILED: File too large');
  res.status(400).json({ success: false, error: 'Workflow exceeds 10MB limit' });
  return;
}
```

**Test:** Add tests for:
- Filename with `../` or `..\\` → sanitized
- Filename with non-ASCII characters → sanitized
- Workflow > 10MB → rejected
- Non-JSON extension → rejected

**Verification:** Attempt malicious uploads, verify rejection.

### 6. Test server stop() methods
**Files:** [tests/httpServer.test.ts](../../tests/httpServer.test.ts), [tests/outputsServer.test.ts](../../tests/outputsServer.test.ts)

Add tests for graceful shutdown:

```typescript
it('stop() shuts down gracefully', async () => {
  const server = httpServer;  // or outputsServer
  
  server.start();
  
  // Verify server is listening
  const app = server.getApp();
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  
  // Stop server
  await server.stop();
  
  // Verify stopped
  await expect(
    request(app).get('/health')
  ).rejects.toThrow();  // Connection refused
});
```

**Verification:** Tests pass, confirming clean shutdown.

### 7. Add rate limiting to both servers
**Files:** [package.json](../../package.json), [src/utils/httpServer.ts](../../src/utils/httpServer.ts), [src/utils/outputsServer.ts](../../src/utils/outputsServer.ts)

Install: `npm install express-rate-limit`

#### Configurator Rate Limits
```typescript
import rateLimit from 'express-rate-limit';

// General limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later' },
});

// Strict limiter for POST endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many configuration changes, please slow down' },
});

// Apply in setupRoutes():
this.app.use('/api/config', generalLimiter);
this.app.post('/api/config/save', strictLimiter, localhostOnly, ...);
this.app.post('/api/config/upload-workflow', strictLimiter, localhostOnly, ...);
this.app.post('/api/test/generate', strictLimiter, localhostOnly, ...);
```

#### Outputs Server Rate Limits
```typescript
const outputsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,  // Higher for static files
  message: { error: 'Too many requests' },
});

this.app.use(outputsLimiter);
```

**Test:** 
- Make 101 requests in 15min → verify 429 response
- Verify rate limit headers present (`X-RateLimit-*`)

**Document:** Add rate limits to README.md under "API Limits" section.

## Verification

### Phase 1: CI
- Push to PR, verify all CI steps pass including new smoke test
- Check CodeQL results for any new security alerts

### Phase 2: Test Coverage
- Run `npm test -- --coverage`
- Verify coverage increased for:
  - `httpServer.ts` (integration tests cover middleware ordering)
  - `outputsServer.ts` (stop method covered)
  - Input validation paths covered

### Phase 3: Manual Testing
- Trigger rate limits locally (loop curl requests)
- Upload malicious filenames, verify sanitization
- Test graceful shutdown with active connections

## Decisions

- **supertest over manual HTTP testing** (industry standard, good DX)
- **Rate limits are permissive** (100/15min general, 20/15min POST) — tighten if abuse occurs
- **CORS allows all origins for outputs** (required for Discord webhooks from arbitrary IPs)
- **Integration tests run in same suite as unit tests** (no separate npm script for now)

## Out of Scope

- E2E tests with real Discord API (too complex, requires bot token)
- Performance/load testing (defer until production metrics available)
- Distributed rate limiting (Redis-backed) — local memory sufficient for single-instance

## Commit Strategy

Suggest 7 commits (one per step):
1. `ci(codeql): enable security-extended queries and TypeScript`
2. `feat(security): add explicit CORS policies for both servers`
3. `ci: add environment variable validation smoke test`
4. `test: add integration tests for HTTP servers with supertest`
5. `feat(security): harden file upload input validation`
6. `test: add graceful shutdown tests for stop() methods`
7. `feat(security): add rate limiting to configurator and outputs servers`

Or batch into 2-3 larger commits if preferred.
