# Naplog

Let the logs wait.

Paste a batch of log lines and get a short morning brief back from a language
model running on this machine through [Ollama](https://ollama.com). Nothing is
sent to a cloud provider.

## Requirements

- Node.js 22 or newer
- [Ollama](https://ollama.com) running locally, with the `gemma3:4b` model
  pulled: `ollama pull gemma3:4b`

## Run

```sh
npm start
```

Then open <http://127.0.0.1:3217>. The server binds to loopback only.

## Test

```sh
npm test
```

The suite stubs the Ollama call, so the model does not need to be running.

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
- Successful digests are cached in memory (8 entries, keyed by content hash)
  until the process restarts. Clearing the UI does not clear the cache.

## License

MIT. See [LICENSE](LICENSE).
