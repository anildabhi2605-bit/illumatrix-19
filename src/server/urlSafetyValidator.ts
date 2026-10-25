/**
 * ILLUMATRIX Server-Side URL Safety & SSRF Validator
 * Protects against Server-Side Request Forgery (SSRF) on user-configured endpoints.
 * Source of truth: ILLUMATRIX V.2 Security Specification (Task 0.4)
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface UrlValidationResult {
  isValid: boolean;
  normalizedUrl: string;
  resolvedIps: string[];
  error?: string;
  errorCategory?: 'SSRF_BLOCKED' | 'INVALID_URL' | 'UNSUPPORTED_PROTOCOL';
}

/**
 * Checks whether an IPv4 address falls into loopback, private, link-local,
 * multicast, broadcast, or reserved ranges.
 */
export function isRestrictedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is treated as restricted
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8 — Current network ("this host on this network")
  if (a === 0) return true;

  // 10.0.0.0/8 — Private Class A
  if (a === 10) return true;

  // 100.64.0.0/10 — Carrier-Grade NAT (Shared Address Space)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 127.0.0.0/8 — Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 — Link-Local (Cloud instance metadata: 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 — Private Class B (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 — IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 — TEST-NET-1 (Documentation)
  if (a === 192 && b === 0 && c === 2) return true;

  // 192.168.0.0/16 — Private Class C
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 — Network Benchmark Tests
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 — TEST-NET-2 (Documentation)
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 — TEST-NET-3 (Documentation)
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 — Multicast (224.0.0.0 to 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 — Reserved / Broadcast (240.0.0.0 to 255.255.255.255)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address falls into loopback, unique local, link-local,
/**
 * Parses an IPv6 address string into eight 16-bit numeric words.
 * Correctly normalizes compressed "::", leading zeroes, and embedded IPv4.
 */
export function parseIpv6Words(rawIp: string): number[] | null {
  let ip = rawIp.toLowerCase().trim();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.168.1.1 or 64:ff9b::127.0.0.1 or ::127.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  let ipv4Words: number[] | null = null;
  if (lastColon !== -1) {
    const afterColon = ip.slice(lastColon + 1);
    if (afterColon.includes('.')) {
      const parts = afterColon.split('.').map((p) => parseInt(p, 10));
      if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        ipv4Words = [
          ((parts[0] << 8) | parts[1]) >>> 0,
          ((parts[2] << 8) | parts[3]) >>> 0,
        ];
        if (lastColon > 0 && ip[lastColon - 1] === ':') {
          ip = ip.slice(0, lastColon + 1);
        } else {
          ip = ip.slice(0, lastColon);
        }
      }
    }
  }

  const doubleColonIndex = ip.indexOf('::');
  if (doubleColonIndex !== -1) {
    // Only one '::' sequence allowed
    if (ip.indexOf('::', doubleColonIndex + 2) !== -1) return null;
    const leftPart = ip.slice(0, doubleColonIndex);
    const rightPart = ip.slice(doubleColonIndex + 2);

    const leftWords = leftPart ? leftPart.split(':').map((h) => parseInt(h, 16)) : [];
    const rightWords = rightPart ? rightPart.split(':').map((h) => parseInt(h, 16)) : [];
    if (leftWords.some(isNaN) || rightWords.some(isNaN)) return null;

    const totalWordsNeeded = 8 - (ipv4Words ? 2 : 0);
    const zeroesNeeded = totalWordsNeeded - (leftWords.length + rightWords.length);
    if (zeroesNeeded < 0) return null;

    const zeroWords = new Array(zeroesNeeded).fill(0);
    const allWords = [...leftWords, ...zeroWords, ...rightWords];
    if (ipv4Words) allWords.push(...ipv4Words);
    return allWords.length === 8 ? allWords : null;
  }

  const words = ip.split(':').map((h) => parseInt(h, 16));
  if (words.some(isNaN)) return null;
  if (ipv4Words) words.push(...ipv4Words);
  return words.length === 8 ? words : null;
}

/**
 * Checks whether an IPv6 address falls into loopback, unique local, link-local,
 * multicast, unspecified, IPv4-mapped, IPv4-compatible, or IPv4-translated ranges.
 */
