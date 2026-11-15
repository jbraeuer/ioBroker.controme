'use strict';
/* global describe, it */

const { expect } = require('chai');
const { sceneKey, parseScenes, activeSceneId, resolveScene, sceneDuration, sceneRequest } = require('./house');

// shape of a real answer of GET temperaturszenen/ (names from a real server, room list shortened)
const BODY = [
    {
        id: 1,
        Name: 'Standard*',
        raeume: [
            { active: false, temperatur: '18', name: 'EG / Living' },
            { active: false, temperatur: 18.0, name: 'EG / Parents' },
        ],
    },
    { id: 4, Name: 'Nachts', raeume: [{ active: false, temperatur: '18', name: 'EG / Living' }] },
    {
        id: 7,
        Name: 'Tags',
        raeume: [
            { active: true, temperatur: '21', name: 'EG / Living' },
            { active: true, temperatur: 18.0, name: 'EG / Parents' },
        ],
    },
    { id: 9, Name: 'TagsDINK', raeume: [{ active: false, temperatur: '21', name: 'EG / Living' }] },
];

describe('house: scenes', () => {
    it('parses id, name, active and room counts', () => {
        const s = parseScenes(BODY);
        expect(s.map(x => x.id)).to.deep.equal([1, 4, 7, 9]);
        expect(s[0]).to.deep.equal({ id: 1, name: 'Standard*', active: false, rooms: 2, activeRooms: 0 });
        expect(s[2]).to.include({ name: 'Tags', active: true, activeRooms: 2 });
    });

    it('ignores garbage: no array, entries without a valid id, rooms that are not objects', () => {
        expect(parseScenes({})).to.deep.equal([]);
        expect(parseScenes(null)).to.deep.equal([]);
        const s = parseScenes([
            { Name: 'x' },
            { id: 'abc' },
            { id: -1 },
            { id: 3, Name: ' Ferien ', raeume: [null, 5, { active: true }] },
        ]);
        expect(s).to.deep.equal([{ id: 3, name: 'Ferien', active: true, rooms: 1, activeRooms: 1 }]);
    });

    it('active scene = most active rooms; none active = 0', () => {
        expect(activeSceneId(parseScenes(BODY))).to.equal(7);
        expect(activeSceneId(parseScenes([BODY[0], BODY[1]]))).to.equal(0);
        const split = parseScenes([
            { id: 2, Name: 'a', raeume: [{ active: true }] },
            { id: 5, Name: 'b', raeume: [{ active: true }, { active: true }] },
        ]);
        expect(activeSceneId(split)).to.equal(5);
    });

    it('resolves a written value: id, id as string, name (case, trailing * ignored); unknown = 0', () => {
        const s = parseScenes(BODY);
        expect(resolveScene(7, s)).to.equal(7);
        expect(resolveScene('4', s)).to.equal(4);
        expect(resolveScene('standard', s)).to.equal(1);
        expect(resolveScene('Standard*', s)).to.equal(1);
        expect(resolveScene(' tagsdink ', s)).to.equal(9);
        expect(resolveScene(99, s)).to.equal(0);
        expect(resolveScene('Urlaub', s)).to.equal(0);
        expect(resolveScene('', s)).to.equal(0);
        expect(resolveScene(null, s)).to.equal(0);
        expect(resolveScene(true, s)).to.equal(0);
        expect(resolveScene('0x7', s)).to.equal(0);
        expect(resolveScene('7e0', s)).to.equal(0);
        expect(resolveScene(' 7 ', s)).to.equal(7);
    });

    it('duration: positive minutes as a string, else omitted', () => {
        expect(sceneDuration(120)).to.equal('120');
        expect(sceneDuration('90.4')).to.equal('90');
        expect(sceneDuration(0)).to.equal(null);
        expect(sceneDuration(0.4)).to.equal(null);
        expect(sceneDuration(-5)).to.equal(null);
        expect(sceneDuration(undefined)).to.equal(null);
        expect(sceneDuration('x')).to.equal(null);
    });

    it('sceneKey: only positive integers', () => {
        expect(sceneKey(7)).to.equal('7');
        expect(sceneKey('7')).to.equal('7');
        expect(sceneKey(0)).to.equal('');
        expect(sceneKey('a.b')).to.equal('');
    });

    it('request: whole flat (no room_id), duration only when set', () => {
        const cfg = { url: '10.0.0.9', houseID: '1', user: 'u', password: 'p' };
        const a = sceneRequest(cfg, 7, null);
        expect(a.url).to.equal('http://10.0.0.9/set/json/v1/1/temperaturszenen/7/');
        expect(a.fields).to.deep.equal([
            ['user', 'u'],
            ['password', 'p'],
        ]);
        const b = sceneRequest(cfg, 4, '120');
        expect(b.fields.map(f => f[0])).to.deep.equal(['user', 'password', 'duration']);
        expect(b.fields.some(f => f[0] === 'room_id')).to.equal(false);
    });
});
