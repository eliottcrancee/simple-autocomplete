const vscode = require('vscode');
const {
  CURSOR_MARKER,
  cropStart,
  cropEnd,
  parseCompletion,
  buildUserMessage,
  responseContract,
  buildEditMessage,
  editContract,
  parseEditSuggestions,
  resolveUniqueRange
} = require('./lib/context');
const { buildRequest, resolveApiMode, sendRequest, waitForDebounce } = require('./lib/api');

const SECRET_KEY = 'simpleAutocomplete.apiKey';
const DEFAULT_SYSTEM_PROMPT = `You are an inline code completion engine. You receive a snippet of a file containing a single cursor marker ${CURSOR_MARKER}. Write the text that belongs exactly at that marker.

Guidelines:
- Complete the current construct: statement, expression, block, documentation or string.
- Match the language, indentation, quotes, naming, and comment/documentation style of the snippet.
- Stay local. Do not invent or paste code that belongs elsewhere in the file.
- Never repeat text that is already present before or after the marker.
- It is better to return nothing than to guess something the user did not ask for.`;
let requestSerial = 0;
let activeCompletion;
let activeCompletionUri;
let lastRequest = '';
let missingKeyWarned = false;
let configPanel;
let statusBarItem;
let output;
const pendingEdits = new Map();
let codeLensEmitter;

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

function getReplacementContext(document, position, inlineContext) {
  const fullText = document.getText();
  const cursorOffset = document.offsetAt(position);
  let range = new vscode.Range(position, position);
  let acceptedPrefix = '';

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === document.uri.toString()) {
    const selection = editor.selection;
    if (!selection.isEmpty && selection.start.line === selection.end.line && selection.contains(position)) {
      range = new vscode.Range(selection.start, selection.end);
    }
  }

  const selected = inlineContext?.selectedCompletionInfo;
  if (selected && selected.range.start.line === selected.range.end.line && selected.range.contains(position)) {
    range = selected.range;
    acceptedPrefix = selected.text;
  }

  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const target = fullText.slice(startOffset, endOffset);
  const c = cfg();
  const prefixChars = c.get('prefixChars', 4000);
  const suffixChars = c.get('suffixChars', 1500);

  // Whole-line, bounded context around the replacement range. Keeping the window
  // small and local is what stops the model from pulling in unrelated code.
  return {
    fileName: document.fileName || 'untitled',
    languageId: document.languageId,
    line: position.line + 1,
    column: position.character + 1,
    prefix: fullText.slice(cropStart(fullText, startOffset, prefixChars), startOffset) + acceptedPrefix,
    target,
    suffix: fullText.slice(endOffset, cropEnd(fullText, endOffset, suffixChars)),
    range,
    acceptedPrefix,
    fullText,
    startOffset,
    endOffset,
    lineText: document.lineAt(position.line).text,
    position,
    cursorOffset
  };
}

function shouldRequestAutomatically(document, position, context) {
  if (context?.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) return true;

  const c = cfg();
  if (!c.get('conservative', true)) return true;

  const line = document.lineAt(position.line).text;
  const before = line.slice(0, position.character);
  const after = line.slice(position.character);

  // Never spend a request on a completely empty top-level line unless the previous
  // line clearly opens a block/expression. Indented blank lines are still useful.
  if (!before.trim() && !after.trim()) {
    const indentation = before.length;
    const prev = position.line > 0 ? document.lineAt(position.line - 1).text.trimEnd() : '';
    const last = prev.slice(-1);
    const opensContext = Boolean(last) && (':=([{.,\\'.includes(last) || /(?:return|yield|raise|await)\s*$/.test(prev));
    if (indentation === 0 && !opensContext) return false;
  }

  return true;
}

