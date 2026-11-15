'use strict';

/**
 * Heating program (Heizprogramm, the week schedule) of the whole house via the Controme web UI.
 * The public API has no call for this; the web UI does (captured by the owner 2026-11-15, Smart-Heat-OS):
 *   login:  GET  /accounts/m_login/                → cookie csrftoken + hidden csrfmiddlewaretoken
 *           POST /accounts/m_login/  mail, pw, csrfmiddlewaretoken (form)   → cookie sessionid
 *   read:   GET  /m_heizprogramm/<house>/          → HTML list "Heizprogramm: <name>", one radio per program
 *   switch: POST /m_heizprogramm/<house>/  activated=<index>  (X-CSRFToken, X-Requested-With: XMLHttpRequest)
 * index = position of the program in that list, 0-based (3 programs → activated 0, 1, 2).
 * Fail closed: a program is only switched by a name or index that was read from the page.
 * Cookies live in memory only and are never logged.
 */

const LOGIN = '/accounts/m_login/';

/**
 * Collects cookies from set-cookie headers into a jar object.
 *
 * @param jar name → value
 * @param setCookie the set-cookie header (array or string)
 * @returns the jar
 */
function storeCookies(jar, setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const c of list) {
        const m = /^\s*([^=;\s]+)=([^;]*)/.exec(String(c));
        if (m) {
            jar[m[1]] = m[2];
        }
    }
    return jar;
}

/**
 * @param jar name → value
 * @returns Cookie header value
 */
function cookieHeader(jar) {
    return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/**
 * @param html login page
 * @returns the hidden csrfmiddlewaretoken, or ''
 */
function parseLoginToken(html) {
    const m = /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/.exec(String(html || ''));
    return m ? m[1] : '';
}

/**
 * Decodes the few HTML entities a program name can contain.
 *
 * @param t text
 * @returns decoded, trimmed text
 */
function decode(t) {
    return t
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parses the program page: program names in list order and, if the markup shows it, the active one.
 * Active = the list entry (<li>) of exactly one program carries a checked marker (checked attribute,
 * "checked" / "ui-radio-on" / "active" class). Otherwise active is -1 (unknown).
 *
 * @param html page /m_heizprogramm/<house>/
 * @returns names (index = activated value) and the active index (-1 = unknown)
 */
function parsePrograms(html) {
    const s = String(html || '');
    const names = [];
    const positions = [];
    const re = /Heizprogramm:\s*([^<]+)</g;
    let m;
    while ((m = re.exec(s))) {
        const name = decode(m[1]);
        if (name) {
            names.push(name);
            positions.push(m.index);
        }
    }
    const marked = [];
    positions.forEach((pos, i) => {
        const start = s.lastIndexOf('<li', pos);
        const end = s.indexOf('</li>', pos);
        if (start < 0 || end < 0) {
            return;
        }
        const item = s.slice(start, end);
        if (/\bchecked\b|\bui-radio-on\b|class=['"][^'"]*\bactive\b/.test(item)) {
            marked.push(i);
        }
    });
    return { names, active: marked.length === 1 ? marked[0] : -1 };
}

/**
 * Resolves a written program value to its index: a name (case-insensitive, as read from the page) or the
 * plain decimal index. Unknown → -1.
 *
 * @param value written value
 * @param names program names in list order
 * @returns index or -1
 */
function resolveProgram(value, names) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 0 && value < names.length ? value : -1;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return -1;
    }
    const norm = t => t.trim().toLowerCase();
    const byName = names.findIndex(n => norm(n) === norm(value));
    if (byName >= 0) {
        return byName;
    }
    if (/^\s*\d+\s*$/.test(value)) {
        const n = Number(value);
        return n < names.length ? n : -1;
    }
    return -1;
}

/** A logged-in web UI session. */
class WebUi {
    /**
     * @param http axios-like client ({ get, post })
     * @param config adapter config: url, houseID, user, password
     */
    constructor(http, config) {
        this.http = http;
        this.base = `http://${config.url}`;
        this.house = config.houseID;
        this.user = config.user;
        this.password = config.password;
        this.jar = {};
    }

    /**
     * Request options: no redirects followed, cookies attached.
     *
     * @param extra extra axios options and headers
     * @returns axios options
     */
    _opts(extra = {}) {
        return {
            timeout: 15000,
            maxRedirects: 0,
            validateStatus: s => s >= 200 && s < 400,
            ...extra,
            headers: { Cookie: cookieHeader(this.jar), ...(extra.headers || {}) },
        };
    }

    /**
     * @param res axios response
     * @returns true if the server redirects to the login page
     */
    _isLoginRedirect(res) {
        const loc = res && res.headers && res.headers.location;
        return !!(res && res.status >= 300 && res.status < 400 && loc && String(loc).includes(LOGIN));
    }

    /** Logs in (fresh cookies): login page → csrf token → POST mail/pw → sessionid. */
    async login() {
        this.jar = {};
        const page = await this.http.get(this.base + LOGIN, this._opts());
        storeCookies(this.jar, page.headers['set-cookie']);
        const token = parseLoginToken(page.data);
        if (!token) {
            throw new Error('web UI login: no csrf token on the login page');
        }
        const body = new URLSearchParams({ csrfmiddlewaretoken: token, mail: this.user, pw: this.password }).toString();
        const res = await this.http.post(
            this.base + LOGIN,
            body,
            this._opts({
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base + LOGIN },
            }),
        );
        storeCookies(this.jar, res.headers['set-cookie']);
        if (!this.jar.sessionid) {
            throw new Error('web UI login failed (no session; check user and password in the adapter config)');
        }
    }

    /** @returns URL of the program page */
    _pageUrl() {
        return `${this.base}/m_heizprogramm/${this.house}/`;
    }

    /** GET the program page, with one re-login when the session expired. */
    async _getPage() {
        if (!this.jar.sessionid) {
            await this.login();
        }
        let res = await this.http.get(this._pageUrl(), this._opts());
        if (this._isLoginRedirect(res)) {
            await this.login();
            res = await this.http.get(this._pageUrl(), this._opts());
        }
        if (this._isLoginRedirect(res) || res.status !== 200) {
            throw new Error(`web UI: program page not readable (HTTP ${res.status})`);
        }
        storeCookies(this.jar, res.headers['set-cookie']);
        return String(res.data || '');
    }

    /** @returns names in list order and the active index (-1 = unknown) */
    async readPrograms() {
        return parsePrograms(await this._getPage());
    }

    /**
     * Switches the house to the program with this index (the index must come from readPrograms).
     *
     * @param index program index
     */
    async activate(index) {
        const res = await this.http.post(
            this._pageUrl(),
            `activated=${encodeURIComponent(String(index))}`,
            this._opts({
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-CSRFToken': this.jar.csrftoken || '',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: this._pageUrl(),
                    Origin: this.base,
                },
            }),
        );
        if (this._isLoginRedirect(res) || res.status >= 300) {
            throw new Error(`web UI: switching the program failed (HTTP ${res.status})`);
        }
    }
}

module.exports = { storeCookies, cookieHeader, parseLoginToken, parsePrograms, resolveProgram, WebUi };
