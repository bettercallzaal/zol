'use strict';

// model-gateway.js - Layer 7 (Model Gateway) for ZOL Persistent Agent Upgrade v2
// CommonJS, no external npm deps — only node:http and node:crypto.

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// QuotaExceededError
// ---------------------------------------------------------------------------
class QuotaExceededError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'QuotaExceededError';
  }
}

// ---------------------------------------------------------------------------
// httpPost helper (spec-prescribed pattern)
// ---------------------------------------------------------------------------
function httpPost(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('node:https') : require('node:http');
    const data = JSON.stringify(body);
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// PROVIDER ADAPTERS (internal, not exported)
// ---------------------------------------------------------------------------

// 1. OpenRouterAdapter
class OpenRouterAdapter {
  constructor() {
    this.name = 'openrouter';
  }

  get available() {
    if (process.env.OPENROUTER_MODEL) return true;
    try {
      const fs = require('fs');
      const key = fs.readFileSync(
        (process.env.HOME || '') + '/.zao/private/openrouter.key',
        'utf8'
      ).trim();
      return !!key;
    } catch (e) {
      return false;
    }
  }

  async complete(prompt, { model, timeoutMs } = {}) {
    const { ork } = require('./zol-lib');
    const text = await ork(prompt, '', { max: 512, temp: 0.7 });
    if (text === null || text === undefined) {
      throw new Error('OpenRouter returned null');
    }
    const resolvedModel =
      model ||
      process.env.OPENROUTER_MODEL ||
      'anthropic/claude-fable-5';
    return { text: String(text), model: resolvedModel };
  }
}

// 2. OllamaAdapter (only constructed if OLLAMA_BASE_URL is set)
class OllamaAdapter {
  constructor() {
    this.name = 'ollama';
    this.baseUrl = process.env.OLLAMA_BASE_URL || '';
  }

  get available() {
    return !!process.env.OLLAMA_BASE_URL;
  }

  async complete(prompt, { model = 'llama3', timeoutMs = 30000 } = {}) {
    if (!this.baseUrl) {
      throw new Error('OllamaAdapter: OLLAMA_BASE_URL not set');
    }
    const url = this.baseUrl.replace(/\/$/, '') + '/api/generate';
    const responseJson = await httpPost(url, { model, prompt, stream: false }, timeoutMs);
    const text = responseJson.response;
    if (text === undefined || text === null) {
      throw new Error('Ollama response missing .response field');
    }
    return { text: String(text), model: responseJson.model || model };
  }
}

// 3. MockAdapter
class MockAdapter {
  constructor() {
    this.name = 'mock';
  }

  get available() {
    return true;
  }

  async complete(prompt, opts = {}) {
    const hash = crypto
      .createHash('sha256')
      .update(prompt.slice(0, 50))
      .digest('hex')
      .slice(0, 8);
    return { text: 'mock:' + hash, model: 'mock' };
  }
}

// ---------------------------------------------------------------------------
// ModelGateway
// ---------------------------------------------------------------------------
class ModelGateway {
  /**
   * @param {object} stateStore - has .get(key) and .put(key, value)
   * @param {object} [opts]
   * @param {string} [opts.defaultProvider='openrouter']
   * @param {number} [opts.quotaTokensPerDay=20000]
   */
  constructor(stateStore, { defaultProvider = 'openrouter', quotaTokensPerDay = 20000 } = {}) {
    this.stateStore = stateStore;
    this.defaultProvider = defaultProvider;
    this.quotaTokensPerDay = quotaTokensPerDay;

    // Build provider map; OllamaAdapter only included when OLLAMA_BASE_URL is set
    this._providers = {
      openrouter: new OpenRouterAdapter(),
      mock: new MockAdapter(),
    };
    if (process.env.OLLAMA_BASE_URL) {
      this._providers.ollama = new OllamaAdapter();
    }
  }

  // -------------------------------------------------------------------------
  // Quota helpers
  // -------------------------------------------------------------------------
  _todayDate() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  async _loadQuota() {
    let data;
    try {
      data = await this.stateStore.get('model-gateway-quota');
    } catch (e) {
      data = null;
    }
    const today = this._todayDate();
    if (!data || data.date !== today) {
      return { date: today, tokensUsedToday: 0 };
    }
    return data;
  }

  async _saveQuota(data) {
    await this.stateStore.put('model-gateway-quota', data);
  }

  // -------------------------------------------------------------------------
  // Telemetry helpers
  // -------------------------------------------------------------------------
  async _recordTelemetry(entry) {
    // entry must NOT contain prompt or response text
    let list;
    try {
      list = await this.stateStore.get('model-gateway-telemetry');
    } catch (e) {
      list = null;
    }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    // Keep last 100 entries
    if (list.length > 100) list = list.slice(list.length - 100);
    try {
      await this.stateStore.put('model-gateway-telemetry', list);
    } catch (e) {
      // non-critical
    }
  }

  // -------------------------------------------------------------------------
  // complete(prompt, opts) → { text, provider, model, tokensEstimate, durationMs }
  // -------------------------------------------------------------------------
  async complete(
    prompt,
    { model, provider, timeoutMs = 30000, fallbackProvider } = {}
  ) {
    // 1. Check quota (use a rough prompt-length estimate before we know output size)
    const quota = await this._loadQuota();
    if (quota.tokensUsedToday >= this.quotaTokensPerDay) {
      throw new QuotaExceededError(
        `Daily quota of ${this.quotaTokensPerDay} tokens exceeded (used: ${quota.tokensUsedToday}). ` +
          `Resets at ${this._nextMidnightISO()}.`
      );
    }

    // 2. Select provider: arg > env > defaultProvider; fall back to 'mock' if unavailable
    const requestedProvider =
      provider || process.env.OPENROUTER_MODEL_PROVIDER || this.defaultProvider;
    let selectedProvider = requestedProvider;
    if (!this._providers[selectedProvider] || !this._providers[selectedProvider].available) {
      selectedProvider = 'mock';
    }

    // 3. Call with AbortController timeout
    const start = Date.now();
    let result;
    let usedProvider = selectedProvider;
    let success = false;
    let err;

    try {
      result = await this._callWithTimeout(selectedProvider, prompt, { model, timeoutMs });
      success = true;
    } catch (primaryErr) {
      err = primaryErr;
      // 4. On error, try fallbackProvider if set
      if (fallbackProvider) {
        const fb = fallbackProvider;
        if (this._providers[fb] && this._providers[fb].available) {
          try {
            result = await this._callWithTimeout(fb, prompt, { model, timeoutMs });
            usedProvider = fb;
            success = true;
            err = null;
          } catch (fallbackErr) {
            err = new Error(
              `Primary provider '${selectedProvider}' failed: ${primaryErr.message}. ` +
                `Fallback provider '${fb}' also failed: ${fallbackErr.message}`
            );
          }
        } else {
          err = new Error(
            `Primary provider '${selectedProvider}' failed: ${primaryErr.message}. ` +
              `Fallback provider '${fb}' is not available.`
          );
        }
      }
    }

    const durationMs = Date.now() - start;

    if (!success) {
      // Record failed telemetry (no text)
      const failEntry = {
        date: this._todayDate(),
        provider: usedProvider,
        model: model || 'unknown',
        tokensEstimate: 0,
        durationMs,
        success: false,
      };
      await this._recordTelemetry(failEntry);
      throw err;
    }

    // 5. Compute token estimate: Math.ceil((prompt.length + text.length) / 4)
    const tokensEstimate = Math.ceil((prompt.length + result.text.length) / 4);
    const finalModel = result.model || model || 'unknown';

    // 5. Record telemetry (NO prompt/response text)
    const telemetryEntry = {
      date: this._todayDate(),
      provider: usedProvider,
      model: finalModel,
      tokensEstimate,
      durationMs,
      success: true,
    };
    await this._recordTelemetry(telemetryEntry);

    // 6. Update quota usage
    quota.tokensUsedToday += tokensEstimate;
    await this._saveQuota(quota);

    // 7. Return result
    return {
      text: result.text,
      provider: usedProvider,
      model: finalModel,
      tokensEstimate,
      durationMs,
    };
  }

  async _callWithTimeout(providerName, prompt, { model, timeoutMs }) {
    const adapter = this._providers[providerName];
    if (!adapter) throw new Error(`Unknown provider: ${providerName}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await adapter.complete(prompt, { model, timeoutMs, signal: controller.signal });
      return result;
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`Provider '${providerName}' timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // getQuotaStatus() → { tokensUsedToday, quotaLimit, remaining, resetAt }
  // -------------------------------------------------------------------------
  async getQuotaStatus() {
    const quota = await this._loadQuota();
    return {
      tokensUsedToday: quota.tokensUsedToday,
      quotaLimit: this.quotaTokensPerDay,
      remaining: Math.max(0, this.quotaTokensPerDay - quota.tokensUsedToday),
      resetAt: this._nextMidnightISO(),
    };
  }

  _nextMidnightISO() {
    const now = new Date();
    const nextMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    return nextMidnight.toISOString();
  }

  // -------------------------------------------------------------------------
  // resetQuota() → clear daily counter
  // -------------------------------------------------------------------------
  async resetQuota() {
    await this._saveQuota({ date: this._todayDate(), tokensUsedToday: 0 });
  }

  // -------------------------------------------------------------------------
  // getProviders() → [{ name, available, healthy }]
  // -------------------------------------------------------------------------
  async getProviders() {
    const results = [];
    for (const [name, adapter] of Object.entries(this._providers)) {
      const available = adapter.available;
      let healthy = false;
      if (available) {
        try {
          // MockAdapter and OpenRouterAdapter have no healthCheck; treat available as healthy
          healthy = typeof adapter.healthCheck === 'function'
            ? await adapter.healthCheck()
            : available;
        } catch (e) {
          healthy = false;
        }
      }
      results.push({ name, available, healthy });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { ModelGateway, QuotaExceededError };
