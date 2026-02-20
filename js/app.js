/**
 * app.js
 * Main application controller.
 * Depends on: cassette.js, api.js
 */

const App = (() => {

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        specimen:    null,   // { id, name }
        histories:   [],     // [{ id, label, is_primary }]
        template_id: null,
        termsShown:  [],     // terms displayed in word cloud this session
        termsUsed:   [],     // terms detected as used in gross text
        sections:    { cloud: true, blocks: true, controls: true }
    };

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        const ta = document.getElementById('dictation');

        // Cassette automation
        Cassette.init(ta);
        ta.addEventListener('cassette:advance', (e) => {
            toast(`${e.detail.letter}${e.detail.from} → ${e.detail.letter}${e.detail.to}`, 'blue');
            updateFooter();
            updateBlockMap();
        });

        // Live footer + block map on any input
        ta.addEventListener('input', () => {
            updateFooter();
            updateBlockMap();
            scanTermUsage();
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
                state.specimen = { id: item.id, name: item.name };
                document.getElementById('specimen-input').value = item.name;
                closeDropdown('specimen-dropdown');
                updateHeaderContext();
                fetchSuggestions();
            },
            async (value) => {
                // New specimen typed — upsert it
                const created = await API.specimens.upsert(value);
                state.specimen = { id: created.id, name: created.name };
                updateHeaderContext();
                fetchSuggestions();
            },
            (row) => ({ label: row.name, meta: row.case_count ? `${row.case_count} cases` : '' })
        );

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

        // Try to infer specimen from template header lines
        // "A. The specimen is received in a container labeled "[___]" with the specimen site "[___]"."
        // Extract everything after "specimen site" as a hint
        const siteMatch = text.match(/specimen site\s+"([^"]+)"/i);
        if (siteMatch && !state.specimen) {
            const inferred = siteMatch[1].trim();
            if (inferred && inferred !== '___') {
                try {
                    const created = await API.specimens.upsert(inferred);
                    state.specimen = { id: created.id, name: created.name };
                    document.getElementById('specimen-input').value = created.name;
                    updateHeaderContext();
                    toast(`Specimen inferred: ${created.name}`, 'blue');
                    fetchSuggestions();
                } catch {}
            }
        }

        // Submit template text to backend for dedup + placeholder extraction
        if (state.specimen && text.length > 30) {
            try {
                const result = await API.templates.submit(state.specimen.id, text);
                state.template_id = result.id;
                if (result.new) {
                    toast(`Template saved (${result.placeholders?.length ?? 0} fields detected)`, 'blue');
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
        const ta    = document.getElementById('dictation');
        const lines = ta.value.split('\n');
        const map   = document.getElementById('block-map');
        const blocks = [];

        lines.forEach(line => {
            const parsed = Cassette.parseBlockLine(line);
            if (parsed) {
                const desc = line.substring(parsed.raw.length).trim();
                blocks.push({ label: `${parsed.letter}${parsed.number}`, desc: desc || '…' });
            }
        });

        if (blocks.length === 0) {
            map.innerHTML = '<span style="font-size:11px;color:var(--muted2);font-style:italic">No blocks detected</span>';
        } else {
            map.innerHTML = blocks.map(b =>
                `<div class="block-row">
                    <span class="block-lbl">${b.label}</span>
                    <span class="block-txt">${b.desc}</span>
                </div>`
            ).join('');
            // Auto-scroll to bottom
            map.scrollTop = map.scrollHeight;
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

        try {
            await API.cases.submit({
                specimen_id:  state.specimen.id,
                template_id:  state.template_id,
                gross_text:   gross,
                histories:    state.histories.map(h => ({ id: h.id, is_primary: h.is_primary ? 1 : 0 })),
                terms_shown:  state.termsShown,
                terms_used:   state.termsUsed
            });
            toast('Case submitted ✓', 'green');
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

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

    // Public surface
    return {
        newBlock, newSpecimen, undoInsert,
        submitCase, copyToClipboard, clearAll,
        toggleSection, detectFromPaste
    };

})();
