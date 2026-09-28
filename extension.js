const vscode = require('vscode');

const SECRET_KEY = 'simpleAutocomplete.apiKey';
let requestSerial = 0;
let missingKeyWarned = false;
let configPanel;
let statusBarItem;
let output;

function cfg() {
  return vscode.workspace.getConfiguration('simpleAutocomplete');
}

async function getApiKey(context) {
  const c = cfg();
  const source = c.get('apiKeySource', 'environment');

  if (source === 'secret') {
    const stored = await context.secrets.get(SECRET_KEY);
    if (stored?.trim()) return { key: stored.trim(), source: 'VS Code SecretStorage' };
    return { key: null, source: 'VS Code SecretStorage (empty)' };
  }

  const envName = String(c.get('apiKeyEnvVar', 'OPENAI_API_KEY')).trim();
  const envKey = envName ? process.env[envName] : undefined;
  if (envKey?.trim()) return { key: envKey.trim(), source: `${envName} environment variable` };
  return { key: null, source: envName ? `${envName} environment variable (missing)` : 'environment variable (not configured)' };
}

function getReplacementContext(document, position) {
  const fullText = document.getText();
  const cursorOffset = document.offsetAt(position);
  let range = new vscode.Range(position, position);

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === document.uri.toString()) {
    const selection = editor.selection;
    if (!selection.isEmpty && selection.start.line === selection.end.line && selection.contains(position)) {
      range = new vscode.Range(selection.start, selection.end);
    }
  }

  if (range.isEmpty) {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (wordRange && wordRange.start.line === wordRange.end.line && wordRange.contains(position)) {
      range = wordRange;
    }
  }

  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const c = cfg();
  const prefixChars = c.get('prefixChars', 7000);
  const suffixChars = c.get('suffixChars', 3000);

  return {
    fileName: document.fileName || 'untitled',
    languageId: document.languageId,
    line: position.line + 1,
    column: position.character + 1,
    prefix: fullText.slice(Math.max(0, startOffset - prefixChars), startOffset),
    target: fullText.slice(startOffset, endOffset),
    suffix: fullText.slice(endOffset, Math.min(fullText.length, endOffset + suffixChars)),
    range,
    lineText: document.lineAt(position.line).text,
    position,
    cursorOffset
  };
}

function shouldRequestAutomatically(document, position, context) {
  const c = cfg();
  if (!c.get('conservative', true)) return true;
  if (context?.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) return true;

  const line = document.lineAt(position.line).text;
  const before = line.slice(0, position.character);
  const after = line.slice(position.character);

  // Never spend a request on a completely empty top-level line unless the previous
  // line clearly opens a block/expression. Indented blank lines are still useful.
  if (!before.trim() && !after.trim()) {
    const indentation = before.length;
    const prev = position.line > 0 ? document.lineAt(position.line - 1).text.trimEnd() : '';
    const last = prev.slice(-1);
    const opensContext = ':=([{.,\\'.includes(last) || /(?:return|yield|raise|await)\s*$/.test(prev);
    if (indentation === 0 && !opensContext) return false;
  }

  // Skip comments that contain no obvious unfinished code marker.
  if (before.trimStart().startsWith('#') && !/[=:([{.]\s*$/.test(before)) return false;
  return true;
}

function responseContract() {
  return [
    'RESPONSE CONTRACT (mandatory):',
    '- Reply with exactly one JSON object and nothing else.',
    '- Use {"completion":"..."} when there is a useful edit.',
    '- Use {"completion":null} when no completion is clearly useful.',
    '- The completion string is the EXACT text that replaces <TARGET>.',
    '- Preserve every leading space, newline, quote and indentation exactly as it should appear in the file.',
    '- Never include Markdown fences, explanations, reasoning, labels, PREFIX, TARGET, or SUFFIX in the completion.',
    '- Prefer the smallest confident edit. Do not invent unrelated code or expand the task beyond the local context.',
    '- If <TARGET> is non-empty, minimally fix/complete that target rather than rewriting surrounding code.',
    '- If the cursor is on a blank/complete location and there is no strongly implied next code, return null.'
  ].join('\n');
}

function buildMessagesFromContext(completionContext) {
  const c = cfg();
  const customPrompt = c.get('systemPrompt', 'You are a precise, low-latency inline code editing engine.');
  const systemPrompt = `${customPrompt.trim()}\n\n${responseContract()}`;
  const user = [
    `File: ${completionContext.fileName}`,
    `Language: ${completionContext.languageId}`,
    `Cursor: line ${completionContext.line}, column ${completionContext.column}`,
    `Operation: ${completionContext.target ? 'replace TARGET' : 'insert at TARGET'}`,
    '',
    '<PREFIX>',
    completionContext.prefix,
    '</PREFIX>',
    '<TARGET>',
    completionContext.target,
    '</TARGET>',
    '<SUFFIX>',
    completionContext.suffix,
    '</SUFFIX>',
    '',
    'Produce the smallest useful completion under the response contract.'
  ].join('\n');
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user }
  ];
}

function parseCompletion(raw, completionContext, maxLines) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let completion;

  // Preferred path: strict JSON preserves significant whitespace inside the string.
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'completion')) {
      if (parsed.completion === null) return '';
      if (typeof parsed.completion === 'string') completion = parsed.completion;
    }
  } catch {}

  // Robust fallbacks for models that ignore the JSON contract.
  if (completion === undefined) {
    const tagged = raw.match(/<COMPLETION>([\s\S]*?)<\/COMPLETION>/i);
    if (tagged) completion = tagged[1];
  }
  if (completion === undefined) {
    const fenced = raw.match(/```(?:[a-zA-Z0-9_+.-]+)?\s*\n([\s\S]*?)```/);
    if (fenced) completion = fenced[1].replace(/\n$/, '');
  }
  if (completion === undefined) {
    const trimmed = raw.trim();
    if (/^(?:none|null|no completion|no suggestion)$/i.test(trimmed)) return '';
    completion = raw;
  }

  if (!completion || !completion.trim()) return '';
  if (completion === completionContext.target) return '';

  const lines = completion.split('\n');
  if (lines.length > maxLines) completion = lines.slice(0, maxLines).join('\n');
  return completion;
}

