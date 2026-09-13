'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_TIMEOUT_MS = 180000;
const STDERR_LIMIT = 80;
const RESTART_LIMIT = 3;

const POSITION_SCHEMA = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } };
// Node creation returns only content that Codex should author. The web app
// owns all mutable tree state and supplies it when inserting the node.
const NODE_CREATE_NODE_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'title', 'description', 'goal'], properties: {
  id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, goal: { type: 'string' }
} };
const NODE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'title', 'description', 'goal', 'status', 'xp', 'masteryState', 'prerequisites', 'children', 'resourceIds', 'challengeIds', 'position', 'createdAt', 'updatedAt', 'archived'], properties: {
  id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, goal: { type: 'string' }, status: { type: 'string', enum: ['hidden', 'unlocked', 'cleared'] }, xp: { type: 'integer', minimum: 0 }, masteryState: { type: 'string', enum: ['familiar', 'developing', 'mastered'] },
  prerequisites: { type: 'array', items: { type: 'string' } }, children: { type: 'array', items: { type: 'string' } }, resourceIds: { type: 'array', items: { type: 'string' } }, challengeIds: { type: 'array', items: { type: 'string' } }, position: POSITION_SCHEMA, createdAt: { type: 'string' }, updatedAt: { type: 'string' }, archived: { type: 'boolean' }
} };
const EDGE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['from', 'to', 'type'], properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: ['dependency', 'recommended', 'related'] } } };
const RESOURCE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'title', 'url', 'language', 'type', 'authorityTier', 'guidance', 'supports', 'locator', 'verifiedAt'], properties: {
  id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, language: { type: 'string' }, type: { type: 'string', enum: ['primary_paper', 'official_docs', 'government', 'university', 'textbook', 'course', 'technical_docs', 'article', 'video', 'community', 'other'] }, authorityTier: { type: 'string', enum: ['A', 'B', 'C', 'D'] }, locator: { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { kind: { type: 'string', enum: ['section', 'page', 'heading', 'chapter', 'timestamp', 'other'] }, value: { type: 'string' } } }, guidance: { type: 'string' }, supports: { type: 'array', items: { type: 'string' } }, verifiedAt: { type: 'string' }
} };
const CHALLENGE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'nodeId', 'promptStyle', 'difficulty', 'prompt', 'expectedConcepts', 'modelAnswer', 'explanation', 'rubric', 'commonMisconceptions', 'resourceIds', 'createdAt', 'mode', 'questions'], properties: {
  id: { type: 'string' }, nodeId: { type: 'string' }, promptStyle: { type: 'string', enum: ['definition', 'why', 'mechanism', 'compare', 'scenario', 'critique', 'synthesis'] }, difficulty: { type: 'integer', minimum: 1, maximum: 4 }, prompt: { type: 'string', minLength: 1 }, expectedConcepts: { type: 'array', items: { type: 'string' } }, modelAnswer: { type: 'string', minLength: 1 }, explanation: { type: 'string', minLength: 1 }, rubric: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion', 'required'], properties: { criterion: { type: 'string' }, required: { type: 'boolean' } } } }, commonMisconceptions: { type: 'array', items: { type: 'string' } }, resourceIds: { type: 'array', items: { type: 'string' } }, createdAt: { type: 'string' }, mode: { type: 'string', enum: ['explain', 'short_answer', 'true_false'] }, questions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['id', 'prompt', 'modelAnswer', 'expectedConcepts', 'explanation'], properties: { id: { type: 'string' }, prompt: { type: 'string', minLength: 1 }, modelAnswer: { type: 'string', minLength: 1 }, expectedConcepts: { type: 'array', items: { type: 'string' } }, explanation: { type: 'string', minLength: 1 } } } }
} };

function parseJsonlChunk(buffer, chunk) {
  const combined = buffer + String(chunk);
  const lines = combined.split(/\r?\n/);
  const nextBuffer = lines.pop() || '';
  const messages = [];
  let malformed = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { buffer: nextBuffer, messages, malformed };
}

