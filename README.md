# GrossApp

A web application for pathology assistants to dictate gross descriptions, receive AI-assisted term suggestions, and build a self-improving library of templates and terminology over time.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Frontend (GitHub Pages — app.jjjp.ca)              │
│  HTML + CSS + vanilla JS                            │
│  cassette.js · api.js · rapid.js · app.js           │
└───────────────┬────────────────────────┬────────────┘
                │ HTTPS/JSON             │ HTTPS/JSON
                ▼                        ▼
┌───────────────────────┐   ┌────────────────────────────┐
│  Synology NAS         │   │  M4 Mac Mini               │
│  jjjp.ca/grossapp/    │   │  Tokenization Worker       │
│  PHP 8.4 endpoints    │◄──│  tokenize_worker.py        │
│  SQLite database      │   │  Ollama + Gemma2:9b        │
│  grossapp.db          │   │  (runs nightly via launchd)│
└───────────────────────┘   └────────────────────────────┘
                │ Anthropic API (HTTPS)
                ▼
┌───────────────────────┐
│  Anthropic Claude     │
│  claude-opus-4-6      │
│  (LLM term fallback)  │
└───────────────────────┘
```

---

## The Three AI Systems

### 1. Ollama / Gemma2:9b — Nightly Tokenization Worker

**Purpose:** Extract meaningful pathology tokens from completed gross descriptions for the similarity engine.

The tokenization worker (`tokenize_worker.py`) runs nightly on the M4 Mac Mini via launchd. It fetches all unprocessed cases from the Synology, passes each gross description through a locally-running Gemma2:9b model (via Ollama), and asks it to do two things:

- **Descriptor extraction:** Identify up to 40 macroscopic descriptor terms (texture, colour, consistency, architecture, margin features, invasion patterns) that would be useful suggestions for future similar cases. These populate the `terms` table and drive the word cloud.
- **Tokenization:** Extract meaningful terms stripped of measurements, cassette labels, and stopwords, with TF-IDF weights. These populate `case_tokens` and drive the similarity engine.

**Why a local model?** Tokenization runs over every case in the corpus on a nightly schedule. Using a cloud API for this would be expensive and slow. Gemma2:9b on the M4 runs in seconds per case and produces medically-aware term extraction that a simple regex tokenizer cannot.

**PHP fallback:** If Ollama is unavailable (model not loaded, network issue, timeout), the worker falls back to `php_tokenize()` — a regex-based tokenizer that strips measurements and stopwords deterministically. The results are less semantically rich but the pipeline never stalls. The fallback is also used server-side in `similarity.php` for real-time query tokenization, since Ollama is not available during a live user session.

**First-line stripping:** Before any tokenization, the boilerplate reception sentence is removed:
> *"The specimen is received in a container labelled with the patient's name, who has the initials 'XX' and the specimen site 'left breast...'"*

This sentence appears identically in every gross description. Without stripping it, tokens like `specimen`, `patient`, `initials`, and `container` would appear in every case's token set and dilute TF-IDF similarity scores. Suture-orientation words (`long lateral`, `short superior`) embedded in the specimen site field are also removed here.

---

### 2. Anthropic Claude API — Live Term Suggestions

**Purpose:** Supplement the word cloud with intelligently suggested terms when the local database is too sparse.

When a specimen is selected and the `terms` table has fewer than a threshold number of entries for that specimen/history combination, `suggestions.php` calls the Anthropic API (`claude-opus-4-6`) with the specimen name, clinical history, and context to generate a list of relevant pathology descriptor terms.

**Why a cloud LLM here?** This is a real-time request during active dictation. The user expects suggestions within a second or two. Routing to the M4 Mac Mini would add latency and coupling. The Anthropic API is fast, reliable, and produces high-quality domain-specific pathology terms on demand.

**Source tracking:** Every term in the word cloud carries a source flag — `db` (from your own historical cases), `llm` (from the Anthropic API), `sim` (boosted by similar past cases), or a combination. The coloured dot indicators in the sidebar reflect this, and hovering any word cloud term shows its provenance.

**Graduated reliance:** As your case database grows, the LLM is called less frequently. Once a specimen/history combination has enough recorded terms, suggestions come entirely from your own data.

---

### 3. TF-IDF Similarity Engine — Similar Cases Panel

**Purpose:** Find past gross descriptions that are most structurally similar to the one currently being written.

When the gross text reaches a minimum length, `similarity.php` tokenizes it in real time using the PHP fallback tokenizer, builds a TF-IDF query vector, and computes cosine similarity against all stored `case_tokens`. The top N most similar past cases are returned and displayed in the sidebar.

**TF-IDF (Term Frequency–Inverse Document Frequency):** A term that appears often in one case but rarely across the whole corpus gets a high score — it's distinctive. A term like `tan-white` that appears in every case gets a low IDF weight and contributes little to similarity. This means the engine naturally ignores universal boilerplate and focuses on the diagnostically meaningful parts of each description.

**Canonical widening:** If a specimen has few stored cases (e.g. your first right-upper-lobe lung case), the similarity search automatically widens to include sibling specimens in the same canonical organ group. A `right upper lobe lung` case can find similar `left lower lobe lung` cases because the grossing technique is identical regardless of laterality. Once enough same-specimen cases accumulate, the widening stops.

---

## Database Structure

```
specimens           Organ/specimen types (left breast, appendix, etc.)
  └── canonical_id  → parent canonical specimen (breast, colon, etc.)