export function isRestrictedIpv6(rawIp: string): boolean {
  const words = parseIpv6Words(rawIp);
  if (!words) {
    return true; // Unparseable or malformed IPv6 is treated as restricted
  }

  // ::1 — Loopback (words 0..6 === 0, word 7 === 1)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) {
    return true;
  }

  // :: — Unspecified (all words === 0)
  if (words.every((w) => w === 0)) {
    return true;
  }

  // Deprecated IPv4-compatible IPv6 address: ::a.b.c.d (words 0..5 === 0)
  if (words.slice(0, 6).every((w) => w === 0)) {
    const compatibleIpv4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isRestrictedIpv4(compatibleIpv4);
  }

  // IPv4-mapped IPv6 address: ::ffff:a.b.c.d (words 0..4 === 0, word 5 === 0xffff)
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const mappedIpv4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isRestrictedIpv4(mappedIpv4);
  }

  // IPv4-translated IPv6: ::ffff:0:a.b.c.d (words 0..3 === 0, word 4 === 0xffff, word 5 === 0)
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0) {
    const translatedIpv4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isRestrictedIpv4(translatedIpv4);
  }

  // 64:ff9b::/96 — Well-Known Prefix for IPv4-IPv6 Translation (word 0 === 0x0064, word 1 === 0xff9b, words 2..5 === 0)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const translatedIpv4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isRestrictedIpv4(translatedIpv4);
  }

  // fc00::/7 — Unique Local Address (ULA) (top 7 bits: 1111110)
  if ((words[0] & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 — Link-Local Unicast (top 10 bits: 1111111010)
  if ((words[0] & 0xffc0) === 0xfe80) {
    return true;
  }

  // ff00::/8 — Multicast (top 8 bits: 11111111)
  if ((words[0] & 0xff00) === 0xff00) {
    return true;
  }

  // 100::/64 — Discard prefix (word 0 === 0x0100, words 1..3 === 0)
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    return true;
  }

  // 2001:db8::/32 — Documentation (word 0 === 0x2001, word 1 === 0x0db8)
  if (words[0] === 0x2001 && words[1] === 0x0db8) {
    return true;
  }

  return false;
}

/**
 * Checks whether an IP address (v4 or v6) is in any restricted or private block.
 */
export function isRestrictedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return isRestrictedIpv4(ip);
  }
  if (version === 6) {
    return isRestrictedIpv6(ip);
  }
  return true; // Not a valid IP -> restricted
}

/**
 * Checks if a hostname directly indicates a local, loopback, internal, or cloud metadata target.
 */
export function isRestrictedHostname(rawHost: string): boolean {
  const host = rawHost.toLowerCase().trim();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.corp')
  ) {
    return true;
  }

  // Cloud metadata endpoint hostnames
  if (
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'instance-data' ||
    host.endsWith('.instance-data')
  ) {
    return true;
  }

  return false;
}

/**
 * Default DNS lookup implementation using Node's dns.promises.lookup with { all: true }
 */
export async function defaultDnsResolver(
  hostname: string
): Promise<Array<{ address: string; family: number }>> {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return Array.isArray(results) ? results : [results];
}

/**
 * Validates a custom provider URL against SSRF vulnerabilities:
 * 1. Validates URL protocol strictly to http: or https:
 * 2. Rejects URL credentials (user:pass)
 * 3. Rejects loopback, private, and link-local IP addresses
 * 4. Resolves hostname via DNS and checks EVERY returned record
 * 5. Rejects if ANY resolved address is private, loopback, or non-public
 */
