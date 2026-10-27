'use strict';

// A rare, readable placeholder. Code models treat it as the single point where
// text must be produced, whatever the language or construct.
const CURSOR_MARKER = '⟪CURSOR⟫';

const DEFINITION_IN_COMPLETION = /(?:^|\n)[ \t]*(?:(?:async\s+)?(?:def|class)|function|func|fn)\s+([A-Za-z_$][\w$]*)/g;
const DEFINITION_IN_CONTEXT = /(?:def|class|function|func|fn|fun)\s+([A-Za-z_$][\w$]*)/g;

function definitionNames(text, pattern) {
  return [...String(text).matchAll(pattern)].map(match => match[1]);
}

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Keeps the snippet aligned on whole lines so the model never sees a fragment
 * of a token, and crops the context to a predictable window. Context size is the
 * main driver of the "model pastes unrelated code" failures.
 */
function cropStart(fullText, offset, maxChars) {
  const start = Math.max(0, offset - Math.max(0, maxChars));
  if (start === 0) return 0;
  const nextNewline = fullText.indexOf('\n', start);
  return nextNewline === -1 || nextNewline >= offset ? start : nextNewline + 1;
}

function cropEnd(fullText, offset, maxChars) {
  if (maxChars <= 0) return offset;
  const end = Math.min(fullText.length, offset + Math.max(0, maxChars));
  if (end === fullText.length) return end;
  // Round up to the end of the line so the current line is never cut in half.
  const nextNewline = fullText.indexOf('\n', end);
  return nextNewline === -1 ? fullText.length : nextNewline;
}

/**
 * A completion that only restates text already present before the cursor is what
 * makes VS Code re-offer, and the user re-accept, the exact same suggestion.
 */
