/**
 * api.js
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
        forSpecimen: (specimen_id) =>
            request(`templates.php?specimen_id=${specimen_id}`),
        submit: (specimen_id, raw_text) =>
            request('templates.php', {
                method: 'POST',
                body: JSON.stringify({ specimen_id, raw_text })
            })
    };

    // ── Suggestions ───────────────────────────────────────────────────────────
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

    // ── Cases ─────────────────────────────────────────────────────────────────
    const cases = {
        submit: (payload) =>
            request('submit_case.php', {
                method: 'POST',
                body: JSON.stringify(payload)
            })
    };

    return { specimens, histories, templates, suggestions, cases };

})();
