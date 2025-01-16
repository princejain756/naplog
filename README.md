# Naplog

![A server asleep under a blanket of log lines](assets/cover.png)

Let the logs wait.

Naplog turns a pasted batch of log lines into a short morning brief using a
local language model through [Ollama](https://ollama.com). Every issue in the
brief links back to the numbered lines it came from, so you can check the
evidence before acting. Built for Hacktoberfest 2026, Week 3.

No cloud inference, no accounts, no scheduled jobs. The pasted text never
leaves this machine and is held only in memory for the lifetime of the
process.

## Requirements

- Node.js 22 or newer (uses only the standard library)
- [Ollama](https://ollama.com) running on this machine
- The `gemma3:4b` model pulled locally:

  ```sh
  ollama pull gemma3:4b
  ```

Initial model download needs internet access. After that, inference runs
entirely offline.

## Run

```sh
npm start
```

Then open <http://127.0.0.1:3217>. The app listens on loopback only.

## Test

```sh
npm test
```

Checks cover input preparation, schema validation, the Ollama request
contract (via a stubbed fetch), the HTTP surface, and the single-inference
lock (via a real loopback server on an ephemeral port and an injected
digest). The suite does not require the model.

Model output quality is verified separately by hand. On the bundled
16-line synthetic sample, `gemma3:4b` returned 5 incidents in about 128
seconds on an M1 Max; every cited line number existed and the sample's
demo token was masked before reaching the model. Results on real logs
still need the same eyeball check the UI asks for.

## What it does

- Numbered nonblank lines are sent to `gemma3:4b` with a fixed prompt and
  JSON schema (`contract.json`).
- The model returns at most five incidents; each must cite input line
  numbers. Evidence is shown next to each incident and expands to the actual
  source lines.
- Successful digests are cached in memory (8 entries, keyed by content hash)
  until the process restarts. Clearing the UI does not clear the cache.
- Common credential shapes (`password=`, `token=`, `api_key=`, `secret=`,
  `Bearer` values) are replaced with `[REDACTED]` before the text is sent to
  the model.

## Limits and honesty notes

- Input is limited to 120 nonblank lines and 64 KiB of UTF-8.
- Masking is best-effort pattern matching, not complete anonymization.
  Unusual key names and free-form secrets pass through.