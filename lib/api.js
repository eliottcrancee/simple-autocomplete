'use strict';
const { URL } = require('node:url');

function resolveApiMode(mode, endpoint) {
  if (mode === 'chat' || mode === 'fim') return mode;
  try {
    return /\/fim\/completions\/?$/.test(new URL(endpoint).pathname) ? 'fim' : 'chat';
  } catch {
    throw new Error('Configure a valid HTTP(S) API endpoint.');
  }
}

function buildRequest(options, context, messages, overrides = {}) {
  const endpoint = String(options.endpoint || '').trim();
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Configure a valid HTTP(S) API endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Configure a valid HTTP(S) API endpoint.');
  if (!options.model?.trim()) throw new Error('No model configured.');
  const mode = resolveApiMode(options.apiMode, endpoint);
  const body = {
    temperature: options.temperature ?? 0,
    max_tokens: options.maxTokens ?? 256,
    ...options.extraBody,
    ...overrides,
    model: options.model.trim(),
    // Request shape and non-streaming parsing are owned by the extension.
    stream: false
  };
  delete body.messages;
  delete body.prompt;
  delete body.suffix;
  if (mode === 'fim') {
    if (!context) throw new Error('Suggested edits require a chat completions endpoint and chat API mode.');
    body.prompt = context.prefix;
    body.suffix = context.suffix;
  } else {
    body.messages = messages;
  }
  return { endpoint, mode, body };
}

function readCompletion(data) {
  const choice = data?.choices?.[0];
  if (!choice) throw new Error('The provider response has no completion choices.');
  if (choice.message?.content === null && choice.text === undefined) return '';
  const content = choice.message?.content ?? choice.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  }
  if (content === null) return '';
  throw new Error('The provider response has no supported completion text.');
}

function cancelledError() {
  const error = new Error('Request cancelled.');
  error.name = 'AbortError';
  return error;
}

async function sendRequest(request, { key, timeoutMs, token, fetchImpl = fetch }) {
  if (token?.isCancellationRequested) throw cancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancellation = token?.onCancellationRequested?.(() => controller.abort());
  try {
    const response = await fetchImpl(request.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    const responseText = await response.text();
    if (!response.ok) {
      let detail;
      try {
        const parsed = JSON.parse(responseText);
        detail = parsed.error?.message || parsed.message || (typeof parsed.error === 'string' ? parsed.error : '');
      } catch { /* HTTP status remains useful for non-JSON errors. */ }
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
    }
    let data;
    try { data = JSON.parse(responseText); }
    catch { throw new Error('The provider returned a non-JSON response.'); }
    if (token?.isCancellationRequested) throw cancelledError();
    return { raw: readCompletion(data), data, mode: request.mode };
  } catch (error) {
    if (token?.isCancellationRequested) throw cancelledError();
    if (timedOut) throw new Error(`Request timed out after ${timeoutMs} ms. Increase simpleAutocomplete.timeoutMs or disable model reasoning where supported.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation?.dispose?.();
  }
}

function waitForDebounce(ms, token) {
  if (token?.isCancellationRequested) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { cancellation?.dispose?.(); resolve(true); }, ms);
    const cancellation = token?.onCancellationRequested?.(() => { clearTimeout(timer); cancellation?.dispose?.(); resolve(false); });
  });
}

module.exports = { resolveApiMode, buildRequest, readCompletion, sendRequest, waitForDebounce };
