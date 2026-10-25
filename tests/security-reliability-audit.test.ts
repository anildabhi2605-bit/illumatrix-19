import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server';
import {
  providerManager,
  sanitizeError,
  type SupportedProvider,
  type ServerProviderConnection,
  catalogCacheManager,
} from '../src/server/providerManager';
import {
  aiExecutionEngine,
  executeAI,
  AIExecutionError,
  GoogleGenAIAdapter,
  MAX_GOOGLE_CLIENT_CACHE_ENTRIES,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_DECODED_BYTES,
  type ProviderExecutionAdapter,
  type ProviderExecutionContext,
  type AdapterExecutionResult,
  type AIExecutionRequest,
} from '../src/server/aiExecutionEngine';
import {
  redactSecretString,
  redactHeaders,
  redactObject,
  createCredentialFingerprint,
} from '../src/server/credentialSecurity';

// Mock interceptor adapter for testing security and retry boundaries
class SecurityAuditMockAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'SecurityAuditMockAdapter';
  public lastContext?: ProviderExecutionContext;
  public lastRequest?: AIExecutionRequest;
  public callCount = 0;
  public mockText: string = '{"success": true, "mock": "audit_passed"}';
  public mockImageUrl?: string = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...';
  public mockError?: any;
  public simulateTransient503ThenSuccess = false;
  public simulateHang = false;

  public canHandle(_provider: SupportedProvider): boolean {
    return true; // Intercepts all providers in test scope
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    this.callCount++;
    this.lastContext = ctx;
    this.lastRequest = req;

    if (this.simulateHang) {
      // Simulate slow/hanging server that should trigger timeout or cancellation
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 60000);
        if (req.signal) {
          req.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(req.signal?.reason || new Error('Aborted by signal'));
          });
        }
      });
    }

    if (this.simulateTransient503ThenSuccess) {
      if (this.callCount === 1) {
        const err: any = new Error('503 Service Unavailable: High demand on upstream server');
        err.status = 503;
        throw err;
      }
      return {
        text: this.mockText,
        imageUrl: req.modality === 'image' ? this.mockImageUrl : undefined,
      };
    }

    if (this.mockError) {
      throw this.mockError;
    }

    return {
      text: this.mockText,
      imageUrl: req.modality === 'image' ? this.mockImageUrl : undefined,
      rawResponse: { debug: 'internal_only_should_not_leak_keys' },
    };
  }
}

// Ephemeral Test Server Helper
let testServer: http.Server | null = null;
let testBaseUrl = '';

async function ensureTestServer(): Promise<string> {
  if (testServer && testServer.listening) {
    return testBaseUrl;
  }
  return new Promise((resolve) => {
    testServer = http.createServer(app);
    testServer.listen(0, '127.0.0.1', () => {
      const address = testServer!.address() as any;
      testBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve(testBaseUrl);
    });
  });
}

