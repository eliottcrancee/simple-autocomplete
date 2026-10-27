# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-10-27

### Added

- Automatic replacement suggestions after a typing pause in chat mode, enabled by default. The delay is configurable with `editDebounceMs` (1500 ms by default); `suggestEditsAutomatically` switches the feature off.
- Preview, Apply and Dismiss actions above each proposed change. Preview opens immutable before/after snapshots in VS Code's native diff editor.
- Commands to preview, apply or dismiss the nearest suggestion. `Cmd+Alt+Enter` / `Ctrl+Alt+Enter` accepts it from the source or diff editor.
- Cursor-line context for edit review prompts and one suggestion per automatic review. Manual reviews retain the configurable `maxEdits` limit.
- Cancellation of pending edit reviews on typing, editor changes, configuration changes and dismissal. Automatic reviews stay quiet and do not modify the buffer without acceptance.

### Fixed

- Reject overlapping edits, matches outside the transmitted snippet, and ambiguous matches with overlapping occurrences.
- Prevent dismissed replacements from reappearing automatically in the same file session.
- Retain and relocate remaining proposals after acceptance; avoid triggering a new review solely because a suggested edit was accepted.
- Include pending edit activity and the number of available suggestions in the status bar.

## [0.10.0] - 2026-10-27

### Added

- Native FIM requests (`prompt` / `suffix`) for Mistral Codestral alongside chat completions for GreenPT and compatible providers. `apiMode` selects the protocol explicitly or detects it from the endpoint.
- Configurable typing debounce (`debounceMs`, default 150 ms), cancellation of superseded HTTP requests, and rejection of responses for an older document version.
- Request latency and provider errors in the output channel and status tooltip.
- Regression tests for API payloads, transport errors, cancellation, cursor ranges and completion-menu integration.

### Fixed

- Keep the already typed token in the prefix and pass the actual replacement range to VS Code.
- Preserve raw FIM output, including `None`, `null`, literal JSON, indentation and newlines.
- Preserve multiline insertion text at a mid-line cursor and extend selected completion-menu items using their replacement range.
- Keep context bounds valid on long lines and honor a zero suffix budget.
- Avoid contradictory JSON instructions, accidental parsing of JSON fields inside code, and deletion of meaningful whitespace. Strip chat reasoning envelopes and duplicated closing delimiters.
- Reject stale suggested edits after document changes and distinguish timeouts from user cancellation.
- Correct response-format descriptions and synchronize package-lock metadata.

## [0.9.1] - 2026-09-28

### Fixed

- A completion that re-emits code already present right after the cursor no longer duplicates it. This was the case where a docstring answer also contained the following function body, inserting it twice. Post-processing now trims: a structural overlap at the start with PREFIX (quotes, brackets, indentation), a structural overlap at the end with SUFFIX, and any following block whose line was copied from SUFFIX.
- Trailing whitespace is stripped from generated text, and a short pure-identifier overlap is deliberately left alone so that completing `value` into `values = ...` is never cut to `s = ...`.

## [0.9.0] - 2026-09-28

### Added

