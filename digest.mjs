import { createHash } from 'node:crypto';
import contract from './contract.json' with { type: 'json' };

const MAX_RESPONSE_BYTES = 64 * 1024;

// Best-effort masking of common credential shapes only. This is not complete
// anonymization: uncommon key names, free-form secrets and partial tokens all
// pass through untouched.
const KEY_VALUE_SECRET =
  /\b(password|token|api_key|apikey|secret)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function maskLine(text) {
  return text
    .replace(KEY_VALUE_SECRET, (_m, key) => `${key}=[REDACTED]`)
    .replace(BEARER_SECRET, 'Bearer [REDACTED]');
}

export class DigestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DigestError';
    this.code = code;
  }
}

export function prepareLines(text) {
  if (typeof text !== 'string') {
    throw new DigestError('bad_input', 'Input must be a string of log text.');
  }
  if (text.trim().length === 0) {
    throw new DigestError('bad_input', 'Input is empty.');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > contract.maxInputBytes) {
    throw new DigestError(
      'bad_input',
      `Input is ${bytes} bytes, over the ${contract.maxInputBytes} byte limit.`,
    );
  }
  const lines = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const trimmed = raw[i].trim();
    if (trimmed.length === 0) continue;
    lines.push({ id: i + 1, text: maskLine(trimmed) });
  }
  if (lines.length > contract.maxLines) {
    throw new DigestError(
      'bad_input',
      `Input has ${lines.length} nonempty lines, over the ${contract.maxLines} line limit.`,
    );
  }
  return lines;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExactKeys(obj, keys, where) {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  for (const key of expected) {
    if (!Object.hasOwn(obj, key)) {
      throw new DigestError('invalid_model_output', `${where} is missing required key "${key}".`);
    }
  }
  for (const key of actual) {
    if (!expected.includes(key)) {
      // static wording: key names come from untrusted model output and must
      // not leak into error text
      throw new DigestError('invalid_model_output', `${where} has an unexpected key.`);
    }
  }
}

function checkString(value, name, maxLength, where) {
  if (typeof value !== 'string') {
    throw new DigestError('invalid_model_output', `${where}.${name} must be a string.`);
  }
  if (value.trim().length === 0) {
    throw new DigestError('invalid_model_output', `${where}.${name} must not be empty.`);
  }
  if (value.length > maxLength) {
    throw new DigestError(
      'invalid_model_output',
      `${where}.${name} is ${value.length} characters, over the ${maxLength} limit.`,
    );
  }
}

export function validateDigest(value, allowedLineIds) {
  const allowed = allowedLineIds instanceof Set ? allowedLineIds : new Set(allowedLineIds);
  if (!isPlainObject(value)) {
    throw new DigestError('invalid_model_output', 'Digest must be a plain object.');
  }
  requireExactKeys(value, ['incidents'], 'digest');
  const { incidents } = value;
  if (!Array.isArray(incidents)) {
    throw new DigestError('invalid_model_output', 'digest.incidents must be an array.');
  }
  if (incidents.length > 5) {
    throw new DigestError(
      'invalid_model_output',
      `digest.incidents has ${incidents.length} items, over the 5 incident limit.`,
    );
  }
  incidents.forEach((incident, index) => {
    const where = `incidents[${index}]`;
    if (!isPlainObject(incident)) {
      throw new DigestError('invalid_model_output', `${where} must be a plain object.`);
    }
    requireExactKeys(incident, ['title', 'observation', 'nextCheck', 'evidence'], where);
    checkString(incident.title, 'title', 100, where);
    checkString(incident.observation, 'observation', 400, where);
    checkString(incident.nextCheck, 'nextCheck', 250, where);
    const { evidence } = incident;
    if (!Array.isArray(evidence)) {
      throw new DigestError('invalid_model_output', `${where}.evidence must be an array.`);
    }
    if (evidence.length < 1 || evidence.length > 120) {
      throw new DigestError(
        'invalid_model_output',
        `${where}.evidence must have 1 to 120 items.`,
      );
    }
    const seen = new Set();
    for (const id of evidence) {
      if (!Number.isInteger(id) || id < 1) {
        throw new DigestError(
          'invalid_model_output',
          `${where}.evidence contains a line id that is not a positive integer.`,
        );
      }
      if (seen.has(id)) {
        throw new DigestError(
          'invalid_model_output',
          `${where}.evidence repeats a line id.`,
        );
      }
      seen.add(id);
      if (!allowed.has(id)) {
        throw new DigestError(
          'invalid_model_output',
          `${where}.evidence cites a line that is not in the input.`,
        );
      }
    }
  });
  return value;
}

async function readBoundedBody(res, limit) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // cancellation is best-effort
        }
        throw new DigestError(
          'invalid_model_output',
          `Model response exceeded the ${limit} byte limit.`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new DigestError(
      'invalid_model_output',
      `Model response exceeded the ${limit} byte limit.`,
    );
  }
  return text;
}

// Validated responses only, keyed by content hash. Never holds failures.
// Bounded by contract.cacheEntries; entries live until process restart.
const cache = new Map();

function cacheKey(lines) {
  return createHash('sha256')
    .update(contract.model)
    .update('\n')
    .update(JSON.stringify(lines))
    .update('\n')
    .update(contract.systemPrompt)
    .digest('hex');
}

function cacheStore(key, result) {
  if (cache.size >= contract.cacheEntries) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, structuredClone(result));
}

export async function digestLogs(text, { fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const lines = prepareLines(text);
  const key = cacheKey(lines);
  const hit = cache.get(key);
  if (hit !== undefined) {
    const copy = structuredClone(hit);
    copy.cached = true;
    copy.elapsedMs = Date.now() - started;
    return copy;
  }

  const numbered = lines.map((line) => `${line.id}: ${line.text}`).join('\n');
  const messages = [
    { role: 'system', content: contract.systemPrompt },
    { role: 'user', content: contract.userPrefix + numbered + contract.userSuffix },
  ];
  const body = JSON.stringify({
    model: contract.model,
    messages,
    format: contract.schema,
    stream: false,
    options: contract.options,
  });

  let res;
  try {
    res = await fetchImpl(contract.ollamaUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(contract.timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new DigestError(
        'timeout',
        `Model request timed out after ${contract.timeoutMs}ms.`,
      );
    }
    throw new DigestError('ollama_unreachable', 'Could not reach the local Ollama server.');
  }

  if (!res.ok) {
    throw new DigestError(
      'upstream_http',
      `Model server returned HTTP ${res.status}.`,
      );
  }

  let raw;
  try {
    raw = await readBoundedBody(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof DigestError) throw err;
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new DigestError(
        'timeout',
        `Model request timed out after ${contract.timeoutMs}ms.`,
      );
    }
    throw new DigestError('invalid_model_output', 'Could not read the model response.');
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new DigestError('invalid_model_output', 'Model response was not valid JSON.');
  }
  if (!isPlainObject(envelope) || envelope.done !== true) {
    throw new DigestError('invalid_model_output', 'Model generation did not complete.');
  }
  const content = envelope.message && envelope.message.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new DigestError('invalid_model_output', 'Model response is missing message content.');
  }
  let digest;
  try {
    digest = JSON.parse(content);
  } catch {
    throw new DigestError('invalid_model_output', 'Model message content was not valid JSON.');
  }
  const allowedIds = new Set(lines.map((line) => line.id));
  validateDigest(digest, allowedIds);

  const result = {
    incidents: digest.incidents,
    lines,
    model: contract.model,
    cached: false,
    elapsedMs: Date.now() - started,
  };
  cacheStore(key, result);
  return structuredClone(result);
}
