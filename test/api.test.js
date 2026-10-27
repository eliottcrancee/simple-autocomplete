'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, resolveApiMode, readCompletion, sendRequest } = require('../lib/api');

const options = { endpoint: 'https://api.greenpt.ai/v1/chat/completions', model: 'test-model' };
const context = { prefix: 'def greet(name):\n    return ', suffix: '\n' };
const messages = [{ role: 'user', content: 'complete this' }];

test('chat and Codestral FIM use distinct payloads and automatic endpoint detection', () => {
  const chat = buildRequest(options, context, messages);
  assert.equal(chat.mode, 'chat');
  assert.deepEqual(chat.body.messages, messages);
  assert.equal(chat.body.prompt, undefined);
  const fim = buildRequest({ ...options, endpoint: 'https://api.mistral.ai/v1/fim/completions', model: 'codestral-latest' }, context, messages);
  assert.equal(fim.mode, 'fim');
  assert.equal(fim.body.prompt, context.prefix);
  assert.equal(fim.body.suffix, context.suffix);
  assert.equal(fim.body.messages, undefined);
  assert.equal(resolveApiMode('chat', fim.endpoint), 'chat');
  assert.equal(resolveApiMode('auto', 'https://example.com/v1/fim/completions/?key=value'), 'fim');
});

test('extra generation options cannot replace the file context or enable unhandled streaming', () => {
  const request = buildRequest({ ...options, extraBody: { stream: true, prompt: 'wrong', suffix: 'wrong', messages: [], model: 'wrong', temperature: 0.2, reasoning_effort: 'none' } }, context, messages);
  assert.equal(request.body.model, options.model);
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.messages, messages);
  assert.equal(request.body.prompt, undefined);
  assert.equal(request.body.temperature, 0.2);
  assert.equal(request.body.reasoning_effort, 'none');
});

test('refuses invalid endpoints and chat-only edits on native FIM', () => {
  assert.throws(() => buildRequest({ ...options, endpoint: 'file:///tmp/test' }, context, messages), /HTTP/);
  assert.throws(() => buildRequest({ ...options, apiMode: 'fim' }, undefined, messages), /Suggested edits require a chat/);
});

test('reads Mistral message content, legacy completion text, and text content parts', () => {
  assert.equal(readCompletion({ choices: [{ message: { content: 'None' } }] }), 'None');
  assert.equal(readCompletion({ choices: [{ text: 'return 1' }] }), 'return 1');
  assert.equal(readCompletion({ choices: [{ message: { content: null } }] }), '');
  assert.equal(readCompletion({ choices: [{ message: { content: [{ type: 'text', text: 'return ' }, { type: 'text', text: '1' }] } }] }), 'return 1');
  assert.throws(() => readCompletion({ choices: [] }), /no completion choices/);
});

test('reports provider error details and malformed responses', async () => {
  const request = buildRequest(options, context, messages);
  await assert.rejects(sendRequest(request, { key: 'test', timeoutMs: 1000, fetchImpl: async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"error":{"message":"Unsupported model"}}' }) }), /HTTP 400 Bad Request: Unsupported model/);
  await assert.rejects(sendRequest(request, { key: 'test', timeoutMs: 1000, fetchImpl: async () => ({ ok: true, text: async () => 'not JSON' }) }), /non-JSON/);
});

test('a cancelled request never calls fetch', async () => {
  let called = false;
  await assert.rejects(sendRequest(buildRequest(options, context, messages), {
    key: 'test', timeoutMs: 1000, token: { isCancellationRequested: true },
    fetchImpl: async () => { called = true; }
  }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('a timeout is reported as a failure rather than silent user cancellation', async () => {
  await assert.rejects(sendRequest(buildRequest(options, context, messages), {
    key: 'test', timeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error(); error.name = 'AbortError'; reject(error); });
    })
  }), /timed out after 5 ms/);
});
