'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURSOR_MARKER,
  cropStart,
  cropEnd,
  buildUserMessage,
  responseContract,
  parseCompletion,
  repeatsTextBeforeCursor,
  repeatsTextAfterCursor,
  reintroducesExistingDefinition,
  sanitizeGeneratedText,
  resolveUniqueRange,
  parseEditSuggestions,
  buildEditMessage,
  editContract
} = require('../lib/context');

test('crops context on whole lines so tokens are never split', () => {
  const text = ['aaa', 'bbbbbbbb', 'cc', 'dddddd', 'ee'].join('\n');
  const offset = text.indexOf('ee');

  // Round down to the start of a line.
  assert.equal(cropStart(text, offset, 8), text.indexOf('dddddd'));
  assert.equal(cropStart(text, offset, 1000), 0);

  // Round up to the end of the current line.
  assert.equal(cropEnd(text, text.indexOf('aaa'), 4), text.indexOf('\n', text.indexOf('bbbbbbbb')));
  assert.equal(cropEnd(text, offset, 3), text.length);
});

test('builds one contiguous fill-in-the-middle snippet with a cursor marker', () => {
  const message = buildUserMessage({
    fileName: 'fuels.py',
    languageId: 'python',
    prefix: 'def f(pair):\n    ',
    target: '',
    suffix: '\n    return pair\n'
  });

  assert.match(message, /<CODE>/);
  assert.match(message, /def f\(pair\):\n    ⟪CURSOR⟫\n    return pair\n/);
  assert.doesNotMatch(message, /PREFIX|SUFFIX|TARGET/);
});

test('escapes a cursor marker that already exists in the snippet', () => {
  const message = buildUserMessage({
    fileName: 'x.py',
    languageId: 'python',
    prefix: 'a = "⟪CURSOR⟫"',
    target: '',
    suffix: ''
  });

  assert.equal(message.split(CURSOR_MARKER).length, 2);
});

test('the text contract forbids fences, repetition and invented definitions', () => {
  const contract = responseContract('text');
  assert.match(contract, /raw text/);
  assert.match(contract, /no markdown/i);
  assert.match(contract, /Never repeat text/);
  assert.match(contract, /already exists/);
  assert.match(responseContract('json'), /JSON MODE/);
});

test('parses a plain fill-in-the-middle answer', () => {
  const result = parseCompletion('return pair', {
    prefix: 'def f(pair):\n    ',
    target: '',
    suffix: '\n'
  }, 20);

  assert.equal(result, 'return pair');
});

test('parses a fenced code block that is not JSON', () => {
  assert.equal(parseCompletion('```python\nreturn 1\n```', { prefix: '', suffix: '' }, 20), 'return 1');
});

test('parses a normal JSON contract answer', () => {
  const raw = '{"completion":"    return pair\\n"}';
  assert.equal(parseCompletion(raw, { prefix: '', target: '', suffix: '' }, 20), '    return pair\n');
});

