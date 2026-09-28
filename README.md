# Inline Completion

A minimal provider-agnostic VS Code inline code completion extension for OpenAI-compatible `/chat/completions` APIs.

[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/eliottcrancee/simple-autocomplete/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Reads an API key from any environment variable, or stores one in VS Code SecretStorage.
- Configurable endpoint, model, system prompt, generation parameters, and provider-specific JSON body fields.
- Preserves significant whitespace and indentation through a strict JSON response contract.
- Conservative automatic mode: skips low-signal contexts where a suggestion is unlikely to help.
- Can replace the current same-line token/selection, not only append after the cursor.
- Configuration test works even when no text editor is open (uses a synthetic Python completion context).
- Cancels stale requests while you keep typing.

## Configure

Run `Inline Completion: Configure` from the Command Palette.

The system prompt is fully editable. The extension appends a non-editable response contract that asks the model for exactly one JSON object (`{"completion":"..."}` or `{"completion":null}`), so leading spaces and newlines are preserved reliably.

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
npm run package    # build a .vsix into dist/
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
