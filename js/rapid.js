/**
 * rapid.js  v1.0
 * Rapid mode for batch biopsy specimen processing.
 * No API calls — pure local text manipulation.
 *
 * Workflow:
 *   1. Toggle rapid mode ON.
 *   2. Paste a template (e.g. "A. The specimen is received labeled …").
 *      The template is saved; the first specimen block is applied immediately.
 *   3. Auto-advance (always ON in rapid mode) walks the user through fields.
 *   4. When a line starting with [___]- is selected, the cassette key is
 *      auto-filled and the cursor lands LEFT of the separator so the user
 *      can extend the range (e.g. A1-A3) before moving on.
 *   5. After all fields are filled, auto-advance lands on the bottom anchor
 *      field [___].  Pressing ▶ Next appends the next specimen block.
 *   6. When the case is done, Copy and paste back into APIS.
 *
 * Depends on: cassette.js (for Cassette.getFormat / FORMAT_NL)
 */

const Rapid = (() => {

    // ── State ─────────────────────────────────────────────────────────────────

    let _active      = false;
    let _template    = null;   // raw template text as saved by user
    let _specimenIdx = 0;      // 0-based index of current (most recently appended) specimen

    // ── Accessors ─────────────────────────────────────────────────────────────

    function isActive()       { return _active; }
    function getTemplate()    { return _template; }
    function getSpecimenIdx() { return _specimenIdx; }

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
            try { localStorage.removeItem('grossapp-rapid'); } catch {}
        }
        updateUI();
        return _active;
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    function updateUI() {
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
            const label = specimenLabel(_specimenIdx);
            el.textContent = `Active: Specimen ${label}`;
        }
    }

    // ── Specimen label helpers ─────────────────────────────────────────────────

    /**
     * Returns the dot-label for a specimen, e.g. "A." or "1."
     * depending on the current cassette format.
     */
    function specimenLabel(idx) {
        const fmt = (typeof Cassette !== 'undefined') ? Cassette.getFormat() : 'letter-number';
        if (fmt === 'number-letter') {
            return `${idx + 1}.`;
        }
        // letter-number: A., B., C. …  (wraps at Z to AA. etc. — practical cap ~26)
        return String.fromCharCode(65 + (idx % 26)) + '.';
    }

    // ── Template manipulation ─────────────────────────────────────────────────

    /**
     * Build the text for specimen `idx` by rewriting the first-line header.
     * Handles both "A. rest-of-line" (LN) and "1. rest-of-line" (NL).
     * If no header is detected the label is prepended.
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
            lines[0] = label + ' ' + firstLine;
        }
        return lines.join('\n');
    }

    // ── Textarea operations ───────────────────────────────────────────────────

    const ANCHOR = '[___]';

    /**
     * Apply the template as the first specimen (replaces all textarea content).
     * Appends the anchor field at the bottom.
     */
    function applyFirst(ta) {
        if (!_template) return;
        _specimenIdx = 0;
        _persistIdx();
        const block  = buildSpecimenBlock(0);
        ta.value     = block + '\n' + ANCHOR;
        ta.selectionStart = ta.selectionEnd = 0;
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        updateRapidStatus();
    }

    /**
     * Append the next specimen block.
     * Removes the current anchor, appends the new block + new anchor.
     * Positions the cursor at the start of the new block.
     */
    function appendNext(ta) {
        if (!_template) return;
        _specimenIdx++;
        _persistIdx();

        let current        = ta.value;
        const anchorSuffix = '\n' + ANCHOR;
        if (current.endsWith(anchorSuffix)) {
            current = current.slice(0, -anchorSuffix.length);
        } else if (current.endsWith(ANCHOR)) {
            current = current.slice(0, -ANCHOR.length);
        }

        const nextBlock  = buildSpecimenBlock(_specimenIdx);
        const base       = current.trimEnd();
        const newContent = base + '\n\n' + nextBlock + '\n' + ANCHOR;
        ta.value         = newContent;

        // Position cursor at start of new specimen block (after the two newlines)
        const newBlockStart = base.length + 2;
        ta.selectionStart   = ta.selectionEnd = newBlockStart;
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        updateRapidStatus();
    }

    // ── Cassette block cursor adjustment ─────────────────────────────────────

    /**
     * Called (from app.js cassette:advance handler) after cassette fills a
     * [___]- placeholder line in rapid mode.
     *
     * Moves the cursor to be LEFT of the separator so the user can extend the
     * block range (e.g. type "-A3" to make "A1-A3") before moving on.
     * e.g.  prefix = "A1-"  →  cursor lands between "A1" and "-"
     *        prefix = "1A-"  →  cursor lands between "1A" and "-"
     */
    function onCassetteBlock(ta, prefix) {
        if (!prefix) return;
        const fmt = (typeof Cassette !== 'undefined') ? Cassette.getFormat() : 'letter-number';

        let blockLabelLen;
        if (fmt === 'number-letter') {
            // "1A-"  "2AB-"  etc. — digits then letters
            const m = prefix.match(/^(\d+[A-Za-z]+)/);
            blockLabelLen = m ? m[1].length : Math.max(0, prefix.length - 1);
        } else {
            // "A1-"  "B12-" etc. — one letter then digits
            const m = prefix.match(/^([A-Za-z]\d+)/);
            blockLabelLen = m ? m[1].length : Math.max(0, prefix.length - 1);
        }

        const sepLen = prefix.length - blockLabelLen;
        if (sepLen > 0) {
            const newPos = ta.selectionStart - sepLen;
            ta.selectionStart = ta.selectionEnd = Math.max(0, newPos);
        }
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    /** Reset specimen index (keep template). Called on new case. */
    function reset() {
        _specimenIdx = 0;
        _persistIdx();
        updateRapidStatus();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        isActive, toggle, load,
        saveTemplate, getTemplate, clearTemplate,
        specimenLabel, buildSpecimenBlock,
        applyFirst, appendNext,
        onCassetteBlock, reset,
        getSpecimenIdx, updateUI, updateRapidStatus,
        ANCHOR
    };

})();
