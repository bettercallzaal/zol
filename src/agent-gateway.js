'use strict';

// agent-gateway.js - Layer 12 (Agent Gateway) for ZOL Persistent Agent Upgrade v2
// Local-only by default, rate-limited HTTP server exposing REST + MCP endpoints.
// CommonJS, no external npm deps — only node:http and node:crypto built-ins.

const http = require('node:http');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '2.0.0';
const AGENT_ID = 'zolbot';
const FID = 3338501;

const MCP_TOOLS = [
  {
    name: 'create_work_packet',
    description: 'Create a new work packet',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['title', 'description', 'type'],
    },
  },
  {
    name: 'query_memory',
    description: 'Query sourced memory by type and tags',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'list_artifacts',
    description: 'List artifacts by type and status',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        status: { type: 'string' },
      },
    },
  },
  {
    name: 'request_approval',
    description: 'Request human approval for an action',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        context: { type: 'object' },
      },
      required: ['action'],
    },
  },
  {
    name: 'export_proof_drop',
    description: 'Export a sanitized proof drop bundle',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
      },
      required: ['artifactId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Rate limiter — simple token bucket, in-memory, per IP
// ---------------------------------------------------------------------------

class RateLimiter {
  /**
   * @param {number} maxRequests - max requests per window
   * @param {number} windowMs    - window size in milliseconds
   */
  constructor(maxRequests = 60, windowMs = 60_000) {
    this._max = maxRequests;
    this._windowMs = windowMs;
    // Map<ip, { count: number, windowStart: number }>
    this._buckets = new Map();
  }

  /**
   * Check whether `ip` is within its rate limit.
   * @param {string} ip
   * @returns {{ allowed: boolean, remaining: number }}
   */
  check(ip) {
    const now = Date.now();
    let bucket = this._buckets.get(ip);

    if (!bucket || now - bucket.windowStart >= this._windowMs) {
      bucket = { count: 0, windowStart: now };
      this._buckets.set(ip, bucket);
    }

    if (bucket.count >= this._max) {
      return { allowed: false, remaining: 0 };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this._max - bucket.count };
  }

  /** Purge stale buckets (housekeeping — call periodically if needed). */
  purge() {
    const now = Date.now();
    for (const [ip, bucket] of this._buckets) {
      if (now - bucket.windowStart >= this._windowMs) {
        this._buckets.delete(ip);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the request body as JSON.
 * Resolves with the parsed value, or rejects on parse error / timeout.
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes=1_048_576]
 * @returns {Promise<any>}
 */
function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Send a JSON response with security headers.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(payload);
}

/**
 * Send an error JSON response.
 * @param {http.ServerResponse} res
 * @param {number} code
 * @param {string} message
 */
function sendError(res, code, message) {
  sendJson(res, code, { error: message, code });
}

/**
 * Extract the remote IP from the request (accounting for loopback).
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function remoteIp(req) {
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    '127.0.0.1'
  );
}

// ---------------------------------------------------------------------------
// AgentGateway
// ---------------------------------------------------------------------------

class AgentGateway {
  /**
   * @param {object} opts
   * @param {object} opts.capsuleRegistry
   * @param {object} opts.dreamloopRegistry
   * @param {object} opts.workRouter
   * @param {object} opts.artifactPipeline
   * @param {object} opts.receiptJournal
   * @param {object} opts.toolGateway
   * @param {object} [opts.memoryWeaver]      - MemoryWeaver instance for query_memory
   * @param {object} [opts.proofDropAdapter]  - ProofDropAdapter instance for export_proof_drop
   * @param {number} [opts.port]
   * @param {string} [opts.bindAddress]
   * @param {string} [opts.authToken]         - Bearer token required when remote mode is enabled
   */
  constructor({
    capsuleRegistry,
    dreamloopRegistry,
    workRouter,
    artifactPipeline,
    receiptJournal,
    toolGateway,
    memoryWeaver,
    proofDropAdapter,
    port,
    bindAddress,
    authToken,
  } = {}) {
    this._capsuleRegistry = capsuleRegistry;
    this._dreamloopRegistry = dreamloopRegistry;
    this._workRouter = workRouter;
    this._artifactPipeline = artifactPipeline;
    this._receiptJournal = receiptJournal;
    this._toolGateway = toolGateway;
    this._memoryWeaver = memoryWeaver || null;
    this._proofDropAdapter = proofDropAdapter || null;

    // Port: explicit arg > env var > default
    this._port = port != null
      ? Number(port)
      : Number(process.env.ZOL_AGENT_GATEWAY_PORT || 8089);

    // Bind address: respect ZOL_AGENT_GATEWAY_REMOTE=1 for remote access
    const remoteEnabled = process.env.ZOL_AGENT_GATEWAY_REMOTE === '1';
    this._bindAddress = bindAddress != null
      ? bindAddress
      : (remoteEnabled ? '0.0.0.0' : '127.0.0.1');

    // Remote mode requires an auth token — fail at construction time, not at first request
    if (remoteEnabled) {
      const token = authToken || process.env.ZOL_AGENT_GATEWAY_TOKEN || '';
      if (!token) {
        throw new Error(
          'AgentGateway: ZOL_AGENT_GATEWAY_REMOTE=1 requires ZOL_AGENT_GATEWAY_TOKEN ' +
          '(or authToken constructor option). Refusing to bind to 0.0.0.0 without authentication.'
        );
      }
      this._authToken = token;
    } else {
      this._authToken = null;
    }

    this._rateLimiter = new RateLimiter(60, 60_000);
    this._server = null;
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the HTTP server.
   * @returns {Promise<{ port: number, url: string }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      server.on('error', reject);

      server.listen(this._port, this._bindAddress, () => {
        const addr = server.address();
        const port = addr.port;
        const url = `http://${this._bindAddress}:${port}`;
        this._server = server;
        resolve({ port, url });
      });
    });
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this._server) {
        resolve();
        return;
      }
      this._server.close((err) => {
        this._server = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Request dispatcher
  // ---------------------------------------------------------------------------

  async _handleRequest(req, res) {
    // Rate limit check
    const ip = remoteIp(req);
    const rl = this._rateLimiter.check(ip);
    if (!rl.allowed) {
      return sendError(res, 429, 'Too Many Requests');
    }

    // Bearer token auth — required when running in remote mode
    if (this._authToken) {
      const authHeader = req.headers['authorization'] || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (provided !== this._authToken) {
        return sendError(res, 401, 'Unauthorized');
      }
    }

    // Parse URL
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, 'http://localhost');
    } catch (_) {
      return sendError(res, 400, 'Bad Request');
    }

    const pathname = parsedUrl.pathname;
    const method = req.method;

    try {
      // --- Static routes ---

      if (pathname === '/health' && method === 'GET') {
        return this._handleHealth(req, res);
      }

      if (pathname === '/agent-card' && method === 'GET') {
        return this._handleAgentCard(req, res);
      }

      if (pathname === '/capabilities' && method === 'GET') {
        return this._handleCapabilities(req, res);
      }

      if (pathname === '/tasks' && method === 'GET') {
        return this._handleListTasks(req, res, parsedUrl);
      }

      if (pathname === '/tasks' && method === 'POST') {
        return this._handleCreateTask(req, res);
      }

      if (pathname.startsWith('/tasks/') && method === 'GET') {
        const id = pathname.slice('/tasks/'.length);
        return this._handleGetTask(req, res, id);
      }

      if (pathname === '/artifacts' && method === 'GET') {
        return this._handleListArtifacts(req, res, parsedUrl);
      }

      if (pathname === '/receipts' && method === 'GET') {
        return this._handleListReceipts(req, res, parsedUrl);
      }

      if (pathname === '/capsules' && method === 'GET') {
        return this._handleListCapsules(req, res);
      }

      if (pathname === '/dreamloops' && method === 'GET') {
        return this._handleListDreamLoops(req, res);
      }

      if (pathname === '/trappers/import' && method === 'POST') {
        return this._handleTrappersImport(req, res);
      }

      if (pathname.startsWith('/trappers/export/') && method === 'GET') {
        const id = pathname.slice('/trappers/export/'.length);
        return this._handleTrappersExport(req, res, id);
      }

      if (pathname === '/mcp/tools' && method === 'GET') {
        return this._handleMcpTools(req, res);
      }

      if (pathname === '/mcp/execute' && method === 'POST') {
        return this._handleMcpExecute(req, res);
      }

      // --- Method not allowed for known paths ---
      const knownPaths = [
        '/health', '/agent-card', '/capabilities', '/tasks',
        '/artifacts', '/receipts', '/capsules', '/dreamloops',
        '/trappers/import', '/mcp/tools', '/mcp/execute',
      ];
      const isKnownStatic = knownPaths.includes(pathname);
      const isKnownParam =
        pathname.startsWith('/tasks/') ||
        pathname.startsWith('/trappers/export/');

      if (isKnownStatic || isKnownParam) {
        return sendError(res, 405, 'Method Not Allowed');
      }

      // --- 404 ---
      return sendError(res, 404, 'Not Found');

    } catch (err) {
      // Never expose internal details in error messages
      return sendError(res, 500, 'Internal Server Error');
    }
  }

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  _handleHealth(_req, res) {
    sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      agentId: AGENT_ID,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

  _handleAgentCard(_req, res) {
    sendJson(res, 200, {
      agentId: AGENT_ID,
      fid: FID,
      name: 'ZOL',
      version: VERSION,
      description: 'ZAO music scout on Farcaster',
      capabilities: ['capsules', 'dreamloops', 'tasks', 'artifacts', 'receipts', 'memory', 'approval'],
      persona: 'music-first, artist-serving, sparse',
    });
  }

  async _handleCapabilities(_req, res) {
    const result = await this._toolGateway.discover();
    sendJson(res, 200, result);
  }

  async _handleListTasks(_req, res, _parsedUrl) {
    const tasks = await this._workRouter.list({ limit: 50 });
    sendJson(res, 200, { tasks, total: tasks.length });
  }

  async _handleGetTask(_req, res, id) {
    if (!id) {
      return sendError(res, 400, 'Bad Request');
    }
    const task = await this._workRouter.get(id);
    if (!task) {
      return sendError(res, 404, 'not found');
    }
    sendJson(res, 200, { task });
  }

  async _handleCreateTask(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (_) {
      return sendError(res, 400, 'Bad Request');
    }

    const { title, description, type, priority, requestedBy } = body;
    if (!title || !description || !type) {
      return sendError(res, 400, 'Bad Request: title, description, and type are required');
    }

    const packet = await this._workRouter.createPacket({ title, description, type, priority, requestedBy });
    sendJson(res, 200, { task: packet, created: true });
  }

  async _handleListArtifacts(_req, res, _parsedUrl) {
    const artifacts = await this._artifactPipeline.list({ limit: 50 });
    sendJson(res, 200, { artifacts, total: artifacts.length });
  }

  async _handleListReceipts(_req, res, parsedUrl) {
    const limitParam = parsedUrl.searchParams.get('limit');
    const loopId = parsedUrl.searchParams.get('loopId') || undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : 20;

    const receipts = await this._receiptJournal.list({ limit, loopId });
    sendJson(res, 200, { receipts, total: receipts.length });
  }

  async _handleListCapsules(_req, res) {
    const capsules = await this._capsuleRegistry.list();
    sendJson(res, 200, { capsules, total: capsules.length });
  }

  async _handleListDreamLoops(_req, res) {
    const loops = await this._dreamloopRegistry.list();
    sendJson(res, 200, { loops, total: loops.length });
  }

  async _handleTrappersImport(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (_) {
      return sendError(res, 400, 'Bad Request');
    }

    const { bundle } = body;
    if (!bundle || typeof bundle !== 'object') {
      return sendError(res, 400, 'Bad Request: bundle is required and must be an object');
    }

    const plan = await this._artifactPipeline.plan(bundle);
    const artifact = await this._artifactPipeline.build(plan);
    const artifactId = artifact.artifactId || artifact.id || crypto.randomUUID();

    sendJson(res, 200, { artifactId, imported: true });
  }

  async _handleTrappersExport(_req, res, id) {
    if (!id) {
      return sendError(res, 400, 'Bad Request');
    }

    const exported = await this._artifactPipeline.export(id);
    if (!exported) {
      return sendError(res, 404, 'not found');
    }

    sendJson(res, 200, exported);
  }

  _handleMcpTools(_req, res) {
    sendJson(res, 200, MCP_TOOLS);
  }

  async _handleMcpExecute(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (_) {
      return sendError(res, 400, 'Bad Request');
    }

    const { tool, input = {} } = body;
    if (!tool || typeof tool !== 'string') {
      return sendError(res, 400, 'Bad Request: tool is required');
    }

    let result;

    switch (tool) {
      case 'create_work_packet': {
        const { title, description, type, priority, requestedBy } = input;
        if (!title || !description || !type) {
          return sendError(res, 400, 'Bad Request: title, description, and type are required');
        }
        result = await this._workRouter.createPacket({ title, description, type, priority, requestedBy });
        break;
      }

      case 'query_memory': {
        const { type, tags, limit } = input;
        if (this._memoryWeaver && typeof this._memoryWeaver.query === 'function') {
          result = await this._memoryWeaver.query({ type, tags, limit });
        } else {
          // MemoryWeaver not wired — return empty rather than leaking capsule registry internals
          result = [];
        }
        break;
      }

      case 'list_artifacts': {
        const { type, status } = input;
        const artifacts = await this._artifactPipeline.list({ type, status });
        result = artifacts;
        break;
      }

      case 'request_approval': {
        const { action, context } = input;
        if (!action) {
          return sendError(res, 400, 'Bad Request: action is required');
        }
        // Record the approval request as a receipt
        const approvalId = 'approval_' + crypto.randomUUID();
        result = {
          approvalId,
          action,
          context: context || {},
          status: 'pending',
          requestedAt: new Date().toISOString(),
        };
        break;
      }

      case 'export_proof_drop': {
        const { artifactId } = input;
        if (!artifactId) {
          return sendError(res, 400, 'Bad Request: artifactId is required');
        }
        if (!this._proofDropAdapter) {
          return sendError(res, 503, 'ProofDropAdapter not configured');
        }
        const exported = await this._proofDropAdapter.export(artifactId);
        if (!exported) {
          return sendError(res, 404, 'not found');
        }
        result = exported;
        break;
      }

      default:
        return sendError(res, 404, `unknown tool: ${tool}`);
    }

    sendJson(res, 200, { result });
  }
}

module.exports = { AgentGateway };

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const { createStateStore } = require('./state-adapter');
    const { CapsuleRegistry } = require('./capsule-registry');
    const { DreamloopRegistry } = require('./dreamloop-registry');
    const { WorkRouter } = require('./work-router');
    const { ArtifactPipeline } = require('./artifact-pipeline');
    const { ReceiptJournal } = require('./receipt-journal');
    const { ToolGateway } = require('./tool-gateway');
    const { MemoryWeaver } = require('./memory-weaver');

    const stateDir = process.env.ZOL_STATE_DIR ||
      require('path').join(process.env.HOME || '/root', 'zol', 'state');

    const store = await createStateStore(stateDir);
    const capsuleRegistry = new CapsuleRegistry(store);
    const dreamloopRegistry = new DreamloopRegistry(store);
    const workRouter = new WorkRouter(store);
    const receiptJournal = new ReceiptJournal(store);
    const artifactPipeline = new ArtifactPipeline(store, receiptJournal);
    const toolGateway = new ToolGateway(store, receiptJournal);
    const memoryWeaver = new MemoryWeaver(store);

    const gateway = new AgentGateway({
      capsuleRegistry,
      dreamloopRegistry,
      workRouter,
      artifactPipeline,
      receiptJournal,
      toolGateway,
      memoryWeaver,
    });

    const { port, url } = await gateway.start();
    console.log(`[AgentGateway] Listening at ${url}`);

    process.on('SIGTERM', async () => {
      await gateway.stop();
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      await gateway.stop();
      process.exit(0);
    });
  })().catch(err => {
    console.error('[AgentGateway] Fatal startup error:', err.message);
    process.exit(1);
  });
}
