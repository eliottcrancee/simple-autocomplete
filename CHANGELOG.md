# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-09-28

### Fixed

- Completions no longer leak the raw `{"completion":"..."}` envelope into the editor when a model wraps its JSON answer in Markdown code fences or `<COMPLETION>` tags: fallback paths now re-parse the extracted payload against the JSON contract.

## [0.6.2] - 2026-09-28

### Fixed

- Abort errors now report the configured timeout with actionable advice instead of the raw "This operation was aborted" message.
- The "Test configuration" action now uses a relaxed timeout of at least 30 seconds, since manual tests often target reasoning-heavy models that exceed the default 5-second inline timeout.

## [0.6.1] - 2026-09-28

### Added

- "Reset prompt to default" button in the configuration panel: restores the built-in system prompt without editing settings manually.

### Changed

- Configuration feedback now appears at the bottom of the panel, next to the action buttons, with distinct styling: green for success, red for errors. The test result shows a clearer, multi-line completion preview (up to 300 characters).

## [0.6.0] - 2026-09-28

### Changed

- Rewrote the default system prompt: the assistant now behaves as a proactive AI pair programmer that completes whole logical blocks (functions, branches, loops, error handling) instead of suggesting minimal, overly conservative edits. It infers intent from naming conventions, TODOs, existing imports, and language idioms.
- Softened the JSON response contract accordingly: `null` is returned only when nothing useful can be added.
- An empty or whitespace-only `simpleAutocomplete.systemPrompt` setting now falls back to the built-in default prompt.

## [0.5.1] - 2026-09-28

### Fixed

- Status bar item is now actually shown: the item was created but never made visible.

## [0.5.0] - 2026-09-28

### Added

- Status bar item showing extension state at a glance: disabled, ready, warning when no API key is available, and a spinner while a completion request is in flight. Clicking it opens the configuration panel; the tooltip shows the current model and API key source. Refreshes automatically when settings change.

## [0.4.0] - 2026-09-28

### Changed

- Renamed the extension from `inline-completion` to `simple-autocomplete` ("Simple Autocomplete").
- Renamed all command IDs (`simpleAutocomplete.configure`, `simpleAutocomplete.showStatus`, `simpleAutocomplete.clearApiKey`) and configuration keys (`simpleAutocomplete.*`). **Breaking:** existing user settings and keybindings for `inlineCompletion.*` must be migrated manually.

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

[0.6.2]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.2
[0.6.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.1
[0.6.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.0
[0.5.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.5.1
[0.5.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.5.0
[0.4.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.4.0
[0.3.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.3.0
