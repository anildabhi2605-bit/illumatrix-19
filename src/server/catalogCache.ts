import crypto from 'node:crypto';
import type { DiscoveredModel, SupportedProvider } from '../types/hud';
import { redactSecretString, createCredentialFingerprint } from './credentialSecurity';

/**
 * ILLUMATRIX V.2 — Server-Side Catalog Cache & Cooldown Engine (Task 2.2)
 *
 * Architecture & Constraints:
 * 1. Safe Key Fingerprinting: API keys are NEVER logged or stored in cache keys.
 *    A deterministic SHA-256 fingerprint (16 chars) isolates credential contexts.
 * 2. Single-Flight Deduplication: In-flight promises prevent concurrent duplicate fetches.
 * 3. Bounded Memory & LRU: Max 100 entries with automatic expired/LRU eviction.
 * 4. Bounded Exponential Backoff Cooldowns:
 *    - Base cooldown: 5 seconds (5,000 ms)
 *    - Max cooldown: 300 seconds (300,000 ms / 5 minutes)
 *    - Honored Retry-After headers up to max cooldown.
 *    - Distinct handling for Auth vs Transient failures.
 * 5. Stale-If-Error Policy:
 *    - Allows returning expired catalog data (within 24 hours) with explicit `isStale: true`
 *      and explanatory `staleReason` if a live refresh fails.
 *    - If no prior catalog exists, fails closed with the appropriate provider error.
 * 6. Untrusted Content Protection:
 *    - Response size cap: 5 MiB (5 * 1024 * 1024 bytes).
 *    - Model count cap: 2,000 models per catalog.
 *    - Strict type validation: models array, string id, truncated strings.
 * 7. Defensive Isolation: Deep copies on cache write and read (`structuredClone`).
 */

export interface CatalogCacheKeyParams {
  provider: SupportedProvider | string;
  connectionId?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface CatalogCacheEntry<T = DiscoveredModel[]> {
  key: string;
  provider: string;
  connectionId?: string;
  baseUrl?: string;
  fingerprint: string;
  data: T;
  cachedAt: number;
  expiresAt: number;
  source: 'live_api';
}

export interface CooldownRecord {
  cooldownKey: string;
  failureCount: number;
  lastFailureAt: number;
  cooldownUntil: number;
  cooldownDurationMs: number;
  lastErrorCategory: string;
  lastErrorMessage: string;
  lastStatus?: number;
  retryAfterSec?: number;
}

export interface CatalogLookupResult<T = DiscoveredModel[]> {
  hit: boolean;
  data?: T;
  isStale: boolean;
  staleReason?: string;
  expiresAt?: number;
  cachedAt?: number;
  cooldownActive: boolean;
  cooldownRemainingSec?: number;
}

export interface CatalogCacheOptions {
  ttlMs?: number; // Default: 30 minutes (1,800,000 ms)
  staleIfErrorWindowMs?: number; // Default: 24 hours (86,400,000 ms)
  baseCooldownMs?: number; // Default: 5,000 ms (5s)
  maxCooldownMs?: number; // Default: 300,000 ms (5 minutes / 300s)
  maxEntries?: number; // Default: 100 entries
  maxModelsPerCatalog?: number; // Default: 2,000 models
  maxPayloadBytes?: number; // Default: 5 MiB
  clock?: () => number; // Injected clock for deterministic unit tests
}

export class CatalogCacheManager {
  private readonly ttlMs: number;
  private readonly staleIfErrorWindowMs: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxEntries: number;
  private readonly maxModelsPerCatalog: number;
  private readonly maxPayloadBytes: number;
  private readonly clock: () => number;

  private entries: Map<string, CatalogCacheEntry<DiscoveredModel[]>> = new Map();
  private cooldowns: Map<string, CooldownRecord> = new Map();
  private inFlightRequests: Map<string, Promise<any>> = new Map();

  // Telemetry counters
  private hitCount: number = 0;
  private missCount: number = 0;
  private singleFlightShares: number = 0;

  constructor(options?: CatalogCacheOptions) {
    this.ttlMs = options?.ttlMs ?? 30 * 60 * 1000; // 30 minutes
    this.staleIfErrorWindowMs = options?.staleIfErrorWindowMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.baseCooldownMs = options?.baseCooldownMs ?? 5000; // 5 seconds
    this.maxCooldownMs = options?.maxCooldownMs ?? 300000; // 5 minutes
    this.maxEntries = options?.maxEntries ?? 100;
    this.maxModelsPerCatalog = options?.maxModelsPerCatalog ?? 2000;
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 5 * 1024 * 1024; // 5 MiB
    this.clock = options?.clock ?? (() => Date.now());
  }

