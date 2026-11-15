'use strict';
/* global describe, it */

const { expect } = require('chai');
const { storeCookies, parseLoginToken, parsePrograms, resolveProgram, WebUi } = require('./webui');

const PAGE = active => `<ul data-role="listview">
  <li class="${active === 0 ? 'ui-radio-on' : ''}"><a href="/m_heizprogramm/1/edit/3/">Heizprogramm: Standard</a></li>
  <li class="${active === 1 ? 'ui-radio-on' : ''}"><a href="/m_heizprogramm/1/edit/5/">Heizprogramm: Normales Programm</a></li>
  <li class="${active === 2 ? 'ui-radio-on' : ''}"><a href="/m_heizprogramm/1/edit/8/">Heizprogramm: NoKids &amp; Co</a></li>
</ul><a>Heizprogramm erstellen</a>`;

/**
 * A fake Controme web UI (Django-like): CSRF, sessions, login redirect.
 *
 * @param root0
 * @param root0.user
 * @param root0.pw
 */
function fakeServer({ user = 'me@x.de', pw = 'secret' } = {}) {
    const st = { sessions: new Set(), active: 1, posts: [], logins: 0, n: 0 };
    const res = (status, data = '', headers = {}) => ({ status, data, headers });
    const cookies = o =>
        Object.fromEntries(
            ((o.headers && o.headers.Cookie) || '')
                .split('; ')
                .filter(Boolean)
                .map(c => c.split('=')),
        );
    const loggedIn = o => st.sessions.has(cookies(o).sessionid);
    const toLogin = () => res(302, '', { location: '/accounts/m_login/?next=/m_heizprogramm/1/' });
    st.http = {
        get: async (url, o) => {
            if (url.endsWith('/accounts/m_login/')) {
                return res(200, `<form><input type='hidden' name='csrfmiddlewaretoken' value='tok123' /></form>`, {
                    'set-cookie': ['csrftoken=ck1; Path=/; SameSite=Lax'],
                });
            }
            if (url.endsWith('/m_heizprogramm/1/')) {
                return loggedIn(o) ? res(200, PAGE(st.active)) : toLogin();
            }
            return res(404);
        },
        post: async (url, body, o) => {
            const form = Object.fromEntries(new URLSearchParams(body));
            if (url.endsWith('/accounts/m_login/')) {
                if (form.csrfmiddlewaretoken !== 'tok123' || cookies(o).csrftoken !== 'ck1') {
                    return res(403);
                }
                if (form.mail !== user || form.pw !== pw) {
                    return res(200, 'login failed');
                }
                st.logins++;
                const sid = `s${++st.n}`;
                st.sessions.add(sid);
                return res(302, '', { location: '/', 'set-cookie': [`sessionid=${sid}; HttpOnly; Path=/`] });
            }
            if (url.endsWith('/m_heizprogramm/1/')) {
                if (!loggedIn(o)) {
                    return toLogin();
                }
                if (o.headers['X-CSRFToken'] !== 'ck1' || o.headers['X-Requested-With'] !== 'XMLHttpRequest') {
                    return res(403);
                }
                st.posts.push(form);
                st.active = Number(form.activated);
                return res(200, '{}');
            }
            return res(404);
        },
    };
    return st;
}

const CFG = { url: '10.0.0.9', houseID: '1', user: 'me@x.de', password: 'secret' };

describe('webui: parsing', () => {
    it('cookies from set-cookie, login token from the form', () => {
        expect(storeCookies({}, ['csrftoken=a; Path=/', 'sessionid=b; HttpOnly'])).to.deep.equal({
            csrftoken: 'a',
            sessionid: 'b',
        });
        expect(storeCookies({}, undefined)).to.deep.equal({});
        expect(parseLoginToken(`<input type='hidden' name='csrfmiddlewaretoken' value='abc' />`)).to.equal('abc');
        expect(parseLoginToken('<form></form>')).to.equal('');
    });

    it('program names in list order (index = activated), entities decoded, active from the marker', () => {
        expect(parsePrograms(PAGE(1))).to.deep.equal({
            names: ['Standard', 'Normales Programm', 'NoKids & Co'],
            active: 1,
        });
        expect(parsePrograms(PAGE(0)).active).to.equal(0);
        expect(parsePrograms(PAGE(-1)).active).to.equal(-1); // no marker → unknown, not a guess
        expect(parsePrograms('<html>login</html>')).to.deep.equal({ names: [], active: -1 });
    });

    it('two marked entries → unknown', () => {
        const html = PAGE(1).replace('<li class="">', '<li class="ui-radio-on">');
        expect(parsePrograms(html).active).to.equal(-1);
    });

    it('resolve: name (case-insensitive) or plain index from the read list; anything else = -1', () => {
        const names = ['Standard', 'Normales Programm', 'NoKids'];
        expect(resolveProgram('normales programm', names)).to.equal(1);
        expect(resolveProgram('NoKids', names)).to.equal(2);
        expect(resolveProgram(0, names)).to.equal(0);
        expect(resolveProgram('2', names)).to.equal(2);
        expect(resolveProgram(3, names)).to.equal(-1);
        expect(resolveProgram('0x1', names)).to.equal(-1);
        expect(resolveProgram('Urlaub', names)).to.equal(-1);
        expect(resolveProgram(true, names)).to.equal(-1);
        expect(resolveProgram('', names)).to.equal(-1);
        expect(resolveProgram('Standard', [])).to.equal(-1); // nothing read → nothing switched
    });
});

describe('webui: session against a fake web UI', () => {
    it('logs in, reads the programs, switches with CSRF header', async () => {
        const st = fakeServer();
        const ui = new WebUi(st.http, CFG);
        const p = await ui.readPrograms();
        expect(p.names).to.deep.equal(['Standard', 'Normales Programm', 'NoKids & Co']);
        expect(p.active).to.equal(1);
        await ui.activate(2);
        expect(st.posts).to.deep.equal([{ activated: '2' }]);
        expect((await ui.readPrograms()).active).to.equal(2);
        expect(st.logins).to.equal(1);
    });

    it('expired session: one re-login, then it works', async () => {
        const st = fakeServer();
        const ui = new WebUi(st.http, CFG);
        await ui.readPrograms();
        st.sessions.clear(); // server forgot the session
        expect((await ui.readPrograms()).names).to.have.length(3);
        expect(st.logins).to.equal(2);
    });

    it('wrong password: clear error, no switch', async () => {
        const st = fakeServer();
        const ui = new WebUi(st.http, { ...CFG, password: 'wrong' });
        let err = null;
        try {
            await ui.readPrograms();
        } catch (e) {
            err = e;
        }
        expect(err && err.message).to.match(/login failed/);
        expect(err.message).to.not.include('wrong'); // the password is never in a message
        expect(st.posts).to.deep.equal([]);
    });

    it('activate with an expired session fails loudly (no silent success)', async () => {
        const st = fakeServer();
        const ui = new WebUi(st.http, CFG);
        await ui.readPrograms();
        st.sessions.clear();
        let err = null;
        try {
            await ui.activate(0);
        } catch (e) {
            err = e;
        }
        expect(err && err.message).to.match(/failed/);
        expect(st.posts).to.deep.equal([]);
    });
});