function safeErrorMessage(error, fallback = 'Codex App Server request failed.') {
  const message = error && typeof error.message === 'string' ? error.message : fallback;
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function getHomeDirectory() {
  const home = process.platform === 'win32'
    ? (process.env.USERPROFILE || process.env.HOME)
    : process.env.HOME;
  return home && path.isAbsolute(home) ? home : null;
}

function getNpmGlobalBin() {
  const result = spawnSync('npm', ['config', 'get', 'prefix'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout) return null;
  const prefix = result.stdout.trim();
  if (!prefix || !path.isAbsolute(prefix)) return null;
  return path.join(prefix, 'bin');
}

function findCodexExecutable(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);

  if (process.platform === 'win32') {
    // The native Codex installer keeps versioned binaries under LOCALAPPDATA
    // and that location is not always present in the PATH inherited by a
    // portable connector launched from Explorer.
    const localAppData = process.env.LOCALAPPDATA || (
      process.env.USERPROFILE && path.isAbsolute(process.env.USERPROFILE)
        ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
        : null
    );
    const installRoots = [
      localAppData ? path.join(localAppData, 'OpenAI', 'Codex', 'bin') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'OpenAI', 'Codex', 'bin') : null,
      process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'OpenAI', 'Codex', 'bin') : null
    ].filter(Boolean);

    for (const installRoot of installRoots) {
      try {
        const versionedCandidates = fs.readdirSync(installRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const candidate = path.join(installRoot, entry.name, 'codex.exe');
            let mtime = 0;
            try {
              mtime = fs.statSync(candidate).mtimeMs;
            } catch {
              // Ignore stale or partially removed installation directories.
            }
            return { candidate, mtime };
          })
          .sort((left, right) => right.mtime - left.mtime)
          .map((item) => item.candidate);
        candidates.push(...versionedCandidates, path.join(installRoot, 'codex.exe'));
      } catch {
        // The optional install roots may not exist on every Windows machine.
      }
    }

    const result = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true, shell: false });
    if (result.status === 0 && result.stdout) {
      candidates.push(...result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
    }
  } else {
    // The official standalone installer and package managers can place the
    // launcher outside the inherited PATH when this connector is started from
    // a desktop shortcut. Check conventional user/system bin directories
    // before falling back to PATH lookup.
    const home = getHomeDirectory();
    const userBin = process.env.XDG_BIN_HOME && path.isAbsolute(process.env.XDG_BIN_HOME)
      ? process.env.XDG_BIN_HOME
      : null;
    const pathResult = spawnSync('which', ['codex'], { encoding: 'utf8', shell: false });
    if (pathResult.status === 0 && pathResult.stdout) candidates.push(pathResult.stdout.trim());

    const standardCandidates = [
      userBin ? path.join(userBin, 'codex') : null,
      home ? path.join(home, '.local', 'bin', 'codex') : null,
      home ? path.join(home, 'bin', 'codex') : null,
      home ? path.join(home, '.nix-profile', 'bin', 'codex') : null,
      process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : null,
      process.platform === 'darwin' ? '/usr/local/bin/codex' : null,
      process.platform === 'darwin' ? '/opt/local/bin/codex' : null,
      process.platform === 'linux' ? '/usr/local/bin/codex' : null,
      process.platform === 'linux' ? '/usr/bin/codex' : null,
      process.platform === 'linux' ? '/snap/bin/codex' : null
    ].filter(Boolean);
    candidates.push(...standardCandidates);

    const npmGlobalBin = getNpmGlobalBin();
    if (npmGlobalBin) candidates.push(path.join(npmGlobalBin, 'codex'));
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.toLowerCase().endsWith('.cmd') || candidate.toLowerCase().endsWith('.ps1')) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {
      // Ignore missing or inaccessible candidates and continue searching.
    }
  }
  return null;
}

function extractAgentText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items
    .filter((item) => item && (item.type === 'agentMessage' || item.type === 'agent_message'))
    .map((item) => {
      if (typeof item.text === 'string') return item.text;
      if (!Array.isArray(item.content)) return '';
      return item.content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
    })
    .filter(Boolean);
  return messages.length ? messages[messages.length - 1].trim() : '';
}

function isWebSearchItem(item) {
  const type = String(item?.type || '').toLowerCase();
  return type === 'websearch' || type === 'web_search' || type === 'websearchcall' || type === 'web_search_call';
}

function extractSearchEvidence(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const searchItems = items.filter(isWebSearchItem);
  const searches = [];
  const sources = [];
  for (const item of searchItems) {
    const action = item?.action && typeof item.action === 'object' ? item.action : {};
    const queries = [item?.query, action.query, ...(Array.isArray(action.queries) ? action.queries : [])]
      .filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim());
    searches.push(...queries);
    if (typeof action.url === 'string' && /^https?:\/\//i.test(action.url)) {
      sources.push({ title: action.url, url: action.url, query: queries[0] });
    }
    const results = Array.isArray(item?.results) ? item.results : [];
    for (const result of results) {
      if (!result || typeof result !== 'object') continue;
      const url = [result.url, result.link].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
      if (!url) continue;
      const title = [result.title, result.name].find((value) => typeof value === 'string' && value.trim()) || url;
      sources.push({ title: title.trim(), url, query: queries[0] });
    }
  }
  return {
    searchCalls: searchItems.length,
    searches: [...new Set(searches)],
    sources: sources.filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index),
    logs: searchItems.length > 0
      ? ['Codex Web検索を実行しました', `Codex Web検索の出典を確認しました（${sources.length}件）`]
      : []
  };
}

function requireNativeSearchEvidence(turn) {
  const evidence = extractSearchEvidence(turn);
  if (evidence.searchCalls < 1) {
    const error = new Error('Codex Web検索が実行されなかったため、結果を保存せず処理を中止しました。');
    error.code = 'native_research_required';
    throw error;
  }
  return evidence;
}

