'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const api = require('../lib/api');
const manifest = require('../package.json');

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

async function setup({ text = 'return fo', settings = {}, fetchImpl = async () => response('o') } = {}) {
  const document = {
    uri: { toString: () => 'file:///test.py' }, fileName: '/test.py', languageId: 'python', version: 1, eol: 1,
    getText: () => text,
    offsetAt: p => text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character,
    lineAt: line => ({ text: text.split('\n')[line], range: new Range(new Position(line, 0), new Position(line, text.split('\n')[line].length)) })
  };
  const config = { apiKeySource: 'secret', model: 'test', debounceMs: 0, ...settings };
  const defaults = manifest.contributes.configuration.properties;
  const commands = new Map();
  const requests = [];
  let provider;
  let onChange;
  const vscode = {
    Range, CancellationTokenSource, InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 }, EndOfLine: { LF: 1, CRLF: 2 },
    StatusBarAlignment: { Right: 1 },
    InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {}
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable; } },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? defaults[`simpleAutocomplete.${key}`]?.default ?? fallback }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeTextDocument: fn => { onChange = fn; return disposable; },
      onDidSaveTextDocument: () => disposable
    },
    languages: {
      registerCodeLensProvider: () => disposable,
      registerInlineCompletionItemProvider: (selector, p) => { provider = p; return disposable; }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension.js'), 'utf8'), {
    module,
    require: id => {
      if (id === 'vscode') return vscode;
      if (id === './lib/context') return require('../lib/context');
      if (id === './lib/api') return { ...api, sendRequest: (request, options) => api.sendRequest(request, { ...options, fetchImpl: (url, init) => { requests.push(JSON.parse(init.body)); return fetchImpl(url, init); } }) };
      throw new Error(`Unexpected module ${id}`);
    }
  });
  await module.exports.activate({ subscriptions: [], secrets: { get: async () => 'test-key' } });
  const provide = (position = new Position(0, text.split('\n')[0].length), inlineContext = { triggerKind: 0 }, token = new CancellationTokenSource().token) => provider.provideInlineCompletionItems(document, position, inlineContext, token);
  return { document, requests, provide, commands, vscode, change: () => { document.version++; onChange({ document }); } };
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
