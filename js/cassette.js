/**
 * cassette.js
 * Cassette key automation for gross pathology dictation
 *
 * Trigger model:
 *   - Dragon Medical One handles "new line" internally as Enter
 *   - Auto-increment fires on the first input event on a new empty line
 *     whose previous non-empty line is a cassette block or range entry
 *   - Range detection: A5-A10 or A5-10 → next block is A11
 *   - Indented sub-lines (e.g. "    A10-deepest invasion") are parsed for
 *     the block map but do NOT drive the counter — the range end governs
 *   - Manual buttons and undo are also supported
 */

const Cassette = (() => {

    // Standard cassette line: A1-  A12\t  B3:  C20–
    const BLOCK_PATTERN = /^([A-Z])(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Range line formats:
    //   A5-A10-tumor    (full: explicit end letter)
    //   A5-10-tumor     (short: end letter implied, same as start)
    // The separator AFTER the end block must be dash/en-dash/em-dash/tab/colon/space
    const RANGE_PATTERN = /^([A-Z])(\d+)[-\u2013\u2014]([A-Z])?(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Indented sub-line (leading whitespace): "    A10-deepest invasion"
    const INDENTED_PATTERN = /^([\s\t]+)([A-Z])(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Specimen header: "B. The specimen is received"
    const SPECIMEN_HEADER_PATTERN = /^([A-Z])\.\s+[Tt]he specimen is received/;

    let lastAutoInsert = null;
    let _textarea      = null;
    let _ignoreNext    = false;

    // ── Parsing ────────────────────────────────────────────────────────────────

    /**
     * Parse a line and return the effective LAST block it represents.
     *
     * Simple line  "A4-appendix"   → { letter:'A', number:4,  isRange:false, ... }
     * Range line   "A5-A10-tumor"  → { letter:'A', number:10, isRange:true, rangeStart:5 }
     * Range line   "A5-10-tumor"   → { letter:'A', number:10, isRange:true, rangeStart:5 }
     * Returns null if not a cassette line.
     */
    function parseBlockLine(line) {
        const t = line.trimEnd();

        // Range pattern takes priority (more specific)
        const rm = t.match(RANGE_PATTERN);
        if (rm) {
            const startLetter = rm[1];
            const startNum    = parseInt(rm[2], 10);
            const endLetter   = rm[3] || startLetter; // omitted = same letter
            const endNum      = parseInt(rm[4], 10);
            const sep         = rm[5];
            // Sanity: end must be >= start
            if (endNum < startNum && endLetter === startLetter) return null;
            return {
                letter:      endLetter,
                number:      endNum,
                separator:   sep,
                raw:         rm[0],
                isRange:     true,
                rangeStart:  startNum,
                startLetter: startLetter
            };
        }

        // Standard single block
        const bm = t.match(BLOCK_PATTERN);
        if (bm) {
            return {
                letter:    bm[1],
                number:    parseInt(bm[2], 10),
                separator: bm[3],
                raw:       bm[0],
                isRange:   false
            };
        }

        return null;
    }

    /**
     * Parse an indented sub-line for block map display.
     * Does NOT drive the auto-increment counter.
     */
    function parseIndentedLine(line) {
        const m = line.match(INDENTED_PATTERN);
        if (!m) return null;
        return {
            indent:    m[1],
            letter:    m[2],
            number:    parseInt(m[3], 10),
            separator: m[4]
        };
    }

    // Previous non-empty line above cursor
    function getPreviousNonEmptyLine(textarea) {
        const text  = textarea.value;
        const pos   = textarea.selectionStart;
        const lines = text.substring(0, pos).split('\n');
        for (let i = lines.length - 2; i >= 0; i--) {
            if (lines[i].trim() !== '') return lines[i];
        }
        return null;
    }

    // True if cursor is on a line with exactly 1 character (fresh line after Enter)
    function cursorIsOnFreshLine(textarea) {
        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd   = text.indexOf('\n', pos);
        const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
        return line.length === 1;
    }

    // Scan full text for specimen header lines, return last detected letter
    function inferSpecimenFromText(text) {
        let letter = null;
        for (const line of text.split('\n')) {
            const m = line.match(SPECIMEN_HEADER_PATTERN);
            if (m) letter = m[1];
        }
        return letter;
    }

    /**
     * Find the last effective cassette block above the cursor.
     * Skips indented sub-lines — they don't govern the counter.
     * A range "A5-A10" returns number=10 so next line gets A11.
     */
    function findLastBlock(textarea) {
        const text  = textarea.value.substring(0, textarea.selectionStart);
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (/^[\s\t]/.test(line)) continue; // skip indented sub-lines
            const parsed = parseBlockLine(line);
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

        if (!cursorIsOnFreshLine(textarea)) return;

        // Use findLastBlock which already skips indented sub-lines
        const result = findLastBlock(textarea);
        if (!result) return;

        const { parsed } = result;
        const sep    = normalizeSeparator(parsed.separator);
        const prefix = buildPrefix(parsed.letter, parsed.number + 1, sep);

        _ignoreNext = true;
        prependToCurrentLine(textarea, prefix);

        lastAutoInsert = { inserted: prefix, length: prefix.length };

        textarea.dispatchEvent(new CustomEvent('cassette:advance', {
            bubbles: true,
            detail: {
                letter:   parsed.letter,
                from:     parsed.number,
                to:       parsed.number + 1,
                prefix,
                wasRange: parsed.isRange || false
            }
        }));
    }

    // ── Block map builder ─────────────────────────────────────────────────────
    // Returns array of { label, desc, indented, isRange } for all cassette lines

    function buildBlockMap(text) {
        const lines  = text.split('\n');
        const blocks = [];

        for (const line of lines) {
            // Check indented first
            const ind = parseIndentedLine(line);
            if (ind) {
                const prefixLen = ind.indent.length + `${ind.letter}${ind.number}${ind.separator}`.length;
                blocks.push({
                    label:    `  ${ind.letter}${ind.number}`,
                    desc:     line.substring(prefixLen).trim(),
                    indented: true,
                    isRange:  false
                });
                continue;
            }

            const parsed = parseBlockLine(line);
            if (!parsed) continue;

            const desc = line.substring(parsed.raw.length).trim();

            if (parsed.isRange) {
                blocks.push({
                    label:    `${parsed.startLetter}${parsed.rangeStart}–${parsed.letter}${parsed.number}`,
                    desc,
                    indented: false,
                    isRange:  true
                });
            } else {
                blocks.push({
                    label:    `${parsed.letter}${parsed.number}`,
                    desc,
                    indented: false,
                    isRange:  false
                });
            }
        }
        return blocks;
    }

    // ── Init ────────────────────────────────────────────────────────────────────

    function init(textarea) {
        _textarea = textarea;
        textarea.addEventListener('input', onInput);
    }

    return {
        init,
        handleNewBlock,
        handleNewSpecimen,
        handleUndo,
        parseBlockLine,
        findLastBlock,
        buildBlockMap,
        inferSpecimenFromText
    };

})();

document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('dictation');
    if (ta) Cassette.init(ta);
});
