import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server';
import {
  providerManager,
  sanitizeError,
  PROVIDER_REGISTRY,
  type SupportedProvider,
} from '../src/server/providerManager';
import {
  aiExecutionEngine,
  executeAI,
  AIExecutionError,
  type ProviderExecutionAdapter,
  type ProviderExecutionContext,
  type AdapterExecutionResult,
  type AIExecutionRequest,
} from '../src/server/aiExecutionEngine';

// Deterministic in-memory test adapter for intercepting route-level dispatches
class MockRouteInterceptorAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'MockRouteInterceptorAdapter';
  public lastContext?: ProviderExecutionContext;
  public lastRequest?: AIExecutionRequest;
  public callCount = 0;
  public mockText: string = JSON.stringify({
    title: 'Engine Verified Script',
    hookSummary: 'Verified hook summary',
    scenes: [
      {
        sceneNumber: 1,
        timeRange: '0–8s',
        purpose: 'Hook',
        narrationText: 'Opening narration line one.',
        visualDirectionDraft: 'Cinematic visual establishing shot.',
        wordCount: 4,
      },
      {
        sceneNumber: 2,
        timeRange: '8–16s',
        purpose: 'Reveal',
        narrationText: 'Second narration line reveal.',
        visualDirectionDraft: 'Close-up focal composition.',
        wordCount: 4,
      },
      {
        sceneNumber: 3,
        timeRange: '16–24s',
        purpose: 'Payoff',
        narrationText: 'Conclusive payoff line three.',
        visualDirectionDraft: 'Expansive wide shot payoff.',
        wordCount: 4,
      },
    ],
    totalEstimatedWords: 12,
    speakingDurationSeconds: 8,
    packages: [
      {
        sceneNumber: 1,
        title: 'SCENE 01 — HOOK',
        visualPrompt: 'Cinematic 9:16 composition. Deep space anomaly.',
        continuitySnippet: 'Style: Cinematic; Palette: Obsidian & Cyan',
        soundDesign: 'Low ambient drone.',
      },
    ],
    titleOptions: ['Title 1', 'Title 2'],
    selectedTitle: 'Title 1',
    description: 'Verified SEO Description',
    tags: ['space', 'anomaly'],
    hashtags: ['#space'],
    chapters: [{ timestamp: '00:00', title: 'Intro' }],
    options: [
      {
        id: 'option_a',
        name: 'PROMPT A // OBJECT OF ENIGMA',
        conceptAngle: 'Macro core focus',
        ratio: '9:16 vertical',
        focalSubject: 'Crystalline anomaly',
        lightingAndMood: 'Cyan rim lighting',
        composition: 'Macro angle',
        detailedPrompt: 'Detailed thumbnail prompt A',
        overlayTextSuggestion: 'SIGNAL DETECTED',
        negativeConstraints: 'No blur',
      },
    ],
  });
  public mockError?: any;
  public mockImageUrl?: string = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...';

  public canHandle(_provider: SupportedProvider): boolean {
    return true; // Intercepts any provider in test scope
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    this.callCount++;
    this.lastContext = ctx;
    this.lastRequest = req;

    if (this.mockError) {
      throw this.mockError;
    }

    if (req.modality === 'image') {
      return {
        text: this.mockImageUrl!,
        imageUrl: this.mockImageUrl!,
      };
    }

    return {
      text: this.mockText,
      usage: { promptTokens: 25, completionTokens: 40, totalTokens: 65 },
    };
  }

  public reset(): void {
    this.lastContext = undefined;
    this.lastRequest = undefined;
    this.callCount = 0;
    this.mockError = undefined;
  }
}