function repeatsTextBeforeCursor(completion, prefix) {
  const value = normalizeWhitespace(completion);
  if (value.length < 8) return false;
  const before = normalizeWhitespace(prefix).replace(/(?:[`"')\]}]{1,3})$/, '').trim();
  return before.endsWith(value);
}

/**
 * The mirror case: the model predicts text that already exists right after the
 * cursor. Inserting it would duplicate surrounding code.
 */
function repeatsTextAfterCursor(completion, suffix) {
  const value = normalizeWhitespace(completion);
  if (value.length < 8) return false;
  return normalizeWhitespace(suffix).startsWith(value);
}

/**
 * A completion that introduces a definition (function, method, class) whose name
 * already exists in the file is the model copying an unrelated part of the file
 * rather than completing what is at the cursor. Language-agnostic and generic.
 */
function reintroducesExistingDefinition(completion, prefix = '', suffix = '') {
  const names = definitionNames(completion, DEFINITION_IN_COMPLETION);
  if (!names.length) return false;
  const existing = new Set([
    ...definitionNames(prefix, DEFINITION_IN_CONTEXT),
    ...definitionNames(suffix, DEFINITION_IN_CONTEXT)
  ]);
  return names.some(name => existing.has(name));
}

function escapePromptText(text) {
  // Guard against a snippet that itself contains the marker and confuses the model.
  return String(text).split(CURSOR_MARKER).join('⟨?CURSOR?⟩');
}

function buildUserMessage(context) {
  const code = `${escapePromptText(context.prefix)}${CURSOR_MARKER}${escapePromptText(context.suffix)}`;
  return [
    `File: ${context.fileName}`,
    `Language: ${context.languageId}`,
    ...(context.target && !context.acceptedPrefix ? [`Selected text to replace: ${JSON.stringify(context.target)}`] : []),
    '',
    '<CODE>',
    code,
    '</CODE>'
  ].join('\n');
}

/**
 * One generic instruction set, independent of language or construct: the model
 * sees a contiguous snippet and fills the single cursor marker. This is a chat
 * instruction, distinct from a native FIM request, and it covers code bodies,
 * docstrings, comments, strings, expressions, imports and tests without any
 * per-case rule.
 */
function responseContract(format = 'text') {
  const shared = [
    'You are an inline code completion engine.',
    `The snippet below contains exactly one cursor marker ${CURSOR_MARKER}.`,
    'Write the text that belongs exactly at that marker.',
    '',
    'Rules:',
    format === 'json'
      ? '- Output exactly the JSON object specified below. Nothing else.'
      : `- Output only the raw text that replaces ${CURSOR_MARKER}. Nothing else.`,
    '- No explanations, no reasoning, no markdown, no code fences, no labels.',
    '- Never repeat text that already appears before or after the marker.',
    '- Match the language, indentation, quote style, naming and comment/documentation style of the snippet.',
    '- Finish the current construct (statement, expression, block, documentation) and stay local.',
    '- Never introduce a definition (function, method, class) that already exists in the snippet.',
    '- If nothing useful can be added at the marker, output nothing at all.'
  ];
  if (format === 'json') {
    return [
      ...shared,
      '',
      `JSON MODE: reply with exactly one JSON object and nothing else: {"completion":"..."} where the value is the text that replaces ${CURSOR_MARKER}, or {"completion":null} when nothing is useful. Preserve every space, newline and quote exactly; escape them according to JSON rules.`
    ].join('\n');
  }
  return shared.join('\n');
}

function stripFences(text) {
  return text
    .replace(/^\s*```[a-zA-Z0-9_+.-]*[ \t]*\n?/, '')
    .replace(/\n?\s*```\s*$/, '');
}

// --- Fill-in-the-middle overlap hygiene ---------------------------------------
// Code models sometimes re-emit the characters or the lines that already sit right
// before or right after the marker. That turns a correct answer into duplicated
// code. These guards are pure text-level and language-agnostic.

const OVERLAP_MIN = 2;
const DUPLICATE_LINE_MIN = 12;

/**
 * A short overlap is only trusted when it is structural (quotes, brackets,
 * whitespace). A pure identifier overlap must be long before we dare to trim it,
 * so that completing `value` into `values = ...` is never cut to `s = ...`.
 */
function shouldTrimOverlap(overlap) {
  if (overlap.length < OVERLAP_MIN) return false;
  if (/^[A-Za-z0-9_$]+$/.test(overlap)) return overlap.length >= 8;
  return true;
}

function trimOverlapStart(text, prefix) {
  const max = Math.min(text.length, prefix.length);
  for (let length = max; length >= OVERLAP_MIN; length -= 1) {
    const overlap = prefix.slice(prefix.length - length);
    // Spaces at a cursor are not evidence that the model echoed the prefix.
    // In particular, a newline + indentation may start a new statement.
    if (overlap.trim() && text.startsWith(overlap) && shouldTrimOverlap(overlap)) return text.slice(length);
  }
  return text;
}

function trimOverlapEnd(text, suffix) {
  const max = Math.min(text.length, suffix.length);
  for (let length = max; length >= 1; length -= 1) {
    const overlap = suffix.slice(0, length);
    const closingDelimiter = length === 1 && /^["'`)\]}]$/.test(overlap);
    if (text.endsWith(overlap) && (closingDelimiter || shouldTrimOverlap(overlap))) return text.slice(0, text.length - length);
  }
  return text;
}

/**
 * Catches a whole following block being re-emitted: if the answer contains one of
 * the first non-trivial lines that already sit after the marker, everything from
 * that line on is a copy of the suffix and gets cut.
 */
function trimDuplicatedFollowingBlock(text, suffix) {
  if (!suffix) return text;
  const anchors = suffix
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= DUPLICATE_LINE_MIN)
    .slice(0, 3);
  for (const anchor of anchors) {
    const lines = text.split('\n');
    let offset = 0;
    for (const line of lines) {
      if (offset > 0 && line.trim() === anchor) return text.slice(0, offset).replace(/\n[ \t]*$/, '');
      offset += line.length + 1;
    }
  }
  return text;
}

