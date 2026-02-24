/**
 * app.js
 * Main application controller.
 * Depends on: cassette.js, api.js
 */

const App = (() => {

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        specimen:    null,
        histories:   [],
        template_id: null,
        termsShown:  [],
        termsUsed:   [],
        sections:    { cloud: true, blocks: true, controls: true },
        submitted:   false,
        theme:       'light',   // 'light' | 'dark'
        format:      'letter-number' // 'letter-number' | 'number-letter'
    };

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        const ta = document.getElementById('dictation');

        // Apply saved preferences
        const savedTheme  = localStorage.getItem('grossapp-theme')  || 'light';
        const savedFormat = localStorage.getItem('grossapp-format') || 'letter-number';
        applyTheme(savedTheme);
        applyFormat(savedFormat);

        // Cassette automation
        Cassette.init(ta);
        ta.addEventListener('cassette:advance', (e) => {
            toast(`Block: ${e.detail.prefix}`, 'blue');
            updateFooter();
            updateBlockMap();
        });

        // Live footer + block map on any input
        ta.addEventListener('input', () => {
            updateFooter();
            updateBlockMap();
            scanTermUsage();
            checkCompletion();
            maybeInferSpecimen();
            onFieldInput();
            refreshFieldCounter();
        });

        // Detect template on paste; also reset field tracking
        ta.addEventListener('paste', () => {
            setTimeout(() => {
                detectFromPaste();
                fieldAdv.anchor = -1;
                clearTimeout(fieldAdv.timer);
                refreshFieldCounter();
            }, 50);
        });

        // Specimen autocomplete
        setupAutocomplete(
            'specimen-input',
            'specimen-dropdown',
            (q) => API.specimens.search(q),
            (item) => {
                // Selected from dropdown
                state.specimen = { id: item.id, name: item.name };
                document.getElementById('specimen-input').value = item.name;
                closeDropdown('specimen-dropdown');
                updateHeaderContext();
                fetchSuggestions();
                toast(`Specimen: ${item.name}`, 'blue');
            },
            async (value) => {
                // Typed and confirmed with Enter — upsert
                const created = await API.specimens.upsert(value);
                state.specimen = { id: created.id, name: created.name };
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
                toast(`Specimen: ${created.name}`, 'blue');
            },
            (row) => ({ label: row.name, meta: row.case_count ? `${row.case_count} cases` : '' })
        );

        // ── Field advancement init ────────────────────────────────────────────
        loadFieldPrefs();
        updateNextBtn();

        // Single-click → next field; double-click (within 260 ms) → toggle auto-advance
        let _nfClicks = 0, _nfTimer = null;
        document.getElementById('btn-next-field').addEventListener('click', () => {
            _nfClicks++;
            clearTimeout(_nfTimer);
            _nfTimer = setTimeout(() => {
                if (_nfClicks >= 2) toggleAutoAdvance();
                else goToNextField();
                _nfClicks = 0;
            }, 260);
        });

        // Gear button — open/close prefs panel
        document.getElementById('btn-field-prefs').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFieldPrefs();
        });

        // Close prefs panel when clicking outside the group
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('field-prefs-panel');
            const grp   = document.getElementById('field-adv-group');
            if (panel && panel.classList.contains('open') && !grp.contains(e.target)) {
                panel.classList.remove('open');
            }
        });

        // Delay input change
        document.getElementById('pref-delay').addEventListener('change', (e) => {
            fieldAdv.delay = Math.max(300, Math.min(8000, parseInt(e.target.value) || 1500));
            saveFieldPrefs();
        });

        // Add pause character
        document.getElementById('pref-add-char').addEventListener('click', () => {
            const c = prompt('Add pause character (single char):');
            if (!c) return;
            const ch = c.trim().charAt(0);
            if (ch && !fieldAdv.contChars.includes(ch)) {
                fieldAdv.contChars.push(ch);
                saveFieldPrefs();
                renderFieldPrefs();
            }
        });

        // Add pause word
        document.getElementById('pref-add-word').addEventListener('click', () => {
            const w = prompt('Add pause word:');
            if (!w) return;
            const lw = w.trim().toLowerCase();
            if (lw && !fieldAdv.contWords.includes(lw)) {
                fieldAdv.contWords.push(lw);
                saveFieldPrefs();
                renderFieldPrefs();
            }
        });

        // Clear learned exceptions
        document.getElementById('pref-clear-learned').addEventListener('click', () => {
            fieldAdv.learned = [];
            saveFieldPrefs();
            renderFieldPrefs();
            toast('Learned exceptions cleared', '');
        });

        // Cursor-back detection for learning
        document.addEventListener('selectionchange', checkCursorBack);

        // Also commit specimen on blur (clicking away after typing)
        document.getElementById('specimen-input').addEventListener('blur', async () => {
            const val = document.getElementById('specimen-input').value.trim();
            if (!val || (state.specimen && state.specimen.name === val)) return;
            try {
                const created = await API.specimens.upsert(val);
                state.specimen = { id: created.id, name: created.name };
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
            } catch {}
        });

        // History autocomplete
        setupAutocomplete(
            'history-input',
            'history-dropdown',
            (q) => API.histories.search(q),
            (item) => {
                addHistoryTag({ id: item.id, label: item.label });
                document.getElementById('history-input').value = '';
                closeDropdown('history-dropdown');
                fetchSuggestions();
            },
            async (value) => {
                const created = await API.histories.upsert(value);
                addHistoryTag({ id: created.id, label: created.label });
                document.getElementById('history-input').value = '';
                fetchSuggestions();
            },
            (row) => ({ label: row.label, meta: row.use_count ? `${row.use_count}×` : '' })
        );
    }

    // ── Autocomplete factory ──────────────────────────────────────────────────
    // Builds a reusable autocomplete on any input + dropdown pair
    function setupAutocomplete(inputId, dropdownId, searchFn, onSelect, onNew, renderRow) {
        const input    = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        let timer      = null;

        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (!q) { closeDropdown(dropdownId); return; }
            timer = setTimeout(async () => {
                try {
                    const results = await searchFn(q);
                    renderDropdown(dropdown, results, renderRow, onSelect, q, onNew);
                } catch { closeDropdown(dropdownId); }
            }, 200);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = input.value.trim();
                if (val) onNew(val);
                closeDropdown(dropdownId);
            }
            if (e.key === 'Escape') closeDropdown(dropdownId);
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                closeDropdown(dropdownId);
            }
        });
    }

    function renderDropdown(dropdown, results, renderRow, onSelect, query, onNew) {
        dropdown.innerHTML = '';
        if (results.length === 0) {
            // Offer to create new entry
            const el = document.createElement('div');
            el.className = 'dd-item new-entry';
            el.textContent = `Add "${query}"`;
            el.onclick = () => onNew(query);
            dropdown.appendChild(el);
        } else {
            results.forEach(row => {
                const r    = renderRow(row);
                const el   = document.createElement('div');
                el.className = 'dd-item';
                el.innerHTML = `<span>${r.label}</span>${r.meta ? `<span class="dd-count">${r.meta}</span>` : ''}`;
                el.onclick = () => onSelect(row);
                dropdown.appendChild(el);
            });
            // Always offer "add new" at bottom if query doesn't exactly match
            const exactMatch = results.some(r => renderRow(r).label.toLowerCase() === query.toLowerCase());
            if (!exactMatch) {
                const el = document.createElement('div');
                el.className = 'dd-item new-entry';
                el.textContent = `Add "${query}"`;
                el.onclick = () => onNew(query);
                dropdown.appendChild(el);
            }
        }
        dropdown.classList.add('open');
    }

    function closeDropdown(id) {
        document.getElementById(id)?.classList.remove('open');
    }

    // ── History tags ──────────────────────────────────────────────────────────
    function addHistoryTag(h) {
        // Avoid duplicates
        if (state.histories.find(x => x.id === h.id)) return;
        // First tag added is primary
        h.is_primary = state.histories.length === 0;
        state.histories.push(h);
        renderHistoryTags();
        updateHeaderContext();
    }

    function removeHistoryTag(id) {
        state.histories = state.histories.filter(h => h.id !== id);
        // If we removed primary, promote first remaining
        if (!state.histories.find(h => h.is_primary) && state.histories.length > 0) {
            state.histories[0].is_primary = true;
        }
        renderHistoryTags();
        updateHeaderContext();
        fetchSuggestions();
    }

    function setPrimaryHistory(id) {
        state.histories.forEach(h => h.is_primary = h.id === id);
        renderHistoryTags();
        fetchSuggestions();
    }

    function renderHistoryTags() {
        const container = document.getElementById('history-tags');
        container.innerHTML = '';
        state.histories.forEach(h => {
            const tag = document.createElement('span');
            tag.className = 'tag' + (h.is_primary ? ' primary' : '');
            tag.title = h.is_primary ? 'Primary history (click another to change)' : 'Click to set as primary';
            tag.innerHTML = `${h.label}<span class="tag-remove" title="Remove">×</span>`;
            tag.onclick = (e) => {
                if (e.target.classList.contains('tag-remove')) {
                    removeHistoryTag(h.id);
                } else {
                    setPrimaryHistory(h.id);
                }
            };
            container.appendChild(tag);
        });
    }

    // ── Header context summary ────────────────────────────────────────────────
    function updateHeaderContext() {
        const el = document.getElementById('header-context');
        if (!state.specimen) { el.textContent = 'No specimen selected'; return; }
        const primary = state.histories.find(h => h.is_primary);
        el.textContent = state.specimen.name + (primary ? ` — ${primary.label}` : '');
    }

    // ── Suggestions / word cloud ──────────────────────────────────────────────
    let suggestionDebounce = null;

    async function fetchSuggestions() {
        if (!state.specimen) return;
        clearTimeout(suggestionDebounce);
        suggestionDebounce = setTimeout(async () => {
            try {
                setLlmDot(true);
                const primary = state.histories.find(h => h.is_primary);
                const allIds  = state.histories.map(h => h.id);
                const data    = await API.suggestions.get(
                    state.specimen.id,
                    allIds,
                    primary?.id ?? 0
                );
                // Merge DB terms and LLM terms, DB terms first
                const dbTerms  = (data.terms || []).map(t => t.term);
                const llmTerms = (data.llm_terms || []).filter(t => !dbTerms.includes(t.toLowerCase()));
                const all      = [...dbTerms, ...llmTerms];
                state.termsShown = all;
                renderWordCloud(all, data.terms || []);
                setLlmDot(false);
            } catch (e) {
                setLlmDot(false);
                console.warn('Suggestions fetch failed:', e);
            }
        }, 300);
    }

    function renderWordCloud(terms, dbTerms) {
        const cloud = document.getElementById('word-cloud');
        cloud.innerHTML = '';

        if (terms.length === 0) {
            cloud.innerHTML = '<span class="cloud-empty">No suggestions yet</span>';
            return;
        }

        const grossText = document.getElementById('dictation').value.toLowerCase();

        terms.forEach(term => {
            const el    = document.createElement('span');
            el.className = 'cloud-term';
            el.textContent = term;
            el.dataset.term = term;

            // Check if already used in gross
            if (isTermUsed(term, grossText)) {
                el.classList.add('used');
            }

            // Click to insert at cursor
            el.addEventListener('click', () => {
                insertTerm(term);
                el.classList.add('inserted');
            });

            cloud.appendChild(el);
        });
    }

    function isTermUsed(term, text) {
        // Stem: check if base form or common suffix variants appear
        const base = term.toLowerCase().replace(/(?:ly|ed|ing|s|al)$/, '');
        return text.includes(term.toLowerCase()) || (base.length > 4 && text.includes(base));
    }

    function scanTermUsage() {
        const grossText = document.getElementById('dictation').value.toLowerCase();
        const used = [];
        document.querySelectorAll('.cloud-term').forEach(el => {
            const term = el.dataset.term;
            if (isTermUsed(term, grossText)) {
                el.classList.add('used');
                used.push(term);
            } else {
                el.classList.remove('used');
                if (!el.classList.contains('inserted')) {
                    el.classList.remove('inserted');
                }
            }
        });
        state.termsUsed = used;
    }

    function insertTerm(term) {
        const ta    = document.getElementById('dictation');
        const start = ta.selectionStart;
        const end   = ta.selectionEnd;
        const text  = ta.value;
        // Add a space before if cursor isn't at start of line or after space
        const before = text.substring(0, start);
        const needsSpace = before.length > 0 && !/[\s\n]$/.test(before);
        const insert = (needsSpace ? ' ' : '') + term;
        ta.value = before + insert + text.substring(end);
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // ── Paste / template detection ────────────────────────────────────────────
    async function detectFromPaste() {
        const text = document.getElementById('dictation').value;
        if (!text.trim()) return;

        // Do NOT try to infer specimen from template text —
        // placeholders like "[___]" are unfilled and would corrupt the field.
        // The user sets specimen manually before or after pasting.
        // Once the database has real completed cases, template matching
        // can suggest a specimen retroactively — that's a future feature.

        // Save template to backend for dedup + placeholder extraction
        // Only if specimen is already known
        if (state.specimen && text.length > 30) {
            try {
                const result = await API.templates.submit(state.specimen.id, text);
                state.template_id = result.id;
                if (result.new) {
                    toast(`Template saved (${result.placeholders?.length ?? 0} fields detected)`, 'blue');
                } else {
                    toast(`Template recognised`, 'blue');
                }
            } catch {}
        }

        updateFooter();
        updateBlockMap();
    }

    // ── Footer + block map ────────────────────────────────────────────────────
    function updateFooter() {
        const ta   = document.getElementById('dictation');
        const text = ta.value;

        document.getElementById('char-count').textContent = `${text.length} chars`;

        // Block count + next block preview
        const lines  = text.split('\n');
        const blocks = lines.filter(l => /^[A-Z]\d+/.test(l.trimEnd()));
        document.getElementById('block-count').textContent = `${blocks.length} block${blocks.length !== 1 ? 's' : ''}`;

        const result = Cassette.findLastBlock(ta);
        const preview = document.getElementById('next-block-preview');
        if (result) {
            const { parsed } = result;
            const sep = parsed.separator.trim() || parsed.separator;
            preview.textContent = `Next: ${parsed.letter}${parsed.number + 1}${sep}`;
        } else {
            preview.textContent = '';
        }
    }

    function updateBlockMap() {
        const ta     = document.getElementById('dictation');
        const map    = document.getElementById('block-map');
        const blocks = Cassette.buildBlockMap(ta.value);

        if (blocks.length === 0) {
            map.innerHTML = '<span style="font-size:11px;color:var(--muted2);font-style:italic">No blocks detected</span>';
            return;
        }

        map.innerHTML = blocks.map(b => {
            const labelStyle = b.isRange
                ? 'color:var(--yellow);font-weight:500'
                : b.indented
                    ? 'color:var(--muted);font-weight:400'
                    : 'color:var(--green);font-weight:500';
            return `<div class="block-row">
                <span class="block-lbl" style="${labelStyle}">${b.label}</span>
                <span class="block-txt">${b.desc}</span>
            </div>`;
        }).join('');

        map.scrollTop = map.scrollHeight;
    }

    // Scan textarea for filled-in specimen site and infer specimen if not yet set
    // Pattern: specimen site "something that is not [___]"
    let _inferTimer = null;
    function maybeInferSpecimen() {
        if (state.specimen) return;
        clearTimeout(_inferTimer);
        _inferTimer = setTimeout(async () => {
            const text = document.getElementById('dictation').value;
            // Match: specimen site "VALUE" where VALUE is not a placeholder
            const m = text.match(/specimen site\s+"([^"\[\]]{3,})"/i);
            if (!m) return;
            const inferred = m[1].trim();
            if (!inferred || /^\[/.test(inferred)) return;
            try {
                const created = await API.specimens.upsert(inferred);
                state.specimen = { id: created.id, name: created.name };
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
                toast(`Specimen inferred: ${created.name}`, 'blue');
            } catch {}
        }, 800); // debounce — only fires 800ms after user stops typing
    }

    // Check if the gross appears complete (no unfilled placeholders remain)
    // and update the Submit Case button state accordingly
    function checkCompletion() {
        const text = document.getElementById('dictation').value;
        const hasUnfilled = /\[[^\]]{0,60}\]/.test(text); // any [...] remaining
        const hasContent  = text.trim().length > 50;
        const complete    = !hasUnfilled && hasContent && !state.submitted;

        const btn = document.getElementById('btn-submit-header');
        if (btn) {
            btn.dataset.complete = complete ? '1' : '0';
            btn.title = complete
                ? 'Submit completed gross to database'
                : hasUnfilled
                    ? 'Unfilled fields remain (shown in brackets)'
                    : 'Add content before submitting';
        }
    }

    // ── Cassette button handlers ──────────────────────────────────────────────
    function newBlock() {
        const ta = document.getElementById('dictation');
        Cassette.handleNewBlock(ta);
        updateFooter();
        updateBlockMap();
    }

    function newSpecimen() {
        const ta = document.getElementById('dictation');
        Cassette.handleNewSpecimen(ta);
        updateFooter();
        updateBlockMap();
    }

    function undoInsert() {
        const ta = document.getElementById('dictation');
        if (Cassette.handleUndo(ta)) {
            toast('Undone', 'blue');
            updateFooter();
            updateBlockMap();
        }
    }

    // ── Case submission ───────────────────────────────────────────────────────
    async function submitCase() {
        if (!state.specimen) { toast('Select a specimen first', ''); return; }
        const gross = document.getElementById('dictation').value.trim();
        if (gross.length < 10) { toast('Gross description is too short', ''); return; }
        if (state.submitted) { toast('Already submitted — start a New Case', ''); return; }

        try {
            await API.cases.submit({
                specimen_id:  state.specimen.id,
                template_id:  state.template_id,
                gross_text:   gross,
                histories:    state.histories.map(h => ({ id: h.id, is_primary: h.is_primary ? 1 : 0 })),
                terms_shown:  state.termsShown,
                terms_used:   state.termsUsed
            });
            state.submitted = true;
            toast('Case submitted ✓', 'green');
            checkCompletion(); // update button state
        } catch (e) {
            toast('Submission failed', '');
            console.error(e);
        }
    }

    // ── Copy to clipboard ─────────────────────────────────────────────────────
    function copyToClipboard() {
        const text = document.getElementById('dictation').value;
        if (!text) { toast('Nothing to copy', ''); return; }
        navigator.clipboard.writeText(text).then(() => {
            toast('Copied to clipboard', 'green');
        }).catch(() => {
            // Fallback for older browsers
            const ta = document.getElementById('dictation');
            ta.select();
            document.execCommand('copy');
            toast('Copied to clipboard', 'green');
        });
    }

    // ── Clear / new case ──────────────────────────────────────────────────────
    function clearAll() {
        if (document.getElementById('dictation').value &&
            !confirm('Start a new case? Current content will be cleared.')) return;

        document.getElementById('dictation').value = '';
        document.getElementById('specimen-input').value = '';
        document.getElementById('history-input').value = '';
        document.getElementById('history-tags').innerHTML = '';
        document.getElementById('word-cloud').innerHTML =
            '<span class="cloud-empty">Select a specimen to see suggestions</span>';
        document.getElementById('block-map').innerHTML =
            '<span style="font-size:11px;color:var(--muted2);font-style:italic">No blocks detected</span>';

        state.specimen    = null;
        state.histories   = [];
        state.template_id = null;
        state.termsShown  = [];
        state.termsUsed   = [];
        state.submitted   = false;

        // Reset field tracking
        fieldAdv.anchor    = -1;
        fieldAdv.watchBack = false;
        clearTimeout(fieldAdv.timer);
        updateFieldCounter(0, 0);

        updateFooter();
        updateHeaderContext();
    }

    // ── Collapsible sidebar sections ──────────────────────────────────────────
    function toggleSection(key) {
        state.sections[key] = !state.sections[key];
        const body   = document.getElementById(`section-${key}`);
        const toggle = document.getElementById(`toggle-${key}`);
        body.style.display   = state.sections[key] ? '' : 'none';
        toggle.textContent   = state.sections[key] ? '▾' : '▸';
    }

    // ── Status dots ───────────────────────────────────────────────────────────
    function setLlmDot(active) {
        const dot   = document.getElementById('dot-llm');
        const label = document.getElementById('label-llm');
        dot.className   = 'dot' + (active ? ' warn' : '');
        label.textContent = active ? 'LLM loading…' : 'LLM';
    }

    // ── Toast ─────────────────────────────────────────────────────────────────
    let toastTimer = null;
    function toast(msg, type = '') {
        const el = document.getElementById('toast');
        el.textContent  = msg;
        el.className    = 'show' + (type ? ` ${type}` : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = ''; }, 2000);
    }

    // ── Theme toggle ──────────────────────────────────────────────────────────
    function applyTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        const btn = document.getElementById('btn-theme');
        if (btn) btn.textContent = theme === 'dark' ? '☾ Dark' : '☀ Light';
        localStorage.setItem('grossapp-theme', theme);
    }

    function toggleTheme() {
        applyTheme(state.theme === 'light' ? 'dark' : 'light');
    }

    // ── Format toggle ─────────────────────────────────────────────────────────
    function applyFormat(fmt) {
        state.format = fmt;
        Cassette.setFormat(fmt);
        const btn = document.getElementById('btn-format');
        if (btn) btn.textContent = fmt === Cassette.FORMAT_NL ? 'Format: 1A' : 'Format: A1';
        localStorage.setItem('grossapp-format', fmt);
        updateFooter();
        updateBlockMap();
    }

    function toggleFormat() {
        const next = state.format === Cassette.FORMAT_NL ? Cassette.FORMAT_LN : Cassette.FORMAT_NL;
        applyFormat(next);
        toast(`Format: ${next === Cassette.FORMAT_NL ? '1A 1B 1C…' : 'A1 A2 A3…'}`, 'blue');
    }

    // ── Field advancement ─────────────────────────────────────────────────────

    // Mutable preferences + runtime state (all in one object for clarity)
    const fieldAdv = {
        auto:      false,
        delay:     1500,                          // ms before auto-advancing
        contChars: [',', '.'],                    // end-chars that pause advance
        contWords: ['with', 'including', 'includes', 'and', 'or', 'to', 'of', 'the', 'a', 'an'],
        learned:   [],                            // words learned from cursor-back events
        // runtime (not persisted)
        anchor:        -1,                        // textarea pos where tracked field started
        timer:         null,                      // pending auto-advance timeout
        lastAdvTime:   0,                         // Date.now() of last auto-advance
        lastAdvFromPos: -1,                       // cursor pos just before last auto-advance
        lastAdvCtx:    '',                        // last word before the advance (for learning)
        watchBack:     false,                     // whether we're watching for cursor-back
    };

    function loadFieldPrefs() {
        try {
            const a  = localStorage.getItem('grossapp-field-auto');
            const d  = localStorage.getItem('grossapp-field-delay');
            const cc = localStorage.getItem('grossapp-field-cont-chars');
            const cw = localStorage.getItem('grossapp-field-cont-words');
            const le = localStorage.getItem('grossapp-field-learned');
            if (a  !== null) fieldAdv.auto  = a === '1';
            if (d  !== null) fieldAdv.delay = Math.max(300, Math.min(8000, parseInt(d) || 1500));
            if (cc) fieldAdv.contChars = JSON.parse(cc);
            if (cw) fieldAdv.contWords = JSON.parse(cw);
            if (le) fieldAdv.learned   = JSON.parse(le);
        } catch { /* ignore corrupt prefs */ }
    }

    function saveFieldPrefs() {
        try {
            localStorage.setItem('grossapp-field-auto',       fieldAdv.auto ? '1' : '0');
            localStorage.setItem('grossapp-field-delay',      fieldAdv.delay);
            localStorage.setItem('grossapp-field-cont-chars', JSON.stringify(fieldAdv.contChars));
            localStorage.setItem('grossapp-field-cont-words', JSON.stringify(fieldAdv.contWords));
            localStorage.setItem('grossapp-field-learned',    JSON.stringify(fieldAdv.learned));
        } catch { /* ignore quota errors */ }
    }

    // Returns true if `pos` is inside a [...] placeholder in `text`
    function isCursorInField(text, pos) {
        const lb = text.lastIndexOf('[', pos - 1);
        if (lb < 0) return false;
        const rb = text.indexOf(']', lb);
        if (rb < 0) return false;
        // Must be: lb < pos <= rb+1, with no ] between lb and pos
        return pos > lb && pos <= rb + 1 && !text.substring(lb + 1, pos).includes(']');
    }

    // Returns array of all [...] fields in `text` with start/end indices
    function findAllFields(text) {
        const out = [];
        const re  = /\[[^\]]{0,60}\]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            out.push({ start: m.index, end: m.index + m[0].length });
        }
        return out;
    }

    // Navigate cursor to the next [...] field, wrapping around if needed.
    // `fromPos` defaults to current selectionEnd.
    function goToNextField(fromPos) {
        const ta     = document.getElementById('dictation');
        const text   = ta.value;
        const from   = fromPos !== undefined ? fromPos : ta.selectionEnd;
        const fields = findAllFields(text);

        if (fields.length === 0) {
            toast('No fields remaining', '');
            fieldAdv.anchor = -1;
            updateFieldCounter(0, 0);
            return false;
        }

        // Next field at or after `from`, wrap around if needed
        let target = fields.find(f => f.start >= from);
        if (!target) target = fields[0];

        ta.setSelectionRange(target.start, target.end);
        ta.focus();

        fieldAdv.anchor    = target.start;
        fieldAdv.watchBack = false;
        clearTimeout(fieldAdv.timer);

        const idx = fields.indexOf(target) + 1;
        updateFieldCounter(idx, fields.length);
        return true;
    }

    function updateFieldCounter(cur, total) {
        const el = document.getElementById('field-counter');
        if (!el) return;
        if (total === 0) {
            el.textContent = '';
            el.classList.remove('has-fields');
        } else {
            el.textContent = `${cur}\u2009/\u2009${total}`;
            el.classList.add('has-fields');
        }
    }

    // Refresh field counter based on current cursor position
    function refreshFieldCounter() {
        const ta     = document.getElementById('dictation');
        const fields = findAllFields(ta.value);
        if (fields.length === 0) { updateFieldCounter(0, 0); return; }
        const cursor = ta.selectionEnd;
        let idx = fields.findIndex(f => cursor >= f.start && cursor <= f.end);
        if (idx < 0) idx = fields.findIndex(f => f.start >= cursor);
        if (idx < 0) idx = 0; // wrap to first
        updateFieldCounter(idx + 1, fields.length);
    }

    // Returns true if `text` (replacement so far) suggests the user isn't done
    function shouldHoldAdvance(text) {
        if (!text) return true;
        const t = text.trim();
        if (!t) return true;

        // Ends with a continuation character
        const lastChar = t[t.length - 1];
        if (fieldAdv.contChars.includes(lastChar)) return true;

        // Last word is a continuation word (strip trailing punctuation)
        const words    = t.toLowerCase().split(/\s+/);
        const lastWord = words[words.length - 1].replace(/[.,;:!?]+$/, '');
        if (fieldAdv.contWords.some(w => w.toLowerCase() === lastWord)) return true;
        if (fieldAdv.learned.some(w  => w.toLowerCase() === lastWord)) return true;

        return false;
    }

    // Called on every textarea `input` event — drives auto-advance
    function onFieldInput() {
        if (fieldAdv.anchor < 0) return;

        const ta     = document.getElementById('dictation');
        const text   = ta.value;
        const cursor = ta.selectionEnd;

        // If cursor is still inside a [...], the field isn't filled yet
        if (isCursorInField(text, cursor)) {
            clearTimeout(fieldAdv.timer);
            return;
        }

        // Only drive auto-advance when that mode is on
        if (!fieldAdv.auto) return;

        // Estimate replacement: text from anchor to cursor
        const anchor = Math.min(fieldAdv.anchor, text.length);
        const filled = text.substring(anchor, cursor).trim();
        if (!filled) { clearTimeout(fieldAdv.timer); return; }

        if (shouldHoldAdvance(filled)) { clearTimeout(fieldAdv.timer); return; }

        // Schedule the advance (re-schedule on each keystroke to debounce)
        clearTimeout(fieldAdv.timer);
        fieldAdv.timer = setTimeout(() => {
            const fromPos = document.getElementById('dictation').selectionEnd;
            const rawFill = document.getElementById('dictation').value
                .substring(Math.min(fieldAdv.anchor, document.getElementById('dictation').value.length), fromPos)
                .trim();
            const words = rawFill.split(/\s+/);
            fieldAdv.lastAdvCtx     = words[words.length - 1].replace(/[.,;:!?]+$/, '').toLowerCase();
            fieldAdv.lastAdvFromPos = fromPos;
            fieldAdv.lastAdvTime    = Date.now();
            fieldAdv.watchBack      = true;
            goToNextField(fromPos);
        }, fieldAdv.delay);
    }

    // Called on `selectionchange` — watches for cursor-back after auto-advance
    function checkCursorBack() {
        if (!fieldAdv.watchBack) return;
        if (Date.now() - fieldAdv.lastAdvTime > 4000) { fieldAdv.watchBack = false; return; }

        const ta = document.getElementById('dictation');
        if (document.activeElement !== ta) return;

        // Cursor moved back more than 3 chars from where we auto-advanced from
        if (ta.selectionStart < fieldAdv.lastAdvFromPos - 3) {
            fieldAdv.watchBack = false;
            learnException(fieldAdv.lastAdvCtx);
        }
    }

    function learnException(word) {
        if (!word || word.length < 2) return;
        if (fieldAdv.learned.includes(word))   return;
        if (fieldAdv.contWords.includes(word)) return;
        if (fieldAdv.contChars.includes(word)) return;
        fieldAdv.learned.push(word);
        saveFieldPrefs();
        renderFieldPrefs();
        toast(`Learned: "${word}" now pauses auto-advance`, 'blue');
    }

    function toggleAutoAdvance() {
        fieldAdv.auto = !fieldAdv.auto;
        saveFieldPrefs();
        updateNextBtn();
        if (fieldAdv.auto) {
            toast('Auto-advance ON — double-click \u25b6 Next to disable', 'green');
        } else {
            clearTimeout(fieldAdv.timer);
            toast('Auto-advance OFF', '');
        }
    }

    function updateNextBtn() {
        const btn = document.getElementById('btn-next-field');
        if (!btn) return;
        btn.classList.toggle('auto-mode', fieldAdv.auto);
        btn.title = fieldAdv.auto
            ? '\u25b6 Next Field \u2014 Auto ON (double-click to disable)'
            : '\u25b6 Next Field (double-click to enable auto-advance)';
    }

    // ── Field prefs panel ─────────────────────────────────────────────────────

    function toggleFieldPrefs() {
        const panel = document.getElementById('field-prefs-panel');
        if (!panel) return;
        const open = panel.classList.toggle('open');
        if (open) renderFieldPrefs();
    }

    function renderFieldPrefs() {
        const delay = document.getElementById('pref-delay');
        if (delay) delay.value = fieldAdv.delay;
        renderPrefChips('pref-cont-chars', fieldAdv.contChars, (c) => {
            fieldAdv.contChars = fieldAdv.contChars.filter(x => x !== c);
            saveFieldPrefs(); renderFieldPrefs();
        });
        renderPrefChips('pref-cont-words', fieldAdv.contWords, (w) => {
            fieldAdv.contWords = fieldAdv.contWords.filter(x => x !== w);
            saveFieldPrefs(); renderFieldPrefs();
        });
        renderPrefChips('pref-learned', fieldAdv.learned, (w) => {
            fieldAdv.learned = fieldAdv.learned.filter(x => x !== w);
            saveFieldPrefs(); renderFieldPrefs();
        });
    }

    function renderPrefChips(containerId, items, onRemove) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        items.forEach(item => {
            const chip = document.createElement('span');
            chip.className   = 'pref-chip';
            chip.textContent = item;
            chip.title       = 'Click to remove';
            chip.onclick     = () => onRemove(item);
            el.appendChild(chip);
        });
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

    // Public surface
    return {
        newBlock, newSpecimen, undoInsert,
        submitCase, copyToClipboard, clearAll,
        toggleSection, detectFromPaste,
        toggleTheme, toggleFormat,
        goToNextField, toggleAutoAdvance, toggleFieldPrefs
    };

})();
