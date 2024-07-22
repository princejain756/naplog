# Naplog

Let the logs wait.

Paste a batch of log lines and get a short morning brief back from a language
model running on this machine through [Ollama](https://ollama.com). Nothing is
sent to a cloud provider.

## Requirements

- Node.js 22 or newer
- [Ollama](https://ollama.com) running on this machine
- The `gemma3:4b` model pulled locally:

  ```sh
  ollama pull gemma3:4b
  ```

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
lock. The suite does not require the model.

## Configuration

Model tag, endpoint, timeouts, input limits, prompt and the JSON schema the
model must answer with all live in `contract.json`. Both the request and the
validator read from it, so the two cannot drift apart.

## What it does

- Numbered nonblank lines are sent to `gemma3:4b` with a fixed prompt and
  JSON schema (`contract.json`).
- The model returns at most five incidents; each must cite input line
  numbers, and every cited number is checked against the batch that was sent.
- Common credential shapes (`password=`, `token=`, `api_key=`, `secret=`,
  `Bearer` values) are replaced with `[REDACTED]` before the text is sent.
- Only one digest runs at a time; concurrent requests get HTTP 429.
- Successful digests are cached in memory (8 entries, keyed by content hash)
  until the process restarts. Clearing the UI does not clear the cache.

## License

MIT. See [LICENSE](LICENSE).
