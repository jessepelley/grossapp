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
        });

        // Detect template on paste
        ta.addEventListener('paste', () => {
            setTimeout(() => detectFromPaste(), 50);
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

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

    // Public surface
    return {
        newBlock, newSpecimen, undoInsert,
        submitCase, copyToClipboard, clearAll,
        toggleSection, detectFromPaste,
        toggleTheme, toggleFormat
    };

})();