- **Suggested edits anywhere in the document.** Run `Simple Autocomplete: Suggest Edits Around Cursor` (`Cmd+Alt+.` on macOS, `Ctrl+Alt+.` elsewhere) and the model reviews the code around the cursor and returns minimal corrections. Each one renders as a clickable CodeLens above the line it changes — so an edit that is *not* at the cursor is still one click away, which the stable inline-completion API cannot do (its range must be single-line and contain the cursor).
- Edits are expressed as exact *find*/*replace* pairs and located by unique match in the document, instead of line/column coordinates. Ambiguous or unresolvable suggestions are dropped, and remaining suggestions are re-located after an edit is applied.
- `simpleAutocomplete.suggestEditsOnSave` runs the review automatically on save.
- `simpleAutocomplete.maxEdits` limits how many suggestions are shown.
- `Simple Autocomplete: Clear Suggested Edits` command; suggestions also disappear as soon as the document changes.
- Shared the chat request plumbing so inline completion and edit review use the same endpoint, key and `extraBody` handling.

## [0.8.0] - 2026-09-28

### Changed

- **Redesigned around fill-in-the-middle.** The request is now one contiguous `<CODE>` snippet with a single `⟪CURSOR⟫` marker, and the model returns only the text that replaces it. This replaces the `PREFIX`/`TARGET`/`SUFFIX` split and the per-situation prompting: one generic instruction now covers code bodies, docstrings, comments, strings, expressions, imports and tests.
- `responseFormat` now defaults to `text` (raw fill-in-the-middle), which is what code-specialized models expect. `json` remains available for chat models.
- Context is cropped to a bounded, whole-line window (`prefixChars` 4000, `suffixChars` 1500 by default). Smaller, local context is the main lever against the model pasting unrelated code.
- Extracted all prompt/context/parsing logic into a dependency-free `lib/context.js` module.

### Added

- Generic output hygiene, independent of language or construct: reject answers that repeat text already before or after the cursor, echo the prompt marker, or reintroduce a definition (function/method/class) that already exists in the snippet.

### Removed

- All docstring-specific and per-situation logic (`SITUATION_NOTES`, `analyzeCursor`, docstring closing/collapse and intent detection). Those were band-aids over a context-and-prompt problem, not a general solution.

## [0.7.1] - 2026-09-28

### Fixed

- Accepting a docstring suggestion no longer re-offers the same sentence: a completion that only repeats text already present right before the cursor is rejected instead of being inserted again.
- When the user accepts a docstring body but the closing quotes are still missing, the next suggestion is only the closing delimiter (placed on its own line), so the docstring gets terminated instead of the body being written twice. The model's instructions now also require closing the docstring.

## [0.7.0] - 2026-09-28

### Added

- Cursor situation detection: docstring body, docstring opening, string, comment, block opening, identifier replacement, or general code. Each situation gets its own targeted instruction, so "write the docstring of the definition above" is now asked explicitly instead of "continue the code".
- Structure-aware context: the enclosing function/class signature is sent as `<ENCLOSING_DEFINITION>`, and up to two existing docstrings are sent as `<EXISTING_DOCSTRINGS>` so the model copies the file's documentation style.
- `simpleAutocomplete.responseFormat` setting (`json` or `text`). `json` keeps the whitespace-safe JSON contract; `text` asks for raw fill-in-the-middle output, which often suits code-specialized models better.
- Unit tests for the pure context/prompt/parsing logic (`npm test`).

### Changed

- Rewrote the default system prompt: it now behaves like a well-scoped inline autocomplete instead of a "proactive coding agent" that invents whole unrelated blocks. This was the main cause of a two-quote docstring turning into an unrelated function.
- The response contract now explicitly forbids repeating surrounding code and inventing code that belongs elsewhere in the file.

### Fixed

- Mid-line multi-line completions (for example a cursor between `"""` and `"""`) are no longer dropped: they fall back to their first meaningful line, and an empty same-line docstring is answered with a single line so VS Code can render it.
- Documentation answers are de-duplicated against the opening and closing quote characters already present in the buffer, so `""""""` breakage is avoided.
- A "docstring" answer that is actually a large unrelated code block is rejected instead of being inserted.
- Markdown-fenced, truncated or otherwise malformed `{"completion":"..."}` envelopes can no longer leak into the editor: the parser tolerates fenced, truncated, tagged and plain-text answers, and salvages the string value even when the JSON is cut off by the token limit.

### Removed

- The old default prompt's instruction to prefer whole logical blocks over keeping the completion local.

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

[0.9.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.9.1
[0.9.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.9.0
[0.8.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.8.0
[0.7.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.7.1
[0.7.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.7.0
[0.6.2]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.2
[0.6.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.1
[0.6.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.6.0
[0.5.1]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.5.1
[0.5.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.5.0
[0.4.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.4.0
[0.3.0]: https://github.com/eliottcrancee/simple-autocomplete/releases/tag/v0.3.0
