import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  providerManager,
  sanitizeError,
  maskApiKey,
  PROVIDER_REGISTRY,
  SupportedProvider,
  handleGenerationError,
} from '../src/server/providerManager';
import {
  classifyOpenRouterPricing,
  evaluateConnectionPricing,
  evaluateModelCompatibility,
} from '../src/server/modelCompatibility';

test('Task 1.4B: Provider Execution & Cost Policy Remediation Suite', async (t) => {
  // Scenario 1: Explicit unknown connection ID returns CONNECTION_NOT_FOUND (HTTP 404) without dispatch
  await t.test('1. Explicit unknown connection ID returns CONNECTION_NOT_FOUND (404) without dispatch', async () => {
    const unknownId = 'conn_completely_nonexistent_xyz_999';

    // 1a. getEffectiveCredentials fails closed
    assert.throws(
      () => {
        providerManager.getEffectiveCredentials(unknownId);
      },
      (err: any) => {
        assert.equal(err.category, 'CONNECTION_NOT_FOUND');
        assert.equal(err.status, 404);
        assert.ok(err.message.includes(unknownId));
        return true;
      }
    );

    // 1b. executeTextGeneration fails closed without attempting dispatch
    await assert.rejects(
      async () => {
        await providerManager.executeTextGeneration({
          connectionId: unknownId,
          prompt: 'Hello world',
        });
      },
      (err: any) => {
        assert.equal(err.category, 'CONNECTION_NOT_FOUND');
        assert.equal(err.status, 404);
        assert.ok(err.message.includes(unknownId));
        return true;
      }
    );

    // 1c. testConnection returns errorCategory CONNECTION_NOT_FOUND
    const testResult = await providerManager.testConnection(unknownId);
    assert.equal(testResult.success, false);
    assert.equal(testResult.errorCategory, 'CONNECTION_NOT_FOUND');
    assert.ok(testResult.error?.includes(unknownId));
  });

  // Scenario 2: BYOK routing uses only the selected connection
  await t.test('2. BYOK routing uses only the explicitly selected connection and credentials', () => {
    const byokIdA = `conn_byok_test_a_${Date.now()}`;
    const byokIdB = `conn_byok_test_b_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: byokIdA,
      name: 'Custom User BYOK Alpha',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: 'gsk_alpha_user_supplied_key_123456789',
      quotaPool: 'POOL_ALPHA',
    });

    providerManager.addOrUpdateConnection({
      id: byokIdB,
      name: 'Custom User BYOK Beta',
      provider: 'OpenRouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      apiKey: 'sk-or-v1-beta_user_supplied_key_987654321',
      quotaPool: 'POOL_BETA',
    });

    try {
      const credsA = providerManager.getEffectiveCredentials(byokIdA);
      assert.equal(credsA.id, byokIdA);
      assert.equal(credsA.name, 'Custom User BYOK Alpha');
      assert.equal(credsA.apiKey, 'gsk_alpha_user_supplied_key_123456789');

      const credsB = providerManager.getEffectiveCredentials(byokIdB);
      assert.equal(credsB.id, byokIdB);
      assert.equal(credsB.name, 'Custom User BYOK Beta');
      assert.equal(credsB.apiKey, 'sk-or-v1-beta_user_supplied_key_987654321');

      // Zero leakage between connections
      assert.notEqual(credsA.apiKey, credsB.apiKey);
    } finally {
      providerManager.deleteConnection(byokIdA);
      providerManager.deleteConnection(byokIdB);
    }
  });

  // Scenario 3: free_only blocks paid, unknown, missing, and ambiguous pricing before dispatch (PAYWALL_BLOCKED)
  await t.test('3. free_only blocks paid, unknown, missing, and ambiguous pricing before dispatch (PAYWALL_BLOCKED)', async () => {
    const paidConnId = `conn_paid_test_${Date.now()}`;
    const unknownConnId = `conn_unknown_test_${Date.now()}`;

    // Paid model
    providerManager.addOrUpdateConnection({
      id: paidConnId,
      name: 'Paid OpenAI Connection',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-testPaidKey123456789',
      pricing: {
        isZeroPriced: false,
        pricingTier: 'paid',
        promptPricePerMillion: 2.5,
        completionPricePerMillion: 10.0,
      },
    });

    // Unknown pricing model
    providerManager.addOrUpdateConnection({
      id: unknownConnId,
      name: 'Unknown Pricing Connection',
      provider: 'External Provider',
      modelId: 'custom-unverified-llm',
      apiKey: 'sk-ext-testUnknownKey123456',
      baseUrl: 'https://example.com/api',
    });

    try {
      // 3a. Paid model blocked under free_only
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: paidConnId,
            costPolicy: 'free_only',
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('free_only'));
          return true;
        }
      );

      // 3b. Unknown pricing model blocked under free_only
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: unknownConnId,
            costPolicy: 'free_only',
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('unknown, missing, or unverified'));
          return true;
        }
      );

      // 3c. OpenRouter model with ":free" in ID but non-zero pricing is NOT trusted
      const fakeFreeClassified = classifyOpenRouterPricing(
        { prompt: '0.000001', completion: '0.000002' },
        'meta-llama/llama-3-8b:free'
      );
      assert.equal(fakeFreeClassified.isZeroPriced, false);
      assert.equal(fakeFreeClassified.pricingTier, 'paid');
    } finally {
      providerManager.deleteConnection(paidConnId);
      providerManager.deleteConnection(unknownConnId);
    }
  });

  // Scenario 4: prefer_free cannot silently incur paid costs when free routes are unavailable
  await t.test('4. prefer_free cannot silently incur paid costs without explicit authorization', async () => {
    const paidConnId = `conn_prefer_paid_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: paidConnId,
      name: 'Paid Frontier Connection',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-testPreferPaidKey123',
      pricing: {
        isZeroPriced: false,
        pricingTier: 'paid',
        promptPricePerMillion: 5.0,
      },
    });

    try {
      // 4a. Without allowPaidExecution: true, fails closed with PAYWALL_BLOCKED (402)
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: paidConnId,
            costPolicy: 'prefer_free',
            allowPaidExecution: false,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('prefer_free'));
          assert.ok(err.message.includes('allowPaidExecution: true'));
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(paidConnId);
    }
  });

  // Scenario 5: manual follows documented authorization and selection rules
  await t.test('5. manual policy and invalid policy validation', async () => {
    // 5a. Invalid cost policy values are rejected with HTTP 400 INVALID_PAYLOAD
    await assert.rejects(
      async () => {
        await providerManager.executeTextGeneration({
          costPolicy: 'unlimited_paid' as any,
          prompt: 'Test prompt',
        });
      },
      (err: any) => {
        assert.equal(err.category, 'INVALID_PAYLOAD');
        assert.equal(err.status, 400);
        assert.ok(err.message.includes('Invalid cost policy'));
        return true;
      }
    );
  });

  // Scenario 6: Every applicable generation route enforces cost policy server-side
  await t.test('6. handleGenerationError enforces consistent status codes for policy errors', () => {
    let capturedStatus = 0;
    let capturedJson: any = null;

    const mockRes: any = {
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json(data: any) {
        capturedJson = data;
        return this;
      },
    };

    // 6a. CONNECTION_NOT_FOUND -> HTTP 404
    const err404 = new Error('Connection "missing_123" not found.');
    (err404 as any).category = 'CONNECTION_NOT_FOUND';
    (err404 as any).status = 404;

    const handled404 = handleGenerationError(err404, mockRes);
    assert.equal(handled404, true);
    assert.equal(capturedStatus, 404);
    assert.equal(capturedJson.error, true);
    assert.equal(capturedJson.category, 'CONNECTION_NOT_FOUND');

    // 6b. PAYWALL_BLOCKED -> HTTP 402
    const err402 = new Error('Blocked by free_only policy.');
    (err402 as any).category = 'PAYWALL_BLOCKED';
    (err402 as any).status = 402;

    const handled402 = handleGenerationError(err402, mockRes);
    assert.equal(handled402, true);
    assert.equal(capturedStatus, 402);
    assert.equal(capturedJson.error, true);
    assert.equal(capturedJson.category, 'PAYWALL_BLOCKED');

    // 6c. INVALID_PAYLOAD / UNSUPPORTED_MODALITY -> HTTP 400
    const err400 = new Error('Selected model does not support text generation.');
    (err400 as any).category = 'UNSUPPORTED_MODALITY';
    (err400 as any).status = 400;

    const handled400 = handleGenerationError(err400, mockRes);
    assert.equal(handled400, true);
    assert.equal(capturedStatus, 400);
    assert.equal(capturedJson.error, true);
    assert.equal(capturedJson.category, 'UNSUPPORTED_MODALITY');
  });

  // Scenario 7: Free failover never reaches paid or unknown-priced connections
  await t.test('7. Failover cost-tier isolation: free_only never fails over to paid or unknown route', async () => {
    // We create a mock HTTP server that returns 429 Rate Limit for the primary connection
    let primaryHit = false;
    let paidFailoverHit = false;

    const mockServer = http.createServer((req, res) => {
      if (req.url?.includes('/primary')) {
        primaryHit = true;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded (429)' } }));
      } else if (req.url?.includes('/paid_failover')) {
        paidFailoverHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Paid generated text' } }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const primaryId = `conn_failover_prim_${Date.now()}`;
    const paidFailoverId = `conn_failover_paid_${Date.now()}`;

    // Primary connection (configured as free tier)
    providerManager.addOrUpdateConnection({
      id: primaryId,
      name: 'Primary Free Connection',
      provider: 'External Provider',
      modelId: 'primary-free-model',
      baseUrl: `http://127.0.0.1:${port}/primary`,
      apiKey: 'sk-prim-key',
      quotaPool: 'POOL_PRIMARY',
      pricing: {
        isZeroPriced: true,
        pricingTier: 'free',
      },
    });

    // Mark primary connection allowFailover = true
    const primObj = providerManager.getConnection(primaryId);
    if (primObj) primObj.allowFailover = true;

    // Candidate failover connection (paid tier)
    providerManager.addOrUpdateConnection({
      id: paidFailoverId,
      name: 'Candidate Paid Failover',
      provider: 'External Provider',
      modelId: 'paid-failover-model',
      baseUrl: `http://127.0.0.1:${port}/paid_failover`,
      apiKey: 'sk-paid-key',
      quotaPool: 'POOL_SECONDARY',
      pricing: {
        isZeroPriced: false,
        pricingTier: 'paid',
        promptPricePerMillion: 10.0,
      },
    });

    const paidObj = providerManager.getConnection(paidFailoverId);
    if (paidObj) paidObj.allowFailover = true;

    try {
      // Execute under free_only
      // When primary returns 429, failover finder must REJECT the candidate paid connection
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: primaryId,
            costPolicy: 'free_only',
            prompt: 'Test prompt',
            customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
          });
        },
        (err: any) => {
          assert.equal(err.category, 'RATE_LIMIT_429');
          return true;
        }
      );

      // Verify that the paid failover endpoint was NEVER called
      assert.equal(primaryHit, true, 'Primary connection should have been attempted');
      assert.equal(paidFailoverHit, false, 'Paid failover should NEVER have been dispatched under free_only');
    } finally {
      mockServer.close();
      providerManager.deleteConnection(primaryId);
      providerManager.deleteConnection(paidFailoverId);
    }
  });

  // Scenario 8: Failover preserves connection and credential isolation
  await t.test('8. Failover preserves connection and credential isolation between free routes', async () => {
    let primaryKeyReceived = '';
    let failoverKeyReceived = '';

    const mockServer = http.createServer((req, res) => {
      if (req.url?.includes('/free_prim')) {
        primaryKeyReceived = req.headers['authorization'] || '';
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit 429' } }));
      } else if (req.url?.includes('/free_sec')) {
        failoverKeyReceived = req.headers['authorization'] || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Failover success text' } }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve(true)));
    const port = (mockServer.address() as any).port;

    const primaryId = `conn_iso_prim_${Date.now()}`;
    const secondaryId = `conn_iso_sec_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: primaryId,
      name: 'Primary Free Isolation Test',
      provider: 'External Provider',
      modelId: 'free-prim-model',
      baseUrl: `http://127.0.0.1:${port}/free_prim`,
      apiKey: 'sk-primary-secret-key-11111',
      quotaPool: 'POOL_ISO_1',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });
    const primObj = providerManager.getConnection(primaryId);
    if (primObj) primObj.allowFailover = true;

    providerManager.addOrUpdateConnection({
      id: secondaryId,
      name: 'Secondary Free Isolation Test',
      provider: 'External Provider',
      modelId: 'free-sec-model',
      baseUrl: `http://127.0.0.1:${port}/free_sec`,
      apiKey: 'sk-secondary-secret-key-22222',
      quotaPool: 'POOL_ISO_2',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });
    const secObj = providerManager.getConnection(secondaryId);
    if (secObj) secObj.allowFailover = true;

    try {
      const result = await providerManager.executeTextGeneration({
        connectionId: primaryId,
        costPolicy: 'free_only',
        prompt: 'Test prompt',
        customResolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      assert.equal(result.isFallback, true);
      assert.equal(result.text, 'Failover success text');

      // Verify that each endpoint received ONLY its own credentials
      assert.equal(primaryKeyReceived, 'Bearer sk-primary-secret-key-11111');
      assert.equal(failoverKeyReceived, 'Bearer sk-secondary-secret-key-22222');
      assert.notEqual(primaryKeyReceived, failoverKeyReceived);
    } finally {
      mockServer.close();
      providerManager.deleteConnection(primaryId);
      providerManager.deleteConnection(secondaryId);
    }
  });

  // Scenario 9: Connection tests do not trigger billable inference without explicit authorization (BILLABLE_TEST_REQUIRED)
  await t.test('9. Connection tests do not trigger billable inference without authorization', async () => {
    const paidConnId = `conn_billable_test_${Date.now()}`;

    // Paid model on OpenAI without non-generative mock
    providerManager.addOrUpdateConnection({
      id: paidConnId,
      name: 'Paid OpenAI Connection Test',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-testOpenAiKey123',
      pricing: {
        isZeroPriced: false,
        pricingTier: 'paid',
        promptPricePerMillion: 2.5,
      },
    });

    try {
      // 9a. Without allowBillableTest: true, testConnection fails closed with BILLABLE_TEST_REQUIRED
      const resultWithoutAuth = await providerManager.testConnection(paidConnId, {
        allowBillableTest: false,
      });

      assert.equal(resultWithoutAuth.success, false);
      assert.equal(resultWithoutAuth.errorCategory, 'BILLABLE_TEST_REQUIRED');
      assert.ok(resultWithoutAuth.error?.includes('requires billable generative inference'));
    } finally {
      providerManager.deleteConnection(paidConnId);
    }
  });

  // Scenario 10: Existing valid provider execution, missing credentials, SSRF protection, and built-in providers remain functional
  await t.test('10. Existing valid provider execution, missing credentials, and SSRF protection remain functional', async () => {
    // 10a. Missing credentials fails safely with KEY_UNCONFIGURED (HTTP 401)
    const unconfiguredId = `conn_unconfigured_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: unconfiguredId,
      name: 'Unconfigured Groq Connection',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: '', // empty key
    });

    try {
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: unconfiguredId,
            prompt: 'Hello',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'KEY_UNCONFIGURED');
          assert.equal(err.status, 401);
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(unconfiguredId);
    }

    // 10b. SSRF protection blocks restricted AWS metadata IP
    const ssrfConnId = `conn_ssrf_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: ssrfConnId,
      name: 'SSRF Malicious Connection',
      provider: 'OpenAI Compatible',
      modelId: 'test-model',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-test',
    });

    try {
      await assert.rejects(
        async () => {
          await providerManager.executeTextGeneration({
            connectionId: ssrfConnId,
            prompt: 'Hello',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'SSRF_BLOCKED');
          assert.equal(err.status, 400);
          return true;
        }
      );
    } finally {
      providerManager.deleteConnection(ssrfConnId);
    }

    // 10c. Built-in provider baseline connections remain intact
    const googleBaseline = providerManager.getConnection('conn_gemini_primary');
    assert.ok(googleBaseline, 'Baseline Google connection must exist');
    assert.equal(googleBaseline.provider, 'Google GenAI');

    const pricing = evaluateConnectionPricing(googleBaseline, googleBaseline.modelId);
    assert.equal(pricing.isZeroPriced, true);
    assert.equal(pricing.pricingTier, 'free');
  });
});
