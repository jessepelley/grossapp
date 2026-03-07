/**
 * api.js  v2.2
 * All communication with the PHP backend lives here.
 * Import or include before app.js.
 */
console.log('%capi.js v2.2', 'color:#1a4f8a;font-weight:bold', 'loaded ✓');

const API = (() => {

    const BASE = 'https://api.jjjp.ca/grossapp';

    // Cloudflare Access login URL — redirects here when session is missing,
    // then returns the user to the app after authentication.
    const CF_LOGIN = 'https://jjjp.cloudflareaccess.com/cdn-cgi/access/login'
        + '?redirect_url=' + encodeURIComponent(window.location.href);

    // Resolves when the CF auth popup signals success
    let _authResolve = null;
    window.addEventListener('message', (e) => {
        if (e.data === 'cf_auth_ok' && _authResolve) {
            _authResolve();
            _authResolve = null;
        }
    });

    function handleUnauthorized() {
        return new Promise((resolve) => {
            _authResolve = resolve;
            const popup = window.open(
                'https://api.jjjp.ca/grossapp/cf_ping.php',
                'cf_login',
                'width=520,height=480,menubar=no,toolbar=no,location=no'
            );
            // Fallback if popup is blocked or closed manually
            const check = setInterval(() => {
                if (!popup || popup.closed) {
                    clearInterval(check);
                    if (_authResolve) { _authResolve(); _authResolve = null; }
                }
            }, 500);
        });
    }

    async function request(endpoint, options = {}) {
        const res = await fetch(`${BASE}/${endpoint}`, {
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            ...options
        });
        if (res.status === 401) {
            await handleUnauthorized();
            // Retry once after authentication
            const retry = await fetch(`${BASE}/${endpoint}`, {
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                ...options
            });
            if (retry.status === 401) throw new Error('Authentication failed — please refresh the page');
            const retryJson = await retry.json();
            if (!retryJson.ok) throw new Error(retryJson.error || 'API error');
            return retryJson.data;
        }
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
        // Free-text search across all templates, optionally boosted by context.
        // Returns full { ok, data, count, query } — does NOT go through request()
        // because templates_search.php returns extra fields beyond just .data.
        search: async (q, specimen_id) => {
            const params = new URLSearchParams({ q: q ?? '' });
            if (specimen_id) params.set('specimen_id', specimen_id);
            const res  = await fetch(`${BASE}/templates_search.php?${params}`, {
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || 'Template search error');
            return json;  // caller uses json.data
        },
        // Fetch saved blank templates for a specimen (legacy, used internally)
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