test('parses a fenced truncated JSON envelope without leaking it', () => {
  const raw = '```json\n{\n  "completion": "def foo():\\n    return 1';
  const completion = parseCompletion(raw, { prefix: '', target: '', suffix: '' }, 20);

  assert.equal(completion, 'def foo():\n    return 1');
  assert.doesNotMatch(completion, /```|"completion"/);
});

test('preserves language literals and uses JSON null for no completion', () => {
  assert.equal(parseCompletion('null', { prefix: '', suffix: '' }, 20), 'null');
  assert.equal(parseCompletion('None', { prefix: '', suffix: '' }, 20), 'None');
  assert.equal(parseCompletion('{"completion":null}', {}, 20), '');
});

test('does not repeat a completion the user just accepted', () => {
  assert.equal(repeatsTextBeforeCursor('const b = 2;', 'const a = 1;\nconst b = 2;'), true);
  assert.equal(
    parseCompletion('const b = 2;', {
      prefix: 'const a = 1;\nconst b = 2;',
      target: '',
      suffix: '\n'
    }, 20),
    ''
  );
});

test('does not duplicate text that already follows the cursor', () => {
  assert.equal(repeatsTextAfterCursor('const b = 2;', 'const b = 2;\nconst c = 3;'), true);
  assert.equal(
    parseCompletion('const b = 2;', {
      prefix: 'const a = 1;\n',
      target: '',
      suffix: 'const b = 2;\n'
    }, 20),
    ''
  );
});

test('rejects a completion that reintroduces an existing definition', () => {
  const prefix = [
    'class FuelConfig:',
    '    @cached_property',
    '    def fuel_price_features(self):',
    '        return 1',
    '',
    'def _check_range(pair):',
    '    """Check a range."""'
  ].join('\n');
  const completion = [
    '    @cached_property',
    '    def fuel_price_features(self):',
    '        return 1'
  ].join('\n');

  assert.equal(reintroducesExistingDefinition(completion, prefix, ''), true);
  assert.equal(
    parseCompletion(completion, { prefix, target: '', suffix: '\n    return pair\n' }, 20),
    ''
  );
});

test('keeps a genuinely new definition at module level', () => {
  const completion = 'def brand_new_function():\n    return 1';
  assert.equal(
    parseCompletion(completion, { prefix: 'x = 1\n', target: '', suffix: '\n' }, 20),
    completion
  );
});

test('rejects an answer that echoes the prompt marker', () => {
  assert.equal(
    parseCompletion(`foo ${CURSOR_MARKER} bar`, { prefix: '', target: '', suffix: '' }, 20),
    ''
  );
});

test('caps the number of lines', () => {
  assert.equal(
    parseCompletion('a\nb\nc\nd', { prefix: '', target: '', suffix: '' }, 2),
    'a\nb'
  );
});

test('cuts a following block the model re-emitted', () => {
  const prefix = 'def _check_range(pair):\n    """';
  const suffix = '"""\n    if pair[0] > pair[1]:\n        raise ValueError("bad")\n    return pair\n';
  const completion = [
    '""Check that the range is valid."""',
    '    if pair[0] > pair[1]:',
    '        raise ValueError("bad")',
    '    return pair'
  ].join('\n');

  assert.equal(parseCompletion(completion, { prefix, target: '', suffix }, 20), 'Check that the range is valid.');
});

test('trims a structural overlap with the text after the marker', () => {
  assert.equal(
    parseCompletion('foo())', { prefix: 'bar(', target: '', suffix: '))\n' }, 20),
    'foo('
  );
});

test('does not trim a short identifier overlap', () => {
  assert.equal(
    parseCompletion('values = 1', { prefix: 'value', target: '', suffix: '\n' }, 20),
    'values = 1'
  );
});

test('keeps a normal multi-line completion intact', () => {
  const completion = '    return pair\n\n';
  assert.equal(
    sanitizeGeneratedText(completion, 'def f(pair):\n    ', '\n'),
    completion
  );
});

test('native FIM preserves code without interpreting chat envelopes or stripping whitespace', () => {
  const code = ['null', 'None', '{"completion":"literal"}', '```js\ncode\n```', '\n    return 1\n', '    ', 'def existing():\n    pass'];
  for (const raw of code) {
    assert.equal(parseCompletion(raw, { prefix: 'def existing():\n', suffix: '' }, 20, { mode: 'fim' }), raw);
  }
});

test('does not strip a new line and its indentation at the cursor', () => {
  assert.equal(parseCompletion('\n    return 1', { prefix: 'def f():\n    ', suffix: '' }, 20), '\n    return 1');
});

test('suffix budget zero sends no following context and long lines keep the cursor in bounds', () => {
  const text = 'x'.repeat(100) + '\nnext';
  assert.equal(cropEnd(text, 2, 0), 2);
  assert.ok(cropStart(text, 80, 20) <= 80);
  assert.equal(text.slice(cropStart(text, 80, 20), 80), 'x'.repeat(20));
});

test('does not interpret completion fields embedded inside raw code as an envelope', () => {
  const raw = 'const payload = {"completion":"hello"};';
  assert.equal(parseCompletion(raw, {}, 20), raw);
});

test('trims a closing delimiter already supplied by the editor', () => {
  assert.equal(parseCompletion('value)', { prefix: 'call(', suffix: ')' }, 20), 'value');
});

test('removes chat reasoning but rejects unfinished reasoning', () => {
  assert.equal(parseCompletion('<think>let me think</think>\nreturn 1', {}, 20), 'return 1');
  assert.equal(parseCompletion('<think>unfinished', {}, 20), '');
});

test('locates an edit by unique text and refuses ambiguous ones', () => {
  const text = 'a = 1\nb = 1\n';

  assert.deepEqual(resolveUniqueRange(text, 'a = 1'), { startOffset: 0, endOffset: 5 });
  assert.equal(resolveUniqueRange(text, '= 1'), null);
  assert.equal(resolveUniqueRange(text, 'missing'), null);
});

test('parses suggested edits anywhere in the document', () => {
  const documentText = [
    'class GenerationFeature(FeatureConfig):',
    '    n_blocks: int = Field(ge=0)',
    '    #: Column holding the realised view.',
    '    actual_counterpart: str = None'
  ].join('\n');
  const raw = JSON.stringify({
    edits: [
      {
        find: 'actual_counterpart: str = None',
        replace: 'actual_counterpart: str | None = None',
        reason: 'Field accepts None'
      }
    ]
  });

  const edits = parseEditSuggestions(raw, documentText, 3);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].replace, 'actual_counterpart: str | None = None');
  assert.equal(documentText.slice(edits[0].startOffset, edits[0].endOffset), 'actual_counterpart: str = None');
  assert.equal(edits[0].reason, 'Field accepts None');
});

test('parses a fenced edit answer and drops unusable entries', () => {
  const documentText = 'x = 1\n';
  const raw = [
    '```json',
    JSON.stringify({
      edits: [
        { find: 'missing', replace: 'y', reason: 'nope' },
        { find: 'x = 1', replace: 'x = 1\ny = 2', reason: 'add y' }
      ]
    }),
    '```'
  ].join('\n');

  const edits = parseEditSuggestions(raw, documentText, 3);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].replace, 'x = 1\ny = 2');
});