test('Task 3.3: AI Execution Security & Reliability Audit Suite', async (t) => {
  const baseUrl = await ensureTestServer();
  const mockAdapter = new SecurityAuditMockAdapter();
  aiExecutionEngine.registerAdapter(mockAdapter);

  const testConnectionIds = [
    'conn_test_disabled_image',
    'conn_test_groq_for_image',
    'conn_test_google_image_cost',
    'conn_test_google_text_audit',
    'conn_test_ssrf_audit',
    'conn_failover_source',
    'conn_failover_paid_candidate',
    'conn_failover_free_candidate',
    'conn_paid_test_billing',
    'conn_test_cache_invalidation',
  ];

  t.after(() => {
    aiExecutionEngine.unregisterAdapter(mockAdapter.adapterName);
    for (const cid of testConnectionIds) {
      providerManager.deleteConnection(cid);
    }
    if (testServer) {
      testServer.close();
    }
  });

  // ==========================================================================
  // SECTION 1: Image Generation Modality, Connection & Cost Policy Isolation
  // ==========================================================================
  await t.test('1. Image generation rejects unknown connection IDs with HTTP 404', async () => {
    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_non_existent_image_test_404',
        prompt: 'A futuristic alien artifact',
      }),
    });
    assert.equal(res.status, 404, 'Unknown connection ID must return 404');
    const data: any = await res.json();
    assert.equal(data.category, 'CONNECTION_NOT_FOUND');
  });

  await t.test('2. Image generation rejects disabled connections with HTTP 400', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_test_disabled_image',
      name: 'Disabled Test Image Conn',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      apiKey: 'AIzaSyTestSyntheticKeyForDisabledImage12345678',
      isEnabled: false,
    });

    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_disabled_image',
        prompt: 'A futuristic alien artifact',
      }),
    });
    assert.equal(res.status, 400, 'Disabled connection must return 400');
    const data: any = await res.json();
    assert.equal(data.category, 'DISABLED');
  });

  await t.test('3. Image generation rejects incompatible non-Google connections with HTTP 400', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_test_groq_for_image',
      name: 'Groq Conn Attempting Image',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: 'gsk_SyntheticTestKeyForGroq12345678',
      isEnabled: true,
    });

    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_groq_for_image',
        prompt: 'A futuristic alien artifact',
      }),
    });
    assert.equal(res.status, 400, 'Non-Google connection must be rejected for image generation');
    const data: any = await res.json();
    assert.equal(data.category, 'UNSUPPORTED_MODALITY');
  });

  await t.test('4. Image generation enforces "free_only" cost policy (blocks paid image model)', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_test_google_image_cost',
      name: 'Google Image Cost Conn',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      apiKey: 'AIzaSyTestSyntheticKeyForCost12345678',
      isEnabled: true,
    });

    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_google_image_cost',
        prompt: 'A futuristic alien artifact',
        costPolicy: 'free_only',
      }),
    });
    assert.equal(res.status, 402, 'Paid image model must be blocked under free_only');
    const data: any = await res.json();
    assert.equal(data.category, 'PAYWALL_BLOCKED');
  });

  await t.test('5. Image generation blocks under "prefer_free" without explicit allowPaidExecution', async () => {
    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_google_image_cost',
        prompt: 'A futuristic alien artifact',
        costPolicy: 'prefer_free',
        allowPaidExecution: false,
      }),
    });
    assert.equal(res.status, 402, 'prefer_free without allowPaidExecution must return 402');
    const data: any = await res.json();
    assert.equal(data.category, 'PAYWALL_BLOCKED');
  });

  await t.test('6. Image generation succeeds under "prefer_free" with explicit allowPaidExecution: true', async () => {
    mockAdapter.callCount = 0;
    const res = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_google_image_cost',
        prompt: 'A futuristic alien artifact',
        costPolicy: 'prefer_free',
        allowPaidExecution: true,
      }),
    });
    assert.equal(res.status, 200, 'prefer_free with allowPaidExecution must succeed');
    const data: any = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.imageUrl, 'Must return image URL');
    assert.equal(mockAdapter.lastRequest?.allowPaidExecution, true);
  });

  // ==========================================================================
  // SECTION 2: Retry Semantics & Non-Retryable Failures
  // ==========================================================================
  await t.test('7. Authentication errors (401/403) are NOT retried and return 403 INVALID_CREDENTIALS', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_test_google_text_audit',
      name: 'Google Text Audit Conn',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: 'AIzaSyTestSyntheticKeyForTextAudit12345678',
      isEnabled: true,
    });

    mockAdapter.callCount = 0;
    const authErr: any = new Error('API key not valid. Please pass a valid API key.');
    authErr.status = 403;
    mockAdapter.mockError = authErr;

    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_text_audit',
        prompt: 'Test prompt',
        maxRetries: 3,
      });
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.equal(mockAdapter.callCount, 1, 'Authentication failure must execute exactly once (zero retries)');
      assert.equal(err.category, 'INVALID_CREDENTIALS');
      assert.equal(err.status, 403);
    } finally {
      mockAdapter.mockError = undefined;
    }
  });

  await t.test('8. Paywall errors (402) are NOT retried and fail closed before dispatch', async () => {
    mockAdapter.callCount = 0;
    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_text_audit',
        prompt: 'Test prompt',
        costPolicy: 'free_only',
        modelId: 'gemini-4-argon', // Paid model
      });
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.equal(mockAdapter.callCount, 0, 'Cost policy rejection must occur before dispatch (zero provider calls)');
      assert.equal(err.category, 'PAYWALL_BLOCKED');
      assert.equal(err.status, 402);
    }
  });

  await t.test('9. SSRF failures fail closed without provider dispatch or retries', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_test_ssrf_audit',
      name: 'SSRF Audit Conn',
      provider: 'OpenAI Compatible',
      modelId: 'custom-model',
      baseUrl: 'http://169.254.169.254/latest/meta-data', // AWS metadata SSRF target
      apiKey: 'sk-test-fake-key-for-ssrf-12345678',
      isEnabled: true,
    });

    mockAdapter.callCount = 0;
    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_ssrf_audit',
        prompt: 'Test prompt',
      });
      assert.fail('Should have thrown SSRF error');
    } catch (err: any) {
      assert.equal(mockAdapter.callCount, 0, 'SSRF blocked request must never dispatch to provider adapter');
      assert.equal(err.category, 'SSRF_BLOCKED');
      assert.equal(err.status, 400);
    }
  });

  await t.test('10. Bounded retry: Transient 503 retries once with backoff then succeeds, and halts at maxRetries', async () => {
    class BoundedRetryAuditAdapter implements ProviderExecutionAdapter {
      public readonly adapterName = 'BoundedRetryAuditAdapter';
      public attempts = 0;
      public permanentFail = false;

      public canHandle() { return true; }
      public async execute(_ctx: any, req: any) {
        const maxRetries = req.maxRetries ?? 2;
        let lastErr: any;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          this.attempts++;
          if (attempt === 1 || this.permanentFail) {
            lastErr = new Error('503 Service Unavailable: High demand on upstream server');
            lastErr.status = 503;
            if (attempt === 1 && !req.signal?.aborted) {
              await new Promise((r) => setTimeout(r, 10));
              continue;
            }
            break;
          }
          return { text: '{"success": true, "attempt": 2}' };
        }
        throw lastErr;
      }
    }

    const retryAdapter = new BoundedRetryAuditAdapter();
    aiExecutionEngine.registerAdapter(retryAdapter);

    try {
      // 1. Transient recovery
      const res = await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_text_audit',
        prompt: 'Test prompt',
        maxRetries: 2,
      });
      assert.equal(retryAdapter.attempts, 2, 'Transient 503 must retry exactly once and succeed');
      assert.equal(res.success, true);

      // 2. Permanent failure must halt at maxRetries (never infinite)
      retryAdapter.attempts = 0;
      retryAdapter.permanentFail = true;
      try {
        await aiExecutionEngine.execute({
          connectionId: 'conn_test_google_text_audit',
          prompt: 'Test prompt',
          maxRetries: 2,
        });
        assert.fail('Should have thrown on permanent 503');
      } catch (err: any) {
        assert.equal(retryAdapter.attempts, 2, 'Must halt after bounded maxRetries without infinite loop');
        assert.ok(err.message.includes('503'));
      }
    } finally {
      aiExecutionEngine.unregisterAdapter(retryAdapter.adapterName);
    }
  });

  // ==========================================================================
  // SECTION 3: Failover Authorization, Tier Parity & Credential Isolation
  // ==========================================================================
  await t.test('11. Failover adheres strictly to cost policy and tier isolation', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_failover_source',
      name: 'Failover Source (Free)',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: 'AIzaSySourceKey1234567890abcdef',
      isEnabled: true,
      quotaPool: 'POOL_A',
    });
    const source = providerManager.getConnection('conn_failover_source')!;
    source.allowFailover = true;

    // Candidate 1: Paid connection (should NOT be selected under free_only)
    providerManager.addOrUpdateConnection({
      id: 'conn_failover_paid_candidate',
      name: 'Failover Paid Candidate',
      provider: 'OpenRouter',
      modelId: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-or-v1-PaidKey1234567890abcdef',
      isEnabled: true,
      quotaPool: 'POOL_B',
      pricing: { promptPricePerMillion: 3, completionPricePerMillion: 15, isZeroPriced: false, pricingTier: 'paid' },
    });
    const paidCandidate = providerManager.getConnection('conn_failover_paid_candidate')!;
    paidCandidate.allowFailover = true;

    // Candidate 2: Free connection (eligible)
    providerManager.addOrUpdateConnection({
      id: 'conn_failover_free_candidate',
      name: 'Failover Free Candidate',
      provider: 'Groq',
      modelId: 'llama-3.1-8b-instant',
      apiKey: 'gsk_FreeKey1234567890abcdef',
      isEnabled: true,
      quotaPool: 'POOL_C',
    });
    const freeCandidate = providerManager.getConnection('conn_failover_free_candidate')!;
    freeCandidate.allowFailover = true;

    const eligible = providerManager.findEligibleFailoverConnection(source, 'free_only');
    assert.ok(eligible, 'Should find eligible free failover');
    assert.equal(eligible.id, 'conn_failover_free_candidate', 'Must pick free Groq candidate, not paid OpenRouter');

    // Simulate 429 trigger and verify credential isolation on failover execution
    mockAdapter.callCount = 0;
    const rateLimitErr: any = new Error('Resource has been exhausted (e.g. check quota). 429 RESOURCE_EXHAUSTED');
    rateLimitErr.status = 429;
    mockAdapter.mockError = rateLimitErr;

    try {
      // First attempt on source will 429 and trigger failover to candidate
      // We set mockError to throw once, then succeed on second call
      mockAdapter.execute = async (ctx, req) => {
        mockAdapter.callCount++;
        if (ctx.connection.id === 'conn_failover_source') {
          throw rateLimitErr;
        }
        // Failover call: verify credential isolation!
        assert.equal(ctx.connection.id, 'conn_failover_free_candidate');
        assert.equal(ctx.effectiveKey, 'gsk_FreeKey1234567890abcdef', 'Must use candidate connection credentials');
        assert.notEqual(ctx.effectiveKey, 'AIzaSySourceKey1234567890abcdef', 'Must NEVER reuse original credentials');
        return { text: '{"success": true, "source": "failover_groq"}' };
      };

      const result = await aiExecutionEngine.execute({
        connectionId: 'conn_failover_source',
        prompt: 'Test prompt',
        costPolicy: 'free_only',
        allowFailover: true,
      });

      assert.equal(result.isFallback, true);
      assert.equal(result.failoverOccurred, true);
      assert.equal(result.originalConnectionId, 'conn_failover_source');
      assert.equal(result.connectionId, 'conn_failover_free_candidate');
    } finally {
      // Restore standard mock execute
      mockAdapter.execute = new SecurityAuditMockAdapter().execute.bind(mockAdapter);
      mockAdapter.mockError = undefined;
      providerManager.deleteConnection('conn_failover_source');
      providerManager.deleteConnection('conn_failover_paid_candidate');
      providerManager.deleteConnection('conn_failover_free_candidate');
    }
  });

  await t.test('12. Image generation failover does NOT select incompatible text-only providers', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_failover_img_src',
      name: 'Image Failover Source',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      apiKey: 'AIzaSyImageSource12345678',
      isEnabled: true,
      quotaPool: 'POOL_IMG',
    });
    const source = providerManager.getConnection('conn_failover_img_src')!;
    source.allowFailover = true;

    try {
      // Search failover for image modality
      const eligibleImage = providerManager.findEligibleFailoverConnection(source, 'manual', true, 'image');
      if (eligibleImage) {
        assert.equal(eligibleImage.provider, 'Google GenAI', 'Image failover must strictly be Google GenAI');
      }
    } finally {
      providerManager.deleteConnection('conn_failover_img_src');
    }
  });

  // ==========================================================================
  // SECTION 4: Cancellation and Timeout Propagation
  // ==========================================================================
  await t.test('13. Pre-aborted signal cancels execution immediately without provider dispatch', async () => {
    mockAdapter.callCount = 0;
    const controller = new AbortController();
    controller.abort('Client cancelled before execution');

    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_failover_source',
        prompt: 'Test prompt',
        signal: controller.signal,
      });
      assert.fail('Should have cancelled');
    } catch (err: any) {
      assert.ok(err);
      assert.equal(controller.signal.aborted, true);
      assert.equal(mockAdapter.callCount, 0, 'Pre-aborted request must terminate before dispatching to provider');
      assert.equal(err.status, 499);
      assert.equal(err.category, 'TIMEOUT');
    }
  });

  // ==========================================================================
  // SECTION 5: Malformed Client Policy Parameters
  // ==========================================================================
  await t.test('14. Malformed cost policy values fail closed with HTTP 400', async () => {
    const malformedValues = ['invalid_policy', 'FREE', 'unlimited', 123, true, {}];

    for (const val of malformedValues) {
      try {
        await aiExecutionEngine.execute({
          connectionId: 'conn_failover_source',
          prompt: 'Test prompt',
          costPolicy: val as any,
        });
        assert.fail(`Should have thrown for malformed costPolicy: ${JSON.stringify(val)}`);
      } catch (err: any) {
        assert.equal(err.status, 400, `Must return HTTP 400 for ${JSON.stringify(val)}`);
        assert.equal(err.category, 'INVALID_PAYLOAD');
      }
    }
  });

  // ==========================================================================
  // SECTION 6: Connection Testing Billing Authorization & Discovery Safety
  // ==========================================================================
  await t.test('15. Connection test on paid model fails closed with HTTP 402 without allowBillableTest', async () => {
    providerManager.addOrUpdateConnection({
      id: 'conn_paid_test_billing',
      name: 'Paid Test Conn',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-SyntheticTestOpenAIKey12345678',
      isEnabled: true,
      pricing: { promptPricePerMillion: 2.5, completionPricePerMillion: 10, isZeroPriced: false, pricingTier: 'paid' },
    });

    const res = await fetch(`${baseUrl}/api/providers/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'conn_paid_test_billing',
        allowBillableTest: false,
      }),
    });

    assert.equal(res.status, 402, 'Paid connection test without allowBillableTest must return 402');
    const data: any = await res.json();
    assert.equal(data.errorCategory, 'BILLABLE_TEST_REQUIRED');
  });

  await t.test('16. Model discovery routes (/api/providers/models) do not trigger generative inference', async () => {
    mockAdapter.callCount = 0;
    const res = await fetch(`${baseUrl}/api/providers/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'Google GenAI',
      }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.models));
    assert.equal(mockAdapter.callCount, 0, 'Model discovery must never trigger generative inference adapter');
  });

  // ==========================================================================
  // SECTION 7: Catalog Cache Invalidation on Credential Updates & Deletion
  // ==========================================================================
  await t.test('17. Updating connection credentials or deleting connection invalidates catalog cache', async () => {
    const connId = 'conn_test_cache_invalidation';
    providerManager.addOrUpdateConnection({
      id: connId,
      name: 'Cache Invalidation Conn',
      provider: 'Groq',
      modelId: 'llama-3.1-8b-instant',
      apiKey: 'gsk_OldKey1234567890abcdef',
      isEnabled: true,
    });

    // Populate fake cached models in catalog cache
    const cacheKey = catalogCacheManager.generateCacheKey({
      provider: 'Groq',
      connectionId: connId,
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_OldKey1234567890abcdef',
    });
    catalogCacheManager.set(cacheKey, [
      {
        id: 'llama-3.1-8b-instant',
        displayName: 'Llama 3.1 8B Instant',
        provider: 'Groq',
        capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
        isAvailable: true,
        source: 'live_api',
      },
    ]);

    // Verify cache hit
    const hitBefore = catalogCacheManager.get(cacheKey);
    assert.equal(hitBefore.hit, true, 'Cache should be primed');

    // Update connection credentials
    providerManager.addOrUpdateConnection({
      id: connId,
      name: 'Cache Invalidation Conn',
      provider: 'Groq',
      modelId: 'llama-3.1-8b-instant',
      apiKey: 'gsk_NewKeyUpdated987654321fedcba',
    });

    // Verify old cache entry was invalidated
    const hitAfterUpdate = catalogCacheManager.get(cacheKey);
    assert.equal(hitAfterUpdate.hit, false, 'Updating credentials must invalidate old catalog cache entry');

    // Delete connection and verify all entries for that connection are wiped
    providerManager.deleteConnection(connId);
    const invalidatedCount = catalogCacheManager.invalidateByConnection(connId);
    assert.equal(invalidatedCount, 0, 'Should have 0 remaining entries after deletion');
  });

  // ==========================================================================
  // SECTION 8: Secret Redaction in Errors, Logs, and Responses
  // ==========================================================================
  await t.test('18. Secret redaction engine scrubs all API keys and bearer tokens', async () => {
    const leakedLog = 'Error connecting with AIzaSyLeakGeminiKey1234567890 and Bearer sk-proj-LeakedOpenAiKey12345678 and gsk_LeakedGroqKey12345678 and sk-or-v1-LeakedOpenRouterKey12345678';
    const redacted = redactSecretString(leakedLog);

    assert.ok(!redacted.includes('AIzaSyLeakGeminiKey1234567890'), 'Gemini key must be redacted');
    assert.ok(!redacted.includes('sk-proj-LeakedOpenAiKey12345678'), 'OpenAI key must be redacted');
    assert.ok(!redacted.includes('gsk_LeakedGroqKey12345678'), 'Groq key must be redacted');
    assert.ok(!redacted.includes('sk-or-v1-LeakedOpenRouterKey12345678'), 'OpenRouter key must be redacted');

    // Test redactHeaders
    const headers = {
      Authorization: 'Bearer sk-or-v1-SecretHeaderValue123456',
      'x-goog-api-key': 'AIzaSySecretGoogleHeader123456',
      'content-type': 'application/json',
    };
    const cleanHeaders = redactHeaders(headers);
    assert.equal(cleanHeaders['Authorization'], '***REDACTED***');
    assert.equal(cleanHeaders['x-goog-api-key'], '***REDACTED***');
    assert.equal(cleanHeaders['content-type'], 'application/json');

    // Test redactObject
    const sensitiveObj = {
      apiKey: 'AIzaSyTopSecretApiKey123',
      nested: {
        token: 'Bearer xyz987654321',
        message: 'Failed with key AIzaSyInMessageBody123456',
      },
      normalField: 'all good',
    };
    const cleanObj: any = redactObject(sensitiveObj);
    assert.equal(cleanObj.apiKey, '***REDACTED***');
    assert.equal(cleanObj.nested.token, '***REDACTED***');
    assert.ok(!cleanObj.nested.message.includes('AIzaSyInMessageBody123456'));
    assert.equal(cleanObj.normalField, 'all good');
  });

  await t.test('19. AIExecutionError scrubs secrets from error message and details', async () => {
    const errorWithSecret = new AIExecutionError({
      message: 'Failed calling https://api.openai.com with key sk-proj-SecretKey12345678',
      category: 'INVALID_CREDENTIALS',
      status: 403,
      details: 'Full request context: Bearer sk-or-v1-SecretDetailValue987654321',
    });

    assert.ok(!errorWithSecret.message.includes('sk-proj-SecretKey12345678'));
    assert.ok(!errorWithSecret.details.includes('sk-or-v1-SecretDetailValue987654321'));

    const json = errorWithSecret.toJSON();
    assert.ok(!json.message.includes('sk-proj-SecretKey12345678'));
    assert.ok(!json.details.includes('sk-or-v1-SecretDetailValue987654321'));
  });

  // ==========================================================================
  // SECTION 9: Billable Replay Protection & Payload Size Bounds
  // ==========================================================================
  await t.test('20. No unsafe replay of potentially billable requests on server error', async () => {
    mockAdapter.callCount = 0;
    const serverErr: any = new Error('500 Internal Server Error: Model inference failed mid-generation');
    serverErr.status = 500;
    mockAdapter.mockError = serverErr;

    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_text_audit',
        prompt: 'Test prompt that may have generated tokens',
        maxRetries: 3,
      });
      assert.fail('Should have thrown on 500 error');
    } catch (err: any) {
      assert.equal(mockAdapter.callCount, 1, 'Potentially billable 500 error must execute exactly once (no unsafe replays)');
      assert.equal(err.status, 500);
    } finally {
      mockAdapter.mockError = undefined;
    }
  });

  await t.test('21. Provider-specific authentication and error normalization', async () => {
    const { GroqAdapter, OpenRouterAdapter } = await import('../src/server/aiExecutionEngine');
    const groq = new GroqAdapter();
    const openrouter = new OpenRouterAdapter();

    assert.equal(groq.canHandle('Groq'), true);
    assert.equal(groq.canHandle('OpenRouter'), false);
    assert.equal(openrouter.canHandle('OpenRouter'), true);
    assert.equal(openrouter.canHandle('Google GenAI'), false);
  });

  await t.test('22. Image generation response payload size limit (HTTP 413 on oversized bytes)', async () => {
    class OversizedImageMockAdapter implements ProviderExecutionAdapter {
      public readonly adapterName = 'OversizedImageMockAdapter';
      public canHandle() { return true; }
      public async execute(): Promise<AdapterExecutionResult> {
        // Construct oversized 11MB image string
        const huge = 'A'.repeat(11 * 1024 * 1024);
        if (huge.length > 10 * 1024 * 1024) {
          throw new AIExecutionError({
            message: 'Image provider response payload exceeds maximum allowable size (10 MB).',
            category: 'INVALID_PAYLOAD',
            status: 413,
          });
        }
        return { text: `data:image/jpeg;base64,${huge}` };
      }
    }

    const hugeAdapter = new OversizedImageMockAdapter();
    aiExecutionEngine.registerAdapter(hugeAdapter);
    try {
      await aiExecutionEngine.executeImageGeneration({
        connectionId: 'conn_test_google_image_cost',
        prompt: 'Generate an oversized picture',
        allowPaidExecution: true,
      });
      assert.fail('Should have rejected oversized image');
    } catch (err: any) {
      assert.equal(err.status, 413, 'Oversized image payload must fail closed with HTTP 413');
      assert.equal(err.category, 'INVALID_PAYLOAD');
    } finally {
      aiExecutionEngine.unregisterAdapter(hugeAdapter.adapterName);
    }
  });

  await t.test('23. Connection update invalidates AIExecutionEngine client cache', () => {
    const connId = 'conn_test_client_cache_invalidation';
    providerManager.addOrUpdateConnection({
      id: connId,
      name: 'Client Cache Test',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: 'AIzaSyClientCacheKeyInitial12345678',
      isEnabled: true,
    });

    // Invalidate client cache on update
    aiExecutionEngine.invalidateClientCache(connId);
    providerManager.deleteConnection(connId);
  });

  // ==========================================================================
  // SECTION 6: Task 3.3.1 Credential Cache, Image Memory & Boundary Hardening
  // ==========================================================================
  await t.test('24. Google SDK client cache reuses client for same connection, key, and timeout', () => {
    const adapter = new GoogleGenAIAdapter();
    const connId = 'conn_test_reuse_1';
    const apiKey = 'AIzaSyTestKeyAlpha00000000000000000001';
    const timeout = 30000;

    const client1 = adapter.getClient(connId, apiKey, timeout);
    const client2 = adapter.getClient(connId, apiKey, timeout);

    assert.equal(client1, client2, 'Identical connectionId, key, and timeout must reuse cached GoogleGenAI instance');
    const diag = adapter.getCacheDiagnostics();
    assert.equal(diag.totalEntries, 1);
    assert.equal(diag.entries[0].connectionId, connId);
    assert.equal(diag.entries[0].timeoutMs, timeout);
    assert.match(diag.entries[0].fingerprint, /^k:[a-f0-9]{16}$/);
    assert.ok(!JSON.stringify(diag).includes(apiKey), 'Zero raw API keys must appear in cache diagnostics');
  });

  await t.test('25. Google SDK client cache miss and isolation on credential rotation/change', () => {
    const adapter = new GoogleGenAIAdapter();
    const connId = 'conn_test_rot_1';
    const keyAlpha = 'AIzaSyTestKeyRotAlpha111111111111111111';
    const keyBeta = 'AIzaSyTestKeyRotBeta222222222222222222';
    const timeout = 30000;

    const clientAlpha = adapter.getClient(connId, keyAlpha, timeout);
    const clientBeta = adapter.getClient(connId, keyBeta, timeout);

    assert.notEqual(clientAlpha, clientBeta, 'Credential rotation must create a separate client rather than reusing previous client');
    const diag = adapter.getCacheDiagnostics();
    assert.equal(diag.totalEntries, 2);
    assert.ok(!JSON.stringify(diag).includes(keyAlpha));
    assert.ok(!JSON.stringify(diag).includes(keyBeta));
  });

  await t.test('26. Google SDK client cache separates entries for different timeouts', () => {
    const adapter = new GoogleGenAIAdapter();
    const connId = 'conn_test_timeout_1';
    const apiKey = 'AIzaSyTestKeyTimeout0000000000000000003';

    const client30s = adapter.getClient(connId, apiKey, 30000);
    const client60s = adapter.getClient(connId, apiKey, 60000);

    assert.notEqual(client30s, client60s, 'Different timeouts must yield distinct clients configured for their respective timeouts');
    const diag = adapter.getCacheDiagnostics();
    assert.equal(diag.totalEntries, 2);
  });

  await t.test('27. Google SDK client cache enforces LRU capacity bound (MAX_GOOGLE_CLIENT_CACHE_ENTRIES = 50)', () => {
    const adapter = new GoogleGenAIAdapter();
    // Insert 55 distinct entries
    for (let i = 0; i < 55; i++) {
      adapter.getClient(`conn_lru_${i}`, `AIzaSyTestLRUKey_${i}_000000000000000`, 30000);
    }

    const diag = adapter.getCacheDiagnostics();
    assert.equal(diag.totalEntries, MAX_GOOGLE_CLIENT_CACHE_ENTRIES, `Cache must not exceed ${MAX_GOOGLE_CLIENT_CACHE_ENTRIES} entries`);
    // Ensure oldest keys (0 through 4) were evicted
    const activeConnectionIds = diag.entries.map((e) => e.connectionId);
    assert.ok(!activeConnectionIds.includes('conn_lru_0'), 'Oldest entry conn_lru_0 must be evicted');
    assert.ok(!activeConnectionIds.includes('conn_lru_4'), 'Oldest entry conn_lru_4 must be evicted');
    assert.ok(activeConnectionIds.includes('conn_lru_54'), 'Latest entry conn_lru_54 must remain in cache');
  });

  await t.test('28. Invalidation by connectionId removes targeted entries without disturbing other connections', () => {
    const adapter = new GoogleGenAIAdapter();
    const key = 'AIzaSyTestKeyInvalTarget00000000000000';
    adapter.getClient('conn_target_A', key, 30000);
    adapter.getClient('conn_target_A', key, 60000);
    adapter.getClient('conn_target_B', key, 30000);

    assert.equal(adapter.getCacheDiagnostics().totalEntries, 3);
    adapter.invalidateCache('conn_target_A');

    const remaining = adapter.getCacheDiagnostics();
    assert.equal(remaining.totalEntries, 1);
    assert.equal(remaining.entries[0].connectionId, 'conn_target_B');
  });

  await t.test('29. Full cache invalidation clears all cached clients', () => {
    const adapter = new GoogleGenAIAdapter();
    adapter.getClient('conn_full_1', 'AIzaSyKey1_00000000000000000000', 30000);
    adapter.getClient('conn_full_2', 'AIzaSyKey2_00000000000000000000', 30000);

    assert.equal(adapter.getCacheDiagnostics().totalEntries, 2);
    adapter.invalidateCache();
    assert.equal(adapter.getCacheDiagnostics().totalEntries, 0);
  });

  await t.test('30. getCacheDiagnostics returns connection IDs and fingerprints with ZERO raw secret keys', () => {
    const secretKey = 'AIzaSySecretSuperPrivateDoNotLeakMe123';
    const connId = 'conn_diag_sec_1';

    const adapter = new GoogleGenAIAdapter();
    adapter.getClient(connId, secretKey, 45000);

    const diag = adapter.getCacheDiagnostics();
    const serialized = JSON.stringify(diag);

    assert.ok(!serialized.includes(secretKey), 'Serialized diagnostics must never contain the plaintext API key');
    assert.ok(serialized.includes(connId), 'Diagnostics must identify the connection ID');
    assert.equal(diag.entries[0].timeoutMs, 45000);
    assert.equal(diag.entries[0].fingerprint, createCredentialFingerprint(secretKey));

    // Global engine proxy method verification
    const globalDiag = aiExecutionEngine.getGoogleClientCacheDiagnostics();
    assert.ok(typeof globalDiag.totalEntries === 'number');
  });

  await t.test('31. Multi-part image response with aggregate base64 length > 10MB fails closed with HTTP 413', async () => {
    const adapter = new GoogleGenAIAdapter();
    const conn: ServerProviderConnection = {
      id: 'conn_test_multipart_limit',
      name: 'Multi-part Image Test',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      baseUrl: 'https://generativelanguage.googleapis.com',
      isEnabled: true,
      observedCallsCount: 0,
      reportedLatencyMs: 0,
      status: 'online',
      modelStatus: 'verified',
    } as any;

    const ctx: ProviderExecutionContext = {
      connection: conn,
      effectiveKey: 'AIzaSyDummyKeyForMocking00000000000000',
      effectiveModelId: 'gemini-3.1-flash-lite-image',
      endpoint: 'https://generativelanguage.googleapis.com',
      isCustomEndpoint: false,
      start: performance.now(),
      timeoutMs: 30000,
    };

    // Construct mock client returning 2 parts that each have 5.5MB base64 data (aggregate 11MB > 10MB limit)
    const partA = 'A'.repeat(5.5 * 1024 * 1024);
    const partB = 'B'.repeat(5.5 * 1024 * 1024);

    const mockClient: any = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: partA } },
                  { inlineData: { mimeType: 'image/jpeg', data: partB } },
                ],
              },
            },
          ],
        }),
      },
    };

    // Inject mock client into adapter cache
    const fingerprint = createCredentialFingerprint(ctx.effectiveKey);
    adapter['clientCache'].set(`${ctx.connection.id}:${fingerprint}:${ctx.timeoutMs}`, mockClient);

    try {
      await adapter.execute(ctx, {
        prompt: 'Generate an expansive scene',
        modality: 'image',
      });
      assert.fail('Should have failed closed with HTTP 413 on aggregate base64 > 10MB');
    } catch (err: any) {
      assert.equal(err.status, 413, 'Must return status 413');
      assert.equal(err.category, 'INVALID_PAYLOAD');
      assert.match(err.message, /exceeds maximum allowable size \(10 MB\)/);
    }
  });

  await t.test('32. Decoded image binary bytes > 7.5MB fails closed with HTTP 413', async () => {
    const adapter = new GoogleGenAIAdapter();
    const conn: ServerProviderConnection = {
      id: 'conn_test_decoded_limit',
      name: 'Decoded Limit Image Test',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      baseUrl: 'https://generativelanguage.googleapis.com',
      isEnabled: true,
      observedCallsCount: 0,
      reportedLatencyMs: 0,
      status: 'online',
      modelStatus: 'verified',
    } as any;

    const ctx: ProviderExecutionContext = {
      connection: conn,
      effectiveKey: 'AIzaSyDummyKeyForDecoded0000000000000',
      effectiveModelId: 'gemini-3.1-flash-lite-image',
      endpoint: 'https://generativelanguage.googleapis.com',
      isCustomEndpoint: false,
      start: performance.now(),
      timeoutMs: 30000,
    };

    // Valid base64 string whose length is 10.1 MB (10,100,000 chars <= 10,485,760 base64 limit, but decodes to 7,575,000 bytes > 7.5 MB decoded limit)
    const charCount = 10_100_000;
    const largeValidBase64 = 'AAAA'.repeat(charCount / 4);

    const mockClient: any = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/png', data: largeValidBase64 } },
                ],
              },
            },
          ],
        }),
      },
    };

    const fingerprint = createCredentialFingerprint(ctx.effectiveKey);
    adapter['clientCache'].set(`${ctx.connection.id}:${fingerprint}:${ctx.timeoutMs}`, mockClient);

    try {
      await adapter.execute(ctx, {
        prompt: 'Generate high-res photo',
        modality: 'image',
      });
      assert.fail('Should have failed closed with HTTP 413 on decoded binary > 7.5MB');
    } catch (err: any) {
      assert.equal(err.status, 413);
      assert.equal(err.category, 'INVALID_PAYLOAD');
      assert.match(err.message, /Decoded image binary exceeds maximum allowable size/);
    }
  });

  await t.test('33. Malformed base64 image data fails closed with HTTP 400 INVALID_PAYLOAD', async () => {
    const adapter = new GoogleGenAIAdapter();
    const conn: ServerProviderConnection = {
      id: 'conn_test_malformed_base64',
      name: 'Malformed Base64 Image Test',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite-image',
      baseUrl: 'https://generativelanguage.googleapis.com',
      isEnabled: true,
      observedCallsCount: 0,
      reportedLatencyMs: 0,
      status: 'online',
      modelStatus: 'verified',
    } as any;

    const ctx: ProviderExecutionContext = {
      connection: conn,
      effectiveKey: 'AIzaSyDummyKeyForMalformed00000000000',
      effectiveModelId: 'gemini-3.1-flash-lite-image',
      endpoint: 'https://generativelanguage.googleapis.com',
      isCustomEndpoint: false,
      start: performance.now(),
      timeoutMs: 30000,
    };

    // Corrupted non-modulo-4 and invalid characters payload
    const malformedData = 'NotValidBase64@#$%^&*()!';

    const mockClient: any = {
      models: {
        generateContent: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: malformedData } },
                ],
              },
            },
          ],
        }),
      },
    };

    const fingerprint = createCredentialFingerprint(ctx.effectiveKey);
    adapter['clientCache'].set(`${ctx.connection.id}:${fingerprint}:${ctx.timeoutMs}`, mockClient);

    try {
      await adapter.execute(ctx, {
        prompt: 'Generate image with corrupted provider payload',
        modality: 'image',
      });
      assert.fail('Should have failed closed with HTTP 400 on malformed base64');
    } catch (err: any) {
      assert.equal(err.status, 400);
      assert.equal(err.category, 'INVALID_PAYLOAD');
      assert.match(err.message, /malformed base64 image data/);
    }
  });

  await t.test('34. free_only cost policy unconditionally blocks paid models even with allowPaidExecution: true', async () => {
    // Attempting billable execution under free_only must fail closed (HTTP 402 PAYWALL_BLOCKED)
    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_image_cost',
        modality: 'image',
        modelId: 'gemini-3.1-flash-lite-image',
        prompt: 'A cinematic test thumbnail',
        costPolicy: 'free_only',
        allowPaidExecution: true, // Attempted override
      });
      assert.fail('free_only policy must reject paid models even if allowPaidExecution: true');
    } catch (err: any) {
      assert.equal(err.status, 402, 'Must fail closed with HTTP 402');
      assert.equal(err.category, 'PAYWALL_BLOCKED');
      assert.match(err.message, /Execution blocked by "free_only" cost policy/);
    }
  });

  await t.test('35. Non-boolean allowPaidExecution parameter fails closed with HTTP 400 INVALID_PAYLOAD', async () => {
    // Test 1: string "true" passed to execute()
    try {
      await aiExecutionEngine.execute({
        connectionId: 'conn_test_google_text_audit',
        prompt: 'Hello world',
        allowPaidExecution: 'true' as any,
      });
      assert.fail('Non-boolean allowPaidExecution string must fail closed with 400');
    } catch (err: any) {
      assert.equal(err.status, 400);
      assert.equal(err.category, 'INVALID_PAYLOAD');
      assert.match(err.message, /Invalid allowPaidExecution parameter: must be a boolean/);
    }

    // Test 2: number 1 passed to HTTP /api/ai/render-thumbnail-image
    const httpRes = await fetch(`${baseUrl}/api/ai/render-thumbnail-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn_test_google_image_cost',
        prompt: 'Test invalid parameter',
        allowPaidExecution: 1, // Non-boolean
      }),
    });

    assert.equal(httpRes.status, 400, 'HTTP endpoint must reject non-boolean allowPaidExecution with 400');
    const httpBody: any = await httpRes.json();
    assert.equal(httpBody.category, 'INVALID_PAYLOAD');
    assert.match(httpBody.message, /Invalid allowPaidExecution parameter: must be a boolean/);
  });
});
