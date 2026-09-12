'use strict';

const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { CodexAppServerClient } = require('./codex-app-server-client');

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 43110;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ORIGINS = [
  'https://kokuren333.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_JOBS = 100;
const MAX_EVENTS_PER_JOB = 200;
const JOB_TTL_MS = 30 * 60 * 1000;
const OPERATIONS = new Set([
  'TREE_PROPOSE',
  'NODE_EXPAND',
  'NODE_CREATE',
  'CHALLENGE_CREATE',
  'ANSWER_GRADE'
]);
const OPERATION_ALIASES = new Map([
  ['tree_propose', 'TREE_PROPOSE'],
  ['node_expand', 'NODE_EXPAND'],
  ['node_create', 'NODE_CREATE'],
  ['challenge_create', 'CHALLENGE_CREATE'],
  ['answer_grade', 'ANSWER_GRADE']
]);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const BRIDGE_EVENT_NAMES = new Set(['message', 'progress', 'result']);

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CHALLENGE_TREE_PORT must be an integer from 1024 to 65535.');
  }
  return port;
}

function parseHost(value) {
  const host = value || DEFAULT_HOST;
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('CHALLENGE_TREE_HOST must be 127.0.0.1 or ::1.');
  }
  return host;
}

function validateOrigins(origins) {
  const uniqueOrigins = [...new Set(origins)];
  if (uniqueOrigins.length === 0 || uniqueOrigins.some((origin) => typeof origin !== 'string')) {
    throw new Error('At least one explicit allowed origin is required.');
  }

  if (uniqueOrigins.some((origin) => origin === '*' || /[\r\n]/.test(origin))) {
    throw new Error('CHALLENGE_TREE_ALLOWED_ORIGINS must contain explicit origins, not *.');
  }

  for (const origin of uniqueOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid origin in CHALLENGE_TREE_ALLOWED_ORIGINS: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`Origins must be scheme + host only: ${origin}`);
    }
  }
  return uniqueOrigins;
}

function parseOrigins(value) {
  const configured = value === undefined
    ? []
    : value.split(',').map((origin) => origin.trim()).filter(Boolean);
  return validateOrigins([...DEFAULT_ORIGINS, ...configured]);
}

function createConfig(options = {}) {
  const host = parseHost(options.host ?? process.env.CHALLENGE_TREE_HOST);
  const port = parsePort(options.port ?? process.env.CHALLENGE_TREE_PORT);
  const origins = options.origins
    ? validateOrigins(options.origins)
    : parseOrigins(process.env.CHALLENGE_TREE_ALLOWED_ORIGINS);

  return {
    host,
    port,
    origins,
    token: randomBytes(32).toString('hex'),
    model: options.model || null,
    connected: Boolean(options.connected),
    authenticated: Boolean(options.authenticated)
  };
}

function normalizeOperation(value) {
  if (typeof value !== 'string') return null;
  if (OPERATIONS.has(value)) return value;
  return OPERATION_ALIASES.get(value.toLowerCase()) || null;
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin.length > 0 ? origin : null;
}

function allowedOrigin(req, config) {
  const origin = requestOrigin(req);
  if (origin === null) return null;
  return config.origins.includes(origin) ? origin : false;
}