  /**
   * Generates a safe SHA-256 credential fingerprint without exposing secrets.
   * Returns 'k:none' when key is absent/empty.
   */
  public createCredentialFingerprint(apiKey?: string): string {
    return createCredentialFingerprint(apiKey);
  }

  /**
   * Generates a deterministic cache key distinguishing provider, connection identity,
   * normalized base URL, and credential fingerprint.
   * Format: <provider>|<connectionId>|<normalizedBaseUrl>|<keyFingerprint>
   */
  public generateCacheKey(params: CatalogCacheKeyParams): string {
    const provider = String(params.provider || 'unknown').trim();
    const connId = String(params.connectionId || 'anon').trim();
    const normalizedUrl = String(params.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
    const fingerprint = this.createCredentialFingerprint(params.apiKey);
    return `${provider}|${connId}|${normalizedUrl}|${fingerprint}`;
  }

  /**
   * Generates a cooldown tracking key based on provider, connection identity, and endpoint.
   * Endpoint-level failures back off together for a connection.
   */
  public generateCooldownKey(params: { provider: string; connectionId?: string; baseUrl?: string }): string {
    const provider = String(params.provider || 'unknown').trim();
    const connId = String(params.connectionId || 'anon').trim();
    const normalizedUrl = String(params.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
    return `${provider}|${connId}|${normalizedUrl}`;
  }

  /**
   * Deep-clones data defensively to prevent caller mutation of internal cache structures.
   */
  private defensiveCopy<T>(data: T): T {
    try {
      return structuredClone(data);
    } catch {
      return JSON.parse(JSON.stringify(data));
    }
  }

  /**
   * Retrieves a cached entry if present and not expired.
   */
  public get(key: string): CatalogLookupResult<DiscoveredModel[]> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount++;
      return { hit: false, isStale: false, cooldownActive: false };
    }

    const now = this.clock();
    if (now < entry.expiresAt) {
      // Valid cache hit: update LRU access order
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.hitCount++;
      return {
        hit: true,
        data: this.defensiveCopy(entry.data),
        isStale: false,
        cachedAt: entry.cachedAt,
        expiresAt: entry.expiresAt,
        cooldownActive: false,
      };
    }

    // Expired
    this.missCount++;
    return {
      hit: false,
      isStale: true,
      data: this.defensiveCopy(entry.data),
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
      cooldownActive: false,
    };
  }

  /**
   * Retrieves stale cached data under the explicit stale-if-error policy
   * when a live refresh fails or cooldown is active.
   */
  public getStaleFallback(key: string, reason?: string): CatalogLookupResult<DiscoveredModel[]> {
    const entry = this.entries.get(key);
    if (!entry) {
      return { hit: false, isStale: false, cooldownActive: false };
    }

    const now = this.clock();
    const ageMs = now - entry.cachedAt;
    if (ageMs <= this.staleIfErrorWindowMs) {
      return {
        hit: true,
        data: this.defensiveCopy(entry.data),
        isStale: true,
        staleReason:
          reason ||
          `Live catalog refresh failed; returning verified cached catalog from ${new Date(entry.cachedAt).toISOString()}`,
        cachedAt: entry.cachedAt,
        expiresAt: entry.expiresAt,
        cooldownActive: false,
      };
    }

    return { hit: false, isStale: false, cooldownActive: false };
  }

  /**
   * Stores a successfully discovered model catalog into cache with LRU eviction.
   */
  public set(
    key: string,
    data: DiscoveredModel[],
    params?: { provider?: string; connectionId?: string; baseUrl?: string; apiKey?: string; ttlMs?: number }
  ): void {
    if (!Array.isArray(data)) return;

    const now = this.clock();
    const effectiveTtl = params?.ttlMs ?? this.ttlMs;

    // LRU eviction if at capacity
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.evictExpiredOrLru();
    }

