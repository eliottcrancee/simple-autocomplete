# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-28

### Added

- Provider-agnostic inline completion for OpenAI-compatible `/chat/completions` endpoints.
- API key resolution from any environment variable or from VS Code SecretStorage.
- Webview configuration panel with test-configuration and clear-stored-key actions.
- Strict JSON response contract to preserve significant whitespace and indentation.
- Same-line replacement of the selected/current token, not only append-after-cursor.
- Conservative automatic mode that skips low-signal contexts (empty top-level lines, plain comments).
- Cancellation of stale requests while typing.
- `extraBody` setting for provider-specific JSON request fields.

[0.3.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.3.0
