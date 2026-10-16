import test from 'node:test';
import assert from 'node:assert';
import { coordinates, fallback } from '../lib/location.js';

const FALLBACK: [number, number] = [-104.9903, 39.7392];

test('fallback: unset or blank', () => {
    assert.equal(fallback(), null);
    assert.equal(fallback(''), null);
    assert.equal(fallback('  '), null);
});

test('fallback: Latitude,Longitude becomes [lon, lat]', () => {
    assert.deepEqual(fallback('39.7392,-104.9903'), FALLBACK);
    assert.deepEqual(fallback(' 39.7392 , -104.9903 '), FALLBACK);
});

test('fallback: unusable values are ignored', () => {
    assert.equal(fallback('39.7392'), null);
    assert.equal(fallback('a,b'), null);
    assert.equal(fallback('0,0'), null);
    assert.equal(fallback('39.7392,-104.9903,1'), null);
});

test('coordinates: alert position wins', () => {
    assert.deepEqual(coordinates({ lat: '40', lon: '-105', place: '41,-106' }, FALLBACK), {
        coordinates: [-105, 40],
        source: 'alert'
    });
});

test('coordinates: place holds the position of an ungeocoded alert', () => {
    assert.deepEqual(coordinates({ lat: '0', lon: '0', place: '41, -106' }, FALLBACK), {
        coordinates: [-106, 41],
        source: 'place'
    });
});

test('coordinates: fallback for an alert with no position', () => {
    assert.deepEqual(coordinates({ lat: '0', lon: '0', place: 'Station 1' }, FALLBACK), {
        coordinates: FALLBACK,
        source: 'fallback'
    });

    assert.deepEqual(coordinates({ lat: '', lon: '', place: '' }, FALLBACK), {
        coordinates: FALLBACK,
        source: 'fallback'
    });
});

test('coordinates: unlocated without a fallback', () => {
    assert.equal(coordinates({ lat: '0', lon: '0', place: 'Station 1' }, null), null);
    assert.equal(coordinates({ lat: 'abc', lon: '0', place: '' }, null), null);
});