    const entry: CatalogCacheEntry<DiscoveredModel[]> = {
      key,
      provider: params?.provider || key.split('|')[0] || 'unknown',
      connectionId: params?.connectionId || key.split('|')[1],
      baseUrl: params?.baseUrl,
      fingerprint: this.createCredentialFingerprint(params?.apiKey),
      data: this.defensiveCopy(data),
      cachedAt: now,
      expiresAt: now + effectiveTtl,
      source: 'live_api',
    };

    // Delete first to place at the end of iteration order (LRU)
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /**
   * Evicts expired entries older than the stale window, or the least-recently used entry.
   */
  private evictExpiredOrLru(): void {
    const now = this.clock();
    // 1. Evict entries past stale window first
    for (const [k, entry] of this.entries.entries()) {
      if (now - entry.cachedAt > this.staleIfErrorWindowMs) {
        this.entries.delete(k);
        if (this.entries.size < this.maxEntries) return;
      }
    }

    // 2. If still full, evict oldest accessed entry
    const oldestKey = this.entries.keys().next().value;
    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Invalidates a specific cache key.
   */
  public invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Invalidates all cache entries and cooldowns associated with a connection ID.
   * Called when a connection's credentials, URL, or configuration change.
   */
  public invalidateByConnection(connectionId: string): number {
    if (!connectionId) return 0;
    let count = 0;
    for (const [k, entry] of Array.from(this.entries.entries())) {
      if (entry.connectionId === connectionId || k.includes(`|${connectionId}|`)) {
        this.entries.delete(k);
        count++;
      }
    }
    for (const [ck] of Array.from(this.cooldowns.entries())) {
      if (ck.includes(`|${connectionId}|`)) {
        this.cooldowns.delete(ck);
      }
    }
    return count;
  }

  /**
   * Invalidates all cache entries for a provider.
   */
  public invalidateByProvider(provider: string): number {
    let count = 0;
    for (const [k, entry] of Array.from(this.entries.entries())) {
      if (entry.provider === provider || k.startsWith(`${provider}|`)) {
        this.entries.delete(k);
        count++;
      }
    }
    for (const [ck] of Array.from(this.cooldowns.entries())) {
      if (ck.startsWith(`${provider}|`)) {
        this.cooldowns.delete(ck);
      }
    }
    return count;
  }

  /**
   * Clears all cache entries, cooldowns, and in-flight tracking.
   */
  public clear(): void {
    this.entries.clear();
    this.cooldowns.clear();
    this.inFlightRequests.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.singleFlightShares = 0;
  }

  /**
   * Checks if an active cooldown is currently blocking discovery requests.
   */
  public isCooldownActive(cooldownKey: string): {
    active: boolean;
    remainingSec: number;
    errorCategory?: string;
    reason?: string;
  } {
    const record = this.cooldowns.get(cooldownKey);
    if (!record) {
      return { active: false, remainingSec: 0 };
    }

    const now = this.clock();
    if (now < record.cooldownUntil) {
      const remainingSec = Math.max(1, Math.ceil((record.cooldownUntil - now) / 1000));
      return {
        active: true,
        remainingSec,
        errorCategory: record.lastErrorCategory,
        reason: record.lastErrorMessage,
      };
    }

    return { active: false, remainingSec: 0 };
  }

  /**
   * Records a successful discovery request. Resets consecutive failure count and clears cooldown.
   */
  public recordSuccess(cooldownKey: string): void {
    this.cooldowns.delete(cooldownKey);
  }

  /**
   * Records a discovery failure with bounded exponential backoff and Retry-After parsing.
   * Transient failures trigger backoff; authentication failures are classified distinctly.
   */
  public recordFailure(
    cooldownKey: string,
    error: {
      category: string;
      message: string;
      status?: number;
      retryAfterHeader?: string | null;
    }
  ): {
    cooldownUntil: number;
    cooldownDurationMs: number;
    failureCount: number;
    isAuthError: boolean;
  } {
    const now = this.clock();
    const existing = this.cooldowns.get(cooldownKey);
    const failureCount = (existing ? existing.failureCount : 0) + 1;
    const isAuth =
      error.category === 'INVALID_CREDENTIALS' ||
      error.category === 'AUTH_ERROR' ||
      error.category === 'PERMISSION_DENIED' ||
      error.status === 401 ||
      error.status === 403;

    let cooldownDurationMs = 0;

    if (isAuth) {
      // Authentication errors do NOT use exponential backoff suppression.
      // We record failure details so they can be surfaced, but keep cooldown 0 so credential corrections are not blocked.
      cooldownDurationMs = 0;
    } else {
      // Check Retry-After header first
      let retryAfterParsedMs: number | null = null;
      if (error.retryAfterHeader) {
        const rawHeader = error.retryAfterHeader.trim();
        const asSeconds = parseInt(rawHeader, 10);
        if (!isNaN(asSeconds) && asSeconds > 0) {
          retryAfterParsedMs = asSeconds * 1000;
        } else {
          const asDate = Date.parse(rawHeader);
          if (!isNaN(asDate) && asDate > now) {
            retryAfterParsedMs = asDate - now;
          }
        }
      }

      if (retryAfterParsedMs !== null && retryAfterParsedMs > 0) {
        // Enforce safe bounds: at least 1s, at most maxCooldownMs
        cooldownDurationMs = Math.max(1000, Math.min(this.maxCooldownMs, retryAfterParsedMs));
      } else {
        // Bounded exponential backoff: base * 2^(failureCount - 1), capped at maxCooldownMs
        const exponentialMs = this.baseCooldownMs * Math.pow(2, failureCount - 1);
        cooldownDurationMs = Math.min(this.maxCooldownMs, Math.max(this.baseCooldownMs, exponentialMs));
      }
    }

    const cooldownUntil = cooldownDurationMs > 0 ? now + cooldownDurationMs : 0;
    const sanitizedMsg = redactSecretString(error.message || 'Unknown discovery error');

    this.cooldowns.set(cooldownKey, {
      cooldownKey,
      failureCount,
      lastFailureAt: now,
      cooldownUntil,
      cooldownDurationMs,
      lastErrorCategory: error.category || (isAuth ? 'INVALID_CREDENTIALS' : 'NETWORK_ERROR'),
      lastErrorMessage: sanitizedMsg,
      lastStatus: error.status,
      retryAfterSec: cooldownDurationMs > 0 ? Math.ceil(cooldownDurationMs / 1000) : undefined,
    });

    return {
      cooldownUntil,
      cooldownDurationMs,
      failureCount,
      isAuthError: isAuth,
    };
  }

  /**
   * Single-flight execution prevents concurrent discovery calls for the same cache key.
   */
  public async executeSingleFlight<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      this.singleFlightShares++;
      return inFlight;
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, promise);
    return promise;
  }

