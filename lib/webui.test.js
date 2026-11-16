'use strict';
/* global describe, it */

const { expect } = require('chai');
const { storeCookies, parseLoginToken, parsePrograms, programListOk, resolveProgram, WebUi } = require('./webui');

// real structure (live 2026-11-15) with made-up ids: heizpid differs from the position, so a test proves which is posted
const HP = [3, 5, 8];
const PAGE =
    active => `<ul><li class="heizprogramm-li"><span class="flip-switch"><input type="checkbox" data-role="flipswitch" checked data-hausid="1" name="heizprogramm-on-off"></span><span class="heizprogramm-text"><p>Heizprogramm</p></span></li></ul>
<div class="ui-grid-a select-heizprogramm"><fieldset data-role="controlgroup">
  <div class="leftDiv"><input type="radio" name="radio" value="" id="radio3" data-hausid="1" data-heizpid="3" class=""${active === 0 ? ' checked' : ''}><label for="radio3">Heizprogramm: Standard</label></div>
  <div class="leftDiv"><input type="radio" name="radio" value="" id="radio5" data-hausid="1" data-heizpid="5" class=""${active === 1 ? ' checked' : ''}><label for="radio5">Heizprogramm: Normales Programm</label></div>
  <div class="leftDiv"><input type="radio" name="radio" value="" id="radio8" data-hausid="1" data-heizpid="8" class=""${active === 2 ? ' checked' : ''}><label for="radio8">Heizprogramm: Urlaub &amp; Co</label></div>
</fieldset></div>`;

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
                st.active = HP.indexOf(Number(form.activated));
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
            names: ['Standard', 'Normales Programm', 'Urlaub & Co'],
            ids: ['3', '5', '8'],
            active: 1,
        });
        expect(parsePrograms(PAGE(0)).active).to.equal(0);
        expect(parsePrograms(PAGE(-1)).active).to.equal(-1); // no marker → unknown, not a guess
        expect(parsePrograms('<html>login</html>')).to.deep.equal({ names: [], ids: [], active: -1 });
    });

    it('two checked radios → unknown; the checked on/off flip switch is not a program', () => {
        expect(
            parsePrograms(PAGE(1).replace('data-heizpid="3" class=""', 'data-heizpid="3" class="" checked')).active,
        ).to.equal(-1);
        expect(parsePrograms(PAGE(-1)).names).to.have.length(3);
    });

    it('resolve: name (case-insensitive) or plain index from the read list; anything else = -1', () => {
        const names = ['Standard', 'Normales Programm', 'Ferien'];
        expect(resolveProgram('normales programm', names)).to.equal(1);
        expect(resolveProgram('Ferien', names)).to.equal(2);
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
        expect(p.names).to.deep.equal(['Standard', 'Normales Programm', 'Urlaub & Co']);
        expect(p.active).to.equal(1);
        await ui.activate(p.ids[2]);
        expect(st.posts).to.deep.equal([{ activated: '8' }]); // the program's heizpid, not its position
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
            await ui.activate('3');
        } catch (e) {
            err = e;
        }
        expect(err && err.message).to.match(/failed/);
        expect(st.posts).to.deep.equal([]);
    });
});

describe('webui: review fixes', () => {
    it('a blank program name keeps indices aligned, and the list is then not switchable', () => {
        const r = (id, n) => `<input type="radio" name="radio" data-heizpid="${id}"><label>Heizprogramm: ${n}</label>`;
        const html = r(0, 'A') + r(1, '&nbsp;') + r(2, 'B');
        const p = parsePrograms(html);
        expect(p.names).to.deep.equal(['A', '', 'B']);
        expect(programListOk(p.names)).to.equal(false);
        expect(resolveProgram('B', p.names)).to.equal(-1);
    });

    it('duplicate names (case-insensitive) or an empty list: never switch', () => {
        expect(resolveProgram('Normal', ['Normal', 'normal'])).to.equal(-1);
        expect(programListOk([])).to.equal(false);
        expect(programListOk(['Standard', 'Urlaub'])).to.equal(true);
    });

    it('ids: missing or duplicate data-heizpid → list not switchable; activate refuses a non-numeric id', async () => {
        expect(programListOk(['A', 'B'], ['1', '2'])).to.equal(true);
        expect(programListOk(['A', 'B'], ['1', ''])).to.equal(false);
        expect(programListOk(['A', 'B'], ['1', '1'])).to.equal(false);
        let err = null;
        try {
            await new WebUi(fakeServer().http, CFG).activate('');
        } catch (e) {
            err = e;
        }
        expect(err && err.message).to.match(/no valid program id/);
    });

    it('a login or error page answered with 200 is an error, not an empty program list', async () => {
        const http = {
            get: async url =>
                url.endsWith('/accounts/m_login/')
                    ? {
                          status: 200,
                          data: "<input type='hidden' name='csrfmiddlewaretoken' value='t' />",
                          headers: { 'set-cookie': ['csrftoken=c'] },
                      }
                    : { status: 200, data: '<html>Wartung</html>', headers: {} },
            post: async () => ({ status: 302, data: '', headers: { location: '/', 'set-cookie': ['sessionid=s1'] } }),
        };
        let err = null;
        try {
            await new WebUi(http, CFG).readPrograms();
        } catch (e) {
            err = e;
        }
        expect(err && err.message).to.match(/no programs/);
    });

    it('run() serializes: a poll queued during a switch sees the switched state, the switch keeps its session', async () => {
        const st = fakeServer();
        const ui = new WebUi(st.http, CFG);
        const order = [];
        const write = ui.run(async () => {
            const p = await ui.readPrograms();
            order.push('write-read');
            await ui.activate(p.ids[p.names.indexOf('Urlaub & Co')]);
            order.push('write-activate');
        });
        const poll = ui.run(async () => {
            const p = await ui.readPrograms();
            order.push(`poll-${p.active}`);
        });
        await Promise.all([write, poll]);
        expect(order).to.deep.equal(['write-read', 'write-activate', 'poll-2']);
        expect(st.posts).to.deep.equal([{ activated: '8' }]);
    });

    it('run() keeps going after a failed operation', async () => {
        const ui = new WebUi(fakeServer().http, CFG);
        const bad = ui.run(async () => {
            throw new Error('x');
        });
        await bad.catch(() => {});
        expect((await ui.run(() => ui.readPrograms())).names).to.have.length(3);
    });
});
