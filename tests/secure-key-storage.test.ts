import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  providerManager,
  encryptAtRest,
  decryptAtRest,
  isEncryptedAtRest,
  getMasterKeyFromEnv,
  redactSecretString,
  redactHeaders,
  redactObject,
  sanitizeError,
  MasterKeyMissingError,
  DecryptionFailedError,
  validateProviderAccessOrigin,
} from '../src/server/providerManager';
import {
  StorageService,
  DEFAULT_STORIES,
  DEFAULT_CONTINUITY_BIBLE,
  DEFAULT_SCENE_PACKAGES,
  DEFAULT_SEO_PACKAGE,
  DEFAULT_THUMBNAIL_PACKAGE,
} from '../src/services/storage';

const CONNECTIONS_FILE = path.resolve(process.cwd(), '.provider_connections.json');

test('Task 2.1: Secure Key Storage Migration & Encryption at Rest', async (t) => {
  const TEST_MASTER_KEY = 'test-master-key-illum-v2-32-chars-long!';

  await t.test('1. AES-256-GCM AEAD encryption and decryption roundtrip', () => {
    const rawKey = 'gsk_synthetic_groq_test_secret_1234567890';
    const encrypted = encryptAtRest(rawKey, TEST_MASTER_KEY);

    assert.ok(isEncryptedAtRest(encrypted), 'Encrypted string must start with enc:v1:');
    assert.ok(!encrypted.includes(rawKey), 'Encrypted payload must not contain plaintext secret');

    const decrypted = decryptAtRest(encrypted, TEST_MASTER_KEY);
    assert.equal(decrypted, rawKey, 'Decrypted string must match original plaintext');
  });

  await t.test('2. Ciphertext or tag tampering fails closed with DecryptionFailedError', () => {
    const rawKey = 'sk-or-v1-synthetic_openrouter_secret_abcdef';
    const encrypted = encryptAtRest(rawKey, TEST_MASTER_KEY);
    const parts = encrypted.split(':');

    // Tamper with ciphertext by altering last characters
    const tamperedCiphertext = parts[4].slice(0, -4) + 'AAAA';
    parts[4] = tamperedCiphertext;
    const tamperedPayload = parts.join(':');

    assert.throws(
      () => decryptAtRest(tamperedPayload, TEST_MASTER_KEY),
      (err: any) => err instanceof DecryptionFailedError || err.category === 'AUTH_FAILED',
      'Tampered ciphertext must fail closed with authentication tag failure'
    );
  });

  await t.test('3. Missing master encryption key fails safely without crash', () => {
    const rawKey = 'AIzaSyD_synthetic_google_key_test_123';
    
    // Explicitly empty/missing master key
    assert.throws(
      () => encryptAtRest(rawKey, ''),
      (err: any) => err instanceof MasterKeyMissingError || err.code === 'MASTER_KEY_MISSING',
      'encryptAtRest without master key must throw MasterKeyMissingError'
    );

    const validEncrypted = encryptAtRest(rawKey, TEST_MASTER_KEY);
    assert.throws(
      () => decryptAtRest(validEncrypted, ''),
      (err: any) => err instanceof MasterKeyMissingError || err.code === 'MASTER_KEY_MISSING',
      'decryptAtRest without master key must throw MasterKeyMissingError'
    );
  });

  await t.test('4. Without ILLUMATRIX_ENCRYPTION_KEY, BYOK keys are held in memory and NEVER written in plaintext to disk', () => {
    const originalEnv = process.env.ILLUMATRIX_ENCRYPTION_KEY;
    const originalDisable = process.env.ILLUMATRIX_DISABLE_FILE_KEY;
    delete process.env.ILLUMATRIX_ENCRYPTION_KEY;
    delete process.env.KEY_ENCRYPTION_SECRET;
    process.env.ILLUMATRIX_DISABLE_FILE_KEY = 'true';

    const testId = `conn_ephemeral_byok_${Date.now()}`;
    const syntheticSecret = 'sk-synthetic-ephemeral-key-never-on-disk-999';

    try {
      providerManager.addOrUpdateConnection({
        id: testId,
        name: 'Ephemeral BYOK Node',
        provider: 'OpenAI Compatible',
        modelId: 'gpt-4o-mini',
        apiKey: syntheticSecret,
      });

      // Verify in-memory access is functional for the active process
      const creds = providerManager.getEffectiveCredentials(testId);
      assert.equal(creds.apiKey, syntheticSecret, 'In-memory process must have key for active operations');

      // Verify on-disk file has ZERO plaintext secret
      if (fs.existsSync(CONNECTIONS_FILE)) {
        const rawContent = fs.readFileSync(CONNECTIONS_FILE, 'utf-8');
        assert.ok(!rawContent.includes(syntheticSecret), 'Synthetic BYOK secret leaked into plaintext on disk!');
        
        const parsed = JSON.parse(rawContent);
        const record = (parsed.connections || []).find((c: any) => c.id === testId);
        assert.ok(record, 'Record should be saved on disk');
        assert.equal(record.apiKey, '', 'On-disk apiKey must be empty string');
        assert.equal(record.encryptedApiKey, undefined, 'Without master key, encryptedApiKey must be undefined');
      }
    } finally {
      providerManager.deleteConnection(testId);
      if (originalEnv) process.env.ILLUMATRIX_ENCRYPTION_KEY = originalEnv;
      if (originalDisable !== undefined) {
        process.env.ILLUMATRIX_DISABLE_FILE_KEY = originalDisable;
      } else {
        delete process.env.ILLUMATRIX_DISABLE_FILE_KEY;
      }
    }
  });

  await t.test('5. With ILLUMATRIX_ENCRYPTION_KEY, BYOK keys are encrypted at rest and reloaded securely', () => {
    const originalEnv = process.env.ILLUMATRIX_ENCRYPTION_KEY;
    process.env.ILLUMATRIX_ENCRYPTION_KEY = TEST_MASTER_KEY;

    const testId = `conn_encrypted_byok_${Date.now()}`;
    const syntheticSecret = 'csk-synthetic-cerebras-secret-key-12345';

    try {
      providerManager.addOrUpdateConnection({
        id: testId,
        name: 'Encrypted BYOK Node',
        provider: 'Cerebras',
        modelId: 'llama-3.3-70b',
        apiKey: syntheticSecret,
      });

      // Read on-disk file
      const rawContent = fs.readFileSync(CONNECTIONS_FILE, 'utf-8');
      assert.ok(!rawContent.includes(syntheticSecret), 'Synthetic secret was written in plaintext to disk!');
      
      const parsed = JSON.parse(rawContent);
      const record = (parsed.connections || []).find((c: any) => c.id === testId);
      assert.ok(record, 'Record should exist in file');
      assert.equal(record.apiKey, '', 'On-disk apiKey must be strictly empty string');
      assert.ok(isEncryptedAtRest(record.encryptedApiKey), 'encryptedApiKey must be an enc:v1: ciphertext');

      // Reload connections from disk to simulate server restart
      providerManager.reloadConnections();

      // Verify decrypted key was restored in memory
      const reloadedCreds = providerManager.getEffectiveCredentials(testId);
      assert.equal(reloadedCreds.apiKey, syntheticSecret, 'Decrypted key after reload must match original secret');
    } finally {
      providerManager.deleteConnection(testId);
      if (originalEnv) {
        process.env.ILLUMATRIX_ENCRYPTION_KEY = originalEnv;
      } else {
        delete process.env.ILLUMATRIX_ENCRYPTION_KEY;
      }
    }
  });

  await t.test('6. Public connection listings never leak cleartext keys or encrypted ciphertexts', () => {
    const publicList = providerManager.getPublicConnections();
    for (const conn of publicList) {
      assert.equal((conn as any).apiKey, undefined, `Connection ${conn.id} leaked apiKey in public representation!`);
      assert.equal((conn as any).encryptedApiKey, undefined, `Connection ${conn.id} leaked encryptedApiKey in public representation!`);
      assert.ok(typeof conn.hasKey === 'boolean');
      assert.ok(typeof conn.maskedKey === 'string');
      if (conn.hasKey && conn.provider !== 'Ollama') {
        assert.ok(conn.maskedKey.includes('••••'));
      }
    }
  });

  await t.test('7. Comprehensive secret scrubber scrubs all provider key formats and headers', () => {
    const dump = [
      'Error in Google: AIzaSyD_TestGoogleKey1234567890abcdef',
      'Authorization: Bearer sk-proj-1234567890abcdef1234567890',
      'OpenRouter rejected sk-or-v1-abcdef0123456789abcdef0123456789',
      'Groq key failed: gsk_0123456789abcdef0123456789abcdef',
      'Cerebras rejected csk-0123456789abcdef0123456789',
      'Hugging Face token hf_0123456789abcdef0123456789abcdef was invalid',
      'SambaNova key 550e8400-e29b-41d4-a716-446655440000 quota exceeded',
      'Query param key=AIzaSySecretParamValue123456789 failed',
      'Encrypted payload enc:v1:AAAA:BBBB:CCCC leaked in trace',
    ].join('\n');

    const scrubbed = redactSecretString(dump);

    assert.ok(!scrubbed.includes('AIzaSyD_TestGoogleKey1234567890abcdef'));
    assert.ok(!scrubbed.includes('sk-proj-1234567890abcdef1234567890'));
    assert.ok(!scrubbed.includes('sk-or-v1-abcdef0123456789abcdef0123456789'));
    assert.ok(!scrubbed.includes('gsk_0123456789abcdef0123456789abcdef'));
    assert.ok(!scrubbed.includes('csk-0123456789abcdef0123456789'));
    assert.ok(!scrubbed.includes('hf_0123456789abcdef0123456789abcdef'));
    assert.ok(!scrubbed.includes('550e8400-e29b-41d4-a716-446655440000'));
    assert.ok(!scrubbed.includes('AIzaSySecretParamValue123456789'));
    assert.ok(!scrubbed.includes('enc:v1:AAAA:BBBB:CCCC'));

    // Test redactHeaders
    const headers = {
      'Authorization': 'Bearer secret_token_123',
      'X-API-Key': 'secret_key_456',
      'Content-Type': 'application/json',
      'User-Agent': 'Illumatrix/2.0',
    };
    const scrubbedHeaders = redactHeaders(headers);
    assert.equal(scrubbedHeaders['Authorization'], '***REDACTED***');
    assert.equal(scrubbedHeaders['X-API-Key'], '***REDACTED***');
    assert.equal(scrubbedHeaders['Content-Type'], 'application/json');

    // Test redactObject
    const sensitiveConfig = {
      name: 'Test Node',
      apiKey: 'gsk_secret_nested_key_123',
      nested: {
        token: 'secret_token_abc',
        safeProperty: 'visible_value',
      },
    };
    const redactedObj = redactObject(sensitiveConfig);
    assert.equal(redactedObj.apiKey, '***REDACTED***');
    assert.equal(redactedObj.nested.token, '***REDACTED***');
    assert.equal(redactedObj.nested.safeProperty, 'visible_value');
  });

  await t.test('8. Cross-Origin guard blocks foreign website origins from provider management API', () => {
    let nextCalled = false;
    let blockedResponse: any = null;

    const mockRes: any = {
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        blockedResponse = payload;
      },
    };

    // 1. Foreign origin attacker site
    const foreignReq: any = {
      headers: {
        origin: 'https://malicious-attacker-site.com',
        host: 'localhost:3000',
      },
    };
    validateProviderAccessOrigin(foreignReq, mockRes, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, 'Foreign origin must not be permitted');
    assert.equal(mockRes.statusCode, 403);
    assert.equal(blockedResponse.category, 'FORBIDDEN');

    // 2. Same-origin or loopback request
    let localNext = false;
    const localReq: any = {
      headers: {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
    };
    validateProviderAccessOrigin(localReq, mockRes, () => {
      localNext = true;
    });
    assert.equal(localNext, true, 'Same-origin localhost request must be permitted');

    // 3. Direct server or test request (no Origin header)
    let directNext = false;
    const directReq: any = {
      headers: {
        host: 'localhost:3000',
      },
    };
    validateProviderAccessOrigin(directReq, mockRes, () => {
      directNext = true;
    });
    assert.equal(directNext, true, 'Requests without Origin header must pass');
  });

  await t.test('9. Project backup export does not contain any provider keys or connection credentials', () => {
    const backupJson = StorageService.exportProjectBackupJson({
      project: {
        id: 'proj_test',
        name: 'Security Test',
        format: '9:16_SHORTS',
        shortsDuration: 24,
        longFormDurationMinutes: 4,
        modeId: 'scifi_explainer',
        language: 'en',
        visualStyleId: 'cinematic',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      stories: DEFAULT_STORIES,
      selectedStoryId: DEFAULT_STORIES[0].id,
      scriptVersions: [{
        id: 'script_1',
        sourceStoryId: DEFAULT_STORIES[0].id,
        sourceStoryVersion: 1,
        versionNumber: 1,
        title: 'Security Test Script',
        hookSummary: 'A test script hook summary',
        scenes: [],
        totalWords: 0,
        speakingDurationSeconds: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isApproved: true,
        configSnapshot: {
          format: '9:16_SHORTS',
          duration: 24,
          modeId: 'scifi_explainer',
          language: 'en',
          visualStyleId: 'cinematic',
        },
      }],
      currentScript: {
        id: 'script_1',
        sourceStoryId: DEFAULT_STORIES[0].id,
        sourceStoryVersion: 1,
        versionNumber: 1,
        title: 'Security Test Script',
        hookSummary: 'A test script hook summary',
        scenes: [],
        totalWords: 0,
        speakingDurationSeconds: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isApproved: true,
        configSnapshot: {
          format: '9:16_SHORTS',
          duration: 24,
          modeId: 'scifi_explainer',
          language: 'en',
          visualStyleId: 'cinematic',
        },
      },
      scenePackages: DEFAULT_SCENE_PACKAGES,
      continuityBible: DEFAULT_CONTINUITY_BIBLE,
      seoPackage: DEFAULT_SEO_PACKAGE,
      thumbnailsPackage: DEFAULT_THUMBNAIL_PACKAGE,
      staleMatrix: {
        sourceStoryStale: false,
        scriptStale: false,
        promptsStale: false,
        thumbnailsStale: false,
        seoStale: false,
      },
    });

    assert.ok(backupJson.includes('CLEAN — ZERO API KEYS OR SECRETS EXPORTED'));
    assert.ok(!backupJson.includes('AIzaSy'));
    assert.ok(!backupJson.includes('gsk_'));
    assert.ok(!backupJson.includes('sk-or-v1-'));
    assert.ok(!backupJson.includes('encryptedApiKey'));
    assert.ok(!backupJson.includes('"apiKey"'));
  });

  await t.test('10. Existing environment-variable resolution and baseline Google connection remain functional', () => {
    const baseline = providerManager.getConnection('conn_gemini_primary');
    assert.ok(baseline);
    assert.equal(baseline.isDefault, true);

    const creds = providerManager.getEffectiveCredentials('conn_gemini_primary');
    assert.equal(creds.id, 'conn_gemini_primary');
    assert.equal(creds.provider, 'Google GenAI');

    const expectedEnvKey = (process.env.GEMINI_API_KEY || '').trim();
    assert.equal(creds.apiKey || '', expectedEnvKey);
  });
});