  /**
   * Sanitizes and validates untrusted remote catalog responses.
   * Caps maximum models to prevent memory exhaustion and validates structure.
   */
  public validateAndSanitizeCatalogPayload(raw: any, provider: SupportedProvider | string): any[] {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Malformed catalog payload from ${provider}: response body is not a JSON object`);
    }

    // Google GenAI uses { models: [...] }, OpenAI/Groq/OpenRouter use { data: [...] }
    let rawList: any[] = [];
    if (Array.isArray(raw.models)) {
      rawList = raw.models;
    } else if (Array.isArray(raw.data)) {
      rawList = raw.data;
    } else if (Array.isArray(raw)) {
      rawList = raw;
    } else {
      throw new Error(`Malformed catalog payload from ${provider}: models/data array not found`);
    }

    // Limit to configured max models per catalog
    const boundedList = rawList.slice(0, this.maxModelsPerCatalog);

    // Validate that items are valid objects with non-empty string ID
    const validItems: any[] = [];
    for (const item of boundedList) {
      if (item && typeof item === 'object') {
        const id = item.id || item.name;
        if (typeof id === 'string' && id.trim().length > 0 && id.length < 256) {
          validItems.push(item);
        }
      }
    }

    return validItems;
  }

  /**
   * Validates response byte size limits before processing.
   */
  public checkPayloadSize(byteLength: number, provider: string): void {
    if (byteLength > this.maxPayloadBytes) {
      throw new Error(
        `Catalog response from ${provider} exceeded maximum allowable size (${byteLength} bytes > ${this.maxPayloadBytes} limit)`
      );
    }
  }

  /**
   * Diagnostic statistics for testing and health reporting.
   */
  public getStats() {
    return {
      entryCount: this.entries.size,
      cooldownCount: this.cooldowns.size,
      inFlightCount: this.inFlightRequests.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      singleFlightShares: this.singleFlightShares,
    };
  }
}

// Global server singleton instance
export const catalogCacheManager = new CatalogCacheManager();
