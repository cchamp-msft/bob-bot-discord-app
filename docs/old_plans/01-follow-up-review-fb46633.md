# Follow-up Code Review — `fb46633`

Date: 2026-02-14
Reviewer: Copilot (GPT-5.3-Codex)
Baseline commit for original split-server work: `b09fad5`
Hardening follow-up commit under review: `fb46633`

## Scope and Method

This review validates implementation against the prior hardening recommendations and coding/security best practices.

Evidence sources:
- Commit metadata and touched files via `git show --name-status --pretty=fuller fb46633`
- Code inspection of:
  - `src/utils/httpServer.ts`
  - `src/utils/outputsServer.ts`
  - `src/utils/config.ts`
- Test inspection and execution:
  - `tests/httpServer.test.ts`
  - `tests/outputsServer.test.ts`
  - `tests/config.test.ts`
  - Targeted run: `npm test -- tests/httpServer.test.ts tests/outputsServer.test.ts tests/config.test.ts`
  - Full run: `npm test`
- Operator docs:
  - `README.md`
  - `.env.example`

---

## Touched Files in `fb46633`

- `.env.example`
- `README.md`
- `src/utils/config.ts`
- `src/utils/httpServer.ts`
- `src/utils/outputsServer.ts`
- `tests/config.test.ts`
- `tests/defaultWorkflowRoutes.test.ts`
- `tests/imageGeneration.test.ts`
- `tests/httpServer.test.ts`
- `tests/outputsServer.test.ts`

---

## Recommendation Coverage Matrix

### 1) App-layer admin auth on admin/state-changing routes (`httpServer.ts`)
**Status: MET**

What was implemented:
- Added `adminAuth` middleware using Bearer token from `ADMIN_TOKEN`.
- Uses constant-time token comparison (`crypto.timingSafeEqual`).
- Combined guard (`adminAuth` then `localhostOnly`) applied consistently to configurator/admin endpoints.
- Health endpoint remains unauthenticated by design.

Assessment:
- Meets the recommendation to treat IP/localhost checks as secondary guardrails and enforce app-layer auth when configured.

### 2) Proxy-aware validation + strict trusted-proxy contract
**Status: PARTIALLY MET (by-design decision accepted, strict mode absent)**

What was implemented:
- Explicitly sets `trust proxy = false` on both servers.
- Documentation explains direct-socket IP semantics and upstream TLS termination assumptions.

What is missing relative to draft recommendation wording:
- No opt-in strict trusted-proxy mode.
- No forwarded-header consistency validation contract (e.g., rejecting malformed/mixed forwarded patterns when proxy-trust is enabled).

Assessment:
- Because this branch intentionally disables trust proxy and you accepted that model by design, this is not a blocker, but strict-proxy capability remains unimplemented.

### 3) Hardened HTTP behavior (safe errors, fingerprint reduction, bounded handling)
**Status: PARTIALLY MET**

What was implemented:
- `X-Powered-By` removal + `X-Content-Type-Options: nosniff` middleware.
- `safeHandler` catches async errors and returns generic `500` envelope.
- JSON parser has explicit body limit (`10mb`).
- Outputs server blocks `/logs` path.

Remaining gaps (defense-in-depth):
- No request-rate limiting / auth-attempt throttling for admin routes.
- No stricter body limits per sensitive route classes (single global JSON limit only).
- No explicit request timeout/slowloris mitigation at app layer.

### 4) Restart-required signaling in `config.ts` for split-server bind fields
**Status: MET**

What was implemented:
- `reload()` now flags `HTTP_HOST`, `OUTPUTS_PORT`, `OUTPUTS_HOST` as restart-required, in addition to `HTTP_PORT`.

Assessment:
- Operational correctness requirement is implemented and test-covered.

### 5) Expand tests for security-critical paths
**Status: MET (coverage present), PARTIAL (adversarial depth)**

What was implemented:
- `tests/httpServer.test.ts`: admin token required/optional behavior, bad/good token, security headers, trust proxy false.
- `tests/outputsServer.test.ts`: `/logs` deny behavior, health availability, security headers, trust proxy false.
- `tests/config.test.ts`: admin token getter and restart-required fields for split bind settings.

Depth observations:
- No tests for brute-force resistance because feature is absent.
- No forwarded-header spoof contract tests (aligned with no strict trusted-proxy mode implementation).

### 6) Docs updates (`README.md`, `.env.example`)
**Status: MET**

What was implemented:
- Added `ADMIN_TOKEN` guidance and reverse-proxy/SSL-termination notes.
- Clarified `OUTPUT_BASE_URL` expectations for proxied HTTPS deployments.
- Clarified restart-needed fields for split-server host/port changes.

---

## Findings (Strict Mode)

### Medium — Missing auth brute-force throttling on admin token endpoint surface
- Admin routes rely on static bearer token and return immediate `401` on mismatch.
- There is no built-in rate limit, lockout, or backoff for repeated failed auth attempts.
- Impact: if proxy exposure controls are misconfigured, token spraying risk increases.

Recommendation:
- Add IP/token-failure throttling middleware for `/api/config*` and `/api/discord*` admin routes.

### Medium — Strict trusted-proxy header contract is not implemented
- Current model is hard disable (`trust proxy=false`), documented and safer by default.
- However, the hardening draft requested an opt-in strict trusted-proxy mode with forwarded-header pattern checks.
- Impact: limits supported secure topologies where trusted proxy semantics are required.

Recommendation:
- If remote admin behind managed proxy is a long-term requirement, add explicit trusted proxy allowlist + forwarded-header validation mode.

### Low — Abuse-resistance controls are minimal
- Current hardening includes useful baseline controls (nosniff, hidden framework header, safe 500s, 10mb JSON limit).
- Broader DOS/abuse controls remain minimal.

Recommendation:
- Add route-scoped request-size caps where practical and consider app-level timeout/rate-limiting middleware.

---

## Best-Practice Review

Strengths:
- Security controls are centralized and readable (`adminAuth`, `localhostOnly`, `safeHandler`, `securityHeaders`).
- Constant-time token comparison is correctly used.
- Sensitive values are not logged directly.
- Restart semantics for bind fields are now explicit and test-backed.
- Documentation aligns with implemented behavior and deployment caveats.

Cautions:
- Localhost-only + optional token fallback is backward compatible but weaker when token is unset.
- Consider making `ADMIN_TOKEN` mandatory when `HTTP_HOST` is non-loopback.

---

## Test Verification

Targeted hardening tests:
- Command: `npm test -- tests/httpServer.test.ts tests/outputsServer.test.ts tests/config.test.ts`
- Result: PASS (`3/3` suites, `113/113` tests)

Full suite:
- Command: `npm test`
- Result: PASS (`26/26` suites, `1034/1034` tests)

---

## Final Verdict

`fb46633` substantially implements the hardening recommendations and is operationally sound for the declared default trust model (`trust proxy=false` with upstream TLS termination).

Status summary:
- Met: admin auth guardrails, restart signaling fixes, docs/env updates, targeted tests.
- Partial: strict trusted-proxy capability and deeper abuse-resistance controls.

Risk posture:
- No critical blockers found.
- Two medium-priority hardening opportunities remain (auth throttling, optional strict trusted-proxy mode).