function buildMessagesFromContext(completionContext) {
  const c = cfg();
  const customPrompt = c.get('systemPrompt', DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT;
  const format = c.get('responseFormat', 'text') === 'json' ? 'json' : 'text';
  const systemPrompt = `${customPrompt.trim()}\n\n${responseContract(format)}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildUserMessage(completionContext) }
  ];
}

async function requestCompletion(context, messages, token, overrides = {}, completionContext) {
  const c = cfg();
  const auth = await getApiKey(context);
  if (!auth.key) throw new Error(`No API key available from ${auth.source}.`);
  const { timeoutMs: timeoutOverride, ...bodyOverrides } = overrides;
  const request = buildRequest({
    endpoint: c.get('endpoint', ''),
    apiMode: c.get('apiMode', 'auto'),
    model: c.get('model', ''),
    temperature: c.get('temperature', 0),
    maxTokens: c.get('maxTokens', 256),
    extraBody: c.get('extraBody', {}) || {}
  }, completionContext, messages, bodyOverrides);
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : c.get('timeoutMs', 5000);
  const started = Date.now();
  try {
    const result = await sendRequest(request, { key: auth.key, timeoutMs, token });
    lastRequest = `${request.mode}: ${Date.now() - started} ms, ${result.raw.length} generated characters`;
    output.appendLine(`[request] ${lastRequest}`);
    return result;
  } catch (err) {
    if (err?.name !== 'AbortError') lastRequest = `${request.mode}: ${err.message}`;
    throw err;
  }
}

async function callApiWithContext(context, completionContext, token, overrides = {}) {
  const c = cfg();
  const { raw, data, mode } = await requestCompletion(context, buildMessagesFromContext(completionContext), token, overrides, completionContext);
  const completion = parseCompletion(raw, completionContext, c.get('maxLines', 20), { mode });
  if (raw && !completion) output.appendLine('[completion] Empty after output filtering.');
  return { completion, raw, data };
}

async function callApi(context, document, position, token, overrides = {}, completionContext) {
  const ctx = completionContext || getReplacementContext(document, position);
  const result = await callApiWithContext(context, ctx, token, overrides);
  return { ...result, completionContext: ctx };
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
  const ready = auth.key && model !== '(not configured)' && String(c.get('endpoint', '')).trim();
  statusBarItem.text = activeCompletion ? '$(sync~spin) SA' : ready ? '$(sparkle) SA' : '$(warning) SA';
  statusBarItem.tooltip = [
    'Simple Autocomplete',
    `Model: ${model}`,
    `API mode: ${c.get('apiMode', 'auto')}`,
    `API key: ${auth.key ? `available via ${auth.source}` : `missing (${auth.source})`}`,
    lastRequest ? `Last request: ${lastRequest}` : 'No requests yet',
    'Click to configure'
  ].join('\n');
  statusBarItem.backgroundColor = ready ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
}

async function fetchCompletion(context, document, position, inlineContext, token) {
  const c = cfg();
  if (!c.get('enabled', true)) return null;
  if (c.get('excludedLanguages', ['plaintext', 'dotenv', 'scminput']).includes(document.languageId)) return null;

  // Build the context once so the same snippet drives the gate and the request.
  const completionContext = getReplacementContext(document, position, inlineContext);
  if (!shouldRequestAutomatically(document, position, inlineContext)) return null;

  try {
    if (statusBarItem) statusBarItem.text = '$(sync~spin) SA';
    const result = await callApi(context, document, position, token, {}, completionContext);
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
    await updateStatusBar(context);
  }
}

// --- Suggested edits anywhere in the document ---------------------------------
// The stable inline-completion API cannot render ghost text away from the cursor.
// CodeLens is the native, stable way to attach a one-click action to a line
// elsewhere: the model returns find/replace pairs, we locate each one exactly and
// anchor a lens on its line.

function editsKey(document) {
  return document.uri.toString();
}

async function suggestEdits(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Simple Autocomplete: open a file first.');
    return;
  }
  const document = editor.document;
  const c = cfg();
  if (!c.get('enabled', true)) return;
  if (c.get('excludedLanguages', ['plaintext', 'dotenv', 'scminput']).includes(document.languageId)) return;

  const fullText = document.getText();
  const version = document.version;
  const cursorOffset = document.offsetAt(editor.selection.active);
  const code = fullText.slice(cropStart(fullText, cursorOffset, 6000), cropEnd(fullText, cursorOffset, 4000));
  const maxEdits = c.get('maxEdits', 3);
  const messages = [
    { role: 'system', content: editContract() },
    {
      role: 'user',
      content: buildEditMessage({
        fileName: document.fileName || 'untitled',
        languageId: document.languageId,
        code,
        maxEdits
      })
    }
  ];

  try {
    if (statusBarItem) statusBarItem.text = '$(sync~spin) SA';
    const { raw } = await requestCompletion(context, messages, undefined, {
      max_tokens: Math.max(c.get('maxTokens', 256), 700),
      timeoutMs: Math.max(c.get('timeoutMs', 5000), 30000)
    });
    if (document.version !== version || document.isClosed) return;
    const edits = parseEditSuggestions(raw, fullText, maxEdits).map((edit, index) => ({
      ...edit,
      id: `${document.version}-${index}`
    }));
    if (edits.length) {
      pendingEdits.set(editsKey(document), { version: document.version, edits });
    } else {
      pendingEdits.delete(editsKey(document));
    }
    codeLensEmitter?.fire();
    vscode.window.showInformationMessage(
      edits.length
        ? `Simple Autocomplete: ${edits.length} suggested edit(s). Click the sparkle lens above the line.`
        : 'Simple Autocomplete: no edits suggested for this file.'
    );
  } catch (err) {
    output.appendLine(`[edits] ${err?.stack || err}`);
    vscode.window.showErrorMessage(`Simple Autocomplete: ${err?.message || err}`);
  } finally {
    if (statusBarItem) statusBarItem.text = '$(sparkle) SA';
  }
}

async function applySuggestedEdit(uriString, editId) {
  const entry = pendingEdits.get(uriString);
  if (!entry) return;
  const edit = entry.edits.find(candidate => candidate.id === editId);
  if (!edit) return;

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
  if (entry.version !== document.version || document.getText().slice(edit.startOffset, edit.endOffset) !== edit.find) {
    pendingEdits.delete(uriString);
    codeLensEmitter?.fire();
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  const range = new vscode.Range(document.positionAt(edit.startOffset), document.positionAt(edit.endOffset));
  workspaceEdit.replace(document.uri, range, edit.replace);
  if (!(await vscode.workspace.applyEdit(workspaceEdit))) return;

  // Offsets shift after an edit: re-locate the remaining suggestions on the new text.
  const updatedText = document.getText();
  const remaining = entry.edits
    .filter(candidate => candidate.id !== editId)
    .map(candidate => {
      const resolved = resolveUniqueRange(updatedText, candidate.find);
      return resolved ? { ...candidate, ...resolved } : null;
    })
    .filter(Boolean);
  if (remaining.length) pendingEdits.set(uriString, { version: document.version, edits: remaining });
  else pendingEdits.delete(uriString);
  codeLensEmitter?.fire();
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
    apiMode: c.get('apiMode', 'auto'),
    model: c.get('model', ''),
    apiKeySource: c.get('apiKeySource', 'environment'),
    apiKeyEnvVar: c.get('apiKeyEnvVar', 'OPENAI_API_KEY'),
    hasStoredSecret: Boolean(secret),
    keyStatus: auth.key ? `Available via ${auth.source}` : `Unavailable: ${auth.source}`,
    systemPrompt: c.get('systemPrompt', ''),
    extraBody: JSON.stringify(c.get('extraBody', {}) || {}, null, 2),
    maxTokens: c.get('maxTokens', 256),
    temperature: c.get('temperature', 0),
    prefixChars: c.get('prefixChars', 4000),
    suffixChars: c.get('suffixChars', 1500),
    debounceMs: c.get('debounceMs', 150),
    timeoutMs: c.get('timeoutMs', 5000),
    maxLines: c.get('maxLines', 20),
    conservative: c.get('conservative', true),
    responseFormat: c.get('responseFormat', 'text')
  };
}

async function renderConfigPanel(context, panel, message = '', kind = 'info') {
  const v = await currentConfig(context);
  const n = nonce();
  const sourceEnv = v.apiKeySource === 'environment' ? 'checked' : '';
  const sourceSecret = v.apiKeySource === 'secret' ? 'checked' : '';
  const messageClass = kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'info';
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
  .message { margin-top:14px; padding:10px 12px; border-radius:3px; white-space:pre-wrap; word-break:break-word; }
  .message.info { border:1px solid var(--vscode-input-border, transparent); background:var(--vscode-textBlockQuote-background); }
  .message.success { color:var(--vscode-charts-green); border:1px solid var(--vscode-charts-green); }
  .message.error { color:var(--vscode-errorForeground); border:1px solid var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h1>Simple Autocomplete</h1>
  <p class="muted">Provider-agnostic OpenAI-compatible inline completion. Direct API keys are stored in VS Code SecretStorage and never written to settings.json.</p>
  <div class="status"><strong>API key:</strong> ${escapeHtml(v.keyStatus)}</div>
  <div class="grid">
    <div class="full row"><input id="enabled" type="checkbox" ${v.enabled ? 'checked' : ''}><label for="enabled" style="margin:0">Enabled</label></div>
    <div class="full"><label for="endpoint">API endpoint</label><input id="endpoint" value="${escapeHtml(v.endpoint)}" placeholder="https://provider.example/v1/chat/completions"></div>
    <div><label for="model">Model</label><input id="model" value="${escapeHtml(v.model)}" placeholder="model-id"></div>
    <div><label for="apiMode">API mode</label><select id="apiMode"><option value="auto" ${v.apiMode === 'auto' ? 'selected' : ''}>Auto (detect from endpoint)</option><option value="chat" ${v.apiMode === 'chat' ? 'selected' : ''}>Chat completions (GreenPT, compatible APIs)</option><option value="fim" ${v.apiMode === 'fim' ? 'selected' : ''}>Native FIM (Mistral Codestral)</option></select></div>
    <div class="full muted">Chat sends messages. Native FIM sends the code before the cursor as prompt and the code after it as suffix. Auto selects FIM for /fim/completions endpoints.</div>
    <div><label>API key source</label><div class="row"><label><input name="keySource" type="radio" value="environment" ${sourceEnv}> Environment variable</label><label><input name="keySource" type="radio" value="secret" ${sourceSecret}> Stored key</label></div></div>
    <div><label for="envVar">Environment variable name</label><input id="envVar" value="${escapeHtml(v.apiKeyEnvVar)}" placeholder="OPENAI_API_KEY"></div>
    <div><label for="apiKey">Direct API key</label><input id="apiKey" type="password" placeholder="${v.hasStoredSecret ? 'Stored securely — leave blank to keep it' : 'Paste key to store securely'}"></div>
    <div><label for="responseFormat">Chat response format (ignored in native FIM)</label><select id="responseFormat"><option value="text" ${v.responseFormat === 'text' ? 'selected' : ''}>Raw insertion text</option><option value="json" ${v.responseFormat === 'json' ? 'selected' : ''}>JSON contract</option></select></div>
    <div><label for="debounceMs">Typing delay (ms)</label><input id="debounceMs" type="number" min="0" max="2000" value="${v.debounceMs}"></div>
    <div class="full"><label for="systemPrompt">Chat system prompt (ignored in native FIM)</label><textarea id="systemPrompt">${escapeHtml(v.systemPrompt)}</textarea><div class="muted">A response contract is appended automatically for chat requests.</div></div>
    <div class="full row"><input id="conservative" type="checkbox" ${v.conservative ? 'checked' : ''}><label for="conservative" style="margin:0">Conservative automatic suggestions (skip low-signal contexts)</label></div>
    <div class="full"><label for="extraBody">Extra generation options (JSON)</label><textarea id="extraBody">${escapeHtml(v.extraBody)}</textarea><div class="muted">For example { "reasoning_effort": "none" } if supported by the chat model. Model, stream and context fields are managed by the extension.</div></div>
    <div><label for="maxTokens">Max tokens</label><input id="maxTokens" type="number" value="${v.maxTokens}"></div>
    <div><label for="temperature">Temperature</label><input id="temperature" type="number" step="0.1" value="${v.temperature}"></div>
    <div><label for="prefixChars">Prefix chars</label><input id="prefixChars" type="number" value="${v.prefixChars}"></div>
    <div><label for="suffixChars">Suffix chars</label><input id="suffixChars" type="number" value="${v.suffixChars}"></div>
    <div><label for="timeoutMs">Timeout (ms)</label><input id="timeoutMs" type="number" value="${v.timeoutMs}"></div>
    <div><label for="maxLines">Max ghost-text lines</label><input id="maxLines" type="number" value="${v.maxLines}"></div>
    <div class="full row">
      <button id="save">Save</button>
      <button id="test" class="secondary">Test configuration</button>
      <button id="resetPrompt" class="secondary">Reset prompt to default</button>
      <button id="clear" class="secondary">Clear stored API key</button>
    </div>
    ${message ? `<div class="message ${messageClass}">${escapeHtml(message)}</div>` : ''}
  </div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const value = id => document.getElementById(id).value;
const number = id => Number(value(id));
document.getElementById('save').addEventListener('click', () => {
  vscode.postMessage({ type:'save', data:{
    enabled: document.getElementById('enabled').checked,
    endpoint:value('endpoint'), model:value('model'), apiMode:value('apiMode'), debounceMs:number('debounceMs'),
    apiKeySource:document.querySelector('input[name="keySource"]:checked').value,
    apiKeyEnvVar:value('envVar'), apiKey:value('apiKey'), systemPrompt:value('systemPrompt'), extraBody:value('extraBody'), responseFormat:value('responseFormat'),
    maxTokens:number('maxTokens'), temperature:number('temperature'), prefixChars:number('prefixChars'), suffixChars:number('suffixChars'), timeoutMs:number('timeoutMs'), maxLines:number('maxLines'), conservative:document.getElementById('conservative').checked
  }});
});
document.getElementById('test').addEventListener('click', () => vscode.postMessage({type:'test'}));
document.getElementById('resetPrompt').addEventListener('click', () => vscode.postMessage({type:'resetPrompt'}));
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
    c.update('apiMode', ['chat', 'fim'].includes(data.apiMode) ? data.apiMode : 'auto', target),
    c.update('debounceMs', Math.max(0, Math.min(2000, Number(data.debounceMs) || 0)), target),
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
    c.update('conservative', Boolean(data.conservative), target),
    c.update('responseFormat', data.responseFormat === 'json' ? 'json' : 'text', target)
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
        await renderConfigPanel(context, configPanel, 'Configuration saved.', 'success');
      } else if (msg.type === 'resetPrompt') {
        await cfg().update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
        await renderConfigPanel(context, configPanel, 'System prompt reset to the built-in default.', 'info');
      } else if (msg.type === 'clearSecret') {
        await context.secrets.delete(SECRET_KEY);
        await updateStatusBar(context);
        await renderConfigPanel(context, configPanel, 'Stored API key cleared.', 'info');
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
        const result = await callApiWithContext(context, testContext, undefined, {
          max_tokens: Math.min(cfg().get('maxTokens', 256), 256),
          timeoutMs: Math.max(cfg().get('timeoutMs', 5000), 30000)
        });
        const preview = result.completion
          ? `Test succeeded.\n\nCompletion preview:\n${JSON.stringify(result.completion.slice(0, 300))}${result.completion.length > 300 ? '…' : ''}`
          : 'Test succeeded — the provider responded, but returned no completion for this context.';
        await renderConfigPanel(context, configPanel, preview, 'success');
      }
    } catch (err) {
      await renderConfigPanel(context, configPanel, `Test failed: ${err?.message || err}`, 'error');
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
      let mode;
      try { mode = resolveApiMode(c.get('apiMode', 'auto'), c.get('endpoint', '')); } catch { mode = 'invalid endpoint'; }
      vscode.window.showInformationMessage(`Simple Autocomplete — ${status}. Model: ${c.get('model', '') || '(not configured)'}. API: ${mode}. ${lastRequest}`);
    }),
    vscode.commands.registerCommand('simpleAutocomplete.suggestEdits', () => suggestEdits(context)),
    vscode.commands.registerCommand('simpleAutocomplete.applyEdit', (uriString, editId) => applySuggestedEdit(uriString, editId)),
    vscode.commands.registerCommand('simpleAutocomplete.clearEdits', () => {
      pendingEdits.clear();
      codeLensEmitter?.fire();
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
      if (e.affectsConfiguration('simpleAutocomplete')) {
        activeCompletion?.cancel();
        await updateStatusBar(context);
      }
    })
  );

  // Suggested edits: a lens sits above each line the model wants to change, so an
  // edit away from the cursor is still one click, and disappears as soon as the
  // document changes.
  codeLensEmitter = new vscode.EventEmitter();
  context.subscriptions.push(codeLensEmitter);
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === activeCompletionUri) activeCompletion?.cancel();
      const entry = pendingEdits.get(event.document.uri.toString());
      if (entry && entry.version !== event.document.version) {
        pendingEdits.delete(event.document.uri.toString());
        codeLensEmitter?.fire();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async document => {
      if (!cfg().get('suggestEditsOnSave', false)) return;
      if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) return;
      await suggestEdits(context);
    })
  );

  const selector = [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }];
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(document) {
      const entry = pendingEdits.get(document.uri.toString());
      if (!entry || entry.version !== document.version) return [];
      return entry.edits.map(edit => {
        const position = document.positionAt(edit.startOffset);
        return new vscode.CodeLens(document.lineAt(position.line).range, {
          title: `$(sparkle) ${edit.reason || 'Apply suggested edit'}`,
          tooltip: `${edit.find.trim()}\n→\n${edit.replace.trim()}`,
          command: 'simpleAutocomplete.applyEdit',
          arguments: [document.uri.toString(), edit.id]
        });
      });
    }
  }));
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(selector, {
    async provideInlineCompletionItems(document, position, inlineContext, token) {
      const mySerial = ++requestSerial;
      activeCompletion?.cancel();
      const cancellation = new vscode.CancellationTokenSource();
      activeCompletion = cancellation;
      activeCompletionUri = document.uri.toString();
      const subscription = token.onCancellationRequested(() => cancellation.cancel());
      const version = document.version;
      try {
        if (token.isCancellationRequested) return [];
        const delay = inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 0 : cfg().get('debounceMs', 150);
        if (!(await waitForDebounce(delay, cancellation.token))) return [];
        const result = await fetchCompletion(context, document, position, inlineContext, cancellation.token);
        if (cancellation.token.isCancellationRequested || mySerial !== requestSerial || document.version !== version || document.isClosed || !result?.completion) return [];

        const { completionContext } = result;
        const range = completionContext.range;
        const text = completionContext.acceptedPrefix + result.completion;
        const completion = document.eol === vscode.EndOfLine.CRLF ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
        return [new vscode.InlineCompletionItem(completion, range)];
      } finally {
        subscription.dispose();
        if (activeCompletion === cancellation) {
          activeCompletion = undefined;
          activeCompletionUri = undefined;
        }
        cancellation.dispose();
        await updateStatusBar(context);
      }
    }
  }));
}

function deactivate() { activeCompletion?.cancel(); }
module.exports = { activate, deactivate };
