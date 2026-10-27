'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const api = require('../lib/api');
const manifest = require('../package.json');
const { URL } = require('node:url');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(other) { return this.line === other.line && this.character === other.character; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  get isEmpty() { return this.start.isEqual(this.end); }
  contains(p) { return this.start.line === p.line && this.end.line === p.line && this.start.character <= p.character && p.character <= this.end.character; }
}
class CancellationTokenSource {
  constructor() {
    this.listeners = new Set();
    this.token = { isCancellationRequested: false, onCancellationRequested: fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; } };
  }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; for (const fn of this.listeners) fn(); } }
  dispose() { this.listeners.clear(); }
}
const disposable = { dispose() {} };
function response(text) { return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) }; }
function editResponse(edits) { return response(JSON.stringify({ edits })); }

async function setup({ text = 'return fo', settings = {}, fetchImpl = async () => response('o') } = {}) {
  const parseUri = value => {
    const url = new URL(value);
    return { scheme: url.protocol.slice(0, -1), path: url.pathname, toString: () => value };
  };
  const document = {
    uri: parseUri('file:///test.py'), fileName: '/test.py', languageId: 'python', version: 1, eol: 1,
    getText: () => text,
    offsetAt: p => text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character,
    positionAt: offset => { const lines = text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines[lines.length - 1].length); },
    lineAt: line => ({ text: text.split('\n')[line], range: new Range(new Position(line, 0), new Position(line, text.split('\n')[line].length)) })
  };
  const config = { apiKeySource: 'secret', model: 'test', debounceMs: 0, ...settings };
  const defaults = manifest.contributes.configuration.properties;
  const commands = new Map();
  const requests = [];
  const executedCommands = [];
  const notifications = [];
  const timers = new Map();
  const contentProviders = new Map();
  let nextTimer = 0;
  let provider;
  let lensProvider;
  let onChange;
  let onClose;
  let onActiveEditor;
  const change = value => {
    if (value !== undefined) text = value;
    document.version++;
    onChange({ document, contentChanges: [{ text }] });
  };
  const vscode = {
    Range, CancellationTokenSource, InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 }, EndOfLine: { LF: 1, CRLF: 2 },
    StatusBarAlignment: { Right: 1 },
    Uri: { parse: parseUri, from: ({ scheme, path, query }) => parseUri(`${scheme}:${path}?${query}`) },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, replacement) { this.edits.push({ uri, range, replacement }); } },
    CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
    InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      showWarningMessage: msg => notifications.push(msg), showInformationMessage: msg => notifications.push(msg), showErrorMessage: msg => notifications.push(msg),
      onDidChangeActiveTextEditor: fn => { onActiveEditor = fn; return disposable; }
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return disposable; },
      executeCommand: async (name, ...args) => { executedCommands.push({ name, args }); }
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? defaults[`simpleAutocomplete.${key}`]?.default ?? fallback }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeTextDocument: fn => { onChange = fn; return disposable; },
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: fn => { onClose = fn; return disposable; },
      registerTextDocumentContentProvider: (scheme, p) => { contentProviders.set(scheme, p); return disposable; },
      openTextDocument: async uri => uri.toString() === document.uri.toString() ? document : { uri, getText: () => contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri) },
      applyEdit: async edit => {
        for (const e of edit.edits) {
          const next = text.slice(0, document.offsetAt(e.range.start)) + e.replacement + text.slice(document.offsetAt(e.range.end));
          change(next);
        }
        return true;
      }
    },
    languages: {
      registerCodeLensProvider: (selector, p) => { lensProvider = p; return disposable; },
      registerInlineCompletionItemProvider: (selector, p) => { provider = p; return disposable; }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension.js'), 'utf8'), {
    module,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    require: id => {
      if (id === 'vscode') return vscode;
      if (id === './lib/context') return require('../lib/context');
      if (id === './lib/api') return { ...api, sendRequest: (request, options) => api.sendRequest(request, { ...options, fetchImpl: (url, init) => { requests.push(JSON.parse(init.body)); return fetchImpl(url, init); } }) };
      throw new Error(`Unexpected module ${id}`);
    }
  });
  await module.exports.activate({ subscriptions: [], secrets: { get: async () => 'test-key' } });
  const provide = (position = new Position(0, text.split('\n')[0].length), inlineContext = { triggerKind: 0 }, token = new CancellationTokenSource().token) => provider.provideInlineCompletionItems(document, position, inlineContext, token);
  return {
    document, requests, provide, commands, vscode, change, notifications, timers, executedCommands, contentProviders,
    lenses: () => lensProvider.provideCodeLenses(document),
    showEditor: (position = new Position(0, 0)) => { const selection = new Range(position, position); selection.active = position; vscode.window.activeTextEditor = { document, selection }; },
    runEditTimer: async () => { const [id, timer] = [...timers.entries()][0]; timers.delete(id); await timer.fn(); },
    close: () => { document.isClosed = true; onClose(document); },
    blur: () => { vscode.window.activeTextEditor = undefined; onActiveEditor(); },
    stop: () => module.exports.deactivate()
  };
}

