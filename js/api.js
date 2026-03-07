/**
 * api.js  v2.1
 * All communication with the PHP backend lives here.
 * Import or include before app.js.
 */

const API = (() => {

    const BASE = 'https://jjjp.ca/grossapp';

    async function request(endpoint, options = {}) {
        const res = await fetch(`${BASE}/${endpoint}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'API error');
        return json.data;
    }

    // ── Specimens ─────────────────────────────────────────────────────────────
    const specimens = {
        search: (q) =>
            request(`specimens.php?q=${encodeURIComponent(q)}`),
        upsert: (name) =>
            request('specimens.php', { method: 'POST', body: JSON.stringify({ name }) })
    };

    // ── Histories ─────────────────────────────────────────────────────────────
    const histories = {
        search: (q) =>
            request(`histories.php?q=${encodeURIComponent(q)}`),
        upsert: (label) =>
            request('histories.php', { method: 'POST', body: JSON.stringify({ label }) })
    };

    // ── Templates ─────────────────────────────────────────────────────────────
    const templates = {
        // Fetch saved blank templates for a specimen (for the Template modal)
        forSpecimen: (specimen_id) =>
            request(`templates_suggest.php?specimen_id=${specimen_id}`),
        submit: (specimen_id, raw_text) =>
            request('templates.php', {
                method: 'POST',
                body: JSON.stringify({ specimen_id, raw_text })
            })
    };

    // ── Suggestions ───────────────────────────────────────────────────────────
    // Returns full data object including:
    //   terms[]     — database terms with scores
    //   llm_terms[] — Anthropic API terms (strings)
    //   source      — 'database' | 'llm' | 'mixed' | 'empty'
    const suggestions = {
        get: (specimen_id, history_ids, primary_history_id) => {
            const ids = history_ids.join(',');
            return request(
                `suggestions.php?specimen_id=${specimen_id}` +
                `&history_ids=${ids}` +
                `&primary_history_id=${primary_history_id}`
            );
        }
    };

    // ── Similarity search ─────────────────────────────────────────────────────
    // Finds past cases similar to the current gross text using TF-IDF cosine
    // similarity on stored case_tokens. POST body carries gross_text since it
    // can be large; query params carry options.
    // Returns: { similar[], query_tokens, total_docs }
    //   similar[]: { case_id, similarity, specimen, histories, excerpt, gross_chars, submitted_at }
    const similarity = {
        find: (gross_text, specimen_id, limit = 5) =>
            request(
                `similarity.php?specimen_id=${encodeURIComponent(specimen_id)}&limit=${limit}`,
                {
                    method: 'POST',
                    body: JSON.stringify({ gross_text })
                }
            )
    };

    // ── Cases ─────────────────────────────────────────────────────────────────
    const cases = {
        submit: (payload) =>
            request('submit_case.php', {
                method: 'POST',
                body: JSON.stringify(payload)
            })
    };

    return { specimens, histories, templates, suggestions, similarity, cases };

})();