export async function validateCustomProviderUrl(
  inputUrl: string,
  customResolver?: DnsResolver
): Promise<UrlValidationResult> {
  const resolver = customResolver || defaultDnsResolver;

  if (!inputUrl || typeof inputUrl !== 'string' || inputUrl.trim().length === 0) {
    return {
      isValid: false,
      normalizedUrl: '',
      resolvedIps: [],
      errorCategory: 'INVALID_URL',
      error: 'Endpoint URL is empty or missing.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(inputUrl.trim());
  } catch {
    return {
      isValid: false,
      normalizedUrl: inputUrl,
      resolvedIps: [],
      errorCategory: 'INVALID_URL',
      error: 'Endpoint URL is malformed or invalid.',
    };
  }

  // 1. Protocol check: Allow only http: and https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isValid: false,
      normalizedUrl: parsed.toString(),
      resolvedIps: [],
      errorCategory: 'UNSUPPORTED_PROTOCOL',
      error: `Unsupported protocol "${parsed.protocol}". Only HTTP and HTTPS endpoints are permitted.`,
    };
  }

  // 2. Reject embedded URL credentials
  if (parsed.username || parsed.password) {
    return {
      isValid: false,
      normalizedUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      resolvedIps: [],
      errorCategory: 'INVALID_URL',
      error: 'Embedded credentials (username/password) in endpoint URLs are forbidden.',
    };
  }

  // 3. Extract and check hostname
  // WHATWG URL keeps enclosing brackets on IPv6 hostnames (e.g. "[::1]"). Strip them for IP & DNS evaluation.
  const rawHostname = parsed.hostname;
  if (!rawHostname || rawHostname.length === 0) {
    return {
      isValid: false,
      normalizedUrl: parsed.toString(),
      resolvedIps: [],
      errorCategory: 'INVALID_URL',
      error: 'Endpoint URL hostname is missing.',
    };
  }

  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

  // Check explicit hostname patterns (localhost, internal domains, cloud metadata)
  if (isRestrictedHostname(hostname)) {
    return {
      isValid: false,
      normalizedUrl: parsed.toString(),
      resolvedIps: [],
      errorCategory: 'SSRF_BLOCKED',
      error: 'Destination is restricted: loopback, local, or cloud metadata hostnames are forbidden.',
    };
  }

  // 4. IP Literal Check (if host is an IP address)
  const isDirectIp = net.isIP(hostname);
  if (isDirectIp !== 0) {
    if (isRestrictedIp(hostname)) {
      return {
        isValid: false,
        normalizedUrl: parsed.toString(),
        resolvedIps: [hostname],
        errorCategory: 'SSRF_BLOCKED',
        error: 'Destination is restricted: loopback, link-local, and private IP destinations are forbidden.',
      };
    }

    return {
      isValid: true,
      normalizedUrl: parsed.toString(),
      resolvedIps: [hostname],
    };
  }

  // 5. DNS Resolution: Check ALL resolved IP answers
  try {
    const records = await resolver(hostname);
    if (!records || records.length === 0) {
      return {
        isValid: false,
        normalizedUrl: parsed.toString(),
        resolvedIps: [],
        errorCategory: 'INVALID_URL',
        error: `Could not resolve hostname "${hostname}".`,
      };
    }

    const resolvedIps = records.map((r) => r.address);

    // If ANY resolved IP is restricted, reject immediately (guards against split/mixed DNS answers)
    for (const ip of resolvedIps) {
      if (isRestrictedIp(ip)) {
        return {
          isValid: false,
          normalizedUrl: parsed.toString(),
          resolvedIps,
          errorCategory: 'SSRF_BLOCKED',
          error: 'Destination is restricted: resolved IP address belongs to a private, loopback, or cloud metadata network.',
        };
      }
    }

    return {
      isValid: true,
      normalizedUrl: parsed.toString(),
      resolvedIps,
    };
  } catch (dnsErr: any) {
    return {
      isValid: false,
      normalizedUrl: parsed.toString(),
      resolvedIps: [],
      errorCategory: 'INVALID_URL',
      error: `DNS resolution failed for "${hostname}": ${dnsErr?.message || 'Host not found'}`,
    };
  }
}

export interface SafeSsrfFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const DEFAULT_SSRF_TIMEOUT_MS = 10_000; // 10 seconds default
export const MAX_SSRF_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB maximum payload
export const MAX_SSRF_REDIRECT_HOPS = 3;

/**
 * Executes an outbound HTTP/HTTPS request strictly pinned to a validated IP address.
 * Socket-level DNS lookup returns only the pinned IP, eliminating DNS rebinding and TOCTOU.
 * Original hostname is preserved for HTTP Host header, TLS SNI, and TLS certificate hostname verification.
 * TLS certificate verification (rejectUnauthorized: true) is strictly enforced.
 */