test('chat keeps the already typed token in the prompt and inserts at the actual cursor', async () => {
  const app = await setup();
  const items = await app.provide();
  assert.match(app.requests[0].messages[1].content, /return fo⟪CURSOR⟫/);
  assert.equal(items[0].insertText, 'o');
  assert.equal(items[0].range.start.character, 9);
  assert.equal(items[0].range.isEmpty, true);
});

test('Codestral sends raw code around the cursor and preserves a Python literal response', async () => {
  const app = await setup({ text: 'x = \nnext()', settings: { endpoint: 'https://api.mistral.ai/v1/fim/completions' }, fetchImpl: async () => response('None') });
  const items = await app.provide(new Position(0, 4));
  assert.equal(app.requests[0].prompt, 'x = ');
  assert.equal(app.requests[0].suffix, '\nnext()');
  assert.equal(app.requests[0].messages, undefined);
  assert.equal(items[0].insertText, 'None');
});

test('multiline insertions in the middle of a line keep their indentation', async () => {
  const app = await setup({ text: 'call()', fetchImpl: async () => response('\n    value\n') });
  const items = await app.provide(new Position(0, 5));
  assert.equal(items[0].insertText, '\n    value\n');
});

test('extends the selected completion widget item using the same replacement range', async () => {
  const app = await setup({ text: 'console.l', fetchImpl: async () => response('(value)') });
  const range = new Range(new Position(0, 8), new Position(0, 9));
  const items = await app.provide(new Position(0, 9), { triggerKind: 0, selectedCompletionInfo: { range, text: 'log' } });
  assert.match(app.requests[0].messages[1].content, /console.log⟪CURSOR⟫/);
  assert.equal(items[0].insertText, 'log(value)');
  assert.equal(items[0].range, range);
});

test('a same-line selection is replaced at its original range instead of appended at the cursor', async () => {
  const app = await setup({ text: 'x = val', fetchImpl: async () => response('value') });
  const selection = new Range(new Position(0, 4), new Position(0, 7));
  app.vscode.window.activeTextEditor = { document: app.document, selection };
  const items = await app.provide(new Position(0, 7));
  assert.equal(items[0].insertText, 'value');
  assert.equal(items[0].range.start.character, 4);
  assert.equal(items[0].range.end.character, 7);
  assert.match(app.requests[0].messages[1].content, /x = ⟪CURSOR⟫/);
});

test('completion newlines follow the document line ending setting', async () => {
  const app = await setup({ fetchImpl: async () => response('first\n    second\n') });
  app.document.eol = 2;
  const items = await app.provide();
  assert.equal(items[0].insertText, 'first\r\n    second\r\n');
});

test('a newer invocation aborts the old HTTP request and only returns the newer result', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  let oldSignal;
  const app = await setup({ fetchImpl: async (url, { signal }) => {
    calls++;
    if (calls > 1) return response('newResult');
    oldSignal = signal;
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { const error = new Error(); error.name = 'AbortError'; reject(error); }));
  } });
  const old = app.provide();
  await ready;
  const latest = await app.provide();
  assert.equal(oldSignal.aborted, true);
  assert.equal((await old).length, 0);
  assert.equal(latest[0].insertText, 'newResult');
});

