/**
 * rapid.js  v2.0
 * Rapid mode for batch biopsy specimen processing.
 * No API calls — pure local text manipulation.
 *
 * Workflow:
 *   1. Toggle rapid mode ON  →  layout switches (context bar + word cloud hidden).
 *   2. Paste a template.  The template is saved and applied as specimen 1.
 *      If the first line has no "A." / "1." header, one is prepended automatically.
 *   3. Auto-advance (always ON) walks through [___] fields.
 *   4. When a [___]-suffix line is auto-filled by cassette logic, the cursor
 *      lands LEFT of the separator.  A timer fires after fieldAdv.delay to move
 *      on automatically; if the user types to extend a range (e.g. -A3) the
 *      timer resets each keystroke, then fires when they stop.
 *   5. When there are no more [___] fields ahead of the cursor the next specimen
 *      block is appended automatically — no button click required.
 *   6. When the case is done, Copy and paste back into APIS.
 *
 * Depends on: cassette.js (for Cassette.getFormat / FORMAT_NL)
 */

const Rapid = (() => {

    // ── State ─────────────────────────────────────────────────────────────────

    let _active      = false;
    let _template    = null;   // raw template text (original unfilled paste)
    let _specimenIdx = 0;      // 0-based index of most recently appended specimen

    // Position just after the cassette separator when a [___]- line was filled.
    // While non-null, onFieldInput in app.js debounces the advance timer instead
    // of running normal field-tracking logic.
    let _blockSepEnd = null;

    // ── Accessors ─────────────────────────────────────────────────────────────

    function isActive()       { return _active; }
    function getTemplate()    { return _template; }
    function getSpecimenIdx() { return _specimenIdx; }
    function getBlockSepEnd() { return _blockSepEnd; }
    function clearBlockSepEnd() { _blockSepEnd = null; }

    // ── Persistence ───────────────────────────────────────────────────────────

    function load() {
        try {
            _active      = localStorage.getItem('grossapp-rapid') === '1';
            const saved  = localStorage.getItem('grossapp-rapid-template');
            _template    = saved || null;
            _specimenIdx = parseInt(localStorage.getItem('grossapp-rapid-idx') || '0', 10) || 0;
        } catch {}
        updateUI();
    }

    function saveTemplate(text) {
        _template = text;
        try { localStorage.setItem('grossapp-rapid-template', text); } catch {}
    }

    function clearTemplate() {
        _template = null;
        try { localStorage.removeItem('grossapp-rapid-template'); } catch {}
    }

    function _persistIdx() {
        try { localStorage.setItem('grossapp-rapid-idx', String(_specimenIdx)); } catch {}
    }

    // ── Toggle ────────────────────────────────────────────────────────────────

    /** Toggle rapid mode on/off. Returns the new active state. */
    function toggle() {
        _active = !_active;
        if (_active) {
            try { localStorage.setItem('grossapp-rapid', '1'); } catch {}
        } else {
            _blockSepEnd = null;
            try { localStorage.removeItem('grossapp-rapid'); } catch {}
        }
        updateUI();
        return _active;
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    function updateUI() {
        // Apply / remove the layout class on <html> so CSS hides API-specific elements
        document.documentElement.classList.toggle('rapid-mode', _active);

        const btn = document.getElementById('btn-rapid');
        if (btn) {
            btn.classList.toggle('rapid-active', _active);
            btn.textContent = _active ? '⚡ Rapid: ON' : '⚡ Rapid';
            btn.title = _active
                ? 'Rapid mode ON — batch specimens, no API calls (click to disable)'
                : 'Rapid mode — streamlined batch biopsy processing, no API calls';
        }

        const sec = document.getElementById('rapid-sidebar-section');
        if (sec) sec.style.display = _active ? '' : 'none';

        updateRapidStatus();
    }

    function updateRapidStatus() {
        const el = document.getElementById('rapid-status');
        if (!el) return;
        if (!_active) { el.textContent = ''; return; }
        if (!_template) {
            el.textContent = 'Paste template to begin';
        } else {
            el.textContent = `Active: Specimen ${specimenLabel(_specimenIdx)}`;
        }
    }

    // ── Specimen label helpers ─────────────────────────────────────────────────

    /**
     * Returns the dot-label for a specimen, e.g. "A." (LN) or "1." (NL).
     */
    function specimenLabel(idx) {
        const fmt = (typeof Cassette !== 'undefined') ? Cassette.getFormat() : 'letter-number';
        if (fmt === 'number-letter') return `${idx + 1}.`;
        return String.fromCharCode(65 + (idx % 26)) + '.';
    }

    // ── Template manipulation ─────────────────────────────────────────────────

    /**
     * Build the text for specimen `idx` by rewriting the first-line header.
     * Handles "A. …" (LN), "1. …" (NL), or no header at all.
     * All [___] fields are left blank (taken straight from _template).
     */
    function buildSpecimenBlock(idx) {
        if (!_template) return '';
        const lines     = _template.split('\n');
        const firstLine = lines[0];
        const label     = specimenLabel(idx);

        const mLN = firstLine.match(/^([A-Z])\.\s*/);
        const mNL = firstLine.match(/^(\d+)\.\s*/);

        if (mLN) {
            lines[0] = label + ' ' + firstLine.substring(mLN[0].length);
        } else if (mNL) {
            lines[0] = label + ' ' + firstLine.substring(mNL[0].length);
        } else {
            // No header detected — prepend one
            lines[0] = label + ' ' + firstLine;
        }
        return lines.join('\n');
    }

    // ── Textarea operations ───────────────────────────────────────────────────

    /**
     * Apply the template as the first specimen (replaces all textarea content).
     * No anchor field — end-of-specimen detection uses cursor position instead.
     */
    function applyFirst(ta) {
        if (!_template) return;
        _specimenIdx = 0;
        _blockSepEnd = null;
        _persistIdx();
        ta.value = buildSpecimenBlock(0);
        ta.selectionStart = ta.selectionEnd = 0;
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        updateRapidStatus();
    }

    /**
     * Append the next specimen block after the current content.
     * Positions cursor at the start of the new block so goToNextField
     * in app.js can jump to the first [___] of that specimen.
     */
    function appendNext(ta) {
        if (!_template) return;
        _specimenIdx++;
        _blockSepEnd = null;
        _persistIdx();

        const base       = ta.value.trimEnd();
        const nextBlock  = buildSpecimenBlock(_specimenIdx);
        ta.value         = base + '\n\n' + nextBlock;

        // Cursor at start of new block so the caller can find the first field
        const newBlockStart = base.length + 2; // after '\n\n'
        ta.selectionStart   = ta.selectionEnd = newBlockStart;
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        updateRapidStatus();
    }

    // ── Cassette block cursor adjustment ─────────────────────────────────────

    /**
     * Called after cassette fills a [___]- placeholder in rapid mode.
     *
     * 1. Moves cursor to be LEFT of the separator so the user can extend
     *    the range (e.g. type "-A3" to get "A1-A3").
     * 2. Stores _blockSepEnd so onFieldInput in app.js knows to debounce
     *    the advance timer rather than running normal field logic.
     *
     * Returns the separator-end position (used by app.js to schedule the
     * initial advance timer).
     */
    function onCassetteBlock(ta, prefix) {
        if (!prefix) return null;
        const fmt = (typeof Cassette !== 'undefined') ? Cassette.getFormat() : 'letter-number';

        let blockLabelLen;
        if (fmt === 'number-letter') {
            const m = prefix.match(/^(\d+[A-Za-z]+)/);
            blockLabelLen = m ? m[1].length : Math.max(0, prefix.length - 1);
        } else {
            const m = prefix.match(/^([A-Za-z]\d+)/);
            blockLabelLen = m ? m[1].length : Math.max(0, prefix.length - 1);
        }

        const sepLen = prefix.length - blockLabelLen;
        if (sepLen > 0) {
            // cursor is currently after the full prefix; move it before the separator
            const newPos = ta.selectionStart - sepLen;
            ta.selectionStart = ta.selectionEnd = Math.max(0, newPos);
            _blockSepEnd = newPos + sepLen; // = original cursor position
        }
        return _blockSepEnd;
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    /** Reset specimen index (keeps saved template). Called on new case. */
    function reset() {
        _specimenIdx = 0;
        _blockSepEnd = null;
        _persistIdx();
        updateRapidStatus();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        isActive, toggle, load,
        saveTemplate, getTemplate, clearTemplate,
        specimenLabel, buildSpecimenBlock,
        applyFirst, appendNext,
        onCassetteBlock,
        getBlockSepEnd, clearBlockSepEnd,
        reset,
        getSpecimenIdx, updateUI, updateRapidStatus
    };

})();
