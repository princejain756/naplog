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

## License

MIT. See [LICENSE](LICENSE).