test('caps the number of suggested edits', () => {
  const documentText = 'a\nb\nc\n';
  const raw = JSON.stringify({
    edits: [
      { find: 'a', replace: 'A' },
      { find: 'b', replace: 'B' },
      { find: 'c', replace: 'C' }
    ]
  });

  assert.equal(parseEditSuggestions(raw, documentText, 2).length, 2);
});

test('builds an edit review request in find/replace form', () => {
  const message = buildEditMessage({
    fileName: 'fuels.py',
    languageId: 'python',
    code: 'x = 1',
    maxEdits: 3
  });

  assert.match(message, /"find"/);
  assert.match(message, /"replace"/);
  assert.match(message, /at most 3/);
  assert.match(message, /<CODE>\nx = 1\n<\/CODE>/);
  assert.match(editContract(), /code reviewer/);
});

test('edit matches must be unique even when occurrences overlap', () => {
  assert.equal(resolveUniqueRange('aaa', 'aa'), null);
});

test('edit review rejects overlapping suggestions and changes outside the supplied context', () => {
  const text = 'outside\nfirst second\nlast';
  const raw = JSON.stringify({ edits: [
    { find: 'outside', replace: 'OUTSIDE' },
    { find: 'first second', replace: 'changed' },
    { find: 'second', replace: 'overlaps' },
    { find: 'last', replace: 'LAST' }
  ] });
  const edits = parseEditSuggestions(raw, text, 3, { startOffset: 8, endOffset: 20 });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].find, 'first second');
});