cases               Submitted gross descriptions
  ├── specimen_id   → specimens
  ├── template_id   → templates (if dictated from a template)
  └── tokenized     Flag: 0 = pending worker, 1 = done

case_histories      Many-to-many: cases ↔ histories

histories           Clinical history entries (IDC, SCC, chronic appendicitis…)

terms               Descriptor terms for the word cloud
  ├── specimen_id   Specific to a specimen type
  ├── history_id    Specific to a history (NULL = general)
  ├── times_shown   How many times surfaced in the word cloud
  └── times_used    How many times clicked and inserted

case_tokens         TF-IDF tokens per case (powers similarity search)
  ├── case_id
  ├── term
  └── tf_idf

corpus_term_frequency   Document frequency per term (for IDF calculation)
  ├── term
  └── document_count

templates           Blank reusable gross description templates
  ├── specimen_id   Associated specimen (NULL = general)
  ├── raw_text      Full template with [___] placeholders intact
  ├── checksum      SHA-256 of stripped text (for deduplication)
  ├── times_used    Incremented each time re-pasted
  ├── first_seen
  └── last_used

template_placeholders   Individual placeholders extracted from templates
  ├── template_id
  ├── placeholder   Hint text inside the brackets
  └── position      Order of appearance
```

---

## Canonical Specimen Groups

Pathology specimens often have laterality or orientation qualifiers that are medically recorded but grossing-technique-neutral. A left breast mastectomy and right breast mastectomy are grossed identically. The canonical group system handles this without collapsing the two specimens into one.

Each specific specimen (e.g. `left breast`, `right breast tissue`) has a `canonical_id` pointing to a parent row (e.g. `breast`). Algorithms widen to the canonical group automatically when a specimen's own data is sparse:

- **Word cloud** — sibling specimen terms blend in at 60% weight
- **Similarity** — widens to sibling cases when fewer than N matches found
- **Templates** — search spans the canonical group

The user always sees the specific specimen name. The canonical grouping is invisible and only activates as a fallback.

---

## Templates — How They Work

### Saving

When a user pastes a blank template into the dictation area, the raw unedited text is captured immediately (before any fields are filled). Once a specimen is inferred from the first line and confirmed, `templates.php` saves the raw text with placeholders intact.

**Deduplication:** The checksum is computed on the template text with the boilerplate reception line neutralised (replaced by a canonical placeholder). This means the same template pasted for different patients — which always has different initials in the first line — correctly maps to the same template record and increments `times_used` rather than creating a new row.

**Placeholders** (`[___]`, `[yes, no]`, `[3 dimensions, color, cystic]`) are extracted and stored separately in `template_placeholders`. The content inside brackets serves as contextual hints displayed during field-advance navigation.

### Using

The Templates modal lets you search all saved templates by keyword before selecting one. Results are ranked by relevance (specimen and history match) and usage frequency. Clicking a template pastes it into the dictation area and navigates to the first unfilled field.

**`times_used`** accumulates over time. Templates used most frequently naturally rank higher in the modal. This creates a self-improving library — your most reliable templates become the easiest to find.

---

## Specimen Inference and Normalization

The first line of every gross description contains a standardized specimen site field:
> *`...the specimen site "left breast, sutures long lateral, short superior".`*

The app reads this field automatically and infers the specimen name, stripping orientation noise before saving:

| Raw specimen site | Saved as |
|---|---|
| `left breast, sutures long lateral, short superior 675 g` | `left breast` |
| `left breast tissue suture short superior long lateral` | `left breast tissue` |
| `right axillary sentinel node #1` | `right axillary sentinel node` |
| `left cheek lesion? SCC` | `left cheek lesion` |