function sanitizeGeneratedText(completion, prefix, suffix) {
  let text = trimOverlapStart(completion, prefix);
  text = trimDuplicatedFollowingBlock(text, suffix);
  text = trimOverlapEnd(text, suffix);
  return text;
}

function decodeJsonStringBody(body) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    // Truncated output: unescape what we can instead of throwing the answer away.
  }
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default:
        out += next;
    }
  }
  return out;
}

function tryJsonContract(text) {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'completion')) {
      if (parsed.completion === null) return '';
      if (typeof parsed.completion === 'string') return parsed.completion;
    }
  } catch {
    // Fall through to the tolerant extractors below.
  }
  return undefined;
}

/** Pulls the `"completion": "..."` value even when the JSON is truncated. */
function extractCompletionField(text) {
  const match = /"completion"\s*:\s*"/.exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let i = start;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') break;
  }
  return decodeJsonStringBody(text.slice(start, i));
}

/** Returns the inner text of a fenced block, with or without a closing fence. */
function extractFencedBlock(text) {
  const match = text.match(/```[a-zA-Z0-9_+.-]*[ \t]*\n?([\s\S]*?)(?:```|$)/);
  if (!match) return undefined;
  return match[1].replace(/\n$/, '');
}

/**
 * Turns a provider answer into the raw text to insert. Tolerates the envelope
 * shapes chat models produce in practice (JSON, fenced JSON, truncated JSON,
 * <COMPLETION> tags, fenced code, plain text) and then applies generic hygiene:
 * no marker echo, no duplicated surrounding text, no reintroduced definitions.
 */
function parseCompletion(raw, context = {}, maxLines, options = {}) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  // Native FIM output is code, not a chat envelope. `null`, JSON objects,
  // markdown fences, repeated method names and whitespace can all be valid code.
  if (options.mode === 'fim') {
    return Number.isFinite(maxLines) ? raw.split('\n').slice(0, maxLines).join('\n') : raw;
  }
  if (/^\s*<think>/i.test(raw)) {
    const end = raw.indexOf('</think>');
    if (end === -1) return '';
    raw = raw.slice(end + '</think>'.length).replace(/^\r?\n/, '');
  }
  const trimmed = raw.trim();
  let completion;

  completion = tryJsonContract(trimmed);

  if (completion === undefined && /^\{\s*"completion"\s*:/.test(trimmed)) {
    completion = extractCompletionField(trimmed);
  }
  if (completion === undefined) {
    const tagged = trimmed.match(/<COMPLETION>([\s\S]*?)<\/COMPLETION>/i);
    if (tagged) completion = tryJsonContract(tagged[1]) ?? extractCompletionField(tagged[1]) ?? tagged[1];
  }
  if (completion === undefined) {
    const fenced = extractFencedBlock(trimmed);
    if (fenced !== undefined) {
      completion = tryJsonContract(fenced) ?? extractCompletionField(fenced) ?? fenced;
    }
  }
  if (completion === undefined) {
    if (/^(?:no completion|no suggestion)$/i.test(trimmed)) return '';
    completion = raw;
  }

  completion = stripFences(completion);
  if (!completion || !completion.trim()) return '';
  if (completion.includes(CURSOR_MARKER) || completion.includes('<CODE>')) return '';
  if (completion === context?.target) return '';

  completion = sanitizeGeneratedText(completion, context?.prefix || '', context?.suffix || '');
  if (!completion || !completion.trim()) return '';

  if (repeatsTextBeforeCursor(completion, context?.prefix)) return '';
  if (repeatsTextAfterCursor(completion, context?.suffix)) return '';
  if (reintroducesExistingDefinition(completion, context?.prefix, context?.suffix)) return '';

  const lines = completion.split('\n');
  if (Number.isFinite(maxLines) && lines.length > maxLines) {
    completion = lines.slice(0, maxLines).join('\n');
  }
  return completion;
}