function parseStructuredText(text) {
  const trimmed = String(text || '').trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    // App Server versions have returned a short preamble around the JSON.
    // Find a balanced object while respecting braces inside JSON strings.
    for (let start = 0; start < withoutFence.length; start += 1) {
      if (withoutFence[start] !== '{') continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < withoutFence.length; index += 1) {
        const character = withoutFence[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') { quoted = true; continue; }
        if (character === '{') depth += 1;
        if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            try { return JSON.parse(withoutFence.slice(start, index + 1)); } catch { break; }
          }
        }
      }
    }
    throw new Error('Codex returned non-JSON output.');
  }
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Grade output field ${field} must be an array of non-empty strings.`);
  }
}

function validateGradeResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Grade output must be a JSON object.');
  const allowed = new Set(['grade', 'summary', 'correct', 'missing', 'misconceptions', 'nuance', 'recommendedAction', 'recommendedNodeIds', 'nextStep']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Grade output contains unsupported field ${key}.`);
  if (!['C', 'B', 'A', 'S'].includes(value.grade)) throw new Error('Grade output field grade must be one of C, B, A, or S.');
  if (typeof value.summary !== 'string' || value.summary.trim() === '') throw new Error('Grade output field summary must be a non-empty string.');
  for (const field of ['correct', 'missing', 'misconceptions', 'nuance']) validateStringArray(value[field], field);
  if (!['retry', 'deepen', 'repair', 'branch'].includes(value.recommendedAction)) throw new Error('Grade output field recommendedAction is invalid.');
  if (value.recommendedNodeIds !== undefined) {
    validateStringArray(value.recommendedNodeIds, 'recommendedNodeIds');
    if (new Set(value.recommendedNodeIds).size !== value.recommendedNodeIds.length) throw new Error('Grade output recommendedNodeIds must be unique.');
  }
  if (value.nextStep !== undefined && typeof value.nextStep !== 'string') throw new Error('Grade output field nextStep must be a string.');
  return {
    grade: value.grade,
    summary: value.summary,
    correct: value.correct,
    missing: value.missing,
    misconceptions: value.misconceptions,
    nuance: value.nuance,
    recommendedAction: value.recommendedAction,
    recommendedNodeIds: value.recommendedNodeIds || [],
    ...(value.nextStep === undefined ? {} : { nextStep: value.nextStep })
  };
}

const QUESTION_COUNT_BY_MODE = { explain: 1, short_answer: 3, true_false: 5 };

function validateChallengeMode(value, expectedMode) {
  if (!expectedMode) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Challenge output must be a JSON object.');
  if (value.mode !== expectedMode) throw new Error(`Challenge output mode must be ${expectedMode}.`);
  const expectedCount = QUESTION_COUNT_BY_MODE[expectedMode];
  if (!Array.isArray(value.questions) || value.questions.length !== expectedCount) {
    throw new Error(`Challenge output mode ${expectedMode} requires exactly ${expectedCount} question(s).`);
  }
  if (typeof value.modelAnswer !== 'string' || !value.modelAnswer.trim()) {
    throw new Error('Challenge output must include a non-empty modelAnswer.');
  }
  if (typeof value.explanation !== 'string' || !value.explanation.trim()) {
    throw new Error('Challenge output must include a non-empty explanation.');
  }
  if (value.questions.some((question) => typeof question.modelAnswer !== 'string' || !question.modelAnswer.trim())) {
    throw new Error('Every challenge question must include a non-empty modelAnswer.');
  }
  if (value.questions.some((question) => typeof question.explanation !== 'string' || !question.explanation.trim())) {
    throw new Error('Every challenge question must include a non-empty explanation.');
  }
  if (expectedMode === 'true_false' && value.questions.some((question) => !['true', 'false'].includes(String(question.modelAnswer).trim().toLowerCase()))) {
    throw new Error('True/false challenge answers must be exactly true or false.');
  }
  return value;
}

function validateProposalChallengeModes(value, expectedMode) {
  if (!expectedMode || !value?.proposals) return value;
  value.proposals.forEach((proposal) => (proposal.challenges || []).forEach((challenge) => validateChallengeMode(challenge, expectedMode)));
  return value;
}

function validateExpansionChallengeModes(value, expectedMode) {
  if (!expectedMode || !value?.challenges) return value;
  value.challenges.forEach((challenge) => validateChallengeMode(challenge, expectedMode));
  return value;
}

function stringifyInput(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    throw new Error('The grading input could not be serialized.');
  }
}

function normalizeModelCatalog(response) {
  if (!Array.isArray(response?.data)) return [];
  return response.data
    .filter((item) => item && typeof item.model === 'string' && item.model.trim() && item.hidden !== true)
    .map((item) => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id : item.model,
      model: item.model,
      displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName : item.model,
      description: typeof item.description === 'string' ? item.description : '',
      defaultReasoningEffort: typeof item.defaultReasoningEffort === 'string' ? item.defaultReasoningEffort : null,
      supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts
          .filter((option) => option && typeof option.reasoningEffort === 'string' && option.reasoningEffort.trim())
          .map((option) => ({ reasoningEffort: option.reasoningEffort, description: typeof option.description === 'string' ? option.description : '' }))
        : [],
      isDefault: item.isDefault === true
    }));
}

class CodexAppServerClient {
  constructor(options = {}) {
    this.codexPath = options.codexPath || process.env.CHALLENGE_TREE_CODEX_PATH || null;
    this.model = options.model || process.env.CHALLENGE_TREE_CODEX_MODEL || DEFAULT_MODEL;
    this.reasoningEffort = options.reasoningEffort || 'low';
    this.cwd = options.cwd || process.cwd();
    this.clientVersion = options.clientVersion || '0.1.0';
    this.onNotification = typeof options.onNotification === 'function' ? options.onNotification : () => {};
    this.stderrLines = [];
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.turnItems = new Map();
    this.turnEmitters = new Map();
    this.nextRequestId = 1;
    this.stdoutBuffer = '';
    this.child = null;
    this.startPromise = null;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.stopping = false;
    this.ready = false;
    this.status = {
      codexFound: false,
      appServerRunning: false,
      authenticated: false,
      modelAvailable: false,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      codexVersion: null,
      appServerVersion: null,
      error: null,
      stderr: []
    };
  }

  getStatus() {
    return { ...this.status, stderr: [...this.stderrLines.slice(-8)] };
  }

  appendStderr(chunk) {
    const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.stderrLines.push(...lines);
    if (this.stderrLines.length > STDERR_LIMIT) this.stderrLines.splice(0, this.stderrLines.length - STDERR_LIMIT);
    this.status.stderr = this.stderrLines.slice(-8);
  }