The normalization runs in `app.js` (`normalizeSpecimenName`) and mirrors `normalize_specimen_name()` in `tokenize_worker.py`. Both must stay in sync.

---

## Rapid Mode

For biopsy sessions (many short specimens of the same type), Rapid Mode accepts a template on first paste and auto-advances through all placeholder fields without making any API calls. Each completed block appends the next specimen letter automatically. No word cloud, no similarity, no suggestions — pure speed for high-volume biopsy days.

---

## File Map

### Frontend (GitHub Pages — `app.jjjp.ca`)

| File | Purpose |
|---|---|
| `index.html` | App shell, all CSS |
| `js/app.js` | Main controller: state, word cloud, similarity, templates, inference |
| `js/api.js` | All backend communication |
| `js/cassette.js` | Cassette key automation (block labels, field advance, DMO) |
| `js/rapid.js` | Rapid mode for batch biopsy processing |

### Backend (Synology NAS — `/volume3/web/jjjp.ca/grossapp/`)

| File | Purpose |
|---|---|
| `config.php` | DB path, API keys, allowed origin, debug flag |
| `db.php` | PDO connection singleton |
| `response.php` | `json_success()`, `json_error()`, CORS headers |
| `api/specimens.php` | Specimen search and upsert |
| `api/histories.php` | History search and upsert |
| `api/suggestions.php` | Word cloud terms (DB + canonical widening + LLM fallback) |
| `api/templates.php` | Template save (POST) with checksum deduplication |
| `api/submit_case.php` | Case submission |
| `api/tokenize_queue.php` | Worker fetches pending cases |
| `api/tokenize_result.php` | Worker posts token results |
| `similarity.php` | Real-time TF-IDF cosine similarity search |
| `templates_suggest.php` | Template search by keyword for the modal |
| `admin.php` | Admin panel: stats, merge/rename/delete specimens, manage terms |

### Tokenization Worker (M4 Mac Mini)

| File | Purpose |
|---|---|
| `/usr/local/grossapp/tokenize_worker.py` | Nightly Ollama tokenization worker |
| `~/Library/LaunchAgents/com.grossapp.tokenizer.plist` | launchd schedule (2am daily) |
| `/usr/local/grossapp/logs/tokenizer.log` | Worker log |

---

## Deployment Notes

- **Frontend:** Push to GitHub → auto-deploys to `app.jjjp.ca`. Bump `?v=X.X` on all `<script>` tags in `index.html` on every deploy to bust browser cache.
- **Backend PHP files:** Copy to `/volume3/web/jjjp.ca/grossapp/` on the Synology. Flat structure — no `api/` subfolder prefix in URLs.
- **Database:** `/volume3/web/grossappbackend/data/grossapp.db` — never in the web root.
- **After schema changes:** Run migration SQL via `sqlite3 [db_path] < migration.sql`.
- **After tokenizer changes:** Mark all cases for re-tokenization: `UPDATE cases SET tokenized = 0;`
- **Re-tokenize manually:** `ssh` to M4 and run `python3 /usr/local/grossapp/tokenize_worker.py`
- **API key rotation:** Update `ANTHROPIC_API_KEY` in `config.php`. Old key (sk-ant-api03-Ogt…) was exposed in session history — rotate immediately if not already done.
- **Debug mode:** Set `define('DEBUG_MODE', false)` in `config.php` for production.