function parseJsonLoose(raw) {
  const text = stripFences(String(raw ?? '').trim());
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

/**
 * Locates an edit by exact text instead of line/column coordinates. Models are
 * unreliable at counting positions but very reliable at copying a snippet, and a
 * unique match makes the edit safe to apply anywhere in the document.
 */
function resolveUniqueRange(documentText, find) {
  if (typeof find !== 'string' || !find) return null;
  const first = documentText.indexOf(find);
  if (first === -1) return null;
  if (documentText.indexOf(find, first + 1) !== -1) return null;
  return { startOffset: first, endOffset: first + find.length };
}

/**
 * Turns a model answer into a list of safe, verifiable edits anchored anywhere in
 * the document. This is what powers suggestions that are not at the cursor.
 */
function parseEditSuggestions(raw, documentText, maxEdits = 3, scope = {}) {
  if (maxEdits <= 0) return [];
  const parsed = parseJsonLoose(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.edits;
  if (!Array.isArray(list)) return [];
  const edits = [];
  for (const item of list) {
    if (!item || typeof item.find !== 'string' || typeof item.replace !== 'string') continue;
    if (!item.find || item.find === item.replace) continue;
    const range = resolveUniqueRange(documentText, item.find);
    if (!range) continue;
    if (range.startOffset < (scope.startOffset ?? 0) || range.endOffset > (scope.endOffset ?? documentText.length)) continue;
    if (edits.some(edit => range.startOffset < edit.endOffset && edit.startOffset < range.endOffset)) continue;
    edits.push({
      ...range,
      find: item.find,
      replace: item.replace,
      reason: typeof item.reason === 'string' ? item.reason.trim() : ''
    });
    if (edits.length >= maxEdits) break;
  }
  return edits;
}

function buildEditMessage(context) {
  const maxEdits = Number.isFinite(context.maxEdits) ? context.maxEdits : 3;
  return [
    `File: ${context.fileName}`,
    `Language: ${context.languageId}`,
    ...(typeof context.currentLine === 'string' ? [`Cursor line: ${JSON.stringify(context.currentLine)}`, 'Prioritize useful replacements on this line or nearby lines.'] : []),
    '',
    `Review the code below and propose at most ${maxEdits} small, high-confidence corrections that make it more correct or more consistent: type annotations, signatures, error handling, obvious bugs. Do not restyle code for its own sake, and do not rewrite whole functions.`,
    ...(context.automatic ? ['This is an automatic review after typing. Suggest only a concrete improvement supported by the code. Do not complete unfinished typing or duplicate an inline insertion suggestion.'] : []),
    '',
    'Reply with exactly one JSON object and nothing else:',
    '{"edits":[{"find":"<exact existing text>","replace":"<replacement>","reason":"<short label>"}]}',
    'Rules:',
    '- "find" must be copied exactly from the code below and must occur exactly once in the file.',
    '- Prefer the smallest "find" that is still unique (usually the line to change).',
    '- Return {"edits":[]} when nothing genuinely needs changing.',
    '',
    '<CODE>',
    context.code,
    '</CODE>'
  ].join('\n');
}

function editContract() {
  return [
    'You are a code reviewer embedded in the user\'s editor.',
    'You suggest minimal, verifiable edits to the code you are shown.',
    'You never invent files, never propose changes outside the shown code, and you answer only with the requested JSON object.'
  ].join('\n');
}

module.exports = {
  CURSOR_MARKER,
  cropStart,
  cropEnd,
  buildUserMessage,
  responseContract,
  parseCompletion,
  repeatsTextBeforeCursor,
  repeatsTextAfterCursor,
  reintroducesExistingDefinition,
  normalizeWhitespace,
  sanitizeGeneratedText,
  resolveUniqueRange,
  parseEditSuggestions,
  buildEditMessage,
  editContract
};
