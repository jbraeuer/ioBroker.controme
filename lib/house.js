'use strict';

/**
 * House-wide functions (whole flat): temperature scenes.
 * Pure helpers, no adapter or network access, so they can be tested on their own (lib/house.test.js).
 *
 * Controme API (support.controme.com/api):
 *   GET  /get/json/v1/<house>/temperaturszenen/          → [{ id, Name, raeume: [{ name, active, temperatur }] }]
 *   POST /set/json/v1/<house>/temperaturszenen/<id>/     body: user, password, [duration], [room_id]
 *        Without room_id the scene applies to every room of the house. Without duration it holds until the next
 *        manual change or the next switch point of the heating program.
 */

/**
 * Object-safe id part for a scene (the numeric Controme id).
 *
 * @param id scene id from the API
 * @returns the id as a string, or '' if it is not a positive integer
 */
function sceneKey(id) {
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? String(n) : '';
}

/**
 * Parses the temperaturszenen answer.
 *
 * @param body parsed JSON from GET temperaturszenen/
 * @returns scenes with a valid id, in API order
 */
function parseScenes(body) {
    if (!Array.isArray(body)) {
        return [];
    }
    const out = [];
    for (const s of body) {
        if (!s || typeof s !== 'object' || !sceneKey(s.id)) {
            continue;
        }
        const rooms = Array.isArray(s.raeume) ? s.raeume.filter(r => r && typeof r === 'object') : [];
        const activeRooms = rooms.filter(r => r.active === true).length;
        out.push({
            id: Number(s.id),
            name: typeof s.Name === 'string' ? s.Name.trim() : typeof s.name === 'string' ? s.name.trim() : '',
            active: activeRooms > 0,
            rooms: rooms.length,
            activeRooms,
        });
    }
    return out;
}

/**
 * The scene that is active for the house: the one with the most active rooms (ties: the first in API order).
 *
 * @param scenes result of parseScenes
 * @returns scene id, or 0 if no scene is active
 */
function activeSceneId(scenes) {
    let best = null;
    for (const s of scenes) {
        if (s.activeRooms > 0 && (!best || s.activeRooms > best.activeRooms)) {
            best = s;
        }
    }
    return best ? best.id : 0;
}

/**
 * Resolves a value written to house.setScene to a scene id: a number (id) or a string (id or scene name,
 * case-insensitive, a trailing "*" of the default scene ignored).
 *
 * @param value value written by the user
 * @param scenes known scenes
 * @returns scene id, or 0 if the value matches no scene
 */
function resolveScene(value, scenes) {
    if (typeof value !== 'number' && typeof value !== 'string') {
        return 0; // also true/false: Number(true) would be scene 1
    }
    if (value === '') {
        return 0;
    }
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) {
        return scenes.some(s => s.id === n) ? n : 0;
    }
    if (typeof value !== 'string') {
        return 0;
    }
    const norm = t => t.trim().replace(/\*$/, '').trim().toLowerCase();
    const hit = scenes.find(s => norm(s.name) === norm(value));
    return hit ? hit.id : 0;
}

/**
 * Optional duration for the scene POST.
 *
 * @param minutes value of house.sceneDuration (0 / empty = until the next switch point)
 * @returns minutes as a string for the form, or null to omit the parameter
 */
function sceneDuration(minutes) {
    const n = Number(minutes);
    return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null;
}

module.exports = { sceneKey, parseScenes, activeSceneId, resolveScene, sceneDuration };
