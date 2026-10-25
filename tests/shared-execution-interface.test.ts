import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  providerManager,
  sanitizeError,
  maskApiKey,
  PROVIDER_REGISTRY,
  SupportedProvider,
} from '../src/server/providerManager';
import {
  aiExecutionEngine,
  executeAI,
  AIExecutionError,
  GoogleGenAIAdapter,
  GroqAdapter,
  OpenRouterAdapter,
  OpenAICompatibleAdapter,
  type AIExecutionRequest,
  type AIExecutionResult,
} from '../src/server/aiExecutionEngine';

test('Task 3.1: Shared AI Execution Interface & Orchestration Engine', async (t) => {
  // --------------------------------------------------------------------------
  // 1. Architecture, Exports & Adapter Registration
  // --------------------------------------------------------------------------
  await t.test('1. Core singletons, error classes, and provider adapters are properly initialized', () => {
    assert.ok(aiExecutionEngine, 'aiExecutionEngine singleton should exist');
    assert.ok(typeof executeAI === 'function', 'executeAI convenience helper should be exported');
    assert.ok(AIExecutionError, 'AIExecutionError class should be exported');

    // Adapter capabilities
    const googleAdapter = new GoogleGenAIAdapter();
    assert.equal(googleAdapter.canHandle('Google GenAI'), true);
    assert.equal(googleAdapter.canHandle('Groq'), false);

    const groqAdapter = new GroqAdapter();
    assert.equal(groqAdapter.canHandle('Groq'), true);
    assert.equal(groqAdapter.canHandle('OpenRouter'), false);

    const orAdapter = new OpenRouterAdapter();
    assert.equal(orAdapter.canHandle('OpenRouter'), true);
    assert.equal(orAdapter.canHandle('OpenAI Compatible'), false);

    const compatAdapter = new OpenAICompatibleAdapter();
    assert.equal(compatAdapter.canHandle('OpenAI'), true);
    assert.equal(compatAdapter.canHandle('OpenAI Compatible'), true);
    assert.equal(compatAdapter.canHandle('Cerebras'), true);
    assert.equal(compatAdapter.canHandle('Mistral AI'), true);
    assert.equal(compatAdapter.canHandle('Google GenAI'), false);
  });

  // --------------------------------------------------------------------------
  // 2. ROUTE-01: Unknown Connection ID Fail-Closed (HTTP 404)
  // --------------------------------------------------------------------------
  await t.test('2. ROUTE-01: Explicit unknown connection ID fails closed with HTTP 404 CONNECTION_NOT_FOUND', async () => {
    const unknownId = `conn_nonexistent_test_${Date.now()}`;

    // 2a. Direct executeAI call fails closed
    await assert.rejects(
      async () => {
        await executeAI({
          connectionId: unknownId,
          prompt: 'Hello AI Studio',
        });
      },
      (err: any) => {
        assert.ok(err instanceof AIExecutionError || err.category === 'CONNECTION_NOT_FOUND');
        assert.equal(err.category, 'CONNECTION_NOT_FOUND');
        assert.equal(err.status, 404);
        assert.ok(err.message.includes(unknownId));
        return true;
      }
    );

    // 2b. providerManager.executeTextGeneration delegates and preserves 404
    await assert.rejects(
      async () => {
        await providerManager.executeTextGeneration({
          connectionId: unknownId,
          prompt: 'Hello AI Studio',
        });
      },
      (err: any) => {
        assert.equal(err.category, 'CONNECTION_NOT_FOUND');
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  // --------------------------------------------------------------------------
  // 3. Disabled Connection Check (HTTP 400 DISABLED)
  // --------------------------------------------------------------------------
  await t.test('3. Disabled connection is rejected with HTTP 400 DISABLED', async () => {
    const disabledId = `conn_disabled_test_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: disabledId,
      name: 'Disabled Test Connection',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: 'gsk_disabled_key_12345',
      isEnabled: false,
    });

    try {
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: disabledId,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'DISABLED');
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('disabled'));
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(disabledId);
    }
  });

  // --------------------------------------------------------------------------
  // 4. Missing Credential Check (HTTP 401 KEY_UNCONFIGURED)
  // --------------------------------------------------------------------------
  await t.test('4. Connection requiring key with unconfigured API key returns HTTP 401 KEY_UNCONFIGURED', async () => {
    const noKeyId = `conn_nokey_test_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: noKeyId,
      name: 'Missing Key Connection',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: '',
      isEnabled: true,
    });

    try {
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: noKeyId,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'KEY_UNCONFIGURED');
          assert.equal(err.status, 401);
          assert.ok(err.message.includes('API key is unconfigured'));
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(noKeyId);
    }
  });

  // --------------------------------------------------------------------------
  // 5. COST-01: Cost Policy Pre-Flight Enforcement
  // --------------------------------------------------------------------------
  await t.test('5. COST-01: Server-side cost policy pre-checks block billable models under free_only/prefer_free', async () => {
    const paidConnId = `conn_engine_paid_${Date.now()}`;
    const unverifiedConnId = `conn_engine_unverified_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: paidConnId,
      name: 'Paid LLM Connection',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-testPaidKeyEngine123',
      pricing: {
        isZeroPriced: false,
        pricingTier: 'paid',
        promptPricePerMillion: 2.5,
        completionPricePerMillion: 10.0,
      },
    });

    providerManager.addOrUpdateConnection({
      id: unverifiedConnId,
      name: 'Unverified LLM Connection',
      provider: 'External Provider',
      modelId: 'unverified-custom-model',
      apiKey: 'sk-ext-unverifiedKey123',
      baseUrl: 'https://example.com/v1',
    });

    try {
      // 5a. free_only blocks paid model with HTTP 402 PAYWALL_BLOCKED
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: paidConnId,
            costPolicy: 'free_only',
            prompt: 'Explain quantum entanglement',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('free_only'));
          return true;
        }
      );

      // 5b. free_only blocks unverified/unknown pricing with HTTP 402 PAYWALL_BLOCKED
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: unverifiedConnId,
            costPolicy: 'free_only',
            prompt: 'Explain quantum entanglement',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('unknown, missing, or unverified'));
          return true;
        }
      );

      // 5c. prefer_free blocks paid model unless allowPaidExecution is explicitly true
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: paidConnId,
            costPolicy: 'prefer_free',
            allowPaidExecution: false,
            prompt: 'Explain quantum entanglement',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('allowPaidExecution: true'));
          return true;
        }
      );

      // 5d. Invalid cost policy string rejected with HTTP 400 INVALID_PAYLOAD
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: paidConnId,
            costPolicy: 'bogus_policy' as any,
            prompt: 'Hello',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'INVALID_PAYLOAD');
          assert.equal(err.status, 400);
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(paidConnId);
      providerManager.deleteConnection(unverifiedConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 6. Modality & Compatibility Pre-Flight Validation
  // --------------------------------------------------------------------------
  await t.test('6. Non-text generation models rejected with HTTP 400 UNSUPPORTED_MODALITY', async () => {
    const embedConnId = `conn_embed_test_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: embedConnId,
      name: 'Embeddings Only Connection',
      provider: 'OpenAI',
      modelId: 'text-embedding-3-small',
      apiKey: 'sk-proj-embedKey123',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    try {
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: embedConnId,
            prompt: 'Generate video script',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'UNSUPPORTED_MODALITY');
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('does not support text generation'));
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(embedConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 7. SSRF Validation for Custom Endpoints
  // --------------------------------------------------------------------------
  await t.test('7. SSRF Validation blocks loopback, private ranges, and non-HTTP protocols on custom endpoints', async () => {
    const ssrfConnId = `conn_ssrf_test_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: ssrfConnId,
      name: 'SSRF Attack Connection',
      provider: 'External Provider',
      modelId: 'custom-model',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-ext-testKey123',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    try {
      await assert.rejects(
        async () => {
          await executeAI({
            connectionId: ssrfConnId,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.ok(err.category === 'SSRF_BLOCKED' || err.status === 400);
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(ssrfConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 8. Live Adapter Execution & Normalized Success Result
  // --------------------------------------------------------------------------
  await t.test('8. Adapter execution returns normalized AIExecutionResult with usage tokens and JSON handling', async () => {
    let capturedAuth = '';
    let capturedBody: any = null;

    const mockServer = http.createServer((req, res) => {
      capturedAuth = req.headers.authorization || '';
      let bodyStr = '';
      req.on('data', (c) => (bodyStr += c));
      req.on('end', () => {
        try {
          capturedBody = JSON.parse(bodyStr);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '```json\n{"title": "Cosmic Anomaly", "scenesCount": 3}\n```',
                },
              },
            ],
            usage: {
              prompt_tokens: 42,
              completion_tokens: 18,
              total_tokens: 60,
            },
          })
        );
      });
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const testConnId = `conn_exec_test_${Date.now()}`;
    const testSecretKey = 'gsk_mock_execution_secret_key_888';

    providerManager.addOrUpdateConnection({
      id: testConnId,
      name: 'Mock Groq Endpoint',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: testSecretKey,
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    try {
      const result: AIExecutionResult = await executeAI({
        connectionId: testConnId,
        prompt: 'Return cosmic anomaly metadata',
        systemInstruction: 'Output JSON schema strictly',
        responseMimeType: 'application/json',
        customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      // Verify execution result contract
      assert.equal(result.success, true);
      assert.equal(result.connectionId, testConnId);
      assert.equal(result.model, 'llama-3.3-70b-versatile');
      assert.ok(result.latencyMs >= 0);
      assert.equal(result.isFallback, false);

      // Verify clean JSON text unwrapping and parsed data
      assert.ok(!result.text.startsWith('```'));
      assert.deepEqual(result.data, { title: 'Cosmic Anomaly', scenesCount: 3 });

      // Verify usage tokens
      assert.equal(result.usage?.promptTokens, 42);
      assert.equal(result.usage?.completionTokens, 18);
      assert.equal(result.usage?.totalTokens, 60);

      // Verify request payload dispatched to provider
      assert.equal(capturedAuth, `Bearer ${testSecretKey}`);
      assert.equal(capturedBody.model, 'llama-3.3-70b-versatile');
      assert.ok(capturedBody.messages.some((m: any) => m.role === 'system'));
      assert.ok(capturedBody.messages.some((m: any) => m.role === 'user'));
    } finally {
      mockServer.close();
      providerManager.deleteConnection(testConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 9. Groq Adapter json_object Rejection Auto-Retry
  // --------------------------------------------------------------------------
  await t.test('9. GroqAdapter retries without response_format if provider returns HTTP 400 with json_object', async () => {
    let callCount = 0;
    let secondAttemptHadFormat = false;

    const mockServer = http.createServer((req, res) => {
      callCount++;
      let bodyStr = '';
      req.on('data', (c) => (bodyStr += c));
      req.on('end', () => {
        const body = JSON.parse(bodyStr);
        if (callCount === 1) {
          // Reject first call due to unsupported response_format
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'response_format is not supported for this model' } }));
        } else {
          // Second call without response_format succeeds
          secondAttemptHadFormat = Boolean(body.response_format);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '{"status": "ok_after_retry"}' } }],
            })
          );
        }
      });
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const retryConnId = `conn_retry_test_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: retryConnId,
      name: 'Groq Retry Test',
      provider: 'Groq',
      modelId: 'qwen/qwen3.8-27b',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'gsk_retry_test_key_999',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    try {
      const result = await executeAI({
        connectionId: retryConnId,
        prompt: 'Generate status',
        responseMimeType: 'application/json',
        customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      assert.equal(callCount, 2, 'Should have retried after HTTP 400 rejection');
      assert.equal(secondAttemptHadFormat, false, 'Second attempt should omit response_format');
      assert.equal(result.success, true);
      assert.deepEqual(result.data, { status: 'ok_after_retry' });
    } finally {
      mockServer.close();
      providerManager.deleteConnection(retryConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 10. OpenRouter Headers & Provenance
  // --------------------------------------------------------------------------
  await t.test('10. OpenRouterAdapter includes HTTP-Referer and X-Title provenance headers', async () => {
    let refererHeader = '';
    let xTitleHeader = '';

    const mockServer = http.createServer((req, res) => {
      refererHeader = req.headers['http-referer'] as string || '';
      xTitleHeader = req.headers['x-title'] as string || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'OpenRouter verified' } }],
        })
      );
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const orConnId = `conn_or_headers_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: orConnId,
      name: 'OpenRouter Headers Test',
      provider: 'OpenRouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-or-v1-testProvenanceKey123',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    try {
      const result = await executeAI({
        connectionId: orConnId,
        prompt: 'Test provenance headers',
        customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      assert.equal(result.success, true);
      assert.equal(refererHeader, 'https://illumatrix.internal');
      assert.equal(xTitleHeader, 'ILLUMATRIX Content Workspace');
    } finally {
      mockServer.close();
      providerManager.deleteConnection(orConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 11. COST-02: Failover Parity and Isolation
  // --------------------------------------------------------------------------
  await t.test('11. COST-02: Failover adheres strictly to active cost policy and credential isolation', async () => {
    let primHits = 0;
    let failoverHits = 0;

    const mockServer = http.createServer((req, res) => {
      if (req.url?.includes('/primary')) {
        primHits++;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit (429)' } }));
      } else if (req.url?.includes('/failover')) {
        failoverHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Failover response content' } }],
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const primId = `conn_fail_p_${Date.now()}`;
    const eligibleFailId = `conn_fail_f_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: primId,
      name: 'Primary Rate Limited Connection',
      provider: 'External Provider',
      modelId: 'primary-model',
      baseUrl: `http://127.0.0.1:${port}/primary`,
      apiKey: 'sk-prim-key-123',
      quotaPool: 'POOL_A',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });
    const prim = providerManager.getConnection(primId);
    if (prim) prim.allowFailover = true;

    providerManager.addOrUpdateConnection({
      id: eligibleFailId,
      name: 'Eligible Free Failover Connection',
      provider: 'External Provider',
      modelId: 'failover-model',
      baseUrl: `http://127.0.0.1:${port}/failover`,
      apiKey: 'sk-fail-key-456',
      quotaPool: 'POOL_B',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });
    const failoverConn = providerManager.getConnection(eligibleFailId);
    if (failoverConn) failoverConn.allowFailover = true;

    try {
      const result = await executeAI({
        connectionId: primId,
        costPolicy: 'free_only',
        prompt: 'Execute with failover permitted',
        customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      assert.equal(primHits, 1, 'Primary should have been attempted first');
      assert.equal(failoverHits, 1, 'Eligible free failover should have succeeded');
      assert.equal(result.isFallback, true);
      assert.equal(result.failoverOccurred, true);
      assert.equal(result.originalConnectionId, primId);
      assert.equal(result.connectionId, eligibleFailId);
      assert.equal(result.text, 'Failover response content');
    } finally {
      mockServer.close();
      providerManager.deleteConnection(primId);
      providerManager.deleteConnection(eligibleFailId);
    }
  });

  // --------------------------------------------------------------------------
  // 12. AIExecutionError Scrubbing & Safe Serialization
  // --------------------------------------------------------------------------
  await t.test('12. AIExecutionError scrubs secrets and serializes safely without cleartext keys', () => {
    const rawSecret = 'AIzaSySecretLeak123456789';
    const err = new AIExecutionError({
      message: `Failed request with secret API key ${rawSecret}`,
      category: 'INVALID_CREDENTIALS',
      status: 403,
      connectionId: 'conn_test_err',
      provider: 'Google GenAI',
      modelId: 'gemini-3.8-flash',
      details: `Bearer ${rawSecret}`,
    });

    // Zero raw secret in message
    assert.ok(!err.message.includes(rawSecret));
    assert.ok(err.message.includes('AIza***') || err.message.includes('***'));

    // Safe toJSON output
    const json = err.toJSON();
    assert.equal(json.error, true);
    assert.equal(json.category, 'INVALID_CREDENTIALS');
    assert.equal(json.status, 403);
    assert.ok(!JSON.stringify(json).includes(rawSecret));
  });
});
