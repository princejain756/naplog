import contract from './contract.json' with { type: 'json' };

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
    lines.push({ id: i + 1, text: trimmed });
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
  for (const key of keys) {
    if (!Object.hasOwn(obj, key)) {
      throw new DigestError('invalid_model_output', `${where} is missing required key "${key}".`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
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
        throw new DigestError('invalid_model_output', `${where}.evidence repeats a line id.`);
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

export async function digestLogs(text, { fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const lines = prepareLines(text);
  const numbered = lines.map((line) => `${line.id}: ${line.text}`).join('\n');

  let res;
  try {
    res = await fetchImpl(contract.ollamaUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: contract.model,
        messages: [
          { role: 'system', content: contract.systemPrompt },
          { role: 'user', content: contract.userPrefix + numbered + contract.userSuffix },
        ],
        format: contract.schema,
        stream: false,
        options: contract.options,
      }),
      signal: AbortSignal.timeout(contract.timeoutMs),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new DigestError('timeout', `Model request timed out after ${contract.timeoutMs}ms.`);
    }
    throw new DigestError('ollama_unreachable', 'Could not reach the local Ollama server.');
  }

  if (!res.ok) {
    throw new DigestError('upstream_http', `Model server returned HTTP ${res.status}.`);
  }

  let envelope;
  try {
    envelope = await res.json();
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

  return {
    incidents: digest.incidents,
    lines,
    model: contract.model,
    elapsedMs: Date.now() - started,
  };
}