function applyCors(res, origin) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Challenge-Tree-Token, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function writeJson(res, statusCode, payload, origin) {
  const body = JSON.stringify(payload);
  applyCors(res, origin);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function writeError(res, statusCode, message, origin) {
  writeJson(res, statusCode, { error: { message } }, origin);
}

function hasValidToken(req, expectedToken) {
  const authorization = req.headers.authorization;
  const headerToken = req.headers['x-challenge-tree-token'];
  let supplied = null;

  if (typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization)) {
    supplied = authorization.replace(/^Bearer\s+/i, '');
  } else if (typeof headerToken === 'string') {
    supplied = headerToken;
  }

  if (!supplied || supplied.length > 512) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
      req.resume();
      return;
    }

    let size = 0;
    const chunks = [];
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        reject(Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 }));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
        }
        resolve(value);
      } catch (error) {
        reject(error.statusCode ? error : Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function safeErrorMessage(error) {
  if (!error || typeof error.message !== 'string') return 'Codex operation failed.';
  return error.message.slice(0, 1000);
}

function eventJson(payload) {
  let serialized;
  try {
    serialized = JSON.stringify(payload === undefined ? null : payload);
  } catch {
    serialized = JSON.stringify({ message: 'Event payload could not be serialized.' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
    return JSON.stringify({ message: 'Event payload exceeded the connector size limit.' });
  }
  return serialized;
}

function writeSse(res, event) {
  res.write(`id: ${event.sequence}\n`);
  res.write(`event: ${event.sseName || event.name}\n`);
  res.write(`data: ${eventJson(event.data)}\n\n`);
}

function normalizedEventName(name) {
  if (name === 'job.result') return 'result';
  if (name === 'job.failed') return 'error';
  if (name === 'job.completed' || name === 'job.cancelled') return 'done';
  if (name === 'job.progress') return 'progress';
  if (name === 'job.created' || name === 'job.started' || name === 'job.message') return 'status';
  return name;
}

function isTerminal(job) {
  return TERMINAL_STATUSES.has(job.status);
}

function createConnector(options = {}) {
  const config = createConfig(options);
  const jobs = new Map();
  const bridgeConfigured = true;
  const codexClient = typeof options.bridge === 'function'
    ? null
    : (options.codexClient || new CodexAppServerClient({
      codexPath: options.codexPath,
      model: options.model || process.env.CHALLENGE_TREE_CODEX_MODEL || undefined,
      reasoningEffort: options.reasoningEffort,
      cwd: options.cwd || process.cwd(),
      onNotification: options.onCodexNotification
    }));
  const bridge = typeof options.bridge === 'function'
    ? options.bridge
    : (operation, input, context) => codexClient.runOperation(operation, input, context);
  let closed = false;

  if (codexClient) {
    void codexClient.start().then((status) => {
      if (typeof options.onCodexReady === 'function') options.onCodexReady(status);
    });
  }

  function emit(job, name, data) {
    const event = {
      sequence: ++job.nextSequence,
      name,
      sseName: normalizedEventName(name),
      data,
      createdAt: new Date().toISOString()
    };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS_PER_JOB) job.events.shift();
    for (const subscriber of [...job.subscribers]) {
      try {
        writeSse(subscriber, event);
      } catch {
        closeSubscriber(job, subscriber);
      }
    }
    return event;
  }

  function setTerminal(job, status, eventName, data) {
    if (isTerminal(job)) return false;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    emit(job, eventName, data);
    for (const subscriber of [...job.subscribers]) closeSubscriber(job, subscriber);
    scheduleCleanup(job);
    return true;
  }

  function scheduleCleanup(job) {
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.cleanupTimer = setTimeout(() => {
      if (job.subscribers.size === 0) jobs.delete(job.id);
    }, JOB_TTL_MS);
    job.cleanupTimer.unref?.();
  }

  function closeSubscriber(job, res) {
    if (!job.subscribers.delete(res)) return;
    if (res.writableEnded) return;
    res.end();
  }

  function startJob(job) {
    queueMicrotask(async () => {
      if (closed || isTerminal(job)) return;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.controller = new AbortController();
      emit(job, 'job.started', { jobId: job.id, operation: job.operation });

      const emitBridgeEvent = (name, data) => {
        if (!BRIDGE_EVENT_NAMES.has(name) || isTerminal(job)) return;
        emit(job, `job.${name}`, data);
      };

      try {
        const result = await bridge(job.operation, job.input, {
          signal: job.controller.signal,
          emit: emitBridgeEvent
        });

        if (job.controller.signal.aborted || job.status === 'cancelled') return;

        if (result && typeof result[Symbol.asyncIterator] === 'function') {
          for await (const item of result) {
            if (job.controller.signal.aborted || job.status === 'cancelled') return;
            emitBridgeEvent('progress', item);
          }
        } else if (result !== undefined) {
          emitBridgeEvent('result', result);
        }

        setTerminal(job, 'completed', 'job.completed', { jobId: job.id });
      } catch (error) {
        if (job.controller.signal.aborted || job.status === 'cancelled' || error?.name === 'AbortError') {
          setTerminal(job, 'cancelled', 'job.cancelled', { jobId: job.id });
          return;
        }
        setTerminal(job, 'failed', 'job.failed', {
          jobId: job.id,
          code: typeof error?.code === 'string' ? error.code : 'job_error',
          message: safeErrorMessage(error)
        });
      }
    });
  }

  function createJob(operation, input, requestId) {
    if (jobs.size >= MAX_JOBS) return null;
    const id = randomUUID();
    const job = {
      id,
      operation,
      input,
      requestId: requestId || null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      nextSequence: 0,
      events: [],
      subscribers: new Set(),
      controller: null,
      cleanupTimer: null
    };
    jobs.set(id, job);
    emit(job, 'job.created', { jobId: id, operation });
    startJob(job);
    return job;
  }

  function cancelJob(job) {
    if (isTerminal(job)) return false;
    job.status = 'cancelled';
    job.controller?.abort();
    job.finishedAt = new Date().toISOString();
    emit(job, 'job.cancelled', { jobId: job.id });
    for (const subscriber of [...job.subscribers]) closeSubscriber(job, subscriber);
    scheduleCleanup(job);
    return true;
  }

  function jobSummary(job) {
    return {
      jobId: job.id,
      operation: job.operation,
      requestId: job.requestId,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
  }

  function statusPayload() {
    const codexStatus = codexClient?.getStatus();
    const appServerRunning = codexStatus ? codexStatus.appServerRunning : config.connected;
    const authenticated = codexStatus ? codexStatus.authenticated : config.authenticated;
    const modelAvailable = codexStatus ? codexStatus.modelAvailable : config.connected;
    return {
      connector: 'ChallengeTreeConnector',
      protocolVersion: PROTOCOL_VERSION,
      connected: Boolean(appServerRunning && authenticated && modelAvailable),
      authenticated,
      codexFound: codexStatus?.codexFound ?? config.connected,
      appServerRunning,
      modelAvailable,
      model: codexStatus?.model || config.model,
      reasoningEffort: codexStatus?.reasoningEffort || null,
      codexVersion: codexStatus?.codexVersion || null,
      appServerVersion: codexStatus?.appServerVersion || null,
      error: codexStatus?.error || null,
      stderr: codexStatus?.stderr || [],
      tokenRequired: true,
      bridgeConfigured,
      token: config.token,
      host: config.host,
      port: server.address()?.port || config.port
    };
  }

  function authorize(req, res, origin) {
    if (!hasValidToken(req, config.token)) {
      writeError(res, 401, 'Valid connector token required.', origin);
      return false;
    }
    return true;
  }

  async function handleRequest(req, res) {
    const origin = allowedOrigin(req, config);
    if (origin === false) {
      writeError(res, 403, 'Request origin is not allowed.', null);
      return;
    }

    if (req.method === 'OPTIONS') {
      applyCors(res, origin);
      res.statusCode = 204;
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      writeError(res, 400, 'Invalid request URL.', origin);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/status') {
      writeJson(res, 200, statusPayload(), origin);
      return;
    }

    if (!authorize(req, res, origin)) return;

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!codexClient) {
        writeError(res, 503, 'Model catalog is unavailable for this connector.', origin);
        return;
      }
      try {
        const models = await codexClient.listModels();
        writeJson(res, 200, { models, selectedModel: statusPayload().model || null }, origin);
      } catch (error) {
        writeError(res, 503, safeErrorMessage(error), origin);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/settings/model') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        writeError(res, 415, 'Content-Type must be application/json.', origin);
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        writeError(res, error.statusCode || 400, error.statusCode === 413 ? error.message : 'Invalid JSON request.', origin);
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['model', 'reasoningEffort'].includes(key)) || (body.model === undefined && body.reasoningEffort === undefined)) {
        writeError(res, 400, 'Model settings must contain model and/or reasoningEffort.', origin);
        return;
      }
      if (!codexClient) {
        writeError(res, 503, 'Model selection is unavailable for this connector.', origin);
        return;
      }
      try {
        const selectedModel = body.model ?? codexClient.model;
        const status = await codexClient.setModel(selectedModel, body.reasoningEffort);
        writeJson(res, 200, { model: status.model, reasoningEffort: status.reasoningEffort, modelAvailable: status.modelAvailable }, origin);
      } catch (error) {
        const statusCode = error?.code === 'invalid_model' ? 400 : ['model_unavailable', 'reasoning_effort_unavailable'].includes(error?.code) ? 409 : 503;
        writeError(res, statusCode, safeErrorMessage(error), origin);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        writeError(res, 415, 'Content-Type must be application/json.', origin);
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        writeError(res, error.statusCode || 400, error.statusCode === 413 ? error.message : 'Invalid JSON request.', origin);
        return;
      }

      const allowedKeys = new Set(['operation', 'input', 'payload', 'requestId', 'protocolVersion']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
        writeError(res, 400, 'Job request contains unsupported fields.', origin);
        return;
      }
      const operation = normalizeOperation(body.operation);
      if (!operation) {
        writeError(res, 400, 'Only the documented Challenge Tree operations are allowed.', origin);
        return;
      }
      const input = body.input ?? body.payload;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        writeError(res, 400, 'Job input must be a JSON object.', origin);
        return;
      }
      if (body.requestId !== undefined && typeof body.requestId !== 'string') {
        writeError(res, 400, 'requestId must be a string when provided.', origin);
        return;
      }
      if (body.protocolVersion !== undefined && body.protocolVersion !== PROTOCOL_VERSION) {
        writeError(res, 400, 'Unsupported connector protocol version.', origin);
        return;
      }

      const job = createJob(operation, input, body.requestId);
      if (!job) {
        writeError(res, 503, 'The connector job limit has been reached.', origin);
        return;
      }
      writeJson(res, 202, {
        jobId: job.id,
        operation: job.operation,
        status: job.status,
        eventsUrl: `/v1/jobs/${job.id}/events`
      }, origin);
      return;
    }

    const eventsMatch = /^\/v1\/jobs\/([0-9a-f-]{36})\/events$/.exec(url.pathname);
    if (req.method === 'GET' && eventsMatch) {
      const job = jobs.get(eventsMatch[1]);
      if (!job) {
        writeError(res, 404, 'Job not found.', origin);
        return;
      }

      applyCors(res, origin);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders?.();

      const lastEventId = Number(req.headers['last-event-id'] || 0);
      for (const event of job.events) {
        if (!Number.isInteger(lastEventId) || event.sequence > lastEventId) writeSse(res, event);
      }
      if (isTerminal(job)) {
        res.end();
        return;
      }

      job.subscribers.add(res);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, 15000);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        closeSubscriber(job, res);
      });
      return;
    }

    const cancelMatch = /^\/v1\/jobs\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
    if (req.method === 'POST' && cancelMatch) {
      req.resume();
      const job = jobs.get(cancelMatch[1]);
      if (!job) {
        writeError(res, 404, 'Job not found.', origin);
        return;
      }
      cancelJob(job);
      writeJson(res, 200, jobSummary(job), origin);
      return;
    }

    writeError(res, 404, 'Not found.', origin);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) writeError(res, 500, 'Internal connector error.', null);
      else res.destroy();
    });
  });

  function close(callback) {
    closed = true;
    for (const job of jobs.values()) {
      if (!isTerminal(job)) cancelJob(job);
      for (const subscriber of [...job.subscribers]) closeSubscriber(job, subscriber);
      if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    }
    if (codexClient) {
      void codexClient.stop().finally(() => server.close(callback));
    } else {
      server.close(callback);
    }
  }

  return {
    server,
    token: config.token,
    config,
    close,
    status: statusPayload,
    codexClient,
    jobs
  };
}

