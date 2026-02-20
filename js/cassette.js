/**
 * cassette.js
 * Cassette key automation for gross pathology dictation
 *
 * Trigger model:
 *   - Dragon Medical One handles "new line" internally as Enter — no phrase appears in text
 *   - Auto-increment fires on the first input event on a new empty line
 *     whose previous non-empty line is a cassette block entry
 *   - Specimen letter is inferred passively from template text:
 *       "^[A-Z]. The specimen is received" → updates expected specimen letter
 *   - Manual buttons and undo are also supported
 */

const Cassette = (() => {

    // Matches a cassette block line at the start: e.g. A1-  A12\t  B3:  C20–
    const BLOCK_PATTERN = /^([A-Z])(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Matches specimen header line: "B. The specimen is received"
    const SPECIMEN_HEADER_PATTERN = /^([A-Z])\.\s+[Tt]he specimen is received/;

    // Internal state
    let lastAutoInsert = null;   // tracks what was auto-inserted for undo
    let _textarea = null;        // reference to the watched textarea
    let _ignoreNext = false;     // prevents re-triggering after our own insertions

    // ── Parsing ────────────────────────────────────────────────────────────────

    function parseBlockLine(line) {
        const trimmed = line.trimEnd();
        const match = trimmed.match(BLOCK_PATTERN);
        if (!match) return null;
        return {
            letter:    match[1],
            number:    parseInt(match[2], 10),
            separator: match[3],
            raw:       match[0]
        };
    }

    // Returns the previous non-empty line relative to the cursor line
    function getPreviousNonEmptyLine(textarea) {
        const text  = textarea.value;
        const pos   = textarea.selectionStart;
        const lines = text.substring(0, pos).split('\n');
        // lines[last] is the current (possibly partial) line
        for (let i = lines.length - 2; i >= 0; i--) {
            if (lines[i].trim() !== '') return lines[i];
        }
        return null;
    }

    // Returns true if the cursor is on a line containing exactly one character
    // (i.e. the very first character just inserted by DMO on a new line)
    function cursorIsOnFreshLine(textarea) {
        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd   = text.indexOf('\n', pos);
        const currentLine = text.substring(
            lineStart,
            lineEnd === -1 ? text.length : lineEnd
        );
        return currentLine.length === 1;
    }

    // Scan entire text for specimen header lines, return last detected letter
    function inferSpecimenFromText(text) {
        const lines = text.split('\n');
        let currentLetter = null;
        for (const line of lines) {
            const m = line.match(SPECIMEN_HEADER_PATTERN);
            if (m) currentLetter = m[1];
        }
        return currentLetter;
    }

    // Find the last cassette block line above the cursor
    function findLastBlock(textarea) {
        const text  = textarea.value.substring(0, textarea.selectionStart);
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const parsed = parseBlockLine(lines[i]);
            if (parsed) return { parsed, lineIndex: i };
        }
        return null;
    }

    // ── Separator helpers ───────────────────────────────────────────────────────

    function normalizeSeparator(sep) {
        if (!sep) return '-';
        if (sep === '\t') return '\t';
        return sep;
    }

    function buildPrefix(letter, number, separator) {
        return `${letter}${number}${separator}`;
    }

    // ── Core insertion ──────────────────────────────────────────────────────────

    function insertAtCursor(textarea, text) {
        const start  = textarea.selectionStart;
        const end    = textarea.selectionEnd;
        const before = textarea.value.substring(0, start);
        const after  = textarea.value.substring(end);
        textarea.value = before + text + after;
        const newPos = start + text.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
    }

    // Prepend prefix to the current line before the character just typed by DMO
    function prependToCurrentLine(textarea, prefix) {
        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const before    = text.substring(0, lineStart);
        const rest      = text.substring(lineStart);
        textarea.value  = before + prefix + rest;
        const newPos    = lineStart + prefix.length + (pos - lineStart);
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
    }

    // ── Public actions ──────────────────────────────────────────────────────────

    // Append a new block line — used by manual button
    function handleNewBlock(textarea) {
        const result = findLastBlock(textarea);
        if (!result) return false;
        const { parsed } = result;
        const sep    = normalizeSeparator(parsed.separator);
        const prefix = buildPrefix(parsed.letter, parsed.number + 1, sep);
        _ignoreNext  = true;
        insertAtCursor(textarea, '\n' + prefix);
        lastAutoInsert = { inserted: '\n' + prefix, length: ('\n' + prefix).length };
        return true;
    }

    // Append a new specimen line — used by manual button
    function handleNewSpecimen(textarea) {
        const result = findLastBlock(textarea);
        if (!result) return false;
        const { parsed }  = result;
        const sep         = normalizeSeparator(parsed.separator);
        const nextLetter  = String.fromCharCode(parsed.letter.charCodeAt(0) + 1);
        const prefix      = buildPrefix(nextLetter, 1, sep);
        _ignoreNext       = true;
        insertAtCursor(textarea, '\n' + prefix);
        lastAutoInsert    = { inserted: '\n' + prefix, length: ('\n' + prefix).length };
        return true;
    }

    // Undo last auto-insert
    function handleUndo(textarea) {
        if (!lastAutoInsert) return false;
        const pos   = textarea.selectionStart;
        const text  = textarea.value;
        const start = pos - lastAutoInsert.length;
        if (start < 0) return false;
        if (text.substring(start, pos) === lastAutoInsert.inserted) {
            textarea.value = text.substring(0, start) + text.substring(pos);
            textarea.selectionStart = textarea.selectionEnd = start;
            lastAutoInsert = null;
            return true;
        }
        return false;
    }

    // ── Auto-trigger on input ───────────────────────────────────────────────────

    function onInput(e) {
        const textarea = e.target;

        if (_ignoreNext) {
            _ignoreNext = false;
            return;
        }

        // Only act on the very first character typed on a new line
        if (!cursorIsOnFreshLine(textarea)) return;

        // Check the previous non-empty line is a cassette block
        const prevLine = getPreviousNonEmptyLine(textarea);
        if (!prevLine) return;

        const parsed = parseBlockLine(prevLine);
        if (!parsed) return;

        // Prepend the next block prefix before what was just typed
        const sep    = normalizeSeparator(parsed.separator);
        const prefix = buildPrefix(parsed.letter, parsed.number + 1, sep);

        _ignoreNext = true;
        prependToCurrentLine(textarea, prefix);

        lastAutoInsert = { inserted: prefix, length: prefix.length };

        // Dispatch custom event for UI layer
        textarea.dispatchEvent(new CustomEvent('cassette:advance', {
            bubbles: true,
            detail: { letter: parsed.letter, from: parsed.number, to: parsed.number + 1, prefix }
        }));
    }

    // ── Init ────────────────────────────────────────────────────────────────────

    function init(textarea) {
        _textarea = textarea;
        textarea.addEventListener('input', onInput);
    }

    // ── Public API ───────────────────────────────────────────────────────────────

    return {
        init,
        handleNewBlock,
        handleNewSpecimen,
        handleUndo,
        parseBlockLine,
        findLastBlock,
        inferSpecimenFromText
    };

})();

document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('dictation');
    if (ta) Cassette.init(ta);
});
