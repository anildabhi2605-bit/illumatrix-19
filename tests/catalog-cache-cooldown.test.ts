import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogCacheManager,
  catalogCacheManager,
  type CatalogCacheOptions,
} from '../src/server/catalogCache';
import { providerManager } from '../src/server/providerManager';
import type { DiscoveredModel } from '../src/types/hud';

// Injected Mock Clock Helper for Deterministic Testing
function createMockClock(initialTime: number = 1000000) {
  let currentTime = initialTime;
  return {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
      return currentTime;
    },
    set: (time: number) => {
      currentTime = time;
      return currentTime;
    },
  };
}

const mockModel: DiscoveredModel = {
  id: 'gemini-3.1-flash-lite',
  displayName: 'Gemini 3.1 Flash Lite',
  provider: 'Google GenAI',
  description: 'Test model',
  capabilities: {
    supportsText: true,
    supportsImageGeneration: false,
    supportsStructuredJson: true,
    supportsStreaming: true,
    supportsTools: true,
  },
  isAvailable: true,
  source: 'live_api',
  fetchedAt: new Date(1000000).toISOString(),
};

test('Task 2.2: Live Catalog Discovery Caching & Cooldowns', async (suite) => {
  // 1. Successful catalog response is cached and reused within the TTL
  await suite.test('1. A successful catalog response is cached and reused within the TTL', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      ttlMs: 60000, // 60s
      clock: clock.now,
    });

    const key = cache.generateCacheKey({
      provider: 'Google GenAI',
      connectionId: 'conn_test_1',
      apiKey: 'AIzaSySecret123',
    });

    // Initial cache miss
    const miss = cache.get(key);
    assert.equal(miss.hit, false);
    assert.equal(miss.data, undefined);

    // Cache successful discovery
    cache.set(key, [mockModel], { provider: 'Google GenAI', connectionId: 'conn_test_1' });

    // Immediate lookup within TTL hits cache
    const hit1 = cache.get(key);
    assert.equal(hit1.hit, true);
    assert.equal(hit1.isStale, false);
    assert.equal(hit1.data?.length, 1);
    assert.equal(hit1.data?.[0].id, 'gemini-3.1-flash-lite');

    // Advance 30s (still within 60s TTL)
    clock.advance(30000);
    const hit2 = cache.get(key);
    assert.equal(hit2.hit, true);
    assert.equal(hit2.isStale, false);
  });

  // 2. Expired entries trigger refresh
  await suite.test('2. Expired entries trigger refresh after TTL expires', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      ttlMs: 60000, // 60s
      clock: clock.now,
    });

    const key = cache.generateCacheKey({
      provider: 'Groq',
      connectionId: 'conn_groq_1',
      apiKey: 'gsk_secret456',
    });

    cache.set(key, [mockModel], { provider: 'Groq', connectionId: 'conn_groq_1' });

    // Advance 61s past TTL
    clock.advance(61000);

    const expired = cache.get(key);
    assert.equal(expired.hit, false, 'Expired entry must not be returned as a fresh hit');
    assert.equal(expired.isStale, true, 'Expired entry must be recognized as stale for stale-if-error');
  });

  // 3. Concurrent requests for the same key share a single discovery request (single-flight)
  await suite.test('3. Concurrent requests for the same key share a single discovery request (single-flight)', async () => {
    const cache = new CatalogCacheManager();
    const key = 'Google GenAI|conn_concurrent|https://generativelanguage.googleapis.com|k:test1234';

    let executionCount = 0;
    const fetchCatalog = async () => {
      executionCount++;
      // Simulate network latency
      await new Promise((r) => setTimeout(r, 10));
      return [{ ...mockModel, id: 'shared-model-1' }];
    };

    // Dispatch 5 concurrent requests simultaneously
    const promises = [
      cache.executeSingleFlight(key, fetchCatalog),
      cache.executeSingleFlight(key, fetchCatalog),
      cache.executeSingleFlight(key, fetchCatalog),
      cache.executeSingleFlight(key, fetchCatalog),
      cache.executeSingleFlight(key, fetchCatalog),
    ];

    const results = await Promise.all(promises);

    assert.equal(executionCount, 1, 'Single-flight must execute underlying fetch exactly once for concurrent callers');
    assert.equal(results.length, 5);
    for (const res of results) {
      assert.equal(res[0].id, 'shared-model-1');
    }
  });

  // 4. Different connections or endpoints do not share cached results
  await suite.test('4. Different connections or endpoints do not share cached results', () => {
    const cache = new CatalogCacheManager();

    const keyConnA = cache.generateCacheKey({
      provider: 'Google GenAI',
      connectionId: 'conn_alpha',
      apiKey: 'key_111',
    });

    const keyConnB = cache.generateCacheKey({
      provider: 'Google GenAI',
      connectionId: 'conn_beta',
      apiKey: 'key_111',
    });

    const keyEndpointB = cache.generateCacheKey({
      provider: 'OpenAI Compatible',
      connectionId: 'conn_custom',
      baseUrl: 'https://endpoint-a.com/v1',
      apiKey: 'key_shared',
    });

    const keyEndpointC = cache.generateCacheKey({
      provider: 'OpenAI Compatible',
      connectionId: 'conn_custom',
      baseUrl: 'https://endpoint-b.com/v1',
      apiKey: 'key_shared',
    });

    assert.notEqual(keyConnA, keyConnB, 'Different connection IDs must yield distinct cache keys');
    assert.notEqual(keyEndpointB, keyEndpointC, 'Different base URLs must yield distinct cache keys');

    cache.set(keyConnA, [{ ...mockModel, id: 'model-a' }]);
    assert.equal(cache.get(keyConnA).hit, true);
    assert.equal(cache.get(keyConnB).hit, false, 'Connection B must not hit Connection A cache');
  });

  // 5. Credential changes invalidate or isolate prior cached entries
  await suite.test('5. Credential changes invalidate or isolate prior cached entries', () => {
    const cache = new CatalogCacheManager();

    const keyOldKey = cache.generateCacheKey({
      provider: 'Groq',
      connectionId: 'conn_groq_byok',
      apiKey: 'gsk_oldKeyOriginal',
    });

    const keyNewKey = cache.generateCacheKey({
      provider: 'Groq',
      connectionId: 'conn_groq_byok',
      apiKey: 'gsk_newKeyUpdated',
    });

    assert.notEqual(keyOldKey, keyNewKey, 'Cache keys must differ when API key is updated');

    cache.set(keyOldKey, [{ ...mockModel, id: 'groq-model-old' }]);
    assert.equal(cache.get(keyOldKey).hit, true);
    assert.equal(cache.get(keyNewKey).hit, false, 'New key must not inherit old key cached catalog');

    // Invalidation by connection removes all associated keys
    const evicted = cache.invalidateByConnection('conn_groq_byok');
    assert.ok(evicted >= 1);
    assert.equal(cache.get(keyOldKey).hit, false, 'Invalidation must purge connection cache');
  });

  // 6. Failed discovery is not cached as a successful result
  await suite.test('6. Failed discovery is not cached as a successful result', () => {
    const cache = new CatalogCacheManager();
    const cooldownKey = cache.generateCooldownKey({ provider: 'Google GenAI', connectionId: 'conn_fail' });
    const cacheKey = cache.generateCacheKey({ provider: 'Google GenAI', connectionId: 'conn_fail' });

    // Record failure
    cache.recordFailure(cooldownKey, {
      category: 'SERVER_ERROR',
      message: 'HTTP 503 Service Unavailable',
      status: 503,
    });

    // Successful cache must remain empty
    const lookup = cache.get(cacheKey);
    assert.equal(lookup.hit, false, 'Failed discovery must never be cached as a success');
    assert.equal(lookup.data, undefined);
  });

  // 7. Repeated transient failures trigger bounded cooldowns with exponential backoff
  await suite.test('7. Repeated transient failures trigger bounded cooldowns with exponential backoff', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      baseCooldownMs: 5000, // 5s
      maxCooldownMs: 60000, // 60s cap
      clock: clock.now,
    });
    const cooldownKey = 'Google GenAI|conn_transient|';

    // Failure 1: base = 5s
    const fail1 = cache.recordFailure(cooldownKey, { category: 'SERVER_ERROR', message: 'Fail 1', status: 500 });
    assert.equal(fail1.cooldownDurationMs, 5000);
    assert.equal(fail1.cooldownUntil, 1005000);

    // Check active
    const check1 = cache.isCooldownActive(cooldownKey);
    assert.equal(check1.active, true);
    assert.equal(check1.remainingSec, 5);

    // Failure 2: 5s * 2^1 = 10s
    clock.advance(6000); // 1s past first cooldown
    const fail2 = cache.recordFailure(cooldownKey, { category: 'SERVER_ERROR', message: 'Fail 2', status: 500 });
    assert.equal(fail2.cooldownDurationMs, 10000);

    // Failure 3: 5s * 2^2 = 20s
    clock.advance(11000);
    const fail3 = cache.recordFailure(cooldownKey, { category: 'SERVER_ERROR', message: 'Fail 3', status: 500 });
    assert.equal(fail3.cooldownDurationMs, 20000);

    // Failure 4: 5s * 2^3 = 40s
    clock.advance(21000);
    const fail4 = cache.recordFailure(cooldownKey, { category: 'SERVER_ERROR', message: 'Fail 4', status: 500 });
    assert.equal(fail4.cooldownDurationMs, 40000);

    // Failure 5: 5s * 2^4 = 80s -> clamped to maxCooldownMs (60s)
    clock.advance(41000);
    const fail5 = cache.recordFailure(cooldownKey, { category: 'SERVER_ERROR', message: 'Fail 5', status: 500 });
    assert.equal(fail5.cooldownDurationMs, 60000, 'Backoff must clamp strictly at maxCooldownMs');
  });

  // 8. Discovery resumes after cooldown expiration
  await suite.test('8. Discovery resumes after cooldown expiration', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      baseCooldownMs: 5000,
      clock: clock.now,
    });
    const cooldownKey = 'Groq|conn_resume|';

    cache.recordFailure(cooldownKey, { category: 'RATE_LIMIT_429', message: 'Rate limit', status: 429 });

    assert.equal(cache.isCooldownActive(cooldownKey).active, true);

    // Advance clock past cooldown
    clock.advance(6000);

    const check = cache.isCooldownActive(cooldownKey);
    assert.equal(check.active, false, 'Cooldown must expire after duration has elapsed');
    assert.equal(check.remainingSec, 0);

    // Success resets failure count
    cache.recordSuccess(cooldownKey);
    const afterSuccess = cache.recordFailure(cooldownKey, { category: 'NETWORK_ERROR', message: 'New single failure' });
    assert.equal(afterSuccess.cooldownDurationMs, 5000, 'Failure count must reset to 1 after success');
  });

  // 9. Invalid credentials are classified distinctly from transient failures
  await suite.test('9. Invalid credentials are classified distinctly from transient failures', () => {
    const cache = new CatalogCacheManager();
    const cooldownKey = 'Google GenAI|conn_auth_fail|';

    const authFail = cache.recordFailure(cooldownKey, {
      category: 'INVALID_CREDENTIALS',
      message: 'API key not valid. Please pass a valid API key.',
      status: 400,
    });

    assert.equal(authFail.isAuthError, true);
    assert.equal(authFail.cooldownDurationMs, 0, 'Auth errors must not impose exponential backoff suppression');
    assert.equal(cache.isCooldownActive(cooldownKey).active, false, 'Auth errors must not lock out corrected key retries');
  });

  // 10. Valid Retry-After values are honored within configured limits
  await suite.test('10. Valid Retry-After values are honored within configured limits', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      baseCooldownMs: 5000,
      maxCooldownMs: 120000, // 2 minutes max
      clock: clock.now,
    });
    const cooldownKey = 'OpenRouter|conn_retry_after|';

    // 10a. Integer seconds format (e.g. 45s)
    const res1 = cache.recordFailure(cooldownKey, {
      category: 'RATE_LIMIT_429',
      message: 'Throttled',
      status: 429,
      retryAfterHeader: '45',
    });
    assert.equal(res1.cooldownDurationMs, 45000, 'Retry-After: 45 must set 45s cooldown');

    // 10b. Oversized Retry-After capped to maxCooldownMs
    const res2 = cache.recordFailure(cooldownKey, {
      category: 'RATE_LIMIT_429',
      message: 'Throttled hard',
      status: 429,
      retryAfterHeader: '999999',
    });
    assert.equal(res2.cooldownDurationMs, 120000, 'Retry-After exceeding maxCooldownMs must clamp to max');
  });

  // 11. Stale-if-error behavior follows the documented policy
  await suite.test('11. Stale-if-error behavior follows the documented policy', () => {
    const clock = createMockClock(1000000);
    const cache = new CatalogCacheManager({
      ttlMs: 60000, // 1 minute
      staleIfErrorWindowMs: 86400000, // 24 hours
      clock: clock.now,
    });
    const key = 'Google GenAI|conn_stale|https://generativelanguage.googleapis.com|k:abc12345';

    // 11a. Populate initial verified catalog
    cache.set(key, [mockModel], { provider: 'Google GenAI' });

    // 11b. Advance past TTL but within stale window
    clock.advance(120000); // 2 minutes later
    assert.equal(cache.get(key).hit, false, 'Fresh get must miss after TTL');

    // 11c. Live refresh fails -> Stale-if-error returns prior catalog with isStale: true
    const staleResult = cache.getStaleFallback(key, 'Live refresh failed (HTTP 503)');
    assert.equal(staleResult.hit, true);
    assert.equal(staleResult.isStale, true);
    assert.ok(staleResult.staleReason?.includes('HTTP 503'));
    assert.equal(staleResult.data?.length, 1);
    assert.equal(staleResult.data?.[0].id, 'gemini-3.1-flash-lite');

    // 11d. If no prior catalog exists, stale fallback returns hit: false
    const unknownKey = 'Google GenAI|conn_nonexistent||k:none';
    const noPrior = cache.getStaleFallback(unknownKey);
    assert.equal(noPrior.hit, false, 'Must not fabricate a catalog if no prior catalog exists');
  });

  // 12. Malformed or oversized catalog responses fail safely
  await suite.test('12. Malformed or oversized catalog responses fail safely', () => {
    const cache = new CatalogCacheManager({
      maxPayloadBytes: 1024, // 1 KB limit for test
      maxModelsPerCatalog: 3,
    });

    // 12a. Oversized payload check
    assert.throws(
      () => cache.checkPayloadSize(2048, 'TestProvider'),
      /exceeded maximum allowable size/,
      'Oversized payload must throw error'
    );

    // 12b. Malformed payload structure
    assert.throws(
      () => cache.validateAndSanitizeCatalogPayload('not an object', 'TestProvider'),
      /not a JSON object/
    );
    assert.throws(
      () => cache.validateAndSanitizeCatalogPayload({ random: 'data' }, 'TestProvider'),
      /models\/data array not found/
    );

    // 12c. Valid payload bounded to maxModelsPerCatalog and sanitized
    const rawData = {
      models: [
        { name: 'models/model-1', description: 'Desc 1' },
        { name: 'models/model-2', description: 'Desc 2' },
        { name: 'models/model-3', description: 'Desc 3' },
        { name: 'models/model-4', description: 'Desc 4' }, // Should be dropped due to cap 3
        { invalid: true }, // Should be dropped (no name/id)
      ],
    };

    const sanitized = cache.validateAndSanitizeCatalogPayload(rawData, 'Google GenAI');
    assert.equal(sanitized.length, 3, 'Must bound catalog to maxModelsPerCatalog');
    assert.equal(sanitized[0].name, 'models/model-1');
  });

  // 13. ProviderManager integration: Cache stats, defensive copies, and full API integration
  await suite.test('13. ProviderManager integration: Cache stats, defensive copies, and clean isolation', async () => {
    const cm = providerManager.getCatalogCache();
    assert.ok(cm instanceof CatalogCacheManager);

    // Verify defensive copies (caller mutating returned model list does not corrupt cache)
    const testKey = 'Google GenAI|conn_defensive||k:def123';
    cm.set(testKey, [{ ...mockModel, id: 'immutable-1' }]);

    const retrieved1 = cm.get(testKey);
    assert.ok(retrieved1.data);
    // Caller mutates array
    retrieved1.data[0].id = 'mutated-by-caller';

    // Retrieve again
    const retrieved2 = cm.get(testKey);
    assert.equal(
      retrieved2.data?.[0].id,
      'immutable-1',
      'Internal cache must remain pristine regardless of caller mutations'
    );

    // Verify live model fetch integration
    const defaultConn = providerManager.getPublicConnections()[0];
    assert.ok(defaultConn);

    const catalogResult = await providerManager.fetchAvailableModels({
      connectionId: defaultConn.id,
    });
    assert.ok(catalogResult.success);
    assert.ok(catalogResult.models.length > 0);
    assert.ok(catalogResult.source === 'live_api' || catalogResult.source === 'cached_catalog');
  });
});
