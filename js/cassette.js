/**
 * cassette.js  v1.9
 * Cassette key automation for gross pathology dictation.
 *
 * Supports two block formats (toggled via Cassette.setFormat):
 *
 *   FORMAT "letter-number" (default):  A1, A2 … A26, A27 … B1, B2 …
 *   FORMAT "number-letter":            1A, 1B … 1Z, 1AA, 1AB … 1AZ, 1BA …
 *                                      2A, 2B … (specimen 2)
 *
 * Triggers:
 *   1. DMO "New Line" — fires a generic input event on the new empty line.
 *      Detected by checking if the current line is empty after an input event.
 *   2. First character typed on a new line (keyboard Enter fallback).
 *   3. selectionchange — when DMO "Next Field" selects [___], auto-fills.
 *   4. +Block / +Specimen / ↩ Undo buttons.
 */

const Cassette = (() => {

    // ── Format definitions ────────────────────────────────────────────────────

    const FORMAT_LN = 'letter-number'; // A1, B3, C20
    const FORMAT_NL = 'number-letter'; // 1A, 2B, 1AA

    let _format = FORMAT_LN;

    function setFormat(fmt) {
        _format = fmt === FORMAT_NL ? FORMAT_NL : FORMAT_LN;
    }
    function getFormat() { return _format; }

    // ── Patterns ──────────────────────────────────────────────────────────────

    // Letter-Number: A1-  A12\t  B3:  C20–
    const BLOCK_LN = /^([A-Z])(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Letter-Number range: A5-A10-  or  A5-10-
    const RANGE_LN = /^([A-Z])(\d+)[-\u2013\u2014]([A-Z])?(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;

    // Number-Letter: 1A-  2B\t  1AA:  2AZ–
    const BLOCK_NL = /^(\d+)([A-Z]{1,2})([\t\-\u2013\u2014]|:\s?|\s)/;

    // Number-Letter range: 1A-1C-  or  1A-C-
    const RANGE_NL = /^(\d+)([A-Z]{1,2})[-\u2013\u2014](\d+)?([A-Z]{1,2})([\t\-\u2013\u2014]|:\s?|\s)/;

    // Indented sub-line (leading whitespace)
    const INDENTED_LN = /^([\s\t]+)([A-Z])(\d+)([\t\-\u2013\u2014]|:\s?|\s)/;
    const INDENTED_NL = /^([\s\t]+)(\d+)([A-Z]{1,2})([\t\-\u2013\u2014]|:\s?|\s)/;

    // Placeholder at start of line: [___]-  [   ]-  [ ]-
    const PLACEHOLDER_LINE_PATTERN = /^(\[[\s_]*\])([\t\-\u2013\u2014]|:\s?|\s)/;

    // Specimen header: "B. The specimen is received"
    const SPECIMEN_HEADER_PATTERN = /^([A-Z])\.\s+[Tt]he specimen is received/;

    // ── Number-Letter helpers ─────────────────────────────────────────────────

    /**
     * Increment a letter suffix: A→B, Z→AA, AZ→BA, ZZ→AAA
     */
    function nextLetterSuffix(letters) {
        const arr = letters.split('');
        let i = arr.length - 1;
        while (i >= 0) {
            if (arr[i] < 'Z') {
                arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1);
                return arr.join('');
            }
            arr[i] = 'A';
            i--;
        }
        return 'A' + arr.join(''); // overflow: Z→AA, ZZ→AAA
    }

    // ── Parsing ───────────────────────────────────────────────────────────────

    /**
     * Parse a cassette line in either format.
     * Returns { specimen, suffix, separator, raw, isRange, rangeStart, startSuffix }
     * where for LN: specimen=letter, suffix=number string
     *       for NL: specimen=number string, suffix=letter string
     * Returns null if not a cassette line.
     */
    function parseBlockLine(line) {
        const t = line.trimEnd();

        if (_format === FORMAT_NL) {
            // Range first
            const rr = t.match(RANGE_NL);
            if (rr) {
                const specNum    = rr[1];
                const startSuf   = rr[2];
                const endSpecNum = rr[3] || specNum;
                const endSuf     = rr[4];
                const sep        = rr[5];
                return {
                    specimen:    endSpecNum,
                    suffix:      endSuf,
                    separator:   sep,
                    raw:         rr[0],
                    isRange:     true,
                    rangeStart:  startSuf,
                    startSuffix: startSuf,
                    startSpec:   specNum
                };
            }
            const br = t.match(BLOCK_NL);
            if (br) {
                return {
                    specimen:  br[1],
                    suffix:    br[2],
                    separator: br[3],
                    raw:       br[0],
                    isRange:   false
                };
            }
            return null;
        }

        // FORMAT_LN
        const rm = t.match(RANGE_LN);
        if (rm) {
            const startLetter = rm[1];
            const startNum    = parseInt(rm[2], 10);
            const endLetter   = rm[3] || startLetter;
            const endNum      = parseInt(rm[4], 10);
            const sep         = rm[5];
            if (endNum < startNum && endLetter === startLetter) return null;
            return {
                specimen:    endLetter,   // reuse field name for letter
                suffix:      endNum,      // reuse field name for number
                separator:   sep,
                raw:         rm[0],
                isRange:     true,
                rangeStart:  startNum,
                startLetter: startLetter,
                // Legacy fields for LN compat
                letter:      endLetter,
                number:      endNum
            };
        }

        const bm = t.match(BLOCK_LN);
        if (bm) {
            return {
                specimen:  bm[1],
                suffix:    parseInt(bm[2], 10),
                separator: bm[3],
                raw:       bm[0],
                isRange:   false,
                letter:    bm[1],
                number:    parseInt(bm[2], 10)
            };
        }

        return null;
    }

    function parseIndentedLine(line) {
        const pattern = _format === FORMAT_NL ? INDENTED_NL : INDENTED_LN;
        const m = line.match(pattern);
        if (!m) return null;
        return _format === FORMAT_NL
            ? { indent: m[1], specimen: m[2], suffix: m[3], separator: m[4] }
            : { indent: m[1], specimen: m[2], suffix: parseInt(m[3],10), separator: m[4] };
    }

    /**
     * Given a parsed block, return the prefix string for the NEXT block.
     * LN: A4 → A5-  (or whatever separator)
     * NL: 1D → 1E-  /  1Z → 1AA-  /  1AZ → 1BA-
     */
    function nextPrefix(parsed, overrideSep) {
        const sep = normalizeSeparator(overrideSep || parsed.separator);
        if (_format === FORMAT_NL) {
            const nextSuf = nextLetterSuffix(parsed.suffix);
            return `${parsed.specimen}${nextSuf}${sep}`;
        }
        // FORMAT_LN
        return `${parsed.letter}${parsed.number + 1}${sep}`;
    }

    /**
     * Next specimen prefix — LN: B1  NL: 2A
     */
    function nextSpecimenPrefix(parsed, overrideSep) {
        const sep = normalizeSeparator(overrideSep || parsed.separator);
        if (_format === FORMAT_NL) {
            const nextSpec = String(parseInt(parsed.specimen, 10) + 1);
            return `${nextSpec}A${sep}`;
        }
        const nextLetter = String.fromCharCode(parsed.letter.charCodeAt(0) + 1);
        return `${nextLetter}1${sep}`;
    }

    // ── Cursor helpers ────────────────────────────────────────────────────────

    function getPreviousNonEmptyLine(textarea) {
        const text  = textarea.value;
        const pos   = textarea.selectionStart;
        const lines = text.substring(0, pos).split('\n');
        for (let i = lines.length - 2; i >= 0; i--) {
            if (lines[i].trim() !== '') return lines[i];
        }
        return null;
    }

    function cursorIsOnEmptyLine(textarea) {
        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd   = text.indexOf('\n', pos);
        const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
        return line.trim() === '';
    }

    function cursorIsOnFreshLine(textarea) {
        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd   = text.indexOf('\n', pos);
        const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
        return line.length === 1; // exactly one char just typed
    }

    function inferSpecimenFromText(text) {
        let letter = null;
        for (const line of text.split('\n')) {
            const m = line.match(SPECIMEN_HEADER_PATTERN);
            if (m) letter = m[1];
        }
        return letter;
    }

    /**
     * Find last effective cassette block above upToPos.
     * Skips indented sub-lines and placeholder lines.
     */
    function findLastBlock(textarea, upToPos) {
        const pos   = upToPos !== undefined ? upToPos : textarea.selectionStart;
        const text  = textarea.value.substring(0, pos);
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (/^[\s\t]/.test(line)) continue;
            if (PLACEHOLDER_LINE_PATTERN.test(line)) continue;
            const parsed = parseBlockLine(line);
            if (parsed) return { parsed, lineIndex: i };
        }
        return null;
    }

    // ── Separator helpers ─────────────────────────────────────────────────────

    function normalizeSeparator(sep) {
        if (!sep) return '-';
        if (sep === '\t') return '\t';
        return sep;
    }

    // ── Placeholder detection ─────────────────────────────────────────────────

    let _savedSelection = null;

    function saveSelection(textarea) {
        _savedSelection = textarea.selectionStart;
    }

    function clearSavedSelection() {
        _savedSelection = null;
    }

    function getPlaceholderOnCurrentLine(textarea) {
        const positions = [];
        if (_savedSelection !== null) positions.push(_savedSelection);
        positions.push(textarea.selectionStart);
        positions.push(textarea.selectionEnd);

        const text = textarea.value;
        for (const pos of positions) {
            const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
            const lineEnd   = text.indexOf('\n', pos);
            const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
            const m         = line.match(PLACEHOLDER_LINE_PATTERN);
            if (m) return { lineStart, matchLength: m[0].length, separator: m[2] };
        }
        return null;
    }

    // ── Core insertion ────────────────────────────────────────────────────────

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

    function replacePlaceholderWithBlock(textarea, prefix, ph) {
        const text   = textarea.value;
        const before = text.substring(0, ph.lineStart);
        const rest   = text.substring(ph.lineStart + ph.matchLength);
        textarea.value = before + prefix + rest;
        const newPos   = ph.lineStart + prefix.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ── dispatchAdvance helper ────────────────────────────────────────────────

    function dispatchAdvance(textarea, parsed, prefix, extra = {}) {
        textarea.dispatchEvent(new CustomEvent('cassette:advance', {
            bubbles: true,
            detail: {
                // LN compat fields
                letter: parsed.letter || parsed.specimen,
                from:   parsed.number !== undefined ? parsed.number : parsed.suffix,
                to:     parsed.number !== undefined ? parsed.number + 1 : nextLetterSuffix(parsed.suffix),
                prefix,
                ...extra
            }
        }));
    }

    // ── Public actions ────────────────────────────────────────────────────────

    function handleNewBlock(textarea) {
        const ph = getPlaceholderOnCurrentLine(textarea);
        if (ph) {
            const result = findLastBlock(textarea, ph.lineStart);
            if (!result) return false;
            const prefix = nextPrefix(result.parsed, ph.separator);
            _ignoreNext  = true;
            clearSavedSelection();
            replacePlaceholderWithBlock(textarea, prefix, ph);
            lastAutoInsert = { inserted: prefix, length: prefix.length, wasPlaceholder: true };
            dispatchAdvance(textarea, result.parsed, prefix, { wasPlaceholder: true });
            return true;
        }

        const result = findLastBlock(textarea);
        if (!result) return false;
        const prefix = nextPrefix(result.parsed);
        clearSavedSelection();
        _ignoreNext  = true;
        insertAtCursor(textarea, '\n' + prefix);
        lastAutoInsert = { inserted: '\n' + prefix, length: ('\n' + prefix).length };
        return true;
    }

    function handleNewSpecimen(textarea) {
        const result = findLastBlock(textarea);
        if (!result) return false;
        const prefix  = nextSpecimenPrefix(result.parsed);
        _ignoreNext   = true;
        insertAtCursor(textarea, '\n' + prefix);
        lastAutoInsert = { inserted: '\n' + prefix, length: ('\n' + prefix).length };
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

    // ── Auto-trigger on input ─────────────────────────────────────────────────

    let lastAutoInsert = null;
    let _ignoreNext    = false;
    let _textarea      = null;

    function tryAutoAdvance(textarea) {
        const result = findLastBlock(textarea);
        if (!result) return false;

        const { parsed } = result;
        const prefix = nextPrefix(parsed);

        _ignoreNext = true;
        prependToCurrentLine(textarea, prefix);
        lastAutoInsert = { inserted: prefix, length: prefix.length };
        dispatchAdvance(textarea, parsed, prefix, { wasRange: parsed.isRange || false });
        return true;
    }

    function onInput(e) {
        const textarea = e.target;

        if (_ignoreNext) {
            _ignoreNext = false;
            return;
        }

        const text      = textarea.value;
        const pos       = textarea.selectionStart;
        const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd   = text.indexOf('\n', pos);
        const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);

        // ── Case 1: DMO "New Line" or keyboard Enter ───────────────────────────
        // DMO fires input with the cursor on a now-empty line.
        // Keyboard fires input after first character, so line.length === 1.
        // Both cases: previous non-empty line must be a cassette block.
        if (line.trim() === '' || line.length === 1) {
            const prevLine = getPreviousNonEmptyLine(textarea);
            if (!prevLine) return;
            if (!parseBlockLine(prevLine)) return;

            if (line.trim() === '') {
                // DMO empty line — fire immediately, no character to move
                const result = findLastBlock(textarea);
                if (!result) return;
                const prefix = nextPrefix(result.parsed);
                _ignoreNext  = true;
                // Insert prefix at start of current empty line
                const before = text.substring(0, lineStart);
                const rest   = text.substring(lineStart);
                textarea.value = before + prefix + rest;
                textarea.selectionStart = textarea.selectionEnd = lineStart + prefix.length;
                textarea.focus();
                lastAutoInsert = { inserted: prefix, length: prefix.length };
                dispatchAdvance(textarea, result.parsed, prefix);
            } else {
                // Keyboard: first char typed, prepend prefix before it
                tryAutoAdvance(textarea);
            }
            return;
        }

        // ── Case 2: character typed at start of placeholder line ──────────────
        const lineWithoutFirst = line.substring(1);
        const phm = lineWithoutFirst.match(PLACEHOLDER_LINE_PATTERN);
        if (phm) {
            const result = findLastBlock(textarea, lineStart);
            if (!result) return;
            const sep    = normalizeSeparator(phm[2]);
            const prefix = nextPrefix(result.parsed, sep);
            const before = text.substring(0, lineStart);
            const rest   = text.substring(lineStart + 1 + phm[0].length);
            _ignoreNext  = true;
            textarea.value = before + prefix + rest;
            textarea.selectionStart = textarea.selectionEnd = lineStart + prefix.length;
            textarea.focus();
            lastAutoInsert = { inserted: prefix, length: prefix.length };
            dispatchAdvance(textarea, result.parsed, prefix, { wasPlaceholder: true });
        }
    }

    // ── selectionchange: DMO "Next Field" selects [___] ───────────────────────

    function autoFillPlaceholderIfSelected(textarea) {
        const text  = textarea.value;
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;

        if (start === end) return;

        // Selection must start with [ and end with ]
        if (text[start] !== '[' || text[end - 1] !== ']') return;

        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const lineEnd   = text.indexOf('\n', start);
        const line      = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);

        const m = line.match(PLACEHOLDER_LINE_PATTERN);
        if (!m) return;
        if (text[lineStart] !== '[') return; // must be at line start

        const ph     = { lineStart, matchLength: m[0].length, separator: m[2] };
        const result = findLastBlock(textarea, lineStart);
        if (!result) return;

        const prefix = nextPrefix(result.parsed, ph.separator);
        _ignoreNext  = true;
        clearSavedSelection();
        replacePlaceholderWithBlock(textarea, prefix, ph);
        lastAutoInsert = { inserted: prefix, length: prefix.length, wasPlaceholder: true };
        dispatchAdvance(textarea, result.parsed, prefix, { wasPlaceholder: true });
    }

    // ── Block map builder ─────────────────────────────────────────────────────

    function buildBlockMap(text) {
        const lines  = text.split('\n');
        const blocks = [];

        for (const line of lines) {
            const ind = parseIndentedLine(line);
            if (ind) {
                const prefixLen = ind.indent.length +
                    (_format === FORMAT_NL
                        ? `${ind.specimen}${ind.suffix}${ind.separator}`
                        : `${ind.specimen}${ind.suffix}${ind.separator}`).length;
                blocks.push({
                    label:    `  ${ind.specimen}${ind.suffix}`,
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
                const startLabel = _format === FORMAT_NL
                    ? `${parsed.startSpec}${parsed.startSuffix}`
                    : `${parsed.startLetter}${parsed.rangeStart}`;
                const endLabel = _format === FORMAT_NL
                    ? `${parsed.specimen}${parsed.suffix}`
                    : `${parsed.letter}${parsed.number}`;
                blocks.push({ label: `${startLabel}–${endLabel}`, desc, indented: false, isRange: true });
            } else {
                blocks.push({
                    label:    `${parsed.specimen}${parsed.suffix}`,
                    desc, indented: false, isRange: false
                });
            }
        }
        return blocks;
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init(textarea) {
        _textarea = textarea;
        textarea.addEventListener('input', onInput);
        textarea.addEventListener('keyup',   () => saveSelection(textarea));
        textarea.addEventListener('mouseup', () => saveSelection(textarea));

        document.addEventListener('selectionchange', () => {
            if (document.activeElement !== textarea) return;
            saveSelection(textarea);
            autoFillPlaceholderIfSelected(textarea);
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        init,
        setFormat,
        getFormat,
        FORMAT_LN,
        FORMAT_NL,
        handleNewBlock,
        handleNewSpecimen,
        handleUndo,
        parseBlockLine,
        findLastBlock,
        buildBlockMap,
        inferSpecimenFromText,
        nextLetterSuffix  // exported for testing
    };

})();

document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('dictation');
    if (ta) Cassette.init(ta);
});