export async function pinnedHttpRequest(
  targetUrl: string,
  pinnedIp: string,
  options: SafeSsrfFetchOptions = {},
  timeoutMs: number = DEFAULT_SSRF_TIMEOUT_MS,
  maxResponseBytes: number = MAX_SSRF_RESPONSE_BYTES
): Promise<Response> {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const family = net.isIP(pinnedIp) === 6 ? 6 : 4;

  const outgoingHeaders: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((value, key) => {
        outgoingHeaders[key] = value;
      });
    } else if (Array.isArray(options.headers)) {
      for (const [key, value] of options.headers) {
        outgoingHeaders[key] = value;
      }
    } else {
      for (const [key, value] of Object.entries(options.headers as Record<string, any>)) {
        if (value !== undefined && value !== null) {
          outgoingHeaders[key] = String(value);
        }
      }
    }
  }

  // Preserve original Host header (includes port if non-default)
  if (!outgoingHeaders['Host'] && !outgoingHeaders['host']) {
    outgoingHeaders['Host'] = parsed.host;
  }

  let bodyBuffer: Buffer | null = null;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === 'string') {
      bodyBuffer = Buffer.from(options.body, 'utf-8');
    } else if (Buffer.isBuffer(options.body)) {
      bodyBuffer = options.body;
    } else if (options.body instanceof Uint8Array) {
      bodyBuffer = Buffer.from(options.body);
    } else if (typeof (options.body as any).toString === 'function') {
      bodyBuffer = Buffer.from((options.body as any).toString(), 'utf-8');
    }
  }

  if (bodyBuffer && !outgoingHeaders['Content-Length'] && !outgoingHeaders['content-length']) {
    outgoingHeaders['Content-Length'] = String(bodyBuffer.length);
  }

  const reqOptions: https.RequestOptions = {
    method: options.method ? options.method.toUpperCase() : 'GET',
    hostname: parsed.hostname,
    port,
    path: `${parsed.pathname || '/'}${parsed.search || ''}`,
    headers: outgoingHeaders,
    lookup: (_hostname, opts, cb) => {
      let callback: any = cb;
      let lookupOpts: any = opts;
      if (typeof lookupOpts === 'function') {
        callback = lookupOpts;
        lookupOpts = {};
      }
      if (lookupOpts && lookupOpts.all) {
        callback(null, [{ address: pinnedIp, family }]);
      } else {
        callback(null, pinnedIp, family);
      }
    },
  };

  if (isHttps) {
    reqOptions.rejectUnauthorized = true;
    const hostWithoutBrackets =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    if (net.isIP(hostWithoutBrackets) === 0) {
      reqOptions.servername = hostWithoutBrackets;
    }
  }

  return new Promise<Response>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let isDone = false;
    let timedOut = false;
    let payloadTooLarge = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onCallerAbort);
      }
    };

    const onCallerAbort = () => {
      if (isDone) return;
      isDone = true;
      cleanup();
      req.destroy(new Error('Outbound request aborted by caller.'));
      const abortErr: any = new Error('Outbound request aborted.');
      abortErr.category = 'ABORTED';
      abortErr.status = 499;
      reject(abortErr);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        const abortErr: any = new Error('Outbound request already aborted.');
        abortErr.category = 'ABORTED';
        abortErr.status = 499;
        return reject(abortErr);
      }
      options.signal.addEventListener('abort', onCallerAbort);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (isDone) return;
        isDone = true;
        timedOut = true;
        cleanup();
        req.destroy(new Error(`Outbound request to ${parsed.hostname} timed out after ${timeoutMs}ms.`));
        const timeoutErr: any = new Error(`Outbound request to ${parsed.hostname} timed out after ${timeoutMs}ms.`);
        timeoutErr.category = 'TIMEOUT';
        timeoutErr.status = 504;
        reject(timeoutErr);
      }, timeoutMs);
    }

    const req = client.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      res.on('data', (chunk: Buffer) => {
        if (isDone) return;
        receivedBytes += chunk.length;
        if (receivedBytes > maxResponseBytes) {
          isDone = true;
          payloadTooLarge = true;
          cleanup();
          res.destroy();
          req.destroy();
          const sizeMb = Math.round(maxResponseBytes / (1024 * 1024));
          const err: any = new Error(
            `Outbound response body exceeded maximum permitted size of ${sizeMb} MiB.`
          );
          err.category = 'PAYLOAD_TOO_LARGE';
          err.status = 413;
          reject(err);
        } else {
          chunks.push(chunk);
        }
      });

      res.on('end', () => {
        if (isDone) return;
        isDone = true;
        cleanup();

        const statusCode = res.statusCode || 200;
        const statusText = res.statusMessage || '';
        const responseHeaders = new Headers();
        for (const [key, val] of Object.entries(res.headers)) {
          if (Array.isArray(val)) {
            for (const v of val) {
              responseHeaders.append(key, v);
            }
          } else if (typeof val === 'string') {
            responseHeaders.set(key, val);
          }
        }

        const totalBuffer = Buffer.concat(chunks);
        const nullBodyStatuses = [101, 204, 205, 304];
        const bodyData = nullBodyStatuses.includes(statusCode)
          ? null
          : totalBuffer.length > 0
          ? totalBuffer
          : null;

        try {
          const response = new Response(bodyData, {
            status: statusCode,
            statusText,
            headers: responseHeaders,
          });
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });

      res.on('error', (err: any) => {
        if (isDone) return;
        isDone = true;
        cleanup();
        err.category = err.category || 'NETWORK_ERROR';
        reject(err);
      });
    });

    req.on('error', (err: any) => {
      if (isDone) return;
      isDone = true;
      cleanup();
      if (timedOut) {
        const timeoutErr: any = new Error(`Outbound request to ${parsed.hostname} timed out after ${timeoutMs}ms.`);
        timeoutErr.category = 'TIMEOUT';
        timeoutErr.status = 504;
        return reject(timeoutErr);
      }
      if (payloadTooLarge) {
        return;
      }
      if (options.signal?.aborted) {
        const abortErr: any = new Error('Outbound request aborted.');
        abortErr.category = 'ABORTED';
        abortErr.status = 499;
        return reject(abortErr);
      }
      err.category = err.category || 'NETWORK_ERROR';
      reject(err);
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

/**
 * Performs a safe outbound request to custom provider endpoints with:
 * - Deterministic IP-pinned transport: socket connects strictly to the validated IP.
 * - Anti-DNS Rebinding / TOCTOU guarantee: socket-level DNS lookup uses only the validated IP.
 * - TLS SNI and hostname certificate validation strictly preserved (rejectUnauthorized: true).
 * - Re-validation and independent IP pinning for every 3xx redirect hop.
 * - Bounded redirect limit (max 3 hops) preventing redirect loops.
 * - Redaction of authorization headers if redirect changes host/origin.
 * - Overall timeout (default 10s) and payload size limit (max 5 MiB) with clean resource cleanup.
 */
export async function safeSsrfFetch(
  urlStr: string,
  init: SafeSsrfFetchOptions = {},
  customResolver?: DnsResolver
): Promise<Response> {
  const maxRedirects = MAX_SSRF_REDIRECT_HOPS;
  let currentUrl = urlStr;
  let currentMethod = init.method ? init.method.toUpperCase() : 'GET';
  let currentBody = init.body;
  let currentHeaders = init.headers ? new Headers(init.headers) : new Headers();
  let redirectCount = 0;

  const totalTimeoutMs =
    init.timeoutMs !== undefined && init.timeoutMs > 0 ? init.timeoutMs : DEFAULT_SSRF_TIMEOUT_MS;
  const maxBytes =
    init.maxResponseBytes !== undefined && init.maxResponseBytes > 0
      ? init.maxResponseBytes
      : MAX_SSRF_RESPONSE_BYTES;
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingTimeout = totalTimeoutMs - elapsed;
    if (remainingTimeout <= 0) {
      const timeoutErr: any = new Error(`Outbound request timed out after ${totalTimeoutMs}ms.`);
      timeoutErr.category = 'TIMEOUT';
      timeoutErr.status = 504;
      throw timeoutErr;
    }

    // 1. SSRF validate the current URL (resolves and validates all A/AAAA records)
    const validation = await validateCustomProviderUrl(currentUrl, customResolver);
    if (!validation.isValid) {
      const err: any = new Error(validation.error || 'Destination URL failed SSRF security validation.');
      err.category = validation.errorCategory || 'SSRF_BLOCKED';
      err.status = 400;
      throw err;
    }

    // 2. Select validated IP for this hop
    const pinnedIp = validation.resolvedIps[0];
    if (!pinnedIp) {
      const err: any = new Error(`No valid IP address resolved for destination ${currentUrl}`);
      err.category = 'SSRF_BLOCKED';
      err.status = 400;
      throw err;
    }

    // 3. Execute pinned request
    const hopOptions: SafeSsrfFetchOptions = {
      ...init,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
    };

    const response = await pinnedHttpRequest(currentUrl, pinnedIp, hopOptions, remainingTimeout, maxBytes);

    // 4. Handle 3xx redirects explicitly
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    if (isRedirect) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        const err: any = new Error('Too many redirects encountered while connecting to provider endpoint.');
        err.category = 'NETWORK_ERROR';
        throw err;
      }

      const location = response.headers.get('location');
      if (!location) {
        const err: any = new Error(`Redirect response (HTTP ${response.status}) missing Location header.`);
        err.category = 'NETWORK_ERROR';
        throw err;
      }

      // Resolve relative redirect against current URL
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        const err: any = new Error('Malformed Location header in redirect response.');
        err.category = 'INVALID_URL';
        throw err;
      }

      // If redirect changes origin, strip Authorization header for safety
      const currentOrigin = new URL(currentUrl).origin;
      if (nextUrl.origin !== currentOrigin) {
        currentHeaders.delete('authorization');
        currentHeaders.delete('Authorization');
      }

      // Standard redirect method transitions
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
      }

      currentUrl = nextUrl.toString();
      continue;
    }

    return response;
  }
}

