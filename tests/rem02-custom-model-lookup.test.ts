import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { providerManager } from '../src/server/providerManager';
import { classifyOpenRouterPricing, evaluateModelCompatibility } from '../src/server/modelCompatibility';
import { AIService } from '../src/services/aiService';
import { DiscoveredModel, SupportedProvider } from '../src/types/hud';

test('REM-02: 1. AIService.fetchSingleModelInfo input validation and payload dispatch', async () => {
  // Test empty model ID rejection
  const emptyRes = await AIService.fetchSingleModelInfo({
    provider: 'OpenRouter',
    modelId: '   ',
  });
  assert.equal(emptyRes.success, false);
  assert.ok(emptyRes.message?.includes('A valid modelId is required'));

  // Test global fetch interception for payload and URL verification
  const originalFetch = globalThis.fetch;
  let interceptedUrl = '';
  let interceptedBody: any = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    interceptedUrl = String(input);
    interceptedBody = JSON.parse(String(init?.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        model: {
          id: 'meta-llama/llama-3.3-70b-instruct',
          displayName: 'Meta: Llama 3.3 70B Instruct',
          provider: 'OpenRouter',
          capabilities: {
            supportsText: true,
            supportsImageGeneration: false,
            supportsStructuredJson: true,
            supportsStreaming: true,
            supportsTools: true,
          },
          pricing: {
            promptPricePerMillion: 0.12,
            completionPricePerMillion: 0.30,
            isZeroPriced: false,
            pricingTier: 'paid',
          },
        },
      }),
    } as any;
  };

  try {
    const res = await AIService.fetchSingleModelInfo({
      provider: 'OpenRouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      connectionId: 'conn_test_01',
    });

    assert.equal(interceptedUrl, '/api/providers/single-model');
    assert.equal(interceptedBody.provider, 'OpenRouter');
    assert.equal(interceptedBody.modelId, 'meta-llama/llama-3.3-70b-instruct');
    assert.equal(interceptedBody.connectionId, 'conn_test_01');
    assert.equal(interceptedBody.apiKey, undefined);

    assert.equal(res.success, true);
    assert.ok(res.model);
    assert.equal(res.model?.id, 'meta-llama/llama-3.3-70b-instruct');
    assert.equal(res.model?.pricing?.pricingTier, 'paid');
    assert.equal(res.model?.pricing?.isZeroPriced, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REM-02: 2. AIService handles timeout and HTTP failure gracefully without throwing', async () => {
  const originalFetch = globalThis.fetch;

  // Simulate server 404
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({
      success: false,
      message: 'Model "nonexistent-model" not found in provider catalog.',
    }),
  } as any);

  try {
    const res = await AIService.fetchSingleModelInfo({
      provider: 'Google GenAI',
      modelId: 'nonexistent-model',
    });
    assert.equal(res.success, false);
    assert.ok(res.message?.includes('not found'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Simulate timeout rejection
  globalThis.fetch = async () => {
    const err: any = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  try {
    const res = await AIService.fetchSingleModelInfo({
      provider: 'OpenRouter',
      modelId: 'slow-model',
    });
    assert.equal(res.success, false);
    assert.ok(res.message?.includes('timed out'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REM-02: 3. ProviderManager.fetchSingleModelInfo resolves connection and cached models', async () => {
  // Test lookup of default baseline model
  const res = await providerManager.fetchSingleModelInfo('Google GenAI', 'gemini-3.1-flash-lite');
  assert.equal(res.success, true);
  assert.ok(res.model);
  assert.equal(res.model?.id, 'gemini-3.1-flash-lite');
  assert.equal(res.model?.capabilities?.supportsText, true);

  // Test lookup of non-existent model returns clear failure without crashing
  const missingRes = await providerManager.fetchSingleModelInfo('Google GenAI', 'completely-fake-model-xyz');
  assert.equal(missingRes.success, false);
  assert.ok(missingRes.message?.includes('not found in Google GenAI catalog'));
});

test('REM-02: 4. OpenRouter pricing classification strictly verifies zero-cost and never marks unknown as free', () => {
  // 1. Genuine zero-price ($0 prompt and $0 completion)
  const freePricing = classifyOpenRouterPricing({ prompt: 0, completion: 0 }, 'test-free-model');
  assert.equal(freePricing.isZeroPriced, true);
  assert.equal(freePricing.pricingTier, 'free');

  // 2. Suffix ":free" but with positive completion price must NOT be free
  const fakeFreePricing = classifyOpenRouterPricing({ prompt: 0, completion: 0.000001 }, 'test-model:free');
  assert.equal(fakeFreePricing.isZeroPriced, false);
  assert.equal(fakeFreePricing.pricingTier, 'paid');

  // 3. Incomplete pricing (missing completion) must be unknown
  const incompletePricing = classifyOpenRouterPricing({ prompt: 0 }, 'test-incomplete');
  assert.equal(incompletePricing.isZeroPriced, false);
  assert.equal(incompletePricing.pricingTier, 'unknown');

  // 4. Undefined / null pricing must be unknown
  const nullPricing = classifyOpenRouterPricing(null, 'test-null');
  assert.equal(nullPricing.isZeroPriced, false);
  assert.equal(nullPricing.pricingTier, 'unknown');
});

test('REM-02: 5. ProviderManagerModal component contains real single-model lookup wiring and HUD fallback states', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/layout/ProviderManagerModal.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // 1. Real API invocation
  assert.ok(
    fileContent.includes('AIService.fetchSingleModelInfo'),
    'ProviderManagerModal must invoke AIService.fetchSingleModelInfo'
  );

  // 2. Loading state to prevent duplicate submissions
  assert.ok(
    fileContent.includes('isLookingUpCustomModel'),
    'ProviderManagerModal must maintain isLookingUpCustomModel loading state'
  );
  assert.ok(
    fileContent.includes('disabled={!customModelInput.trim() || isLookingUpCustomModel}'),
    'Submit button must be disabled when input is empty or lookup is in flight'
  );
  assert.ok(
    fileContent.includes('Verifying...'),
    'Submit button must display Verifying... spinner state while looking up'
  );

  // 3. Validation before submission
  assert.ok(
    fileContent.includes('trimmed.length > 200'),
    'Must validate maximum model ID length'
  );
  assert.ok(
    fileContent.includes('invalid control characters'),
    'Must validate control characters'
  );

  // 4. Conservative metadata handling
  assert.ok(
    fileContent.includes('pricingTier === \'free\''),
    'Must strictly verify free pricing tier'
  );
  assert.ok(
    fileContent.includes('isZeroPriced: false'),
    'Must ensure non-verified pricing is never marked zero-priced'
  );

  // 5. Error notice and explicit safe fallback
  assert.ok(
    fileContent.includes('customModelLookupError'),
    'Must maintain customModelLookupError state'
  );
  assert.ok(
    fileContent.includes('unverifiedCustomCandidate'),
    'Must maintain unverifiedCustomCandidate candidate state'
  );
  assert.ok(
    fileContent.includes('handleProceedWithUnverifiedCustomModel'),
    'Must offer handleProceedWithUnverifiedCustomModel fallback handler'
  );
  assert.ok(
    fileContent.includes('Use Unverified Identifier Anyway'),
    'Must provide button for user to explicitly opt into unverified model'
  );
  assert.ok(
    fileContent.includes('handleCancelCustomLookup'),
    'Must provide cancel handler to dismiss error without mutating connection'
  );
});

test('REM-02: 6. Backend POST /api/providers/single-model route handles connectionId and resolves credentials', () => {
  const filePath = path.resolve(process.cwd(), 'server.ts');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  assert.ok(
    fileContent.includes("app.post('/api/providers/single-model'"),
    'server.ts must define POST /api/providers/single-model route'
  );
  assert.ok(
    fileContent.includes('connectionId'),
    'server.ts must accept connectionId'
  );
  assert.ok(
    fileContent.includes('providerManager.getConnection(connectionId)'),
    'server.ts must resolve connection from connectionId'
  );
  assert.ok(
    fileContent.includes('providerManager.resolveEffectiveApiKey(conn)'),
    'server.ts must securely resolve effective API key from stored connection without exposing it'
  );
});

test('REM-02: 7. WorkflowContext exposes fetchSingleModelInfo for unified model lookup', () => {
  const filePath = path.resolve(process.cwd(), 'src/context/WorkflowContext.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  assert.ok(
    fileContent.includes('fetchSingleModelInfo: (params:'),
    'WorkflowContextType must declare fetchSingleModelInfo signature'
  );
  assert.ok(
    fileContent.includes('const fetchSingleModelInfo = useCallback('),
    'WorkflowProvider must implement fetchSingleModelInfo'
  );
  assert.ok(
    fileContent.includes('fetchSingleModelInfo,'),
    'WorkflowProvider value object must export fetchSingleModelInfo'
  );
});
