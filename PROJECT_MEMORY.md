# ILLUMATRIX V.2 — Living Project Memory & Handoff Record

> **Purpose:** Living state record for ILLUMATRIX V.2. Updated after every meaningful task.  
> **Security Rule:** Never store cleartext secrets, passwords, or tokens in this file.

---

## 1. Current State
- **Current Phase**: Phase 3 — Shared AI Execution Interface & Orchestration
- **Current Task**: Task 3.4B Completed & Verified (REM-01: Setup UI Inputs for Target Audience & Call to Action)
- **Status**: Implemented remediation item REM-01 from Task 3.4A Complete UI Operational Readiness Audit. Added a collapsible "Audience & Conversion" section in `SetupWorkspace.tsx` with single-line inputs for Target Audience and Call to Action (both max 150 chars with character counter), bound to `project.targetAudience` and `project.callToAction`. Changes persist in browser localStorage, reload accurately, export/import cleanly with backward compatibility for older backups, and feed safely into `/api/ai/generate-script` and `/api/ai/generate-seo` prompts. 246 automated tests passing across 16 suites.
- **Last Verified Working State**:
  - `npm test`: 246 passing tests across 16 suites (duration ~10.4s, 0 failures, 0 skipped).
  - `npm run lint`: Clean TypeScript compile (`tsc --noEmit`, 0 diagnostics).
  - `npm run build`: Production bundle built cleanly via Vite (`vite build` in 1.44s).
  - Full-stack dev server: Running Express + Vite on `http://0.0.0.0:3000`.

---

## 2. Completed and Verified Work

### Task 0.1: Baseline Codebase Audit
- **Files Inspected**: `package.json`, `server.ts`, `src/App.tsx`, `src/context/WorkflowContext.tsx`, `src/data/registries.ts`, `src/types/hud.ts`, `src/server/providerManager.ts`, `src/server/modelCompatibility.ts`, `src/services/aiService.ts`, `src/services/storage.ts`, `src/services/promptSafetyEngine.ts`, `tests/*`.
- **Verification Commands & Real Results**:
  - `npm test`: 84 passing subtests.
  - `npm run lint`: Clean (`tsc --noEmit`).
  - `npm run build`: Clean (`vite build`).

### Task 0.2: Synchronization of Seven Root Documentation Files
- **Files Created / Synchronized**: `README.md`, `PROJECT_REQUIREMENTS.md`, `ARCHITECTURE.md`, `FEATURES.md`, `IMPLEMENTATION_PLAN.md`, `DESIGN_SYSTEM.md`, `PROJECT_MEMORY.md`.

### Task 0.3: Credential Security & Gitignore Hardening
- **Objective**: Eliminate hardcoded secrets from stored configuration, create root `.gitignore`, dynamically load Google GenAI credentials from `process.env.GEMINI_API_KEY`, prevent silent credential collision across Google connections, and test missing key states.
- **Files Changed**:
  - `/.gitignore` (Created: ignores `.env*`, `.provider_connections.json`, `dist/`, `node_modules/`, while allowing `!.env.example`).
  - `/.provider_connections.json` (Sanitized: all hardcoded API keys removed; stored `apiKey` set to empty string `""`).
  - `/src/server/providerManager.ts` (Updated: added `resolveEffectiveApiKey()`, updated `loadConnections()` to never write environment secrets to disk, updated `saveConnections()` to strip environment variables prior to serializing, updated `getPublicConnections()`, `getEffectiveCredentials()`, and `executeTextGeneration()` to read environment keys dynamically with safe `unconfigured` states when missing).
  - `/tests/api-provider-manager.test.ts` (Added 5 automated tests for dynamic environment key loading, independent Google connection credentials, missing credential error handling, zero on-disk environment secrets, and `.gitignore` integrity).
- **Verification Commands & Real Results**:
  - `npm test`: 90 passing tests, 0 failures (~3.5s).
  - `npm run lint`: 0 diagnostics (`tsc --noEmit`).
  - `npm run build`: Build succeeded (`vite build`).

### Task 0.4: Custom Provider SSRF Protection
- **Objective**: Implement comprehensive server-side SSRF validation and safe HTTP dispatch for user-configured custom provider endpoints (`baseUrl`).
- **Files Changed / Created**:
  - `/src/server/urlSafetyValidator.ts` (Created: implements `isRestrictedIpv4`, `parseIpv6Words`, `isRestrictedIpv6`, `isRestrictedIp`, `isRestrictedHostname`, `defaultDnsResolver`, `validateCustomProviderUrl`, and `safeSsrfFetch` with manual redirect handling and per-hop revalidation).
  - `/src/server/providerManager.ts` (Updated: imports SSRF tools, adds `SSRF_BLOCKED` to `errorCategory`, validates endpoints in `testConnection()` and `executeTextGeneration()`, dispatches via `safeSsrfFetch`, preserves built-in providers, and rethrows `SSRF_BLOCKED` errors).
  - `/server.ts` (Updated: validates `baseUrl` against SSRF in `app.post('/api/providers')`, returning HTTP 400 with `category: 'SSRF_BLOCKED'`).
  - `/tests/api-provider-manager.test.ts` (Added 12 comprehensive automated test cases covering public URLs, localhost/loopback IPv4 & IPv6, link-local & cloud metadata, private RFC 1918 & CGNAT ranges, IPv6 ULA & IPv4-mapped, protocol & credential rejections, DNS resolution, split-horizon/mixed DNS answers, redirect re-validation, `testConnection()`, `executeTextGeneration()`, and built-in integration preservation).