  setError(code, message) {
    this.status.error = { code, message: String(message).slice(0, 1000), stderr: this.stderrLines.slice(-8) };
  }

  async start() {
    if (this.ready) return this.getStatus();
    if (this.startPromise) return this.startPromise;
    if (this.child && this.status.appServerRunning) return this.getStatus();
    this.stopping = false;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startInternal() {
    const executable = findCodexExecutable(this.codexPath);
    if (!executable) {
      this.status.codexFound = false;
      this.status.appServerRunning = false;
      this.setError('codex_not_found', 'Codex CLI was not found. Install Codex or set CHALLENGE_TREE_CODEX_PATH.');
      return this.getStatus();
    }
    this.codexPath = executable;
    this.status.codexFound = true;
    this.status.error = null;
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
    if (version.status === 0) this.status.codexVersion = String(version.stdout || '').trim().split(/\r?\n/)[0] || null;

    this.child = spawn(executable, [
      'app-server', '--listen', 'stdio://',
      '--enable', 'web_search_request',
      '--config', 'web_search="live"',
      '--config', 'tools.web_search={}'
    ], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    this.status.appServerRunning = true;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.appendStderr(chunk));
    this.child.once('error', (error) => this.handleChildExit(error));
    this.child.once('close', (code, signal) => this.handleChildExit(new Error(`Codex App Server exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`)));

    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'challenge-tree', title: 'Challenge Tree', version: this.clientVersion },
        capabilities: { experimentalApi: true, requestAttestation: false }
      });
      this.status.appServerVersion = initialized?.userAgent || null;
      this.notify('initialized');

      const auth = await this.request('getAuthStatus', { includeToken: false, refreshToken: false });
      this.status.authenticated = Boolean(auth?.authMethod);

      const models = await this.requestModelCatalog();
      const found = models.find((item) => item.model === this.model);
      this.status.modelAvailable = Boolean(found);
      if (!found) {
        this.setError('model_unavailable', `Requested model ${this.model} is not available in the Codex model catalog.`);
        this.ready = false;
        return this.getStatus();
      }
      this.status.model = found.model;
      this.reasoningEffort = this.resolveReasoningEffort(found, this.reasoningEffort);
      this.status.reasoningEffort = this.reasoningEffort;
      this.ready = true;
      this.restartAttempts = 0;
      this.status.error = null;
      return this.getStatus();
    } catch (error) {
      this.ready = false;
      this.setError(error.code || 'app_server_protocol_error', safeErrorMessage(error));
      return this.getStatus();
    }
  }

  async requestModelCatalog() {
    return normalizeModelCatalog(await this.request('model/list', { limit: 100, includeHidden: false }));
  }

  async listModels() {
    const status = await this.start();
    if (!this.child || !status.appServerRunning || !status.authenticated) {
      const error = new Error(status.error?.message || 'Codex App Server is not ready.');
      error.code = status.error?.code || 'app_server_not_ready';
      throw error;
    }
    return this.requestModelCatalog();
  }

  resolveReasoningEffort(model, requested) {
    const supported = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    if (requested && supported.includes(requested)) return requested;
    if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
    return supported[0] || 'low';
  }

  async setModel(model, reasoningEffort) {
    if (typeof model !== 'string' || !model.trim() || model.length > 200) {
      const error = new Error('A valid model name is required.');
      error.code = 'invalid_model';
      throw error;
    }

    const status = await this.start();
    if (!this.child || !status.appServerRunning || !status.authenticated) {
      const error = new Error(status.error?.message || 'Codex App Server is not ready.');
      error.code = status.error?.code || 'app_server_not_ready';
      throw error;
    }

    const requestedModel = model.trim();
    const found = (await this.requestModelCatalog()).find((item) => item.model === requestedModel);
    if (!found) {
      const error = new Error(`Requested model ${requestedModel} is not available in the Codex model catalog.`);
      error.code = 'model_unavailable';
      throw error;
    }

    if (reasoningEffort !== undefined) {
      if (typeof reasoningEffort !== 'string' || !reasoningEffort.trim() || !found.supportedReasoningEfforts.some((option) => option.reasoningEffort === reasoningEffort.trim())) {
        const error = new Error(`Reasoning effort ${String(reasoningEffort)} is not available for model ${requestedModel}.`);
        error.code = 'reasoning_effort_unavailable';
        throw error;
      }
      this.reasoningEffort = reasoningEffort.trim();
    } else {
      this.reasoningEffort = this.resolveReasoningEffort(found, this.reasoningEffort);
    }

    this.model = found.model;
    this.status.model = found.model;
    this.status.reasoningEffort = this.reasoningEffort;
    this.status.modelAvailable = true;
    this.status.error = null;
    this.ready = true;
    return this.getStatus();
  }

  handleStdout(chunk) {
    const parsed = parseJsonlChunk(this.stdoutBuffer, chunk);
    this.stdoutBuffer = parsed.buffer;
    if (parsed.malformed) this.appendStderr(`Ignored ${parsed.malformed} malformed JSONL response line(s).`);
    for (const message of parsed.messages) this.handleMessage(message);
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'Codex App Server returned an error.');
        error.code = 'app_server_request_error';
        error.data = message.error;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      this.rememberTurnItem(message);
    }
    if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      const turnId = turn?.id;
      if (turnId && this.turnWaiters.has(turnId)) {
        const waiter = this.turnWaiters.get(turnId);
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timer);
        waiter.resolve(this.finalizeTurn(turn));
      } else if (turnId) {
        this.completedTurns.set(turnId, this.finalizeTurn(turn));
      }
    }
    if (message.method && message.id !== undefined) {
      this.onNotification({ method: message.method, params: message.params, request: true });
      this.respondToServerRequest(message);
      return;
    }
    if (message.method) {
      try { this.onNotification({ method: message.method, params: message.params }); } catch { /* Diagnostics must not interrupt the protocol reader. */ }
    }
  }

  rememberTurnItem(message) {
    const turnId = message.params?.turnId;
    const item = message.params?.item;
    if (!turnId || !item || typeof item !== 'object') return;
    const itemId = String(item.id || `${item.type || 'item'}:${this.turnItems.size}`);
    let items = this.turnItems.get(turnId);
    if (!items) {
      items = new Map();
      this.turnItems.set(turnId, items);
    }
    items.set(itemId, item);
    if (message.method !== 'item/completed' || !isWebSearchItem(item)) return;
    const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : item.action?.query;
    const emit = this.turnEmitters.get(turnId);
    if (typeof emit !== 'function') return;
    emit('progress', { message: query ? `Codex Web検索: ${query}` : 'Codex Web検索を実行中' });
  }

  finalizeTurn(turn) {
    if (!turn || typeof turn !== 'object' || !turn.id) return turn;
    const recorded = this.turnItems.get(turn.id);
    this.turnItems.delete(turn.id);
    this.turnEmitters.delete(turn.id);
    if (!recorded || recorded.size === 0) return turn;
    const existing = Array.isArray(turn.items) ? turn.items : [];
    const byId = new Map(existing.map((item) => [String(item?.id || ''), item]));
    for (const [id, item] of recorded) if (!byId.has(id)) byId.set(id, item);
    return { ...turn, items: [...byId.values()] };
  }

  respondToServerRequest(message) {
    const denial = {
      id: message.id,
      error: { code: -32001, message: 'Challenge Tree does not grant interactive approvals or server-initiated actions.' }
    };
    this.write(denial);
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server stdin is not writable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = new Error(`Timed out waiting for ${method}.`);
        error.code = 'app_server_timeout';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  handleChildExit(error) {
    if (!this.child) return;
    this.status.appServerRunning = false;
    this.ready = false;
    if (this.status.error === null) this.setError('app_server_stopped', safeErrorMessage(error, 'Codex App Server stopped unexpectedly.'));
    const pendingError = new Error(this.status.error?.message || 'Codex App Server stopped unexpectedly.');
    pendingError.code = 'app_server_stopped';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pendingError);
    }
    this.pending.clear();
    this.child = null;
    if (!this.stopping && this.restartAttempts < RESTART_LIMIT) {
      this.restartAttempts += 1;
      this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.start(); }, Math.min(1000 * this.restartAttempts, 5000));
      this.restartTimer.unref?.();
    }
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server stopped.'));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Codex App Server stopped.'));
    }
    this.turnWaiters.clear();
    this.completedTurns.clear();
    const child = this.child;
    this.child = null;
    if (!child) {
      this.status.appServerRunning = false;
      return;
    }
    child.stdin?.end();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once('close', finish);
      setTimeout(() => { if (!settled) { child.kill(); finish(); } }, 2000).unref?.();
    });
    this.status.appServerRunning = false;
  }

  async runOperation(operation, input, options = {}) {
    if (operation === 'ANSWER_GRADE') return this.runAnswerGrade(input, options);
    if (operation === 'TREE_PROPOSE') return this.runTreePropose(input, options);
    if (operation === 'NODE_EXPAND') return this.runNodeExpand(input, options);
    if (operation === 'NODE_CREATE') return this.runNodeCreate(input, options);
    if (operation === 'CHALLENGE_CREATE') return this.runChallengeCreate(input, options);
    throw new Error(`Unsupported Challenge Tree operation: ${operation}`);
  }

  async runStructuredOperation(operation, input, schema, instructions, validate = (value) => value, options = {}) {
    options.emit?.('progress', { message: `${operation}: Codexへ依頼中` });
    const status = await this.start();
    if (!this.ready) throw new Error(status.error?.message || 'Codex App Server is not ready.');
    const threadResponse = await this.request('thread/start', {
      model: this.model, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      config: { web_search: 'live', tools: { web_search: true } },
      experimentalRawEvents: true,
      baseInstructions: 'Return only strict JSON matching the requested schema. When the supplied context is insufficient for a factual or current claim, you MUST use authoritative web search before deciding whenever network access is available. Do not use shell commands or modify files. Include only claims supported by the supplied context or verified sources, and clearly mark anything that remains unverified.'
    });
    const threadId = threadResponse?.thread?.id;
    if (!threadId) throw new Error('Codex App Server did not return a thread id.');
    const prompt = [instructions, 'Before producing the JSON, you MUST use Codex Web Search at least once for this operation. Search for the exact learning topic and verify the key factual claims against authoritative sources. Do not treat a URL in the input as evidence unless the Web Search tool has actually returned it. The operation is invalid if no Web Search call is completed. Record only sources returned by the Web Search tool; never fabricate citations. If verification remains impossible, state that explicitly in the relevant description or guidance. For every generated node include archived:false. For every generated resource include a locator object (use kind:other and a short value when there is no specific locator) and a verifiedAt ISO timestamp. Resource type must be one of primary_paper, official_docs, government, university, textbook, course, technical_docs, article, video, community, other. authorityTier must be exactly A, B, C, or D; use A for primary or official sources.', 'Return exactly one JSON object matching the output schema only after the Web Search call is complete.', `INPUT:\n${stringifyInput(input)}`].join('\n\n');
    const parse = (turn) => {
      try {
        const research = requireNativeSearchEvidence(turn);
        return { data: validate(parseStructuredText(extractAgentText(turn))), research };
      }
      catch (error) { if (!error.code) error.code = 'invalid_output'; throw error; }
    };
    try {
      options.emit?.('progress', { message: `${operation}: 回答を確認中` });
      const result = parse(await this.startTurn(threadId, prompt, schema, options));
      options.emit?.('progress', { message: `${operation}: 検索結果を確認しました（${result.research.sources.length}件）` });
      return result;
    } catch (firstError) {
      if (firstError?.code !== 'invalid_output' && firstError?.code !== 'native_research_required') throw firstError;
      options.emit?.('progress', { message: firstError?.code === 'native_research_required' ? `${operation}: Codex Web検索を確認できないため再試行中` : `${operation}: 形式を整えて再確認中` });
      const repair = [
        `The previous ${operation} response was invalid.`,
        `Validation issue: ${safeErrorMessage(firstError)}`,
        'Use the Codex Web Search tool now. A completed native Web Search call with returned sources is mandatory before the corrected JSON can be accepted.',
        'Return only a corrected JSON object matching the exact schema. Keep all required fields and do not add explanations.',
        `INPUT:\n${stringifyInput(input)}`
      ].join('\n\n');
      try {
        const result = parse(await this.startTurn(threadId, repair, schema, options));
        options.emit?.('progress', { message: `${operation}: 検索結果を確認しました（${result.research.sources.length}件）` });
        return result;
      } catch (secondError) {
        if (secondError?.code === 'native_research_required') throw secondError;
        if (secondError?.code !== 'invalid_output') throw secondError;
        const error = new Error(`Codex returned invalid ${operation} output after one repair turn: ${safeErrorMessage(secondError)}`);
        error.code = 'invalid_output';
        throw error;
      }
    }
  }

  async runTreePropose(input, options = {}) {
    const schema = {
      type: 'object', additionalProperties: false, required: ['proposals'],
      properties: { proposals: { type: 'array', minItems: 3, maxItems: 3, items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'philosophy', 'learnerProfile', 'branches', 'advantages', 'tradeoffs', 'root', 'initialNodes', 'initialEdges', 'resources', 'challenges'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, philosophy: { type: 'string' }, learnerProfile: { type: 'string' },
          branches: { type: 'array', items: { type: 'string' } }, advantages: { type: 'array', items: { type: 'string' } }, tradeoffs: { type: 'string' },
          root: NODE_OUTPUT_SCHEMA, initialNodes: { type: 'array', minItems: 1, maxItems: 1, items: NODE_OUTPUT_SCHEMA },
          initialEdges: { type: 'array', maxItems: 0, items: EDGE_OUTPUT_SCHEMA }, resources: { type: 'array', maxItems: 8, items: RESOURCE_OUTPUT_SCHEMA },
          challenges: { type: 'array', maxItems: 1, items: CHALLENGE_OUTPUT_SCHEMA }
        }
      } } }
    };
    return this.runStructuredOperation('TREE_PROPOSE', input, schema,
      'Create three distinct learning-tree proposals for the exact topic and learning goal in INPUT. The goal is the primary boundary: every root title, branch description, resource, and starter challenge must directly help the learner achieve that goal. By default, interpret the request as knowledge and conceptual learning. Prioritize definitions, mechanisms, models, classifications, evidence, decision criteria, interpretation, and concrete applications that can be tested. Do not drift into institutional systems, regulations, professional etiquette, mindset, career advice, generic orientation, or motivational content unless the learning goal explicitly asks for those things. For a broad role-based topic such as what a resident physician should learn, focus on clinical knowledge and reasoning rather than how residency works or what attitude to have. Do not drift into adjacent trivia, broad background, biography, entertainment, or unrelated subtopics. Each proposal must start with exactly one unlocked root node and one optional starter challenge. Do not create child nodes or edges yet; they will be generated after the learner answers and the tree expands. Use stable ISO-8601 timestamps and valid Challenge Tree fields. Keep the starter challenge focused on one central, knowledge-based capability of the root and make it answerable from the supplied root resources. Every generated challenge and every question object inside it must include a concise, non-empty modelAnswer and a useful, non-empty explanation. The explanation should teach the key reason, mechanism, or distinction without becoming an essay. Every challenge must use the requested challengeMode: explain has exactly one free-form prompt; short_answer has exactly three independent questions answerable with one word, a short phrase, or at most one short sentence each; true_false has exactly five clear true/false statements. In short_answer mode, never ask the learner to explain, discuss, compare, analyze, or justify.',
      (value) => validateProposalChallengeModes(value, input.challengeMode), options);
  }

  async runNodeExpand(input, options = {}) {
    const branchCount = Math.max(1, Math.min(10, Number(input.branchCount) || 3));
    const schema = {
      type: 'object', additionalProperties: false, required: ['nodes', 'edges', 'resources', 'challenges'],
      properties: {
        nodes: { type: 'array', minItems: branchCount, maxItems: branchCount, items: NODE_OUTPUT_SCHEMA },
        edges: { type: 'array', minItems: branchCount, maxItems: branchCount, items: EDGE_OUTPUT_SCHEMA },
        resources: { type: 'array', maxItems: 8, items: RESOURCE_OUTPUT_SCHEMA },
        challenges: { type: 'array', minItems: branchCount, maxItems: branchCount, items: CHALLENGE_OUTPUT_SCHEMA }
      }
    };
    return this.runStructuredOperation('NODE_EXPAND', input, schema,
      'Expand the exact answered node into exactly INPUT.branchCount distinct useful next-learning child nodes. The project topic, goal, and curriculumContext are hard constraints. Use the learner answer and recentAttempts to identify what should come next; do not invent unrelated branches. By default, every child must be a knowledge or conceptual learning unit: a definition, mechanism, classification, model, evidence-based criterion, interpretation skill, or concrete application. Avoid institutional systems, regulations, professional etiquette, mindset, career advice, generic orientation, and motivational themes unless explicitly required by the goal. The curriculumContext is a consistency guide, not a reason to repeat its branches verbatim. Every child must be a coherent, testable concept directly required for, or a clear next step toward, the project goal. Prefer the smallest useful concept over a broad subject label. The children must be distinct and each must have the current node as a prerequisite. Add one focused challenge per child using the requested challengeMode. Every generated challenge and question must include a concise non-empty modelAnswer and useful non-empty explanation. In short_answer mode, never use explain, discuss, compare, analyze, or justify wording. Return exactly INPUT.branchCount nodes, edges, and challenges. Never return existing node IDs. Use only exact internal enum values in the schema; never use UI labels.',
      (value) => validateExpansionChallengeModes(value, input.challengeMode), options);
  }

  async runNodeCreate(input, options = {}) {
    const schema = {
      type: 'object', additionalProperties: false, required: ['node', 'resources', 'challenges'], properties: {
        node: NODE_CREATE_NODE_SCHEMA, resources: { type: 'array', maxItems: 8, items: RESOURCE_OUTPUT_SCHEMA },
        challenges: { type: 'array', minItems: 1, maxItems: 1, items: CHALLENGE_OUTPUT_SCHEMA }
      }
    };
    return this.runStructuredOperation('NODE_CREATE', input, schema,
      'Create exactly one isolated learning node for INPUT.title. Return node with exactly the four fields id, title, description, and goal; do not add status, xp, masteryState, prerequisites, children, resourceIds, challengeIds, position, timestamps, or archived because the app supplies those fields. It must fit the exact project topic, goal, and curriculumContext, but must not be a child of or prerequisite for another node. It should be a focused, knowledge-based concept that can later be expanded from the learner answer. Return one answerable challenge for this node using the requested challengeMode, with concise model answers and useful explanations. Do not drift into generic orientation or unrelated themes. Add a locator plus verifiedAt for every resource.',
      (value) => validateChallengeMode(value.challenges?.[0], input.challengeMode) && value, options);
  }

  async runChallengeCreate(input, options = {}) {
    const schema = CHALLENGE_OUTPUT_SCHEMA;
    return this.runStructuredOperation('CHALLENGE_CREATE', input, schema,
      'Create one answerable challenge for the exact supplied node, topic, learning goal, and curriculumContext. The curriculumContext is consistency guidance, not a reason to repeat unrelated branches. The node objective is the boundary: test only that knowledge or concept and do not turn it into a broad essay about the surrounding field. Use only supplied resource IDs. The requested challengeMode is strict. Explain mode has exactly one focused free-form prompt. short_answer has exactly three independent, lightweight questions; each must ask for one term, one value, one choice, or one short sentence and must be answerable in roughly 1–20 words. Do not ask for an explanation, discussion, comparison, analysis, justification, multi-step reasoning, or several facts in one question. true_false has exactly five unambiguous statements and each modelAnswer must be exactly true or false. Always provide a concise, non-empty modelAnswer and a useful, non-empty explanation for the challenge and for every question object, because the learner may view them before answering. Keep model answers concise in short_answer mode and make the rubric concrete enough for grading without requiring essay-level detail. Unless the node objective explicitly concerns policy, conduct, or professional development, do not create questions about institutions, rules, attitude, career, or motivation.',
      (value) => validateChallengeMode(value, input.challengeMode), options);
  }

  async runAnswerGrade(input, options = {}) {
    options.emit?.('progress', { message: 'ANSWER_GRADE: 回答を分析中' });
    const status = await this.start();
    if (!this.ready) throw new Error(status.error?.message || 'Codex App Server is not ready.');
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['grade', 'summary', 'correct', 'missing', 'misconceptions', 'nuance', 'recommendedAction', 'recommendedNodeIds', 'nextStep'],
      properties: {
        grade: { type: 'string', enum: ['C', 'B', 'A', 'S'] },
        summary: { type: 'string' },
        correct: { type: 'array', items: { type: 'string' } },
        missing: { type: 'array', items: { type: 'string' } },
        misconceptions: { type: 'array', items: { type: 'string' } },
        nuance: { type: 'array', items: { type: 'string' } },
        recommendedAction: { type: 'string', enum: ['retry', 'deepen', 'repair', 'branch'] },
        recommendedNodeIds: { type: 'array', items: { type: 'string' } },
        nextStep: { type: 'string' }
      }
    };
    const threadResponse = await this.request('thread/start', {
      model: this.model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: { web_search: 'live', tools: { web_search: true } },
      experimentalRawEvents: true,
      baseInstructions: 'Return the requested Challenge Tree grading object as strict JSON only. If the supplied challenge, rubric, or sources do not establish a factual point, you MUST use authoritative web search before grading whenever network access is available. Do not use shell commands or modify files. Clearly distinguish verified facts from uncertain points.'
    });
    const threadId = threadResponse?.thread?.id;
    if (!threadId) throw new Error('Codex App Server did not return a thread id.');
    const instruction = [
      'Grade the learner answer using the supplied challenge, node context, resources, and recent attempts. Compare the answer against the challenge modelAnswer, question modelAnswers, and the essential rubric criteria. If the challenge includes questions, grade each submitted answer against its corresponding question; for short_answer, judge only the requested term, fact, value, or short sentence and never require an explanation, causal reasoning, extra context, or essay-level detail; for true_false, accept only a clear true/false choice and do not require an explanation.',
      'Use a generous educational standard: do not penalize wording, terminology variants, brevity, or minor omissions when the central idea and causal relationship are correct. Grade S when the learner satisfies the same essential conditions as the modelAnswer and all required rubric points are met; grade A when at least half of the essential content is correct but S-level completeness is not reached; grade B when some relevant content is correct but less than half of the essential content is demonstrated; grade C for an empty, entirely incorrect, irrelevant, or unsupported answer. Do not infer a claim the answer does not make. List concrete strengths and improvements, but do not invent deficiencies. Choose retry for a missing core, deepen for a basically correct answer needing nuance, repair for a misconception, and branch only when a new direction is justified.',
      'Before grading, you MUST use Codex Web Search at least once. Search authoritative sources for any factual point needed to grade the answer. If a point remains unverifiable, explicitly state 「現状の資料では確認できない」 in nuance or nextStep and do not guess or penalize the learner for that point.',
      'Return exactly one JSON object matching the output schema only after the Web Search call is complete. Use concise, learner-facing Japanese when the challenge is Japanese.',
      'Every list item must be a non-empty string. recommendedNodeIds may be an empty array when no recommendation is justified.',
      `INPUT:\n${stringifyInput(input)}`
    ].join('\n\n');
    const parseGrade = (turn) => {
      const research = requireNativeSearchEvidence(turn);
      return { data: validateGradeResponse(parseStructuredText(extractAgentText(turn))), research };
    };
    let first;
    try {
      first = parseGrade(await this.startTurn(threadId, instruction, schema, options));
    } catch (firstError) {
      options.emit?.('progress', { message: firstError?.code === 'native_research_required' ? 'ANSWER_GRADE: Codex Web検索を確認できないため再試行中' : 'ANSWER_GRADE: 結果の形式を修復中' });
      const repairInstruction = [
        'Your previous grading response did not satisfy the required JSON contract.',
        `Validation issue: ${safeErrorMessage(firstError)}`,
        'Use the Codex Web Search tool now. A completed native Web Search call with returned sources is mandatory before the corrected JSON can be accepted.',
        'Return only a corrected JSON object matching the exact output schema. Do not add markdown or explanations.',
        `INPUT:\n${stringifyInput(input)}`
      ].join('\n\n');
      try {
        const repaired = parseGrade(await this.startTurn(threadId, repairInstruction, schema, options));
        options.emit?.('progress', { message: `ANSWER_GRADE: 検索結果を確認しました（${repaired.research.sources.length}件）` });
        return repaired;
      } catch (secondError) {
        const error = new Error(secondError?.code === 'native_research_required'
          ? 'Codex Web検索が実行されなかったため、採点結果を保存せず処理を中止しました。'
          : `Codex returned invalid ANSWER_GRADE output after one repair turn: ${safeErrorMessage(secondError)}`);
        error.code = secondError?.code === 'native_research_required' ? 'native_research_required' : 'invalid_output';
        throw error;
      }
    }
    try {
      options.emit?.('progress', { message: 'ANSWER_GRADE: 採点結果を整理中' });
      options.emit?.('progress', { message: `ANSWER_GRADE: 検索結果を確認しました（${first.research.sources.length}件）` });
      return first;
    } catch (error) {
      throw error;
    }
  }

  async startTurn(threadId, text, outputSchema, options = {}) {
    const response = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      model: this.model,
      effort: this.reasoningEffort,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      outputSchema
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const turn = response?.turn;
    if (turn?.status === 'failed') throw new Error(turn.error?.message || 'Codex turn failed.');
    if (!turn) throw new Error('Codex App Server did not return a turn.');
    this.turnEmitters.set(turn.id, options.emit);
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') return this.finalizeTurn(turn);
    const completed = await this.waitForTurn(threadId, turn.id, options.timeoutMs || DEFAULT_TIMEOUT_MS, options.signal);
    if (completed?.status === 'failed') throw new Error(completed.error?.message || 'Codex turn failed.');
    return completed;
  }

  waitForTurn(threadId, turnId, timeoutMs, signal) {
    const alreadyCompleted = this.completedTurns.get(turnId);
    if (alreadyCompleted) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(alreadyCompleted);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        this.turnWaiters.delete(turnId);
        void this.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {});
        const error = new Error('Codex turn was cancelled.');
        error.name = 'AbortError';
        finish(null, error);
      };
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        this.turnWaiters.delete(turnId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        const error = new Error('Timed out waiting for turn/completed.');
        error.code = 'app_server_timeout';
        finish(null, error);
      }, timeoutMs);
      timer.unref?.();
      this.turnWaiters.set(turnId, { resolve: (value) => finish(value), reject: (error) => finish(null, error), timer });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

module.exports = {
  DEFAULT_MODEL,
  CodexAppServerClient,
  findCodexExecutable,
  parseJsonlChunk,
  parseStructuredText,
  extractSearchEvidence,
  requireNativeSearchEvidence,
  safeErrorMessage,
  validateGradeResponse
};