test('editing during generation discards a response even when the transport ignores cancellation', async () => {
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const app = await setup({ fetchImpl: async () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = app.provide();
  await ready;
  app.change();
  finish(response('staleResult'));
  assert.equal((await pending).length, 0);
});

test('cancellation during debounce sends no HTTP request', async () => {
  const app = await setup({ settings: { debounceMs: 50 } });
  const cancellation = new CancellationTokenSource();
  const pending = app.provide(new Position(0, 9), { triggerKind: 1 }, cancellation.token);
  cancellation.cancel();
  assert.equal((await pending).length, 0);
  assert.equal(app.requests.length, 0);
});

test('automatic requests skip an empty file but explicit requests still run', async () => {
  const app = await setup({ text: '' });
  assert.equal((await app.provide(new Position(0, 0), { triggerKind: 1 })).length, 0);
  assert.equal(app.requests.length, 0);
  await app.provide(new Position(0, 0));
  assert.equal(app.requests.length, 1);
});

test('automatic replacement review waits for a pause, coalesces typing and never changes the buffer', async () => {
  const app = await setup({ text: 'value: str = None', fetchImpl: async () => editResponse([{ find: 'value: str = None', replace: 'value: str | None = None', reason: 'Allow None' }]) });
  app.showEditor();
  app.change();
  app.change();
  assert.equal(app.requests.length, 0);
  assert.equal(app.timers.size, 1);
  assert.equal([...app.timers.values()][0].ms, 1500);
  await app.runEditTimer();
  assert.equal(app.requests.length, 1);
  assert.match(app.requests[0].messages[1].content, /at most 1/);
  assert.match(app.requests[0].messages[1].content, /Cursor line: "value: str = None"/);
  assert.equal(app.document.getText(), 'value: str = None');
  assert.equal(app.notifications.length, 0);
  assert.deepEqual(Array.from(app.lenses(), lens => lens.command.command), ['simpleAutocomplete.previewEdit', 'simpleAutocomplete.applyEdit', 'simpleAutocomplete.dismissEdit']);
});

test('a replacement preview is an immutable diff and can be accepted from the diff editor', async () => {
  const app = await setup({ text: 'value: str = None', fetchImpl: async () => editResponse([{ find: 'value: str = None', replace: 'value: str | None = None' }]) });
  app.showEditor();
  await app.commands.get('simpleAutocomplete.suggestEdits')();
  await app.commands.get('simpleAutocomplete.previewEdit')();
  const diff = app.executedCommands[0];
  assert.equal(diff.name, 'vscode.diff');
  const [before, after] = diff.args;
  const content = app.contentProviders.get(before.scheme);
  assert.equal(content.provideTextDocumentContent(before), 'value: str = None');
  assert.equal(content.provideTextDocumentContent(after), 'value: str | None = None');
  assert.equal(app.document.getText(), 'value: str = None');
  app.vscode.window.activeTextEditor = { document: await app.vscode.workspace.openTextDocument(after) };
  await app.commands.get('simpleAutocomplete.applyEdit')();
  assert.equal(app.document.getText(), 'value: str | None = None');
  assert.equal(app.lenses().length, 0);
  assert.equal(content.provideTextDocumentContent(before), 'value: str = None');
});

test('accepting an edit relocates remaining suggestions and does not immediately start a new review', async () => {
  const app = await setup({ text: 'a: str = None\nb: str = None', fetchImpl: async () => editResponse([
    { find: 'a: str = None', replace: 'a: str | None = None' },
    { find: 'b: str = None', replace: 'b: str | None = None' }
  ]) });
  app.showEditor();
  await app.commands.get('simpleAutocomplete.suggestEdits')();
  assert.equal(app.lenses().length, 6);
  await app.commands.get('simpleAutocomplete.applyEdit')();
  assert.equal(app.document.getText(), 'a: str | None = None\nb: str = None');
  assert.equal(app.lenses().length, 3);
  assert.equal(app.timers.size, 0);
  await app.commands.get('simpleAutocomplete.applyEdit')();
  assert.equal(app.document.getText(), 'a: str | None = None\nb: str | None = None');
  assert.equal(app.lenses().length, 0);
});

test('typing invalidates suggested replacements, so a stale preview cannot be accepted', async () => {
  const app = await setup({ text: 'x = 1', fetchImpl: async () => editResponse([{ find: 'x = 1', replace: 'x = 2' }]) });
  app.showEditor();
  await app.commands.get('simpleAutocomplete.suggestEdits')();
  const apply = app.lenses()[1].command;
  app.change('x = 100');
  await app.commands.get(apply.command)(...apply.arguments);
  assert.equal(app.document.getText(), 'x = 100');
  assert.equal(app.lenses().length, 0);
  app.stop();
});

test('resuming typing aborts a replacement request and discards responses that ignore cancellation', async () => {
  let started;
  let finish;
  let signal;
  const ready = new Promise(resolve => { started = resolve; });
  const app = await setup({ text: 'x = 1', fetchImpl: async (url, init) => {
    signal = init.signal;
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  app.showEditor();
  app.change();
  const pending = app.runEditTimer();
  await ready;
  app.change('x = 10');
  assert.equal(signal.aborted, true);
  finish(editResponse([{ find: 'x = 1', replace: 'x = 2' }]));
  await pending;
  assert.equal(app.lenses().length, 0);
  assert.equal(app.notifications.length, 0);
  app.stop();
});

test('dismissing a replacement prevents it from being reoffered automatically after unrelated typing', async () => {
  const app = await setup({ text: 'value: str = None\nother = 1', fetchImpl: async () => editResponse([{ find: 'value: str = None', replace: 'value: str | None = None' }]) });
  app.showEditor();
  app.change();
  await app.runEditTimer();
  await app.commands.get('simpleAutocomplete.dismissEdit')();
  assert.equal(app.lenses().length, 0);
  app.change('value: str = None\nother = 2');
  await app.runEditTimer();
  assert.equal(app.lenses().length, 0);
  assert.equal(app.document.getText(), 'value: str = None\nother = 2');
});

test('automatic review skips FIM, excluded languages and disabled settings', async () => {
  for (const settings of [{ apiMode: 'fim' }, { suggestEditsAutomatically: false }, { enabled: false }]) {
    const app = await setup({ settings });
    app.showEditor();
    app.change();
    assert.equal(app.timers.size, 0);
    assert.equal(app.requests.length, 0);
  }
  const app = await setup();
  app.document.languageId = 'dotenv';
  app.showEditor();
  app.change();
  assert.equal(app.timers.size, 0);
});

test('leaving or closing a document cancels a scheduled review', async () => {
  const app = await setup();
  app.showEditor();
  app.change();
  app.blur();
  assert.equal(app.timers.size, 0);
  app.showEditor();
  app.change();
  app.close();
  assert.equal(app.timers.size, 0);
  assert.equal(app.requests.length, 0);
});