async function callApiWithContext(context, completionContext, token, overrides = {}) {
  const c = cfg();
  const auth = await getApiKey(context);
  if (!auth.key) throw new Error(`No API key available from ${auth.source}.`);

  const endpoint = String(c.get('endpoint', '')).trim();
  const model = String(c.get('model', '')).trim();
  if (!endpoint) throw new Error('No API endpoint configured.');
  if (!model) throw new Error('No model configured.');

  const extraBody = c.get('extraBody', {}) || {};
  const body = {
    model,
    messages: buildMessagesFromContext(completionContext),
    stream: false,
    temperature: c.get('temperature', 0),
    max_tokens: c.get('maxTokens', 256),
    ...extraBody,
    ...overrides
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), c.get('timeoutMs', 5000));
  const cancellation = token?.onCancellationRequested?.(() => controller.abort());

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const responseText = await response.text();
    if (!response.ok) {
      output.appendLine(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    let data;
    try { data = JSON.parse(responseText); }
    catch { throw new Error('The provider returned a non-JSON response.'); }

    const raw = data?.choices?.[0]?.message?.content ?? '';
    const completion = parseCompletion(raw, completionContext, c.get('maxLines', 20));
    return { completion, raw, data };
  } finally {
    clearTimeout(timeout);
    cancellation?.dispose?.();
  }
}

async function callApi(context, document, position, token, overrides = {}) {
  const completionContext = getReplacementContext(document, position);
  const result = await callApiWithContext(context, completionContext, token, overrides);
  return { ...result, completionContext };
}