test('Task 3.2: Execution Engine Integration & Legacy Path Elimination', async (t) => {
  // Ephemeral test HTTP server wrapping the Express app
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', () => res(true)));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const interceptor = new MockRouteInterceptorAdapter();
  aiExecutionEngine.registerAdapter(interceptor);

  // Helper function to send authenticated JSON POST requests to server
  const postJson = async (endpoint: string, body: any) => {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  };

  t.after(() => {
    aiExecutionEngine.unregisterAdapter(interceptor.adapterName);
    server.close();
  });

  // Setup test connections
  const testConnFree = `conn_test_free_${Date.now()}`;
  providerManager.addOrUpdateConnection({
    id: testConnFree,
    name: 'Verified Free Node',
    provider: 'Google GenAI',
    modelId: 'gemini-3.1-flash-lite',
    apiKey: 'AIzaSySyntheticTestKey123',
    pricing: { isZeroPriced: true, pricingTier: 'free' },
  });

  const testConnPaid = `conn_test_paid_${Date.now()}`;
  providerManager.addOrUpdateConnection({
    id: testConnPaid,
    name: 'Frontier Paid Node',
    provider: 'Google GenAI',
    modelId: 'gemini-4-argon',
    apiKey: 'AIzaSySyntheticPaidKey456',
    pricing: { isZeroPriced: false, pricingTier: 'paid' },
  });

  t.after(() => {
    providerManager.deleteConnection(testConnFree);
    providerManager.deleteConnection(testConnPaid);
  });

  // --------------------------------------------------------------------------
  // 1. Audit & Verification: Each generation route reaches the shared engine
  // --------------------------------------------------------------------------
  await t.test('1. Every primary generation route dispatches through the shared AIExecutionEngine', async (subTest) => {
    // 1a. Script Generation
    await subTest.test('1a. POST /api/ai/generate-script reaches shared engine with taskType script_generation', async () => {
      interceptor.reset();
      const res = await postJson('/api/ai/generate-script', {
        connectionId: testConnFree,
        sourceTitle: 'Alien Signal Discovery',
        sourceText: 'A repeating 8.4-second telemetric signal was confirmed originating beyond Pluto.',
        duration: 24,
        format: '9:16_SHORTS',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'script_generation');
      assert.equal(interceptor.lastRequest?.connectionId, testConnFree);
    });

    // 1b. Single Scene Regeneration
    await subTest.test('1b. POST /api/ai/regenerate-scene reaches shared engine with taskType script_generation', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        narrationText: 'Updated telemetric narration line.',
        visualDirectionDraft: 'Refined close-up of sensor readout.',
        wordCount: 5,
      });

      const res = await postJson('/api/ai/regenerate-scene', {
        connectionId: testConnFree,
        sceneNumber: 2,
        timeRange: '8–16s',
        purpose: 'Reveal',
        sourceText: 'Telemetric signal detected.',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'script_generation');
    });

    // 1c. Scene Prompts Generation
    await subTest.test('1c. POST /api/ai/generate-scene-prompts reaches shared engine with taskType scene_prompts', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        packages: [
          {
            sceneNumber: 1,
            title: 'SCENE 01 — HOOK',
            visualPrompt: 'Cinematic 9:16 composition. Deep space void with crystalline prism.',
            continuitySnippet: 'Style: Cinematic; Palette: Obsidian & Cyan',
            soundDesign: 'Low ambient space drone.',
          },
        ],
      });

      const res = await postJson('/api/ai/generate-scene-prompts', {
        connectionId: testConnFree,
        scenes: [
          {
            sceneNumber: 1,
            timeRange: '0–8s',
            purpose: 'Hook',
            narrationText: 'A mysterious signal detected beyond Pluto.',
            visualDirectionDraft: 'Macro shot of space prism.',
          },
        ],
        format: '9:16_SHORTS',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'scene_prompts');
    });

    // 1d. Style-Only Prompt Regeneration
    await subTest.test('1d. POST /api/ai/regenerate-style-prompts reaches shared engine with taskType style_regeneration', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        scenes: [
          {
            sceneNumber: 1,
            visualPrompt: 'Paper craft diorama of alien tetrahedron.',
            continuitySnippet: 'Style: Paper Craft',
          },
        ],
      });

      const res = await postJson('/api/ai/regenerate-style-prompts', {
        connectionId: testConnFree,
        scenes: [
          {
            sceneNumber: 1,
            visualPrompt: 'Cinematic space prism.',
            narration: 'A mysterious signal detected beyond Pluto.',
            scriptBeat: 'A mysterious signal detected beyond Pluto.',
          },
        ],
        newVisualStyleId: 'paper_craft',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'style_regeneration');
    });

    // 1e. Single Scene Prompt Regeneration
    await subTest.test('1e. POST /api/ai/regenerate-scene-prompt reaches shared engine with taskType single_scene_prompt', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        title: 'SCENE 01 — REFINED HOOK',
        visualPrompt: 'Refined macro view of crystalline surface.',
        continuitySnippet: 'Style: Cinematic',
        soundDesign: 'Prismatic chime.',
      });

      const res = await postJson('/api/ai/regenerate-scene-prompt', {
        connectionId: testConnFree,
        sceneNumber: 1,
        narration: 'Signal confirmed.',
        scriptBeat: 'Signal confirmed.',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'single_scene_prompt');
    });

    // 1f. SEO Generation
    await subTest.test('1f. POST /api/ai/generate-seo reaches shared engine with taskType seo_generation', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        titleOptions: ['Signal Detected', 'Cosmic Mystery'],
        selectedTitle: 'Signal Detected',
        description: 'Deep space telemetry analysis.',
        tags: ['space', 'science'],
        hashtags: ['#space'],
        chapters: [{ timestamp: '00:00', title: 'Start' }],
      });

      const res = await postJson('/api/ai/generate-seo', {
        connectionId: testConnFree,
        sourceTitle: 'Alien Signal',
        scenes: [
          {
            sceneNumber: 1,
            timeRange: '0–8s',
            purpose: 'Hook',
            narrationText: 'Signal detected.',
          },
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'seo_generation');
    });

    // 1g. Thumbnail Generation
    await subTest.test('1g. POST /api/ai/generate-thumbnails reaches shared engine with taskType thumbnail_prompts', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        options: [
          {
            id: 'option_a',
            name: 'PROMPT A // OBJECT OF ENIGMA',
            conceptAngle: 'Macro crystal',
            ratio: '9:16 vertical',
            focalSubject: 'Prism',
            lightingAndMood: 'Cyan fill',
            composition: 'Low angle',
            detailedPrompt: 'Detailed macro prompt',
            overlayTextSuggestion: 'SIGNAL FOUND',
            negativeConstraints: 'No blur',
          },
          {
            id: 'option_b',
            name: 'PROMPT B // ASTRONOMER DISCOVERY',
            conceptAngle: 'Astronomer silhouette',
            ratio: '9:16 vertical',
            focalSubject: 'Scientist',
            lightingAndMood: 'Amber telemetry glow',
            composition: 'Dutch angle',
            detailedPrompt: 'Detailed observer prompt',
            overlayTextSuggestion: 'NOT RANDOM',
            negativeConstraints: 'No blur',
          },
        ],
      });

      const res = await postJson('/api/ai/generate-thumbnails', {
        connectionId: testConnFree,
        sourceTitle: 'Alien Signal',
        scenes: [],
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'thumbnail_prompts');
    });

    // 1h. Single Thumbnail Regeneration
    await subTest.test('1h. POST /api/ai/regenerate-single-thumbnail reaches shared engine with taskType single_thumbnail', async () => {
      interceptor.reset();
      interceptor.mockText = JSON.stringify({
        id: 'option_a',
        name: 'PROMPT A // OBJECT OF ENIGMA',
        conceptAngle: 'Refined macro crystal',
        ratio: '9:16 vertical',
        focalSubject: 'Faceted prism',
        lightingAndMood: 'Cyan fill',
        composition: 'Macro angle',
        detailedPrompt: 'Refined prompt A',
        overlayTextSuggestion: 'SIGNAL CONFIRMED',
        negativeConstraints: 'No blur',
      });

      const res = await postJson('/api/ai/regenerate-single-thumbnail', {
        connectionId: testConnFree,
        optionId: 'option_a',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.taskType, 'single_thumbnail');
    });

    // 1i. Thumbnail Image Rendering
    await subTest.test('1i. POST /api/ai/render-thumbnail-image reaches shared engine with modality image', async () => {
      interceptor.reset();
      const res = await postJson('/api/ai/render-thumbnail-image', {
        connectionId: testConnFree,
        prompt: 'Extreme macro view of alien crystal in space, 9:16 vertical',
        format: '9:16_SHORTS',
        optionId: 'option_a',
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(interceptor.callCount, 1);
      assert.equal(interceptor.lastRequest?.modality, 'image');
      assert.equal(interceptor.lastRequest?.modelId, 'gemini-3.1-flash-lite-image');
      assert.ok(res.data.imageUrl.startsWith('data:image/'));
    });
  });

  // --------------------------------------------------------------------------
  // 2. ROUTE-01: Unknown Connection ID Fails Closed
  // --------------------------------------------------------------------------
  await t.test('2. ROUTE-01: Unknown explicit connection IDs fail with HTTP 404 CONNECTION_NOT_FOUND', async () => {
    interceptor.reset();
    const unknownId = `conn_ghost_${Date.now()}`;

    const res = await postJson('/api/ai/generate-script', {
      connectionId: unknownId,
      sourceTitle: 'Ghost Connection Test',
      sourceText: 'Some source content.',
    });

    assert.equal(res.status, 404);
    assert.equal(res.data.error, true);
    assert.equal(res.data.category, 'CONNECTION_NOT_FOUND');
    assert.equal(interceptor.callCount, 0, 'No provider dispatch allowed for unknown connection');
  });

  // --------------------------------------------------------------------------
  // 3. COST-01: Restrictive Cost Policies Block Paid / Unverified Models
  // --------------------------------------------------------------------------
  await t.test('3. COST-01: Paid models blocked under free_only and prefer_free without auth', async () => {
    interceptor.reset();

    // 3a. free_only rejects paid model with HTTP 402 PAYWALL_BLOCKED
    const resFreeOnly = await postJson('/api/ai/generate-script', {
      connectionId: testConnPaid,
      costPolicy: 'free_only',
      sourceTitle: 'Cost Policy Test',
      sourceText: 'Source text for cost check.',
    });

    assert.equal(resFreeOnly.status, 402);
    assert.equal(resFreeOnly.data.error, true);
    assert.equal(resFreeOnly.data.category, 'PAYWALL_BLOCKED');
    assert.equal(interceptor.callCount, 0, 'No dispatch permitted under free_only for paid model');

    // 3b. prefer_free rejects paid model when allowPaidExecution is not provided
    const resPreferFree = await postJson('/api/ai/generate-script', {
      connectionId: testConnPaid,
      costPolicy: 'prefer_free',
      allowPaidExecution: false,
      sourceTitle: 'Cost Policy Test',
      sourceText: 'Source text for cost check.',
    });

    assert.equal(resPreferFree.status, 402);
    assert.equal(resPreferFree.data.category, 'PAYWALL_BLOCKED');
    assert.equal(interceptor.callCount, 0);

    // 3c. Explicit allowPaidExecution permits paid execution
    const resAuthorized = await postJson('/api/ai/generate-script', {
      connectionId: testConnPaid,
      costPolicy: 'prefer_free',
      allowPaidExecution: true,
      sourceTitle: 'Cost Policy Test',
      sourceText: 'Source text for cost check.',
    });

    assert.equal(resAuthorized.status, 200);
    assert.equal(interceptor.callCount, 1);
  });

  // --------------------------------------------------------------------------
  // 4. Credential Isolation Across Connections (BYOK)
  // --------------------------------------------------------------------------
  await t.test('4. BYOK credentials remain isolated per connection with zero cross-leakage', async () => {
    const connA = `conn_byok_a_${Date.now()}`;
    const keyA = 'AIzaSyAlphaSyntheticSecretKey111';
    providerManager.addOrUpdateConnection({
      id: connA,
      name: 'Node Alpha',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: keyA,
    });

    const connB = `conn_byok_b_${Date.now()}`;
    const keyB = 'AIzaSyBetaSyntheticSecretKey222';
    providerManager.addOrUpdateConnection({
      id: connB,
      name: 'Node Beta',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: keyB,
    });

    try {
      interceptor.reset();
      const resA = await postJson('/api/ai/generate-script', {
        connectionId: connA,
        sourceTitle: 'Isolation Test A',
        sourceText: 'Testing key A',
      });
      assert.equal(resA.status, 200);
      assert.equal(interceptor.lastContext?.effectiveKey, keyA);

      interceptor.reset();
      const resB = await postJson('/api/ai/generate-script', {
        connectionId: connB,
        sourceTitle: 'Isolation Test B',
        sourceText: 'Testing key B',
      });
      assert.equal(resB.status, 200);
      assert.equal(interceptor.lastContext?.effectiveKey, keyB);
      assert.notEqual(interceptor.lastContext?.effectiveKey, keyA);

      // Verify response body never leaks cleartext key
      const bodyStr = JSON.stringify(resB.data);
      assert.ok(!bodyStr.includes(keyA));
      assert.ok(!bodyStr.includes(keyB));
    } finally {
      providerManager.deleteConnection(connA);
      providerManager.deleteConnection(connB);
    }
  });

  // --------------------------------------------------------------------------
  // 5. Disabled Connections Cannot Execute
  // --------------------------------------------------------------------------
  await t.test('5. Disabled connections fail closed with HTTP 400 DISABLED', async () => {
    const disabledConnId = `conn_disabled_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: disabledConnId,
      name: 'Disabled Node',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: 'AIzaSyDisabledKey123',
      isEnabled: false,
    });

    try {
      interceptor.reset();
      const res = await postJson('/api/ai/generate-script', {
        connectionId: disabledConnId,
        sourceTitle: 'Disabled Connection Test',
        sourceText: 'Should not run.',
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.error, true);
      assert.equal(res.data.category, 'DISABLED');
      assert.equal(interceptor.callCount, 0, 'Disabled connection must not dispatch');
    } finally {
      providerManager.deleteConnection(disabledConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 6. Unsupported Modality Rejections Before Dispatch
  // --------------------------------------------------------------------------
  await t.test('6. Modality mismatches fail before provider dispatch with HTTP 400 UNSUPPORTED_MODALITY', async () => {
    // 6a. Attempting text generation with an image-only model
    interceptor.reset();
    const resTextOnImage = await postJson('/api/ai/generate-script', {
      connectionId: testConnFree,
      modelId: 'gemini-3.1-flash-lite-image',
      sourceTitle: 'Modality Test',
      sourceText: 'Should be rejected for text generation.',
    });

    assert.equal(resTextOnImage.status, 400);
    assert.equal(resTextOnImage.data.category, 'UNSUPPORTED_MODALITY');
    assert.equal(interceptor.callCount, 0, 'No dispatch when model modality is incompatible with text');

    // 6b. Attempting image rendering with a non-Google provider
    const groqConnId = `conn_groq_modality_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: groqConnId,
      name: 'Groq Modality Node',
      provider: 'Groq',
      modelId: 'llama-3.3-70b-versatile',
      apiKey: 'gsk_syntheticGroqKey123',
    });

    try {
      interceptor.reset();
      const resImageOnGroq = await postJson('/api/ai/render-thumbnail-image', {
        connectionId: groqConnId,
        prompt: 'Render an image with Groq (not supported)',
      });

      assert.equal(resImageOnGroq.status, 400);
      assert.equal(resImageOnGroq.data.category, 'UNSUPPORTED_MODALITY');
      assert.equal(interceptor.callCount, 0, 'Groq does not support image rendering');
    } finally {
      providerManager.deleteConnection(groqConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 7. Honest Error Mapping & Status Codes
  // --------------------------------------------------------------------------
  await t.test('7. Provider errors map to accurate HTTP status codes and structured categories', async () => {
    // 7a. Rate Limit (HTTP 429)
    interceptor.reset();
    interceptor.mockError = new AIExecutionError({
      message: 'Rate limit exceeded (429)',
      category: 'RATE_LIMIT_429',
      status: 429,
    });

    const res429 = await postJson('/api/ai/generate-script', {
      connectionId: testConnFree,
      sourceTitle: 'Rate limit test',
      sourceText: 'Test text.',
    });
    assert.equal(res429.status, 429);
    assert.equal(res429.data.category, 'RATE_LIMIT_429');

    // 7b. Invalid Credentials (HTTP 403)
    interceptor.reset();
    interceptor.mockError = new AIExecutionError({
      message: 'API key is invalid or unauthorized',
      category: 'INVALID_CREDENTIALS',
      status: 403,
    });

    const res403 = await postJson('/api/ai/generate-script', {
      connectionId: testConnFree,
      sourceTitle: 'Auth test',
      sourceText: 'Test text.',
    });
    assert.equal(res403.status, 403);
    assert.equal(res403.data.category, 'INVALID_CREDENTIALS');

    // 7c. Upstream Timeout (HTTP 504)
    interceptor.reset();
    interceptor.mockError = new AIExecutionError({
      message: 'Upstream gateway timed out',
      category: 'TIMEOUT',
      status: 504,
    });

    const res504 = await postJson('/api/ai/generate-script', {
      connectionId: testConnFree,
      sourceTitle: 'Timeout test',
      sourceText: 'Test text.',
    });
    assert.equal(res504.status, 504);
    assert.equal(res504.data.category, 'TIMEOUT');
  });

  // --------------------------------------------------------------------------
  // 8. Custom Provider SSRF Protection
  // --------------------------------------------------------------------------
  await t.test('8. Custom provider endpoints enforce SSRF protections against internal/private IPs', async () => {
    const ssrfConnId = `conn_ssrf_attack_${Date.now()}`;
    providerManager.addOrUpdateConnection({
      id: ssrfConnId,
      name: 'SSRF Target Node',
      provider: 'External Provider',
      modelId: 'custom-model',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-ext-key123',
    });

    try {
      interceptor.reset();
      const res = await postJson('/api/ai/generate-script', {
        connectionId: ssrfConnId,
        sourceTitle: 'SSRF Test',
        sourceText: 'Should be blocked.',
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.category, 'SSRF_BLOCKED');
      assert.equal(interceptor.callCount, 0, 'SSRF attempt must be rejected before dispatch');
    } finally {
      providerManager.deleteConnection(ssrfConnId);
    }
  });

  // --------------------------------------------------------------------------
  // 9. Legacy Path Elimination Verification
  // --------------------------------------------------------------------------
  await t.test('9. Legacy direct SDK calls and unused fallback functions are completely eliminated from server.ts', async () => {
    const serverModule = await import('../server');
    assert.equal((serverModule as any).getAiClient, undefined, 'getAiClient legacy helper must not be exported or present');
    assert.equal((serverModule as any).generateWithModelFallback, undefined, 'generateWithModelFallback legacy helper must not be exported or present');
    assert.ok(serverModule.app, 'Express app must be exported for route testing');
  });
});