function startFromCommandLine() {
  const connector = createConnector({
    model: process.env.CHALLENGE_TREE_CODEX_MODEL || 'gpt-5.6-luna',
    codexPath: process.env.CHALLENGE_TREE_CODEX_PATH,
    onCodexReady: (status) => {
      if (!status.codexFound) {
        process.stderr.write('Codex CLI: not found. Install Codex or set CHALLENGE_TREE_CODEX_PATH.\n');
      } else if (status.error) {
        process.stderr.write(`Codex App Server: ${status.error.message}\n`);
      } else {
        process.stderr.write(`Codex App Server: ready (${status.model}, ${status.codexVersion || 'version unknown'})\n`);
      }
    }
  });

  connector.server.listen(connector.config.port, connector.config.host, () => {
    const address = connector.server.address();
    const displayHost = connector.config.host.includes(':') ? `[${connector.config.host}]` : connector.config.host;
    process.stderr.write(`ChallengeTreeConnector listening at http://${displayHost}:${address.port}\n`);
    process.stderr.write('Ephemeral token (keep private; rotated on restart):\n');
    process.stderr.write(`${connector.token}\n`);
    process.stderr.write('Allowed browser origin: ' + connector.config.origins.join(', ') + '\n');
  });

  const shutdown = () => connector.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return connector;
}

if (require.main === module) startFromCommandLine();

module.exports = {
  PROTOCOL_VERSION,
  OPERATIONS: [...OPERATIONS],
  createConnector,
  normalizeOperation
};