- **Verification Commands & Real Results**:
  - `npm test`: **103 passing tests across 8 suites, 0 failures, 0 skipped** (~10.0s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - `curl -s http://localhost:3000/api/ai/health`: HTTP 200 OK.
- **Architectural Notes & Limitations**:
  - Node.js global `fetch` does not support custom socket dialers or per-request IP pinning without custom `undici.Agent` dispatchers.
  - ILLUMATRIX enforces the strongest safe solution for this architecture:
    1. Pre-flight multi-answer DNS lookup checking *every* resolved IP address.
    2. Forced `redirect: 'manual'` preventing automated unvalidated redirects.
    3. Per-hop URL parsing and SSRF re-validation before following any redirect (up to 3 hops).
    4. Origin-change Authorization header scrubbing on redirect.

### Task 1.2: End-to-End Workflow Regression Suite
- **Objective**: Create and harden deterministic regression tests covering all seven workflow stages (Setup & Rules, Source Library, Script Studio, Scene Prompts, SEO Package, Thumbnail Studio, Review & Export).
- **Files Changed**:
  - `/tests/e2e-workflow-regression.test.ts` (Expanded to 16 comprehensive tests covering: stage status computation, format/duration invariants, source text fidelity & soft-deletion, script breakdown & approval rollback, visual style regeneration byte-for-byte invariant, A/B SEO metadata & timestamp alignment, dual thumbnail options & format responsiveness, readiness audit blocker/warning evaluations, stage-to-stage navigation persistence, backup export/restore roundtrip, single deliverable regeneration isolation, cascading invalidation matrix, safe error handling, prerequisite gating & unsaved edits protection, long-form duration pacing for `[3, 4, 5, 8, 10]` minutes, Hindi Devanagari language consistency, and complete 6-format export verification with strict zero-secret audit).
  - `/src/services/storage.ts` (Fixed generic conditional return type for `loadActiveScriptVersion` supporting fallback objects in testing).
- **Verification Commands & Real Results**:
  - `npm test`: **119 passing tests across 9 suites, 0 failures, 0 skipped** (~2.9s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - Dev server HTTP checks: `http://localhost:3000/api/ai/health` (HTTP 200 OK) and `http://localhost:3000/` (HTTP 200 OK).

### Task 1.3A: SSRF DNS Rebinding Risk Assessment
- **Objective**: Conduct formal security audit of custom-provider endpoint handling (`src/server/urlSafetyValidator.ts`, `providerManager.ts`, `server.ts`) for DNS rebinding and TOCTOU vulnerabilities.
- **Findings & Verdict**:
  - **Verdict**: **VULNERABLE to DNS Rebinding / TOCTOU IP Pinning Bypass**.
  - **Mechanisms Identified**:
    1. `safeSsrfFetch` calls `validateCustomProviderUrl` at $T_0$, which validates all IPs returned by `dns.promises.lookup`.
    2. However, at $T_1$, `safeSsrfFetch` dispatches via Node global `fetch(currentUrl)`, which executes an independent, unpinned DNS lookup through Node's internal network stack.
    3. An attacker with a 0-TTL or split-response DNS server can return a public IP at $T_0$ (passing validation) and a prohibited IP (e.g. `169.254.169.254` or `127.0.0.1`) at $T_1$, bypassing the check entirely.
    4. Minor gap: Deprecated IPv4-compatible IPv6 (`::127.0.0.1`) is not checked in `isRestrictedIpv6`.
    5. Denial-of-service exposure: `safeSsrfFetch` lacks a default timeout and response body byte cap.
- **Remediation Path Designed**: Pinned-socket transport utilizing native Node `node:https` and `node:http` with custom `lookup` or agent-level IP pinning, strictly preserving TLS SNI and certificate hostname verification.
- **Status**: **Assessment Completed & Verified.**

### Task 1.3B: SSRF Transport Hardening & Deterministic IP Pinning (Completed & Verified)
- **Objective**: Remediate SSRF DNS rebinding and TOCTOU vulnerabilities by implementing deterministic socket-level IP pinning, transport resource limits, and IPv4-compatible IPv6 filtering.
- **Implementation Highlights**:
  - `src/server/urlSafetyValidator.ts`:
    - Implemented `pinnedHttpRequest()` using native Node `node:https` and `node:http`.
    - Integrated a custom `lookup` callback on the request options that resolves exclusively to `pinnedIp` (handling Node 22's `all: true` signature), preventing any secondary or unvalidated DNS resolution.
    - Preserved `parsed.hostname` for HTTP `Host` header and TLS SNI (`servername`), strictly enforcing TLS certificate validation (`rejectUnauthorized: true`).
    - Configured a 10-second default request timeout (`DEFAULT_SSRF_TIMEOUT_MS = 10000`), terminating slow or hanging connections with `category: 'TIMEOUT'` and HTTP status 504.
    - Configured a 5 MiB maximum response body size (`MAX_SSRF_RESPONSE_BYTES = 5 * 1024 * 1024`), promptly aborting oversized responses with `category: 'PAYLOAD_TOO_LARGE'` and HTTP status 413.
    - Enforced full stream, socket, timer, and `AbortSignal` cleanup on success, abort, timeout, and errors.
    - Updated `safeSsrfFetch()` to validate every hop, pin each redirect independently, enforce bounded redirects (max 3 hops), and strip `Authorization` headers on cross-origin redirects.
    - Closed the IPv6 classification gap in `parseIpv6Words()` and `isRestrictedIpv6()` for deprecated IPv4-compatible IPv6 addresses (`::127.0.0.1`, `::169.254.169.254`, `::10.0.0.1`) and IPv4-translated IPv6 addresses (`::ffff:0:a.b.c.d`).
- **Tests Added**:
  - Added 14 deterministic automated tests in `tests/api-provider-manager.test.ts` covering IPv4-compatible IPv6 blocking, deterministic IP pinning with Host preservation, anti-DNS rebinding/TOCTOU socket guarantee, multi-answer DNS rejection, redirect revalidation and independent pinning, cross-origin Authorization stripping, redirect hop limits, timeout enforcement (HTTP 504), payload size capping (HTTP 413), caller `AbortSignal` cancellation, provider manager `testConnection()` and `executeTextGeneration()` blocking without secret leaks, and preservation of built-in providers (`Google GenAI`, Groq default, OpenRouter default).
- **Verification Commands & Real Results**:
  - `npm test`: 133 passing tests across 10 test suites (duration ~3s, 0 failures, 0 skipped).
  - `npm run lint`: Clean (`tsc --noEmit`, 0 diagnostics).
  - `npm run build`: Production bundle built cleanly via Vite (`vite build`).
- **Status**: **Verified Completed**.

### Task 1.4A: Provider Execution & Cost Policy Audit (Completed & Verified)
- **Objective**: Conduct comprehensive assessment of existing provider execution engine, backend cost policies, Auto Free selection, BYOK behavior, and fallback handling without modifying application logic.
- **Key Findings**:
  1. **Server-Side Cost Policy & Auto Free Unimplemented**: `classifyOpenRouterPricing` in `modelCompatibility.ts` correctly verifies zero-priced vs paid tokens ($0.00/1M check), but `providerManager.executeTextGeneration` and `server.ts` endpoints do not accept or enforce a `costPolicy` parameter (`free_only`, `prefer_free`, `cost_controlled`, `manual`). Execution executes whatever `modelId`/`connectionId` is targeted.
  2. **Failover Ignores Cost Tiers**: In `providerManager.ts` (lines 2398-2420, 2577-2598), `allowFailover` checks only `quotaPool` mismatch and enabled status, failing to verify `c.pricing?.pricingTier`. A free route could failover to a paid route if both have `allowFailover: true`.
  3. **Connection Testing Triggers Live Generative Tokens**: `testConnection()` in `providerManager.ts` sends live generation requests (`Say OK`, max 5 tokens). For paid models on paid connections, this dispatches real billable inferences without cost warnings or user confirmation.
  4. **Silent Provider Switch on Unrecognized Connection ID**: In `executeTextGeneration`, if a non-existent `connectionId` is passed, the server defaults to `connections.find(c => c.isEnabled) || connections[0]`, silently switching to an unintended provider instead of returning HTTP 404 / `CONNECTION_NOT_FOUND`.
  5. **Credential Security & Zero Secrets Verified**: Key masking, dynamic env loading (`process.env.GEMINI_API_KEY`), error sanitization, `.provider_connections.json` zero-secret persistence, and export scrubber are verified secure with 100% test pass rate.
  6. **SSRF Transport Hardening Verified**: Socket-level IP pinning and safe transport verified secure.
- **Status**: **Audit Completed & Verified (Assessment Only)**.

### Task 1.4B: Provider Execution & Cost Policy Remediation (Completed & Verified)
- **Objective**: Remediate the four core provider execution, cost policy, failover, and testing vulnerabilities (`COST-01`, `COST-02`, `COST-03`, `ROUTE-01`).
- **Remediations Implemented**:
  1. **Strict Connection Resolution (`ROUTE-01`)**:
     - `getEffectiveCredentials()` and `executeTextGeneration()` in `src/server/providerManager.ts` strictly fail closed with error category `CONNECTION_NOT_FOUND` and HTTP status 404 when a caller provides a `connectionId` that does not exist in the configured connection directory.
     - Silent substitution of the default connection is eliminated.
     - BYOK requests strictly execute against the requested connection and its specific credentials without cross-connection leakage.
  2. **Server-Side Cost Policy Enforcement (`COST-01`)**:
     - Added server-side cost policy validation in `src/server/providerManager.ts` (`evaluateConnectionPricing`) and integrated into all AI generation endpoints in `server.ts`.
     - `free_only`: Enforces zero-cost verification via trusted metadata. Blocks paid, unverified, missing, or ambiguous pricing models before dispatch with error category `PAYWALL_BLOCKED` and HTTP status 402. Does not rely on `:free` substring in model names.
     - `prefer_free`: Prefers zero-cost models, but rejects paid model execution unless explicit authorization is granted (`allowPaidExecution: true`).
     - `manual`: Enforces connection validity and fails closed on paid models unless `allowPaidExecution: true`.
     - Error handler `handleGenerationError` maps errors uniformly across all generation routes.
  3. **Failover Cost-Tier Isolation (`COST-02`)**:
     - `findEligibleFailoverConnection()` verifies destination connection eligibility, enabled state, valid credentials, and cost policy compliance.
     - `free_only` failover never transitions to paid or unverified connections.
     - `prefer_free` cannot cross into paid connections without explicit authorization (`allowPaidExecution: true`).
     - Connection and credential isolation are strictly maintained across failover hops.
  4. **Safe Connection Testing (`COST-03`)**:
     - Hardened `testConnection()` in `src/server/providerManager.ts`:
       - Dispatches non-generative connectivity/catalog checks where supported by the provider (Google GenAI `/v1beta/models`, OpenRouter `/api/v1/auth/key`, Groq `/v1/models`).
       - For paid models or providers requiring generative tests, requires explicit authorization (`allowBillableTest: true`) or fails closed with `BILLABLE_TEST_REQUIRED` (HTTP 402).
  5. **Deterministic Regression Suite**:
     - 10 automated test suites added in `tests/cost-policy-remediation.test.ts` validating all scenarios.
- **Affected Files**: `src/server/providerManager.ts`, `src/server/modelCompatibility.ts`, `server.ts`, `tests/cost-policy-remediation.test.ts`, `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md`.
- **Verification Commands & Real Results**:
  - `npm test`: **144 passing tests across 11 suites, 0 failures, 0 skipped** (~5.5s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - Full-stack dev server: Running Express + Vite on `http://0.0.0.0:3000`.
- **Status**: **Completed & Verified**.

### Task 2.1: Secure Key Storage Migration (Completed & Verified)
- **Objective**: Audit and securely migrate provider API-key storage. Eliminate plaintext credentials at rest, enforce cryptographic encryption at rest, centralize secret redaction, and implement origin protection for provider management APIs.
- **Remediations Implemented**:
  1. **Audited All Credential Pathways**: Inspected UI inputs, in-memory state, disk persistence, API responses, logging, and backup exports. Plaintext storage at rest for BYOK keys in `.provider_connections.json` identified and remediated.
  2. **Cryptographic Encryption at Rest (`src/server/credentialSecurity.ts`)**:
     - Standard AES-256-GCM authenticated encryption (AEAD) with 128-bit authentication tag.
     - Key derivation via RFC 5869 HKDF-SHA256 with domain separation.
     - Random 12-byte IV per encryption; formatted as `enc:v1:<base64-iv>:<base64-tag>:<base64-ciphertext>`.
     - Tampering or corrupted tag fails closed with `DecryptionFailedError`.
  3. **Server-Side Storage Boundary & Fail-Closed Behavior**:
     - Precedence: `ILLUMATRIX_ENCRYPTION_KEY` / `KEY_ENCRYPTION_SECRET` environment variables -> dedicated local single-tenant master key file (`.encryption_master_key` mode `0o600`).
     - When master key is unconfigured/disabled (`ILLUMATRIX_DISABLE_FILE_KEY=true`), persistent disk encryption fails closed with `MasterKeyMissingError` (HTTP 500); BYOK keys are held strictly in memory for the active process without leaking plaintext to disk (`apiKey: ""` on disk).
     - Legacy plaintext auto-migration: When `.provider_connections.json` is loaded with legacy plaintext keys, it automatically encrypts them to `enc:v1:...` and overwrites disk with plaintext erased.
  4. **Centralized Secret Redaction**: Centralized `redactSecretString`, `redactHeaders`, `redactObject`, and `sanitizeError` covering all provider prefixes (Google AI Studio, OpenAI, OpenRouter, Groq, Cerebras, Hugging Face, SambaNova), auth headers, and query parameters.
  5. **Cross-Site & Origin Protection**: Implemented `validateProviderAccessOrigin` on `/api/providers` rejecting foreign web origins with HTTP 403 `FORBIDDEN`.
  6. **Environment & Repository Hygiene**: Hardened `/.gitignore` to ignore `.provider_connections.json*`, `*.key`, `*.secret`, `.env*`. Updated `/.env.example` with placeholders for `ILLUMATRIX_ENCRYPTION_KEY` and optional provider keys.
- **Affected Files**: `src/server/credentialSecurity.ts`, `src/server/providerManager.ts`, `server.ts`, `tests/secure-key-storage.test.ts`, `package.json`, `/.gitignore`, `/.env.example`, `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md`.
- **Verification Commands & Real Results**:
  - `npm test`: **155 passing tests across 11 suites, 0 failures, 0 skipped** (~6.8s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - Full-stack dev server: Running Express + Vite on `http://0.0.0.0:3000`.
- **Status**: **Completed & Verified**.

### Task 2.2: Live Catalog Discovery Caching & Cooldowns (Completed & Verified)
- **Objective**: Implement reliable server-side caching, single-flight deduplication, bounded exponential cooldowns, and stale-if-error fallback for live provider and model discovery.
- **Architectural Implementation**:
  1. **Centralized In-Memory Catalog Cache (`src/server/catalogCache.ts`)**:
     - **Safe Credential Fingerprinting**: `createCredentialFingerprint(apiKey)` generates a deterministic 16-character SHA-256 hash (`k:<digest16>` or `k:none`). Raw keys are strictly forbidden from cache keys, logs, or diagnostics.
     - **Cache Key Strategy**: `<provider>|<connectionId>|<normalizedBaseUrl>|<keyFingerprint>` isolates provider, connection identity, endpoint URL, and key changes.
     - **Configurable TTL**: 30 minutes (`1,800,000 ms`) default. Overridable per instance; injectable mock clock supports deterministic unit tests without real delays.
     - **Single-Flight Deduplication**: `executeSingleFlight()` stores in-flight Promises, sharing a single active network fetch across concurrent callers for the same key.
     - **Defensive Immutability & Memory Bound**: All cache inputs and outputs are deep-cloned via `structuredClone`. Storage is bounded to 100 entries with automatic expired and LRU (least-recently-used) eviction.
  2. **Provider Failure Cooldowns & Exponential Backoff**:
     - Applied to transient network failures, timeouts, rate limits (HTTP 429), and server errors (HTTP 5xx).
     - Bounded exponential backoff: `Math.min(maxCooldownMs, baseCooldownMs * 2^(failureCount - 1))` with base = 5s, max = 300s (5 minutes).
     - HTTP `Retry-After` header parsing (seconds or HTTP-date) safely clamped between 1s and 300s.
     - Authentication failures (HTTP 401, 403, `INVALID_CREDENTIALS`, `AUTH_ERROR`) bypass exponential suppression (cooldown = 0) so credential updates can be verified immediately.
     - Successful discovery calls `recordSuccess()` to clear cooldowns and reset failure counters.
  3. **Stale-If-Error Policy**:
     - When an upstream discovery request fails or active cooldown blocks refresh, any cached catalog within a 24-hour window is returned with `source: 'cached_catalog'`, `isStale: true`, `cooldownRemainingSec`, and clear `staleReason`.
     - Never claims stale data is live.
     - If no prior catalog exists, fails closed with the provider error category (`COOLDOWN_ACTIVE`, `RATE_LIMIT_429`, `SERVER_ERROR`, `INVALID_CREDENTIALS`).
  4. **Untrusted Remote Input Protection**:
     - Bounded response body sizes capped at 5 MiB (`checkPayloadSize`).
     - Bounded catalog list parsing capped at 2,000 models (`validateAndSanitizeCatalogPayload`) to prevent memory/CPU exhaustion.
     - Strict type checking ensuring non-empty string IDs and truncated string descriptions.
  5. **Custom Provider SSRF Safety**:
     - Integrates with `validateCustomProviderUrl` and `safeSsrfFetch` for OpenAI-Compatible custom endpoints, ensuring socket-level IP pinning, TLS verification, and redirect re-validation.
- **Affected Files**:
  - `src/server/catalogCache.ts` (Created)
  - `src/server/providerManager.ts` (Updated)
  - `server.ts` (Updated)
  - `tests/catalog-cache-cooldown.test.ts` (Created)
  - `package.json` (Updated)
  - `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md` (Updated)
- **Verification Commands & Real Results**:
  - `npm test`: **169 passing tests across 12 suites, 0 failures, 0 skipped** (~6.1s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - Full-stack dev server: Running Express + Vite on `http://0.0.0.0:3000`.
- **Status**: **Completed & Verified**.

### Task 3.1: Shared AI Execution Interface & Orchestration Engine (Completed & Verified)
- **Objective**: Design and implement a shared, typed AI execution interface across all provider integrations (`Google GenAI`, `Groq`, `OpenRouter`, and `OpenAI Compatible` family). Reduce duplicated execution logic across endpoints while strictly preserving provider-specific behavior, security controls (`ROUTE-01` strict routing, SSRF validation, `COST-01`/`COST-02` cost policy enforcement), failover isolation, and backward compatibility.
- **Architectural Implementation**:
  1. **Typed Execution Contracts (`src/server/aiExecutionEngine.ts`)**:
     - `AIExecutionTaskType`: Standardized taxonomy (`script_generation`, `scene_prompts`, `style_regeneration`, `single_scene_prompt`, `thumbnail_prompts`, `single_thumbnail`, `seo_generation`, `general_text`, `connectivity_test`).
     - `AIExecutionRequest`: Fully typed interface with inputs for connection identity, model selection, prompt, system instruction, JSON response formats/schemas, temperature, max tokens, cost policy, explicit paid execution authorization, timeout, cancellation signals, custom DNS resolvers, and failover options.
     - `AIExecutionResult`: Normalized success output with text, parsed JSON data, provider/model provenance, latency, usage token tracking (`promptTokens`, `completionTokens`, `totalTokens`), fallback/failover indicators, and raw responses.
     - `AIExecutionError`: Subclassed structured error with status codes, categories (`CONNECTION_NOT_FOUND`, `PAYWALL_BLOCKED`, `INVALID_PAYLOAD`, `UNSUPPORTED_MODALITY`, `SSRF_BLOCKED`, etc.), connection context, and secret-scrubbed JSON serialization.
  2. **Modular Provider Adapters (`ProviderExecutionAdapter`)**:
     - `GoogleGenAIAdapter`: Leverages `@google/genai` with `ThinkingLevel.LOW` for `gemini-3.8-flash`, structured JSON schemas via `Type`, usage token extraction, and 503 high-demand transient retries.
     - `GroqAdapter`: Bearer auth, OpenAI format JSON object response mode, automatic retry on 400 rejection without `response_format`, and usage token tracking.
     - `OpenRouterAdapter`: Includes `HTTP-Referer` and `X-Title` provenance headers, Bearer auth, and usage token tracking.
     - `OpenAICompatibleAdapter`: Universal adapter for OpenAI, Cerebras, Cloudflare Workers AI (with Account ID validation), Hugging Face, Mistral AI, SambaNova, Ollama, and OpenAI Compatible custom endpoints using `safeSsrfFetch`.
  3. **Shared Orchestration Pipeline (`AIExecutionEngine.execute()`)**:
     - Step 1: Strict Connection Resolution (`ROUTE-01`: unknown `connectionId` fails closed with HTTP 404 `CONNECTION_NOT_FOUND`).
     - Step 2: Connection Status Check (disabled connection rejected with HTTP 400 `DISABLED`).
     - Step 3: Credential Resolution (resolves key inside server boundary; HTTP 401 `KEY_UNCONFIGURED` if missing).
     - Step 4: Model Resolution (explicit override or connection baseline).
     - Step 5: Cost Policy Pre-Flight (`COST-01`: `free_only` and `prefer_free` fail closed with HTTP 402 `PAYWALL_BLOCKED` on paid or unverified models without `allowPaidExecution: true`).
     - Step 6: Modality & Compatibility Pre-Flight (checks `isTextGenerationCapable`, HTTP 400 `UNSUPPORTED_MODALITY`).
     - Step 7: SSRF Pre-Flight (validates custom endpoints via `validateCustomProviderUrl`, HTTP 400 `SSRF_BLOCKED` / `UNSUPPORTED_PROTOCOL`).
     - Step 8: Adapter Selection & Execution (tracks latency, updates connection stats, defensive copy).
     - Step 9: Failover Handling (`COST-02`: on 429/quota, if `allowFailover === true`, searches eligible failover obeying cost policy parity; fails over with `isFallback: true` and `failoverOccurred: true`).
     - Step 10: Seamless Backward-Compatibility: `providerManager.executeTextGeneration` delegates directly to `aiExecutionEngine.executeTextGeneration`.
- **Affected Files**:
  - `src/server/aiExecutionEngine.ts` (Created)
  - `src/server/providerManager.ts` (Updated)
  - `package.json` (Updated)
  - `tests/shared-execution-interface.test.ts` (Created)
  - `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md` (Updated)
- **Verification Commands & Real Results**:
  - `npm test`: **182 passing tests across 13 suites, 0 failures, 0 skipped** (~8.4s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
  - Full-stack dev server: Running Express + Vite on `http://0.0.0.0:3000`.
- **Status**: **Completed & Verified**.

### Task 3.2: Execution Engine Integration & Legacy Path Elimination (Completed & Verified)
- **Objective**: Audit and complete the integration of the shared `AIExecutionEngine` across all AI-generation workflows and provider execution paths. Eliminate unsafe or redundant legacy execution paths.
- **Route Integration & Audit Findings**:
  - `POST /api/ai/generate-script`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'script_generation'`.
  - `POST /api/ai/regenerate-scene`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'script_generation'`.
  - `POST /api/ai/generate-scene-prompts`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'scene_prompts'`.
  - `POST /api/ai/regenerate-style-prompts`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'style_regeneration'`.
  - `POST /api/ai/regenerate-scene-prompt`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'single_scene_prompt'`.
  - `POST /api/ai/generate-seo`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'seo_generation'`.
  - `POST /api/ai/generate-thumbnails`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'thumbnail_prompts'`.
  - `POST /api/ai/regenerate-single-thumbnail`: Dispatches through `providerManager.executeTextGeneration` with `taskType: 'single_thumbnail'`.
  - `POST /api/ai/render-thumbnail-image`: Migrated from direct SDK call to `aiExecutionEngine.executeImageGeneration` (`GoogleGenAIAdapter`, `gemini-3.1-flash-lite-image`).
  - `POST /api/ai/repair-flow-rejection`: Retained deterministic local policy engine via `PromptSafetyEngine.reviewPrompt()` (no external LLM calls).
  - `POST /api/providers/test`: Retained non-generative / SSRF-pinned probe pipeline to protect user credits.
- **Legacy Paths Eliminated**:
  - `cachedAiClient`, `lastApiKey`, and `getAiClient()` in `server.ts` completely removed.
  - `generateWithModelFallback()` in `server.ts` completely removed.
  - Direct `new GoogleGenAI()` call inside `render-thumbnail-image` eliminated.
- **Security & Cost Invariants Enforced**:
  - `ROUTE-01`: Explicit unknown `connectionId` fails closed with HTTP 404 `CONNECTION_NOT_FOUND`.
  - `COST-01`: Restrictive cost policies (`free_only`, `prefer_free`) block paid/unverified models before dispatch with HTTP 402 `PAYWALL_BLOCKED`.
  - `COST-02`: Multi-connection failover obeys cost-tier parity and credential isolation.
  - BYOK credential isolation: Dynamic server-side resolution; zero cleartext key leakage in responses, logs, or error dumps.
  - Disabled connections blocked before dispatch with HTTP 400 `DISABLED`.
  - Modality validation: Mismatched modalities blocked before dispatch with HTTP 400 `UNSUPPORTED_MODALITY`.
  - Custom endpoint SSRF validation: Socket-level IP pinning and DNS validation preserved.
- **Files Changed**:
  - `/server.ts` (Eliminated legacy fallback functions, exported `app`, passed `taskType` across all routes, routed `render-thumbnail-image` through `aiExecutionEngine.executeImageGeneration`, guarded `startServer` against test runners).
  - `/src/server/aiExecutionEngine.ts` (Added unshift registration for mock adapters, added `unregisterAdapter()`, verified SSRF and modality routing).
  - `/src/server/providerManager.ts` (Added `taskType` to `executeTextGeneration` signature, enhanced `handleGenerationError` with `KEY_UNCONFIGURED` HTTP 401, `TIMEOUT` HTTP 504, and `UNSUPPORTED_PROVIDER` HTTP 400).
  - `/src/server/modelCompatibility.ts` (Classified `gemini-3.1-flash-lite-image` and `-image` suffixed models under primaryModality `image`).
  - `/package.json` (Added `NODE_ENV=test` and `tests/execution-engine-integration.test.ts` to test script).
  - `/tests/execution-engine-integration.test.ts` (Created comprehensive route-level integration test suite with 19 test cases across 9 sections).
- **Verification Commands & Real Results**:
  - `npm test`: **201/201 tests passing across 14 suites, 0 failures, 0 skipped** (~7.6s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.3: AI Execution Security & Reliability Audit (Completed & Verified)
- **Objective**: Conduct comprehensive security and reliability audit of the shared AI execution architecture across image generation, bounded retry and failover semantics, cost policy authorization, provider adapter contracts, connection testing, and discovery boundaries.
- **Audit Findings & Remediations**:
  1. **Image Generation Modality & Cost Isolation**:
     - Audited `aiExecutionEngine.executeImageGeneration()`, `GoogleGenAIAdapter`, and `POST /api/ai/render-thumbnail-image`.
     - Strict connection resolution (404 on unknown `connectionId`), BYOK credential isolation, and disabled connection rejection (HTTP 400).
     - Paid-model authorization & cost-policy enforcement: `gemini-3.1-flash-lite-image` is classified as `pricingTier: 'paid'`, requiring `allowPaidExecution: true` under `prefer_free`, and failing closed with HTTP 402 `PAYWALL_BLOCKED` under `free_only`.
     - Modality validation fails closed (HTTP 400 `UNSUPPORTED_MODALITY`) if non-Google provider or incompatible model is selected.
     - Added 10 MB payload size upper bound check (HTTP 413) on returned base64 image bytes.
     - Added cancellation pre-flight check before image generation dispatch.
     - Endpoint returns strictly sanitized `{ success, provider, isFallback, imageUrl, optionId, timestamp }` with zero secrets, headers, or internal debugging dumps.
  2. **Bounded Retries & Replay Protection**:
     - Verified retry counts and delays are strictly bounded: `GoogleGenAIAdapter` only retries transient HTTP 503 high-demand errors once after a 700ms delay.
     - Groq and OpenAICompatible adapters only retry once on HTTP 400 when omitting unsupported `response_format: { type: 'json_object' }` (0 tokens generated).
     - Potentially billable errors (HTTP 500, mid-generation failures) are never replayed.
     - Authentication (401/403), validation (400), SSRF (400), and paywall (402) errors fail closed immediately with zero retries.
  3. **Cost Policy Pre-Flight & Payload Formatting**:
     - Fixed payload validation ordering: malformed `costPolicy` values (`invalid_policy`, `FREE`, `unlimited`, non-strings) now fail closed at Step 0 with HTTP 400 `INVALID_PAYLOAD` before connection resolution.
     - Unverified, missing, or ambiguous pricing does not qualify as zero-cost ($0.00/1M positive verification required).
  4. **Adapter Client Caching & Invalidation**:
     - Updated `GoogleGenAIAdapter.getClient` to cache clients using composite key `${connId}:${apiKey}:${timeoutMs}`.
     - Added `invalidateCache(connId?: string)` on `GoogleGenAIAdapter` and `aiExecutionEngine.invalidateClientCache()`.
     - Integrated cache invalidation into `providerManager.addOrUpdateConnection` and `deleteConnection`, ensuring credentials changes or connection deletions immediately purge cached client instances.
  5. **Pre-Flight Cancellation**:
     - Added `req.signal?.aborted` pre-flight check at Step 0 of `AIExecutionEngine.execute()`, aborting with HTTP 499 before any provider dispatch or adapter lookup occurs.
- **Affected Files**:
  - `/src/server/aiExecutionEngine.ts` (Composite key caching, `invalidateClientCache()`, Step 0 cancellation and cost policy validation, image payload size limit).
  - `/src/server/providerManager.ts` (Integrated client cache invalidation on update and deletion).
  - `/.gitignore` (Restored root `.gitignore` ignoring `.env*`, `.provider_connections.json`, `dist/`, `node_modules/` while allowing `!.env.example`).
  - `/.env.example` (Created with `GEMINI_API_KEY=` and provider configuration).
  - `/tests/security-reliability-audit.test.ts` (Expanded to 23 automated tests covering all 12 security regression requirements).
- **Verification Commands & Real Results**:
  - `npm test`: **225/225 tests passing across 15 suites, 0 failures, 0 skipped** (~9.1s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.3.1: Credential Cache & Execution Boundary Hardening (Completed & Verified)
- **Objective**: Harden credential-safe SDK caching, multi-candidate image-response memory limits, and server-side authorization boundaries for billable execution.
- **Implementation & Remediations**:
  1. **Credential-Safe SDK Client Caching**:
     - Extracted non-reversible cryptographic fingerprinting function `createCredentialFingerprint(apiKey)` into `src/server/credentialSecurity.ts` (derived via SHA-256 prefix: `k:<sha256(16)>` or `k:none`).
     - Keyed `GoogleGenAIAdapter.clientCache` by `${connId}:${fingerprint}:${timeoutMs}`, completely removing raw API keys from cache map keys, memory objects, and logs.
     - Implemented bounded cache capacity (`MAX_GOOGLE_CLIENT_CACHE_ENTRIES = 50`) with LRU eviction to prevent memory accumulation.
     - Implemented `getCacheDiagnostics()` on `GoogleGenAIAdapter` and `getGoogleClientCacheDiagnostics()` on `AIExecutionEngine`, returning connection IDs and fingerprints with zero raw secrets.
  2. **Image-Response Memory Limits & Multi-Candidate Defense**:
     - Defined explicit bounds: `MAX_IMAGE_BASE64_LENGTH = 10 * 1024 * 1024` (10 MB string length) and `MAX_IMAGE_DECODED_BYTES = 7.5 * 1000 * 1000` (7.5 MB binary bytes).
     - Traversed all candidates and parts in `GoogleGenAIAdapter.execute()`, calculating aggregate base64 length (`aggregateBase64Length`) to prevent multi-part limit bypasses (HTTP 413).
     - Validated base64 structure (modulo-4 length and `^[A-Za-z0-9+/]+={0,2}$` regex), rejecting malformed data with HTTP 400 `INVALID_PAYLOAD`.
     - Calculated exact decoded byte size `(length * 3 / 4) - padding`, failing closed with HTTP 413 if decoded bytes exceed 7.5 MB.
     - Deferred data URL allocation (`data:...;base64,...`) until after all validation checks succeed.
     - Documented upstream SDK buffering constraints: `@google/genai` buffers HTTP responses in memory before returning `GenerateContentResponse`; application checks prevent downstream allocations, URL retention, and serialization bloat.
  3. **Server-Side Authorization Boundaries**:
     - Added Step 0 parameter validation in `AIExecutionEngine.execute()` enforcing strict boolean type for `allowPaidExecution`, failing closed with HTTP 400 `INVALID_PAYLOAD` on non-boolean inputs.
     - Passed `allowPaidExecution` uncoerced in `/api/ai/render-thumbnail-image` to preserve validation integrity.
     - Confirmed `free_only` cost policy unconditionally blocks paid models with HTTP 402 `PAYWALL_BLOCKED` even when `allowPaidExecution: true`.
  4. **Automated Regression Suite (`tests/security-reliability-audit.test.ts`)**:
     - Added 12 new automated tests (tests 24 to 35).
- **Verification Commands & Real Results**:
  - `npm test`: **237/237 tests passing across 15 suites, 0 failures, 0 skipped** (~9.7s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.4B: Setup UI Inputs for Target Audience & Call to Action (REM-01)
- **Objective**: Implement REM-01 by adding user-facing Target Audience and Call to Action input controls to Stage 01 Setup, wiring them to `project` state, local storage persistence, backup serialization, and script / SEO prompt construction.
- **Key Changes**:
  1. **Stage 01 UI (`src/components/stages/SetupWorkspace.tsx`)**:
     - Added a collapsible "Audience & Conversion" section right below Visual Style Selector.
     - Controls:
       - Target Audience single-line input (`id="target-audience-input"`, placeholder `"Curious science and astronomy enthusiasts"`, max 150 chars, character counter).
       - Call to Action single-line input (`id="call-to-action-input"`, placeholder `"Subscribe for weekly deep-space explainers"`, max 150 chars, character counter).
     - State binding: reads `project.targetAudience || ''` and `project.callToAction || ''`; calls `updateProject({ targetAudience: e.target.value })` and `updateProject({ callToAction: e.target.value })`.
     - Preserves state across collapse/expand without resets.
  2. **Persistence & Deserialization (`src/services/storage.ts`)**:
     - `loadProject`: Explicitly validates `typeof parsed.targetAudience === 'string'` and `typeof parsed.callToAction === 'string'` to safely preserve empty strings and fall back gracefully.
     - `importProjectBackupJson`: Safely validates both fields, guaranteeing backward-compatibility when importing older backups that lack them.
  3. **Data Flow & Prompt Sanitization (`WorkflowContext.tsx`, `aiService.ts`, `server.ts`)**:
     - `generateScriptWithAI` passes `targetAudience` and `callToAction`.
     - `generateSeoWithAI` passes `targetAudience` and `callToAction`.
     - `/api/ai/generate-script` slices context strings to 200 characters max (`String(...).slice(0, 200)`).
     - `/api/ai/generate-seo` slices context strings to 200 characters max (`String(...).slice(0, 200)`).
     - Empty or omitted values safely omit prompt lines without literal "undefined" or null leaks.
  4. **Dedicated Automated Regression Suite (`tests/rem01-setup-audience-cta.test.ts`)**:
     - Added 9 tests covering rendering, update handlers, persistence, empty values, legacy backup import, script payload generation, SEO payload generation, prompt sanitization, and length bounding.
- **Verification Commands & Real Results**:
  - `npm test`: **246/246 tests passing across 16 suites, 0 failures, 0 skipped** (~10.4s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.44s).
- **Status**: **Completed & Verified**.

### Task 3.4C: Connect Custom Model Selection to Single-Model Lookup API (REM-02) (Completed & Verified)
- **Objective**: Implement remediation item REM-02 from the Task 3.4A audit. Connect custom model selection in `ProviderManagerModal.tsx` to `POST /api/providers/single-model`, eliminating client-side metadata fabrication and establishing verified API lookups with safe fallbacks.
- **Key Achievements**:
  1. **Backend Integration (`src/server/providerManager.ts` & `server.ts`)**:
     - `fetchSingleModelInfo(provider, modelId, apiKey, connectionId)`: resolves connection, checks cached models, uses OpenRouter live single-model endpoint (`/api/v1/models/:id`) when applicable, classifies pricing with `classifyOpenRouterPricing`, and evaluates compatibility with `evaluateModelCompatibility`.
     - `POST /api/providers/single-model` accepts `connectionId` and resolves credentials on the server side with zero cleartext key leakage.
  2. **Client Service (`src/services/aiService.ts`)**:
     - Added `AIService.fetchSingleModelInfo(...)` with input validation, 12s timeout controller, and error sanitization.
     - Preserved `lookupSingleModel` alias.
  3. **Context Layer (`src/context/WorkflowContext.tsx`)**:
     - Exposed `fetchSingleModelInfo` on `WorkflowContextType` and `WorkflowProvider`.
  4. **Modal Component (`src/components/layout/ProviderManagerModal.tsx`)**:
     - Added loading state `isLookingUpCustomModel`, preventing duplicate clicks and rendering a "Verifying..." spinner.
     - Validates model ID (length <= 200, no control characters).
     - Success state: populates verified model record with real capabilities, pricing, and context length.
     - Failure state: shows informative HUD notice without silently marking model as verified.
     - Explicit fallback: allows user to proceed with unverified model with conservative defaults (`pricingTier: 'unknown'`, `isZeroPriced: false`, `compatibilityStatus: 'unknown'`), which strictly fails closed under `free_only` cost policy.
     - Cancellation: cancel action resets error and candidate state without mutating connection.
  5. **Regression Test Suite (`tests/rem02-custom-model-lookup.test.ts`)**:
      - Added 7 tests covering all requirements, invariants, pricing verification, and error handling.
- **Verification Commands & Real Results**:
  - `npm test`: **253/253 tests passing across 17 suites, 0 failures, 0 skipped** (~24.3s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `compile_applet`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.4D: Clarify UI-Only Provider Simulation Controls (REM-03) (Completed & Verified)
- **Objective**: Implement remediation item REM-03 from Task 3.4A audit. Explicitly identify rate-limit and quota-exhaustion simulation controls as UI-only tests without implying that they change actual server-side provider state or remote quotas.
- **Scope**:
  1. Audited simulation handlers (`simulateRateLimitTest` and `simulateQuotaExhaustedTest` in `src/context/WorkflowContext.tsx`): confirmed both are purely in-memory client React state updates (`setJobs`, `setConnections`, `addActivityEvent`, `showToast`) with zero network calls, zero backend state changes, and zero disk mutations.
  2. Updated button labels in `src/components/layout/ControlCenter.tsx` to explicitly state `SIMULATE RATE LIMIT (UI TEST)` and `SIMULATE QUOTA EXHAUSTED (UI TEST)`. Added accessible `aria-label` attributes.
  3. Added "UI SIMULATION SANDBOX" container header with "UI TEST ONLY" badge and concise helper text: *"Changes simulated UI/test state only. Does not change actual provider cooldowns, quota, credentials, or remote provider state."*
  4. Added explicit button tooltips stating that actions change simulated UI state only and do not alter actual provider cooldowns, quota pools, credentials, or remote state.
  5. Updated resulting error messages, job tasks, activity events, and toast messages in `WorkflowContext.tsx` to consistently state *"Simulated rate limit — UI test"* and *"Simulated quota exhausted — UI test"* with clear disclaimers that actual server provider state and remote quotas are unchanged.
  6. Added truthful tooltip on active connection status badge and connection cards explaining simulated cooldown state without implying remote provider failures.
  7. Added regression test suite `tests/rem03-ui-simulation-controls.test.ts` covering all 7 verification requirements.
- **Verification Commands & Real Results**:
  - `npm test`: **260/260 tests passing across 18 test suites, 0 failures, 0 skipped** (~22.9s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.24s).
- **Status**: **Completed & Verified**.

### Task 3.4E: Remediation Closure & End-to-End Readiness Gate (Completed & Verified)
- **Objective**: Perform a final, evidence-based closure audit of Task 3.4A remediation items REM-01, REM-02, and REM-03, verify the seven-stage workflow integrity, record manual browser verification status, and execute full test/build verification before Phase 4 begins.
- **Scope**:
  1. Audited REM-01, REM-02, and REM-03 across frontend components, storage, services, server routes, security, and tests. All three items verified as closed.
  2. Verified seven-stage end-to-end workflow invariants (exact 8s shorts pacing, byte-for-byte narration preservation, Hindi Devanagari consistency, approval gates, cost policy enforcement, and 6-format export).
  3. Formulated manual browser verification checklist (High-DPI, Clipboard, Modal Focus Trapping, Devanagari rendering) with concise reproduction steps.
  4. Identified that `tests/backend-to-ui-execution-management.test.ts` was an orphan draft test from early Task 3.4 that was superseded by `tests/cost-policy-remediation.test.ts` and `tests/execution-engine-integration.test.ts`, and is not part of the active configured test suite in `package.json`.
- **Verification Commands & Real Results**:
  - `npm test`: **260/260 tests passing across 18 test suites, 0 failures, 0 skipped** (~23.0s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.28s).
- **Status**: **Completed & Verified**.

### Task 4.1: Cost Policy Engine (Completed & Verified)
- **Objective**: Implement a centralized, deterministic Cost Policy Engine providing authoritative decisions on whether a proposed provider/model execution is permitted under the active project policy (`free_only`, `prefer_free`, `manual`).
- **Scope & Delivery**:
  1. **Centralized CostPolicyEngine (`src/server/costPolicyEngine.ts`)**:
     - Typed contracts: `CostPolicyDecision`, `CostPolicyEvaluationContext`, `PolicyValidationResult`, `CostPolicyDecisionReasonCode`.
     - `validatePolicyInput()`: Normalizes `costPolicy` ('free_only', 'prefer_free', 'manual') with whitespace/case handling; defaults omitted policy to 'manual'; rejects invalid strings and non-strings with HTTP 400 `INVALID_PAYLOAD`; validates `allowPaidExecution` strictly as boolean (rejects non-booleans with HTTP 400).
     - `isZeroCostModel()`: Positively verifies zero-cost eligibility ($0.00/1M tokens). Rejects contradictory pricing (e.g. `isZeroPriced: true` with `pricingTier: 'paid'` or non-zero rates), negative rates, NaNs, or missing metadata.
     - `evaluate()`: Centralized deterministic decision maker for `free_only`, `prefer_free`, and `manual`.
     - `evaluateFailoverCandidate()`: Validates candidate suitability for failover with origin zero-cost parity enforcement.
  2. **Core Policy Invariant Enforcement**:
     - `free_only`: Positively verified zero-cost models permitted (`ALLOWED_ZERO_COST`). Paid, unknown, missing, contradictory, or malformed pricing rejected with HTTP 402 `PAYWALL_BLOCKED` (`BLOCKED_FREE_ONLY`). Explicit `allowPaidExecution: true` NEVER overrides `free_only`.
     - `prefer_free`: Verified zero-cost models permitted without authorization. Billable or unverified models strictly require explicit boolean `allowPaidExecution: true`; otherwise rejected with HTTP 402 `PAYWALL_BLOCKED` (`BLOCKED_PAID_UNAUTHORIZED` or `BLOCKED_UNKNOWN_PRICING`).
     - `manual`: Direct execution represents user consent for the selected model unless explicit opt-out (`allowPaidExecution: false`) is provided. Failover from a free connection to a paid candidate strictly requires `allowPaidExecution: true`.
     - Secrets safety: All error and decision messages run through `redactSecretString`. Zero cleartext key, bearer token, or ciphertext leakage.
  3. **Integration Points**:
     - `src/server/aiExecutionEngine.ts`: Step 0 delegates payload validation to `costPolicyEngine.validatePolicyInput()`. Step 5 delegates cost policy enforcement to `costPolicyEngine.evaluate()`.
     - `src/server/providerManager.ts`: `findEligibleFailoverConnection()` delegates candidate evaluation to `costPolicyEngine.evaluateFailoverCandidate()`.
  4. **Dedicated Test Suite (`tests/cost-policy-engine.test.ts`)**:
     - 35 automated tests covering payload validation, zero-cost positive verification, `free_only` invariants, `prefer_free` authorization, `manual` rules, secrets scrubbing, and `aiExecutionEngine.execute()` integration.
- **Affected Files**:
  - `src/server/costPolicyEngine.ts` (new)
  - `src/server/aiExecutionEngine.ts`
  - `src/server/providerManager.ts`
  - `tests/cost-policy-engine.test.ts` (new)
  - `package.json`
  - `IMPLEMENTATION_PLAN.md`
  - `PROJECT_MEMORY.md`
- **Verification Commands & Real Results**:
  - `npx tsx --test tests/cost-policy-engine.test.ts`: **35/35 passing tests, 0 failures** (953ms).
  - `npm test`: **295/295 tests passing across 19 test suites, 0 failures, 0 skipped** (23.5s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

---

## 3. In Progress
- **Item**: Task 4.1 Completed & Verified. Awaiting user review and directive to commence Task 4.2 (Two-Pool Model Management).
- **Upcoming Work**:
  - Phase 4: Task 4.2 Two-Pool Model Management (Verified Free vs BYOK).

---

## 4. Known Issues & Security Risks

| ID | Issue / Risk | Severity | Evidence / Source | Status |
|---|---|---|---|---|
| **SEC-01** | Historical plaintext credentials in previous git commits | **HIGH** | Keys existed in repository before Task 0.3. | **Project owner must revoke/rotate these credentials in Google AI Studio / GCP Console.** |
| **SEC-02** | Missing `.gitignore` at repository root | **RESOLVED** | `.gitignore` created in Task 0.3; hardened in Task 2.1. | **Verified Resolved** |
| **SEC-03** | Custom provider SSRF DNS Rebinding & TOCTOU IP Pinning | **RESOLVED** | Task 1.3B: Socket-level IP pinning (`pinnedHttpRequest`), TLS verification preservation, redirect re-validation, 10s timeout, 5 MiB payload cap, and IPv4-compatible IPv6 filtering implemented and verified. | **Verified Resolved (201/201 tests pass)** |
| **SEC-04** | Vite `allowedHosts: true` | **LOW** | `vite.config.ts` allows any host header. | Documented / Needed for container preview |
| **SEC-05** | Plaintext BYOK API keys stored at rest on server disk | **RESOLVED** | Task 2.1: AES-256-GCM AEAD encryption at rest (`enc:v1:...`) implemented in `credentialSecurity.ts` and `providerManager.ts`. Plaintext `apiKey` on disk permanently eliminated (`""`). | **Verified Resolved (201/201 tests pass)** |
| **SEC-06** | Cross-Origin credential API access from foreign browser websites | **RESOLVED** | Task 2.1: Implemented `validateProviderAccessOrigin` on `/api/providers` rejecting foreign web origins with HTTP 403 `FORBIDDEN`. | **Verified Resolved (201/201 tests pass)** |
| **COST-01** | Centralized Cost Policy Engine integration | **RESOLVED** | Task 4.1: Centralized `CostPolicyEngine` implemented in `src/server/costPolicyEngine.ts` and integrated in `aiExecutionEngine.ts` and `providerManager.ts`. Dedicated suite passing (35 tests). | **Verified Resolved (295/295 tests pass)** |
| **COST-02** | Multi-connection failover does not enforce cost tier parity | **RESOLVED** | Task 1.4B & Task 4.1: `findEligibleFailoverConnection()` delegates to `costPolicyEngine.evaluateFailoverCandidate()` enforcing strict cost policy & pricing tier isolation across failover hops. | **Verified Resolved (295/295 tests pass)** |
| **COST-03** | Provider `testConnection` dispatches live billable generation | **RESOLVED** | Task 1.4B: Non-generative endpoints used where supported; paid generative tests require explicit `allowBillableTest: true` or fail closed with `BILLABLE_TEST_REQUIRED` (402). | **Verified Resolved (201/201 tests pass)** |
| **ROUTE-01**| Unrecognized `connectionId` silently defaults to first enabled connection | **RESOLVED** | Task 1.4B & Task 3.1 & Task 3.2: Unknown explicit `connectionId` strictly fails closed with `CONNECTION_NOT_FOUND` (404). Silent fallback eliminated. | **Verified Resolved (201/201 tests pass)** |
| **TEST-01** | Orphan unconfigured test `backend-to-ui-execution-management.test.ts` in `/tests` | **LOW** | Superseded by `cost-policy-remediation.test.ts` and `execution-engine-integration.test.ts`; not part of `package.json` test script. | Documented / Scheduled for cleanup in release readiness |

---

## 5. Architectural & Product Decisions

| Decision ID | Description | Status | Rationale |
|---|---|---|---|
| **DEC-01** | Long-Form duration: 3-min vs 4-min minimum | **UNRESOLVED / TBD** | Code allows `[3, 4, 5, 8, 10]` min; brief notes a 4-min spec conflict. Existing code is preserved without guessing until product decision. Verified in Task 1.2 regression suite. |
| **DEC-02** | Deployment Model (Single-user vs Multi-user) | **CONFIRMED BASELINE** | Single-user local creative preparation workspace baseline confirmed. Cross-site origin filtering added to `/api/providers`. Multi-tenant session auth remains TBD if hosted multi-user SaaS is planned. |
| **DEC-03** | SEO Package Gate (Optional vs Mandatory) | **CONFIRMED IN CODE** | SEO is treated as optional in Stage 05, but flagged in Stage 07 completeness checklist. Export is permitted with warning. |

---

## 6. Next Exact Task

- **Task ID**: `TASK-4.1-HANDOFF`
- **Goal**: Present Task 4.1 (Cost Policy Engine) completion report to user, wait for review and directive before proceeding to Task 4.2 (Two-Pool Model Management).
- **Scope**: Centralized `CostPolicyEngine` implemented, integrated, and verified with 295/295 passing tests. Zero regressions.