async function updateStatusBar(context) {
  if (!statusBarItem) return;
  const c = cfg();
  if (!c.get('enabled', true)) {
    statusBarItem.text = '$(circle-slash) SA';
    statusBarItem.tooltip = 'Simple Autocomplete — disabled\nClick to configure';
    statusBarItem.backgroundColor = undefined;
    return;
  }
  const auth = await getApiKey(context);
  const model = String(c.get('model', '')).trim() || '(not configured)';
  statusBarItem.text = auth.key ? '$(sparkle) SA' : '$(warning) SA';
  statusBarItem.tooltip = [
    'Simple Autocomplete',
    `Model: ${model}`,
    `API key: ${auth.key ? `available via ${auth.source}` : `missing (${auth.source})`}`,
    'Click to configure'
  ].join('\n');
  statusBarItem.backgroundColor = auth.key ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function fetchCompletion(context, document, position, inlineContext, token) {
  const c = cfg();
  if (!c.get('enabled', true)) return null;
  if (c.get('excludedLanguages', ['plaintext', 'dotenv', 'scminput']).includes(document.languageId)) return null;
  if (!shouldRequestAutomatically(document, position, inlineContext)) return null;

  try {
    if (statusBarItem) statusBarItem.text = '$(sync~spin) SA';
    const result = await callApi(context, document, position, token);
    return result.completion ? result : null;
  } catch (err) {
    if (err?.name !== 'AbortError') {
      output.appendLine(`[completion] ${err?.stack || err}`);
      if (String(err?.message || '').startsWith('No API key') && !missingKeyWarned) {
        missingKeyWarned = true;
        vscode.window.showWarningMessage('Simple Autocomplete: no API key is available. Run “Simple Autocomplete: Configure”.');
      }
    }
    return null;
  } finally {
    if (statusBarItem) statusBarItem.text = '$(sparkle) SA';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

async function currentConfig(context) {
  const c = cfg();
  const secret = await context.secrets.get(SECRET_KEY);
  const auth = await getApiKey(context);
  return {
    enabled: c.get('enabled', true),
    endpoint: c.get('endpoint', ''),
    model: c.get('model', ''),
    apiKeySource: c.get('apiKeySource', 'environment'),
    apiKeyEnvVar: c.get('apiKeyEnvVar', 'OPENAI_API_KEY'),
    hasStoredSecret: Boolean(secret),
    keyStatus: auth.key ? `Available via ${auth.source}` : `Unavailable: ${auth.source}`,
    systemPrompt: c.get('systemPrompt', ''),
    extraBody: JSON.stringify(c.get('extraBody', {}) || {}, null, 2),
    maxTokens: c.get('maxTokens', 256),
    temperature: c.get('temperature', 0),
    prefixChars: c.get('prefixChars', 7000),
    suffixChars: c.get('suffixChars', 3000),
    timeoutMs: c.get('timeoutMs', 5000),
    maxLines: c.get('maxLines', 20),
    conservative: c.get('conservative', true)
  };
}

async function renderConfigPanel(context, panel, message = '') {
  const v = await currentConfig(context);
  const n = nonce();
  const sourceEnv = v.apiKeySource === 'environment' ? 'checked' : '';
  const sourceSecret = v.apiKeySource === 'secret' ? 'checked' : '';
  panel.webview.html = `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simple Autocomplete</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; max-width: 900px; margin: auto; }
  h1 { margin-top: 0; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
  .full { grid-column: 1 / -1; }
  label { display:block; font-weight:600; margin-bottom:5px; }
  input, textarea, select { box-sizing:border-box; width:100%; padding:8px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, transparent); }
  textarea { min-height:150px; resize:vertical; font-family:var(--vscode-editor-font-family); }
  #extraBody { min-height:110px; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .row input[type=radio], .row input[type=checkbox] { width:auto; }
  button { padding:8px 14px; border:0; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .muted { color:var(--vscode-descriptionForeground); font-size:12px; }
  .status { margin:14px 0; padding:10px; background:var(--vscode-textBlockQuote-background); border-left:3px solid var(--vscode-textBlockQuote-border); }
  .message { margin-bottom:14px; color:var(--vscode-notificationsInfoIcon-foreground); }
</style>
</head>
<body>
  <h1>Simple Autocomplete</h1>
  <p class="muted">Provider-agnostic OpenAI-compatible inline completion. Direct API keys are stored in VS Code SecretStorage and never written to settings.json.</p>
  ${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}
  <div class="status"><strong>API key:</strong> ${escapeHtml(v.keyStatus)}</div>
  <div class="grid">
    <div class="full row"><input id="enabled" type="checkbox" ${v.enabled ? 'checked' : ''}><label for="enabled" style="margin:0">Enabled</label></div>
    <div class="full"><label for="endpoint">API endpoint</label><input id="endpoint" value="${escapeHtml(v.endpoint)}" placeholder="https://provider.example/v1/chat/completions"></div>
    <div><label for="model">Model</label><input id="model" value="${escapeHtml(v.model)}" placeholder="model-id"></div>
    <div><label>API key source</label><div class="row"><label><input name="keySource" type="radio" value="environment" ${sourceEnv}> Environment variable</label><label><input name="keySource" type="radio" value="secret" ${sourceSecret}> Stored key</label></div></div>
    <div><label for="envVar">Environment variable name</label><input id="envVar" value="${escapeHtml(v.apiKeyEnvVar)}" placeholder="OPENAI_API_KEY"></div>
    <div><label for="apiKey">Direct API key</label><input id="apiKey" type="password" placeholder="${v.hasStoredSecret ? 'Stored securely — leave blank to keep it' : 'Paste key to store securely'}"></div>
    <div class="full"><label for="systemPrompt">System prompt</label><textarea id="systemPrompt">${escapeHtml(v.systemPrompt)}</textarea><div class="muted">Your instructions are editable. A strict JSON output/whitespace contract is appended automatically so indentation and line breaks survive exactly.</div></div>
    <div class="full row"><input id="conservative" type="checkbox" ${v.conservative ? 'checked' : ''}><label for="conservative" style="margin:0">Conservative automatic suggestions (skip low-signal contexts)</label></div>
    <div class="full"><label for="extraBody">Extra request body (JSON)</label><textarea id="extraBody">${escapeHtml(v.extraBody)}</textarea><div class="muted">Provider-specific options, e.g. { "reasoning_effort": "none" }. These values override the default request fields when keys overlap.</div></div>
    <div><label for="maxTokens">Max tokens</label><input id="maxTokens" type="number" value="${v.maxTokens}"></div>
    <div><label for="temperature">Temperature</label><input id="temperature" type="number" step="0.1" value="${v.temperature}"></div>
    <div><label for="prefixChars">Prefix chars</label><input id="prefixChars" type="number" value="${v.prefixChars}"></div>
    <div><label for="suffixChars">Suffix chars</label><input id="suffixChars" type="number" value="${v.suffixChars}"></div>
    <div><label for="timeoutMs">Timeout (ms)</label><input id="timeoutMs" type="number" value="${v.timeoutMs}"></div>
    <div><label for="maxLines">Max ghost-text lines</label><input id="maxLines" type="number" value="${v.maxLines}"></div>
    <div class="full row">
      <button id="save">Save</button>
      <button id="test" class="secondary">Test configuration</button>
      <button id="clear" class="secondary">Clear stored API key</button>
    </div>
  </div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const value = id => document.getElementById(id).value;
const number = id => Number(value(id));
document.getElementById('save').addEventListener('click', () => {
  vscode.postMessage({ type:'save', data:{
    enabled: document.getElementById('enabled').checked,
    endpoint:value('endpoint'), model:value('model'),
    apiKeySource:document.querySelector('input[name="keySource"]:checked').value,
    apiKeyEnvVar:value('envVar'), apiKey:value('apiKey'), systemPrompt:value('systemPrompt'), extraBody:value('extraBody'),
    maxTokens:number('maxTokens'), temperature:number('temperature'), prefixChars:number('prefixChars'), suffixChars:number('suffixChars'), timeoutMs:number('timeoutMs'), maxLines:number('maxLines'), conservative:document.getElementById('conservative').checked
  }});
});
document.getElementById('test').addEventListener('click', () => vscode.postMessage({type:'test'}));
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({type:'clearSecret'}));
</script>
</body></html>`;
}

async function saveConfig(context, data) {
  let extraBody;
  try { extraBody = data.extraBody.trim() ? JSON.parse(data.extraBody) : {}; }
  catch { throw new Error('Extra request body is not valid JSON.'); }
  if (!extraBody || Array.isArray(extraBody) || typeof extraBody !== 'object') throw new Error('Extra request body must be a JSON object.');

  const c = cfg();
  const target = vscode.ConfigurationTarget.Global;
  await Promise.all([
    c.update('enabled', Boolean(data.enabled), target),
    c.update('endpoint', String(data.endpoint).trim(), target),
    c.update('model', String(data.model).trim(), target),
    c.update('apiKeySource', data.apiKeySource === 'secret' ? 'secret' : 'environment', target),
    c.update('apiKeyEnvVar', String(data.apiKeyEnvVar).trim(), target),
    c.update('systemPrompt', String(data.systemPrompt), target),
    c.update('extraBody', extraBody, target),
    c.update('maxTokens', Number(data.maxTokens), target),
    c.update('temperature', Number(data.temperature), target),
    c.update('prefixChars', Number(data.prefixChars), target),
    c.update('suffixChars', Number(data.suffixChars), target),
    c.update('timeoutMs', Number(data.timeoutMs), target),
    c.update('maxLines', Number(data.maxLines), target),
    c.update('conservative', Boolean(data.conservative), target)
  ]);
  if (String(data.apiKey || '').trim()) await context.secrets.store(SECRET_KEY, String(data.apiKey).trim());
  missingKeyWarned = false;
  await updateStatusBar(context);
}

async function openConfig(context) {
  if (configPanel) { configPanel.reveal(); return; }
  configPanel = vscode.window.createWebviewPanel('simpleAutocompleteConfig', 'Simple Autocomplete', vscode.ViewColumn.One, { enableScripts: true });
  configPanel.onDidDispose(() => { configPanel = undefined; });
  configPanel.webview.onDidReceiveMessage(async msg => {
    try {
      if (msg.type === 'save') {
        await saveConfig(context, msg.data);
        await renderConfigPanel(context, configPanel, 'Configuration saved.');
      } else if (msg.type === 'clearSecret') {
        await context.secrets.delete(SECRET_KEY);
        await updateStatusBar(context);
        await renderConfigPanel(context, configPanel, 'Stored API key cleared.');
      } else if (msg.type === 'test') {
        const editor = vscode.window.activeTextEditor;
        let testContext;
        if (editor) {
          testContext = getReplacementContext(editor.document, editor.selection.active);
        } else {
          testContext = {
            fileName: '__simple_autocomplete_test__.py',
            languageId: 'python',
            line: 2,
            column: 10,
            prefix: 'def greet(name):\n    return ',
            target: '',
            suffix: '\n',
            range: undefined,
            lineText: '    return ',
            position: undefined
          };
        }
        const result = await callApiWithContext(context, testContext, undefined, { max_tokens: Math.min(cfg().get('maxTokens', 256), 256) });
        const preview = result.completion ? JSON.stringify(result.completion.slice(0, 180)) : '(no completion — provider call succeeded)';
        await renderConfigPanel(context, configPanel, `Success. Preview: ${preview}`);
      }
    } catch (err) {
      await renderConfigPanel(context, configPanel, `Error: ${err?.message || err}`);
    }
  });
  await renderConfigPanel(context, configPanel);
}

async function activate(context) {
  output = vscode.window.createOutputChannel('Simple Autocomplete');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('simpleAutocomplete.configure', () => openConfig(context)),
    vscode.commands.registerCommand('simpleAutocomplete.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      missingKeyWarned = false;
      await updateStatusBar(context);
      vscode.window.showInformationMessage('Simple Autocomplete: stored API key cleared.');
    }),
    vscode.commands.registerCommand('simpleAutocomplete.showStatus', async () => {
      const auth = await getApiKey(context);
      const c = cfg();
      const status = auth.key ? `Key available via ${auth.source}` : `No key: ${auth.source}`;
      vscode.window.showInformationMessage(`Simple Autocomplete — ${status}. Model: ${c.get('model', '') || '(not configured)'}.`);
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'Simple Autocomplete';
  statusBarItem.command = 'simpleAutocomplete.configure';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();
  await updateStatusBar(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('simpleAutocomplete')) await updateStatusBar(context);
    })
  );

  const selector = [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }];
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(selector, {
    async provideInlineCompletionItems(document, position, inlineContext, token) {
      const mySerial = ++requestSerial;
      const result = await fetchCompletion(context, document, position, inlineContext, token);
      if (token.isCancellationRequested || mySerial !== requestSerial || !result?.completion) return [];

      const { completion, completionContext } = result;
      const range = completionContext.range || new vscode.Range(position, position);

      // Stable VS Code inline-completion ranges are single-line. Multiline output is
      // safe only when the replacement ends at EOL; otherwise suppress it instead
      // of producing broken/shifted ghost text.
      if (completion.includes('\n')) {
        const lineEnd = document.lineAt(range.end.line).range.end;
        if (!range.end.isEqual(lineEnd)) return [];
      }

      const item = new vscode.InlineCompletionItem(completion, range);
      if (!range.isEmpty) {
        // Ensure VS Code is willing to display a genuine replacement, not just an
        // append-only completion. The public API supports same-line replacement ranges.
        item.filterText = completionContext.target + completion;
      }
      return [item];
    }
  }));
}

function deactivate() {}
module.exports = { activate, deactivate };
