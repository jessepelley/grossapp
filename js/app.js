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
        // Capture state just before any input for cassette:advance undo
        // Word-boundary snapshots: capture text BEFORE the boundary char is inserted
        // so undo/redo navigates word-by-word, not char-by-char.
        ta.addEventListener('beforeinput', (e) => {
            if (e.inputType === 'insertText' && (e.data === ' ' || e.data === '\n')) {
                recordSnapshot('word');
            } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                recordSnapshot('word');
            }
        });
        ta.addEventListener('cassette:advance', (e) => {
            // Snapshot the post-insert state for undo/history
            clearTimeout(_snapshotTimer);
            recordSnapshot('block');
            // Cancel any pending auto-advance so it doesn't steal cursor from the block label
            fieldAdv.anchor = -1;
            clearTimeout(fieldAdv.timer);
            toast(`Block: ${e.detail.prefix}`, 'blue');
            updateFooter();
            updateBlockMap();
        });

        // Live footer + block map on any input
        ta.addEventListener('input', (e) => {
            if (!_restoringFromHistory) {
                // Debounced localStorage draft save
                clearTimeout(_draftSaveTimer);
                _draftSaveTimer = setTimeout(() => {
                    try { localStorage.setItem('grossapp-dictation-draft', ta.value); } catch {}
                }, 300);
                // History snapshot strategy:
                // • paste / drop  → 50 ms (let DOM settle)
                // • word boundary → immediate (captured before-insert in beforeinput; idle below catches post-insert)
                // • everything else (delete, replace, composition) → 800 ms idle
                if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
                    clearTimeout(_snapshotTimer);
                    _snapshotTimer = setTimeout(() => recordSnapshot('paste'), 50);
                } else {
                    clearTimeout(_snapshotTimer);
                    _snapshotTimer = setTimeout(() => recordSnapshot('typed'), 800);
                }
            }
            updateFooter();
            updateBlockMap();
            scanTermUsage();
            checkCompletion();
            maybeInferSpecimen();
            onFieldInput();
            refreshFieldCounter();
            updateFieldAdvStatus();
            updateCopyBtn();
        });

        // Ctrl+Z → undo; Ctrl+Y / Ctrl+Shift+Z → redo
        ta.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'z' && !e.shiftKey) {
                e.preventDefault(); undoAction();
            } else if ((e.ctrlKey || e.metaKey) && !e.altKey &&
                       (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
                e.preventDefault(); redoAction();
            }
        });

        // Detect template on paste; reset field tracking (snapshot handled by input event)
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
                // Selected from dropdown — manual action, lock against re-inference
                state.specimen       = { id: item.id, name: item.name };
                _specimenWasInferred = false;
                document.getElementById('specimen-input').value = item.name;
                closeDropdown('specimen-dropdown');
                updateHeaderContext();
                fetchSuggestions();
                maybeSavePendingTemplate();
                toast(`Specimen: ${item.name}`, 'blue');
            },
            async (value) => {
                // Typed and confirmed with Enter — upsert; manual action
                const created        = await API.specimens.upsert(value);
                state.specimen       = { id: created.id, name: created.name };
                _specimenWasInferred = false;
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
                maybeSavePendingTemplate();
                toast(`Specimen: ${created.name}`, 'blue');
            },
            (row) => ({ label: row.name, meta: row.case_count ? `${row.case_count} cases` : '' })
        );

        // ── Field advancement init ────────────────────────────────────────────
        loadFieldPrefs();
        updateNextBtn();

        // Prev field button
        document.getElementById('btn-prev-field').addEventListener('click', () => goPrevField());

        // Start clipboard background polling (asks for permission once)
        startClipboardPolling();

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
        // Right-click also toggles auto-advance (alternative to double-click)
        document.getElementById('btn-next-field').addEventListener('contextmenu', (e) => {
            e.preventDefault();
            toggleAutoAdvance();
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

        // Cursor-back detection for learning + cancel advance when DMO enters a field
        document.addEventListener('selectionchange', () => {
            checkCursorBack();
            const activeEl = document.activeElement;
            if (activeEl === ta) {
                // Cancel pending auto-advance when cursor enters a field (e.g. DMO highlight)
                if (isCursorInField(ta.value, ta.selectionStart)) {
                    clearTimeout(fieldAdv.timer);
                }
                updateFieldAdvStatus();
            }
        });

        // Also commit specimen on blur (clicking away after typing)
        document.getElementById('specimen-input').addEventListener('blur', async () => {
            const val = document.getElementById('specimen-input').value.trim();
            if (!val || (state.specimen && state.specimen.name === val)) return;
            try {
                const created        = await API.specimens.upsert(val);
                state.specimen       = { id: created.id, name: created.name };
                _specimenWasInferred = false; // user edited manually — lock against re-inference
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
                maybeSavePendingTemplate();
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

        // Close history modal on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeHistoryModal();
        });

        // Restore saved draft unconditionally on load (prevents information loss on reload)
        const savedDraft = localStorage.getItem('grossapp-dictation-draft');
        if (savedDraft) {
            ta.value = savedDraft;
            updateFooter();
            updateBlockMap();
            refreshFieldCounter();
            updateCopyBtn();
            recordSnapshot('draft'); // seed history with restored state
        }

        // Sync footer and Next button to loaded preferences
        updateFieldAdvStatus();
    }

    // ── Autocomplete factory ──────────────────────────────────────────────────
    // Builds a reusable autocomplete on any input + dropdown pair
    function setupAutocomplete(inputId, dropdownId, searchFn, onSelect, onNew, renderRow) {
        const input    = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        let timer      = null;
        let activeIdx  = -1;

        function getItems() { return dropdown.querySelectorAll('.dd-item'); }

        function setActive(idx) {
            const items = getItems();
            activeIdx = Math.max(-1, Math.min(idx, items.length - 1));
            items.forEach((el, i) => el.classList.toggle('highlighted', i === activeIdx));
        }

        input.addEventListener('input', () => {
            clearTimeout(timer);
            activeIdx = -1;
            const q = input.value.trim();
            if (!q) { closeDropdown(dropdownId); return; }
            timer = setTimeout(async () => {
                try {
                    const results = await searchFn(q);
                    renderDropdown(dropdown, results, renderRow, onSelect, q, onNew);
                    activeIdx = -1;
                } catch { closeDropdown(dropdownId); }
            }, 200);
        });

        input.addEventListener('keydown', (e) => {
            const isOpen = dropdown.classList.contains('open');

            if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && isOpen)) {
                if (!isOpen) return;
                e.preventDefault();
                setActive(activeIdx + 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                if (!isOpen) return;
                e.preventDefault();
                setActive(activeIdx - 1);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const items = getItems();
                if (isOpen && activeIdx >= 0 && items[activeIdx]) {
                    items[activeIdx].click();
                } else {
                    const val = input.value.trim();
                    if (val) onNew(val);
                    closeDropdown(dropdownId);
                }
                activeIdx = -1;
                return;
            }
            if (e.key === 'Escape') {
                closeDropdown(dropdownId);
                activeIdx = -1;
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                closeDropdown(dropdownId);
                activeIdx = -1;
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

            // Prevent focus loss from textarea when clicking a term
            el.addEventListener('mousedown', (e) => e.preventDefault());
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

        // Save raw template to localStorage immediately (before edits), so it
        // can be submitted to the backend once a specimen is set.
        if (text.length > 30 && /\[[^\]]*\]/.test(text) && !_pendingRawTemplate) {
            _pendingRawTemplate = text;
            try { localStorage.setItem('grossapp-pending-template', text); } catch {}
        }

        // If specimen is known, submit the raw (unfilled) template to backend.
        // Using _pendingRawTemplate ensures we submit the original unfilled version
        // even when detectFromPaste is called after the user has started filling in fields.
        if (state.specimen) {
            await maybeSavePendingTemplate();
        }

        updateFooter();
        updateBlockMap();
    }

    // ── Footer + block map ────────────────────────────────────────────────────
    function updateFooter() {
        const ta   = document.getElementById('dictation');
        const text = ta.value;

        document.getElementById('char-count').textContent = `${text.length} chars`;

        // Block count using cassette parser — handles both LN and NL formats
        const lines      = text.split('\n');
        const blockCount = lines.filter(l => Cassette.parseBlockLine(l) !== null).length;
        document.getElementById('block-count').textContent = `${blockCount} block${blockCount !== 1 ? 's' : ''}`;

        // Next block preview using cassette's own nextPrefix (handles both formats)
        const result  = Cassette.findLastBlock(ta);
        const preview = document.getElementById('next-block-preview');
        if (result) {
            preview.textContent = `Next: ${Cassette.nextPrefix(result.parsed)}`;
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

    // Scan textarea for filled-in specimen site and infer specimen.
    // Re-runs even when specimen is already set IF it was auto-inferred (not manually set).
    // Pattern: specimen site "something that is not [___]"
    let _inferTimer          = null;
    let _specimenWasInferred = false; // true when specimen came from auto-inference

    function maybeInferSpecimen() {
        // Only skip if the specimen was set manually by the user
        if (state.specimen && !_specimenWasInferred) return;
        clearTimeout(_inferTimer);
        _inferTimer = setTimeout(async () => {
            const text = document.getElementById('dictation').value;
            // Match: specimen site "VALUE" where VALUE is not a placeholder
            const m = text.match(/specimen site\s+"([^"\[\]]{3,})"/i);
            if (!m) return;
            let inferred = m[1].trim();
            if (!inferred || /^\[/.test(inferred)) return;

            // Truncate at first comma — removes orientation/description details
            // e.g. "right breast lump, sutures long..." → "right breast lump"
            const commaIdx = inferred.indexOf(',');
            if (commaIdx > 2) inferred = inferred.substring(0, commaIdx).trim();
            if (!inferred) return;

            // Skip if nothing changed
            if (state.specimen && state.specimen.name === inferred) return;

            try {
                const created     = await API.specimens.upsert(inferred);
                const wasUpdating = !!state.specimen;
                state.specimen    = { id: created.id, name: created.name };
                _specimenWasInferred = true;
                document.getElementById('specimen-input').value = created.name;
                updateHeaderContext();
                fetchSuggestions();
                if (wasUpdating) {
                    toast(`Specimen updated: ${created.name}`, 'blue');
                } else {
                    maybeSavePendingTemplate(); // first inference — now submit raw template
                    toast(`Specimen inferred: ${created.name}`, 'blue');
                }
            } catch {}
        }, 800); // debounce — only fires 800 ms after user stops typing
    }

    // Check if the gross appears complete (no unfilled placeholders remain)
    // and update the Submit Case button state accordingly.
    // Auto-copies to clipboard when all fields are filled.
    function checkCompletion() {
        const text = document.getElementById('dictation').value;
        const hasUnfilled = /\[[^\]]*\]/.test(text); // any [...] remaining (including [])
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

        // Auto-copy to clipboard when all fields are filled (debounced).
        // After first copy (toast shown), continue silently updating on further edits.
        if (complete) {
            clearTimeout(_autoCopyTimer);
            _autoCopyTimer = setTimeout(() => {
                const t = document.getElementById('dictation').value;
                if (!/\[[^\]]*\]/.test(t) && t.trim().length > 50) {
                    const isFirst = !_autoCopied;
                    navigator.clipboard?.writeText(t).then(() => {
                        if (isFirst) {
                            _autoCopied = true;
                            toast('All fields complete \u2014 copied to clipboard \u2713', 'green');
                        }
                        // subsequent edits: clipboard updated silently
                    }).catch(() => {});
                }
            }, 800);
        } else {
            _autoCopied = false;
            clearTimeout(_autoCopyTimer);
        }
    }

    // ── History tape (unified undo/redo + viewer) ─────────────────────────────
    // Each entry: { text: string, timestamp: Date, label: string }
    // _historyIdx points to the entry we're currently "at"; -1 = empty tape.

    const _historyTape          = [];
    let   _historyIdx           = -1;
    const _MAX_HISTORY          = 500;
    let   _snapshotTimer        = null;   // debounce for idle-typed snapshots
    let   _restoringFromHistory = false;  // guard: suppress snapshot during restore

    // Record a snapshot of the current textarea value.
    function recordSnapshot(label) {
        if (_restoringFromHistory) return;
        const ta   = document.getElementById('dictation');
        const text = ta.value;
        // Deduplicate: skip if text is unchanged from head
        if (_historyIdx >= 0 && _historyTape[_historyIdx].text === text) return;
        // Truncate any future entries (discard redo branch)
        if (_historyIdx < _historyTape.length - 1) {
            _historyTape.splice(_historyIdx + 1);
        }
        _historyTape.push({ text, timestamp: new Date(), label });
        _historyIdx = _historyTape.length - 1;
        // Cap size by removing oldest entries
        while (_historyTape.length > _MAX_HISTORY) {
            _historyTape.shift();
            _historyIdx--;
        }
    }

    // Restore textarea to a specific snapshot (does not add to tape).
    function restoreHistoryState(snap) {
        const ta = document.getElementById('dictation');
        _restoringFromHistory = true;
        ta.value = snap.text;
        ta.selectionStart = ta.selectionEnd = snap.text.length;
        ta.focus();
        _restoringFromHistory = false;
        // Update UI — do NOT dispatch input event (would re-trigger cassette)
        updateFooter(); updateBlockMap(); scanTermUsage();
        checkCompletion(); refreshFieldCounter(); updateCopyBtn();
        // Keep localStorage draft in sync
        try { localStorage.setItem('grossapp-dictation-draft', snap.text); } catch {}
    }

    function undoAction() {
        const ta  = document.getElementById('dictation');
        const cur = ta.value;
        // If there's unsaved work since the last snapshot, capture it first so redo can return
        if (_historyIdx < 0 || cur !== _historyTape[_historyIdx].text) {
            recordSnapshot('pre-undo');
        }
        if (_historyIdx <= 0) { toast('Nothing to undo', ''); return false; }
        _historyIdx--;
        restoreHistoryState(_historyTape[_historyIdx]);
        toast('Undone', '');
        return true;
    }

    function redoAction() {
        if (_historyIdx >= _historyTape.length - 1) { toast('Nothing to redo', ''); return false; }
        _historyIdx++;
        restoreHistoryState(_historyTape[_historyIdx]);
        toast('Redone', '');
        return true;
    }

    // ── History viewer ────────────────────────────────────────────────────────

    function openHistoryModal() {
        const overlay = document.getElementById('history-modal-overlay');
        if (!overlay) return;
        renderHistoryTape();
        overlay.style.display = 'flex';
    }

    function closeHistoryModal() {
        const overlay = document.getElementById('history-modal-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    function renderHistoryTape() {
        const list = document.getElementById('history-tape-list');
        if (!list) return;
        list.innerHTML = '';

        if (_historyTape.length === 0) {
            list.innerHTML = '<div class="hst-empty">No history yet — start typing</div>';
            return;
        }

        const ta          = document.getElementById('dictation');
        const currentText = ta.value;
        const headText    = _historyTape[_historyIdx] ? _historyTape[_historyIdx].text : null;

        // Show unsaved "current" state at top if text has diverged from head snapshot
        if (headText !== null && currentText !== headText) {
            const stats = diffStats(headText, currentText);
            const el    = document.createElement('div');
            el.className = 'hst-entry hst-unsaved';
            el.innerHTML = _buildEntryHTML('now', 'unsaved', stats, currentText.length);
            el.title = 'Current unsaved state (not yet a snapshot)';
            list.appendChild(el);
        }

        // Entries in reverse chronological order (most recent first, like git log)
        for (let i = _historyTape.length - 1; i >= 0; i--) {
            const entry = _historyTape[i];
            const prev  = i > 0 ? _historyTape[i - 1] : null;
            const stats = prev
                ? diffStats(prev.text, entry.text)
                : { added: entry.text.length, removed: 0 };

            const el = document.createElement('div');
            el.className = 'hst-entry' + (i === _historyIdx ? ' hst-active' : '');
            el.innerHTML = _buildEntryHTML(
                _fmtHistTime(entry.timestamp),
                _fmtHistLabel(entry.label),
                stats,
                entry.text.length
            );
            el.dataset.idx = i;
            el.title = i === _historyIdx ? 'Current position' : 'Click to restore this state';
            el.addEventListener('click', () => restoreHistoryEntry(i));
            list.appendChild(el);
        }
    }

    function _buildEntryHTML(time, label, stats, charCount) {
        const addedHtml   = stats.added   > 0 ? `<span class="hst-plus">+${stats.added}</span>`   : '';
        const removedHtml = stats.removed > 0 ? `<span class="hst-minus">−${stats.removed}</span>` : '';
        const noneHtml    = stats.added === 0 && stats.removed === 0 ? '<span class="hst-nodiff">·</span>' : '';
        return `<span class="hst-time">${time}</span>` +
               `<span class="hst-label">${label}</span>` +
               `<span class="hst-diff">${addedHtml}${removedHtml}${noneHtml}</span>` +
               `<span class="hst-len">${charCount}&thinsp;c</span>`;
    }

    function diffStats(oldText, newText) {
        // Fast prefix/suffix heuristic: find changed region, count added vs removed chars
        let s = 0;
        while (s < oldText.length && s < newText.length && oldText[s] === newText[s]) s++;
        let oe = oldText.length, ne = newText.length;
        while (oe > s && ne > s && oldText[oe - 1] === newText[ne - 1]) { oe--; ne--; }
        return { added: ne - s, removed: oe - s };
    }

    function restoreHistoryEntry(idx) {
        if (idx < 0 || idx >= _historyTape.length) return;
        _historyIdx = idx;
        restoreHistoryState(_historyTape[idx]);
        toast('Restored \u2014 ' + _fmtHistTime(_historyTape[idx].timestamp), 'blue');
        renderHistoryTape(); // refresh to update current marker
    }

    function _fmtHistTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function _fmtHistLabel(label) {
        return ({
            typed:      'typed',
            word:       'word boundary',
            paste:      'paste',
            clipboard:  'clipboard paste',
            block:      'block insert',
            draft:      'draft loaded',
            'pre-undo': 'pre-undo',
            'new case': 'new case',
            'new specimen': 'new specimen',
        })[label] || label;
    }

    // ── Cassette button handlers ──────────────────────────────────────────────
    function newBlock() {
        const ta = document.getElementById('dictation');
        Cassette.handleNewBlock(ta); // fires cassette:advance which calls recordSnapshot('block')
        fieldAdv.anchor = -1;        // cancel pending auto-advance so cursor stays at block label
        clearTimeout(fieldAdv.timer);
        updateFooter();
        updateBlockMap();
    }

    function newSpecimen() {
        if (document.getElementById('dictation').value &&
            !confirm('Clear gross and specimen for next specimen?\nClinical history will be kept.')) return;

        document.getElementById('dictation').value = '';
        document.getElementById('specimen-input').value = '';
        document.getElementById('history-input').value = '';
        // Keep history-tags and state.histories intentionally
        document.getElementById('word-cloud').innerHTML =
            '<span class="cloud-empty">Select a specimen to see suggestions</span>';
        document.getElementById('block-map').innerHTML =
            '<span style="font-size:11px;color:var(--muted2);font-style:italic">No blocks detected</span>';

        state.specimen    = null;
        state.template_id = null;
        state.termsShown  = [];
        state.termsUsed   = [];
        state.submitted   = false;

        _historyTape.length  = 0;
        _historyIdx          = -1;
        clearTimeout(_snapshotTimer);
        _autoCopied          = false;
        _specimenWasInferred = false;
        clearTimeout(_autoCopyTimer);
        _pendingRawTemplate  = null;
        try { localStorage.removeItem('grossapp-pending-template'); } catch {}
        try { localStorage.removeItem('grossapp-dictation-draft'); } catch {}

        fieldAdv.anchor    = -1;
        fieldAdv.watchBack = false;
        clearTimeout(fieldAdv.timer);
        updateFieldCounter(0, 0);

        updateFooter();
        updateHeaderContext();
        updateNextBtn();
        updateFieldAdvStatus();
        updateCopyBtn();
        checkCompletion();
        recordSnapshot('new specimen'); // mark start of new specimen in history
        toast('Ready for next specimen \u2014 history retained', 'blue');
    }

    function undoInsert() {
        undoAction();
    }

    function redoInsert() {
        redoAction();
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

        // Reset history tape, auto-copy guard, pending template, and inference flag
        _historyTape.length  = 0;
        _historyIdx          = -1;
        clearTimeout(_snapshotTimer);
        _autoCopied          = false;
        _specimenWasInferred = false;
        clearTimeout(_autoCopyTimer);
        _pendingRawTemplate  = null;
        try { localStorage.removeItem('grossapp-pending-template'); } catch {}
        try { localStorage.removeItem('grossapp-dictation-draft'); } catch {}

        // Reset field tracking
        fieldAdv.anchor    = -1;
        fieldAdv.watchBack = false;
        clearTimeout(fieldAdv.timer);
        updateFieldCounter(0, 0);

        updateFooter();
        updateHeaderContext();
        updateNextBtn();
        updateFieldAdvStatus();
        updateCopyBtn();
        checkCompletion();
        recordSnapshot('new case'); // mark start of new case in history
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

    // ── Clipboard / Paste ─────────────────────────────────────────────────────

    let _clipText        = '';      // last clipboard text read
    let _clipHasTemplate = false;   // whether it contains [...] fields
    let _clipPoller      = null;
    let _autoCopied      = false;   // guard for auto-copy-on-complete
    let _autoCopyTimer   = null;
    let _pendingRawTemplate = null; // raw (unfilled) template saved on paste
    let _draftSaveTimer  = null;    // debounce timer for localStorage draft save

    function updatePasteBtn() {
        const btn = document.getElementById('btn-paste');
        if (!btn) return;
        btn.classList.toggle('has-template', _clipHasTemplate);
        btn.title = _clipHasTemplate
            ? 'Template detected in clipboard \u2014 click to paste (replaces all text)'
            : 'Paste from clipboard (replaces all text)';
    }

    async function startClipboardPolling() {
        if (!navigator.clipboard?.readText) return;
        async function poll() {
            try {
                const text = await navigator.clipboard.readText();
                if (text !== _clipText) {
                    _clipText        = text;
                    _clipHasTemplate = text.length > 20 && /\[[^\]]*\]/.test(text);
                    updatePasteBtn();
                }
            } catch { /* no focus or permission denied */ }
        }
        try {
            const perm = await navigator.permissions.query({ name: 'clipboard-read' });
            if (perm.state === 'denied') return;
            perm.addEventListener('change', () => {
                if (perm.state === 'denied') {
                    clearInterval(_clipPoller); _clipPoller = null;
                } else if (!_clipPoller) {
                    poll(); _clipPoller = setInterval(poll, 2000);
                }
            });
        } catch { /* Firefox: no clipboard-read in permissions API — fall through */ }
        poll();
        _clipPoller = setInterval(poll, 2000);
    }

    async function pasteFromClipboard() {
        let text = _clipText;
        if (!text) {
            try { text = await navigator.clipboard.readText(); } catch {
                toast('Clipboard not accessible', ''); return;
            }
        }
        if (!text.trim()) { toast('Clipboard is empty', ''); return; }

        const ta = document.getElementById('dictation');
        clearTimeout(_snapshotTimer); // cancel idle, snapshot after paste

        ta.value = text;
        ta.selectionStart = ta.selectionEnd = 0;
        ta.focus();
        recordSnapshot('clipboard'); // capture post-paste state in history

        // Save raw template immediately (before any edits)
        if (/\[[^\]]*\]/.test(text)) {
            _pendingRawTemplate = text;
            try { localStorage.setItem('grossapp-pending-template', text); } catch {}
        }

        // Reset field tracking
        fieldAdv.anchor = -1;
        clearTimeout(fieldAdv.timer);

        // Update UI without triggering cassette auto-advance
        updateFooter();
        updateBlockMap();
        scanTermUsage();
        checkCompletion();
        refreshFieldCounter();

        _clipHasTemplate = false;
        updatePasteBtn();
        updateCopyBtn();
        toast('Pasted from clipboard', 'blue');
        detectFromPaste();
    }

    async function maybeSavePendingTemplate() {
        if (!state.specimen) return;
        if (!_pendingRawTemplate) {
            try { _pendingRawTemplate = localStorage.getItem('grossapp-pending-template') || null; } catch {}
        }
        if (!_pendingRawTemplate) return;

        const raw = _pendingRawTemplate;
        _pendingRawTemplate = null;
        try { localStorage.removeItem('grossapp-pending-template'); } catch {}

        try {
            const result = await API.templates.submit(state.specimen.id, raw);
            state.template_id = result.id;
            toast(result.new
                ? `Template saved (${result.placeholders?.length ?? 0} fields detected)`
                : `Template recognised`, 'blue');
        } catch {}
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
        const re  = /\[[^\]]*\]/g;
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

    // Navigate to the previous [...] field, wrapping around if at the first one.
    function goPrevField(fromPos) {
        const ta     = document.getElementById('dictation');
        const text   = ta.value;
        const from   = fromPos !== undefined ? fromPos : ta.selectionStart;
        const fields = findAllFields(text);

        if (fields.length === 0) {
            toast('No fields remaining', '');
            fieldAdv.anchor = -1;
            updateFieldCounter(0, 0);
            return false;
        }

        // Last field that starts strictly before `from`; wrap to last if none
        let target = null;
        for (let i = fields.length - 1; i >= 0; i--) {
            if (fields[i].start < from - 1) { target = fields[i]; break; }
        }
        if (!target) target = fields[fields.length - 1];

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
            updateFieldAdvStatus();
            return;
        }

        // Only drive auto-advance when that mode is on
        if (!fieldAdv.auto) return;

        // Estimate replacement: text from anchor to cursor
        const anchor = Math.min(fieldAdv.anchor, text.length);
        const filled = text.substring(anchor, cursor).trim();
        if (!filled) { clearTimeout(fieldAdv.timer); updateFieldAdvStatus(); return; }

        if (shouldHoldAdvance(filled)) { clearTimeout(fieldAdv.timer); updateFieldAdvStatus(); return; }

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
        updateFieldAdvStatus();
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
        updateFieldAdvStatus();
        if (fieldAdv.auto) {
            toast('Auto-advance ON — right-click \u25b6 Next to disable', 'green');
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
            ? '\u25b6 Next Field \u2014 Auto ON (right-click or double-click to disable)'
            : '\u25b6 Next Field (right-click or double-click to enable auto-advance)';
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

    // ── Copy button state ─────────────────────────────────────────────────────
    function updateCopyBtn() {
        const btn = document.getElementById('btn-copy-sidebar');
        if (!btn) return;
        const hasContent = document.getElementById('dictation').value.trim().length > 0;
        btn.classList.toggle('green-btn', hasContent);
    }

    // ── Footer auto-next status ────────────────────────────────────────────────
    function updateFieldAdvStatus() {
        const el = document.getElementById('field-adv-status');
        if (!el) return;

        if (!fieldAdv.auto) { el.textContent = ''; return; }

        const ta     = document.getElementById('dictation');
        const text   = ta.value;
        const cursor = ta.selectionEnd;
        const anchor = fieldAdv.anchor >= 0 ? Math.min(fieldAdv.anchor, text.length) : -1;

        if (anchor < 0) { el.textContent = 'auto-next: on'; return; }

        const filled = text.substring(anchor, cursor).trim();
        if (!filled) { el.textContent = 'auto-next: on'; return; }

        const lastChar = filled[filled.length - 1];
        if (fieldAdv.contChars.includes(lastChar)) {
            el.textContent = `auto-next: paused (${lastChar})`;
            return;
        }

        const words    = filled.toLowerCase().split(/\s+/);
        const lastWord = words[words.length - 1].replace(/[.,;:!?]+$/, '');
        if (fieldAdv.contWords.some(w => w.toLowerCase() === lastWord) ||
            fieldAdv.learned.some(w => w.toLowerCase() === lastWord)) {
            el.textContent = `auto-next: paused (\u201c${lastWord}\u201d)`;
            return;
        }

        el.textContent = fieldAdv.timer ? 'auto-next: counting\u2026' : 'auto-next: on';
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);

    // Public surface
    return {
        newBlock, newSpecimen, undoInsert, redoInsert,
        submitCase, copyToClipboard, clearAll,
        toggleSection, detectFromPaste,
        toggleTheme, toggleFormat,
        goToNextField, goPrevField, toggleAutoAdvance, toggleFieldPrefs,
        pasteFromClipboard,
        openHistoryModal, closeHistoryModal, restoreHistoryEntry
    };

})();
