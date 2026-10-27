# Simple Autocomplete

A VS Code inline code completion extension for chat APIs (including GreenPT) and native fill-in-the-middle APIs (including Mistral Codestral).

[![Version](https://img.shields.io/badge/version-0.10.0-blue.svg)](https://github.com/eliottcrancee/simple-autocomplete/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Reads an API key from any environment variable, or stores one in VS Code SecretStorage.
- Configurable endpoint, model, system prompt, generation parameters, and provider-specific JSON body fields.
- **Two request protocols**: chat mode sends a snippet with a `⟪CURSOR⟫` marker as messages. Native FIM sends raw code before the cursor as `prompt` and raw code after it as `suffix`, with no chat prompt or response envelope.
- **The typed token stays in context**: typing `return fo` asks the model to continue after `fo`, rather than hiding that word and appending a replacement in the wrong place.
- **Focused, whole-line context**: the snippet is cropped to a bounded window on line boundaries, which is what keeps the model from pulling in unrelated code from the rest of the file.
- **Chat output hygiene**: prompt echoes and duplicated surrounding code are rejected or trimmed. Chat envelopes (JSON, fenced JSON, truncated JSON, `<COMPLETION>` tags and fenced code) are parsed. Native FIM output stays raw, preserving code literals, indentation and newlines.
- Conservative automatic mode: skips low-signal contexts where a suggestion is unlikely to help.
- Supports same-line selection ranges and extends the selected suggestion in VS Code's completion menu.
- Configuration test works even when no text editor is open (uses a synthetic Python completion context).
- Status bar indicator: shows disabled/ready/warning state, a spinner while a request is in flight, and opens the configuration panel on click.
- Debounces automatic requests and aborts stale HTTP requests while you keep typing. Explicit requests bypass the typing delay. Responses from an older document version are discarded.
- Request duration and errors are available in the **Simple Autocomplete** Output channel and status tooltip.
- **Suggested edits anywhere in the document.** `Cmd+Alt+.` asks the model to review the code around the cursor and shows each minimal correction as a clickable CodeLens above the line it changes. Edits are transmitted as exact *find*/*replace* pairs and applied by unique match, so a fix that is not at the cursor (for example changing `x: str = None` to `x: str | None = None`) is still one click away. Enable `simpleAutocomplete.suggestEditsOnSave` to run it on every save.

## Install

Download the `.vsix` from the [latest release](https://github.com/eliottcrancee/simple-autocomplete/releases/latest), then run:

```bash
code --install-extension ./simple-autocomplete-0.10.0.vsix --force
```

Reload VS Code after upgrading. If `code` is unavailable on macOS, run **Shell Command: Install 'code' command in PATH** from VS Code's Command Palette.

## Configure GreenPT or Codestral

Run **Simple Autocomplete: Configure** from the Command Palette, or edit VS Code settings.

For [GreenPT chat](https://docs.greenpt.ai/chat-completion), choose a model ID available to your account (see `GET https://api.greenpt.ai/v1/models`):

```json
{
  "simpleAutocomplete.endpoint": "https://api.greenpt.ai/v1/chat/completions",
  "simpleAutocomplete.apiMode": "chat",
  "simpleAutocomplete.model": "YOUR_GREENPT_MODEL_ID",
  "simpleAutocomplete.apiKeyEnvVar": "GREENPT_API_KEY"
}
```

For [Codestral native FIM](https://docs.mistral.ai/api/endpoint/fim):

```json
{
  "simpleAutocomplete.endpoint": "https://api.mistral.ai/v1/fim/completions",
  "simpleAutocomplete.apiMode": "fim",
  "simpleAutocomplete.model": "codestral-latest",
  "simpleAutocomplete.apiKeyEnvVar": "MISTRAL_API_KEY"
}
```

Use the endpoint associated with your API key. `apiMode: "auto"` (the default) detects URLs ending in `/fim/completions`; other URLs use chat mode. For a proxy with a custom path, set the mode explicitly. Both protocols use bearer authentication.

The system prompt and `responseFormat` apply to chat only. `responseFormat` defaults to `text`; use `json` if a chat model works better with a `{"completion":"..."}` contract. Native FIM always consumes raw code. `extraBody` accepts generation options, but cannot override `model`, `stream`, `messages`, `prompt` or `suffix`.

`debounceMs` defaults to 150 ms for automatic suggestions. Models that spend time reasoning may exceed the default 5-second timeout. If your GreenPT model supports it, set `extraBody` to `{"reasoning_effort":"none"}` to disable reasoning; supported values depend on the model. Otherwise increase `timeoutMs`. **Test configuration** uses saved settings and allows at least 30 seconds.

## Suggested edits anywhere (chat mode)

VS Code's stable inline-completion API can only render ghost text on the cursor line. To propose an edit elsewhere, run **Simple Autocomplete: Suggest Edits Around Cursor** (`Cmd+Alt+.` / `Ctrl+Alt+.`):

```python
class GenerationFeature(FeatureConfig):
    n_blocks: int = Field(ge=0)
    #: Column holding the same technology on the realised view.
    actual_counterpart: str = None      # ⟵ a sparkle CodeLens appears here
```

Click the CodeLens to apply the change (`actual_counterpart: str | None = None`). Suggestions are cleared as soon as you type, and are limited by `simpleAutocomplete.maxEdits`.

Suggested edit review needs a chat endpoint. In native FIM mode, this command reports that requirement rather than sending an incompatible payload.

## API key resolution

Choose one of:

1. **Environment variable** — configure any variable name such as `GREENPT_API_KEY`, `OPENAI_API_KEY`, etc.
2. **Stored key** — saved in VS Code SecretStorage, not in `settings.json`.

## Limitations

VS Code's stable `InlineCompletionItem` API supports replacement ranges on a single line. This extension can therefore edit/complete a token around the cursor on the current line, but it does not attempt to reproduce Copilot/VS Code Next Edit Suggestions that rewrite arbitrary multi-line ranges elsewhere in the document.

## Development

```bash
npm install        # install dependencies
npm run lint       # lint the extension source
npm test           # run the pure logic unit tests
npm run package    # build a .vsix in the project directory
```

To try the extension locally, open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Releasing

This project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](CHANGELOG.md). To cut a release:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

Then publish the packaged `.vsix` to the VS Code Marketplace (or Open VSX) with `vsce publish`.

## License

[MIT](LICENSE)
