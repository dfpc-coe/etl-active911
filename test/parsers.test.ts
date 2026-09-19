import test from 'node:test';
import assert from 'node:assert';
import { PARSER_NAMES, parseNarrative, renderRemarks } from '../lib/parsers/index.js';

const ZONE = 'America/Denver';

const DATED_DASH = '9/18/2026    13:21:10   jdoe - CO ALARM GOING OFF      13:21:23   jdoe - NOT FEELING SICK      13:21:41   jdoe - RP WILL WAIT OUTSIDE\nTIME: 9/18/2026 13:20:56';

// Truncated mid-note by Active911
const SPILLMAN = '15 54 54 09 18 2026 :  Jane Doe is at the rec center in a white jeep, throwing up blood 15 55 57 09 18 2026 :  Jane Doe Chief Complaint Non: traumatic (medical) bleeding 1st Party Alone :  42: year: old, Female, Conscious, Breathing. 15 56 45 09 18 2026 :  Jane Doe Dispatch Code 21D05 (Abnormal breathing) Suffix M (MEDICAL) Un\nDispatch: New Call from Spillman at Dispatch|';

test('Parser Names', () => {
    assert.deepEqual(PARSER_NAMES, ['auto', 'raw', 'spillman', 'dated-dash']);
});

test('dated-dash: auto detected', () => {
    assert.deepEqual(parseNarrative(DATED_DASH, ZONE), {
        parser: 'dated-dash',
        entries: [
            { time: '2026-09-18T19:21:10.000Z', author: 'jdoe', text: 'CO ALARM GOING OFF' },
            { time: '2026-09-18T19:21:23.000Z', author: 'jdoe', text: 'NOT FEELING SICK' },
            { time: '2026-09-18T19:21:41.000Z', author: 'jdoe', text: 'RP WILL WAIT OUTSIDE' }
        ],
        fields: { Time: '9/18/2026 13:20:56' }
    });
});

test('dated-dash: notes roll over midnight', () => {
    const narrative = parseNarrative('9/18/2026    23:59:50   jdoe - FIRST      00:00:10   jdoe - SECOND      00:05:00   jdoe - THIRD', ZONE);

    assert.deepEqual(narrative.entries.map((e) => e.time), [
        '2026-09-19T05:59:50.000Z',
        '2026-09-19T06:00:10.000Z',
        '2026-09-19T06:05:00.000Z'
    ]);

    assert.match(renderRemarks({}, narrative, ZONE), /\| 09\/18 23:59:50 \| jdoe \| FIRST \|\n\| 09\/19 00:00:10 \| jdoe \| SECOND \|/);
});

test('dated-dash: hours without a leading zero', () => {
    const narrative = parseNarrative('9/18/2026    9:05:00   jdoe - FIRST', ZONE);

    assert.deepEqual(narrative.entries, [{ time: '2026-09-18T15:05:00.000Z', author: 'jdoe', text: 'FIRST' }]);
});

test('dated-dash: a dash inside of a note does not split it', () => {
    const narrative = parseNarrative('9/18/2026    13:21:10   jdoe - PT IS 42 - FEMALE      13:21:23   jdoe - ENRT', ZONE);

    assert.deepEqual(narrative.entries.map((e) => e.text), ['PT IS 42 - FEMALE', 'ENRT']);
});

test('spillman: auto detected', () => {
    assert.deepEqual(parseNarrative(SPILLMAN, ZONE), {
        parser: 'spillman',
        entries: [
            { time: '2026-09-18T21:54:54.000Z', text: 'Jane Doe is at the rec center in a white jeep, throwing up blood' },
            { time: '2026-09-18T21:55:57.000Z', text: 'Jane Doe Chief Complaint Non: traumatic (medical) bleeding 1st Party Alone :  42: year: old, Female, Conscious, Breathing.' },
            { time: '2026-09-18T21:56:45.000Z', text: 'Jane Doe Dispatch Code 21D05 (Abnormal breathing) Suffix M (MEDICAL) Un' }
        ],
        fields: { Dispatch: 'New Call from Spillman at Dispatch' }
    });
});

test('spillman: notes are split with or without line breaks between them', () => {
    const notes = ['15 54 54 09 18 2026 :  Jane Doe first', '15 55 57 09 18 2026 :  Jane Doe second', 'Dispatch: New Call from Spillman at Dispatch|'];

    for (const separator of ['\n', '\r\n', ' ', '  ']) {
        const narrative = parseNarrative(notes.join(separator), ZONE);

        assert.deepEqual(narrative.entries.map((e) => e.text), ['Jane Doe first', 'Jane Doe second']);
        assert.deepEqual(narrative.fields, { Dispatch: 'New Call from Spillman at Dispatch' });
    }
});

test('spillman: Dispatch: inside of a note is not the trailer', () => {
    const narrative = parseNarrative('15 54 54 09 18 2026 :  Jane Doe Dispatch: advised to stage 15 55 57 09 18 2026 :  Jane Doe second Dispatch: New Call from Spillman at Dispatch|', ZONE);

    assert.deepEqual(narrative.entries.map((e) => e.text), ['Jane Doe Dispatch: advised to stage', 'Jane Doe second']);
    assert.deepEqual(narrative.fields, { Dispatch: 'New Call from Spillman at Dispatch' });
});

test('spillman: Dispatch: inside of a note when the trailer was truncated away', () => {
    for (const details of [
        '15 54 54 09 18 2026 :  Jane Doe Dispatch: advised to stage 15 55 57 09 18 2026 :  Jane Doe second no',
        '15 54 54 09 18 2026 :  Jane Doe Dispatch: advised to sta'
    ]) {
        const narrative = parseNarrative(details, ZONE);

        assert.equal(narrative.entries[0].text.startsWith('Jane Doe Dispatch: advised to sta'), true);
        assert.deepEqual(narrative.fields, {});
    }
});

test('spillman: two notes truncated inside of the last with the trailer on its own line', () => {
    assert.deepEqual(parseNarrative('07 23 46 09 19 2026 :  Jane Doe medical alarm 07 25 17 09 19 2026 :  Jane Doe (ProQA Medical) Chief Complaint Falls Age unknown, Female, Conscious, Breathing. Caller Statement medical alarm wife fell is bleedi\nDispatch: New Call from Spillman at Dispatch|', ZONE), {
        parser: 'spillman',
        entries: [
            { time: '2026-09-19T13:23:46.000Z', text: 'Jane Doe medical alarm' },
            { time: '2026-09-19T13:25:17.000Z', text: 'Jane Doe (ProQA Medical) Chief Complaint Falls Age unknown, Female, Conscious, Breathing. Caller Statement medical alarm wife fell is bleedi' }
        ],
        fields: { Dispatch: 'New Call from Spillman at Dispatch' }
    });
});

test('spillman: whitespace other than a single space inside of a timestamp', () => {
    for (const gap of ['\u00a0', '  ', '\t', '\u2009']) {
        const stamp = (time: string): string => time.replaceAll(' ', gap);
        const narrative = parseNarrative(`\ufeff${stamp('15 54 54 09 18 2026 :')}${gap}${gap}Jane Doe first ${stamp('15 55 57 09 18 2026 :')}${gap}Jane Doe second\r\nDispatch: New Call from Spillman at Dispatch|`, ZONE);

        assert.equal(narrative.parser, 'spillman');
        assert.deepEqual(narrative.entries, [
            { time: '2026-09-18T21:54:54.000Z', text: 'Jane Doe first' },
            { time: '2026-09-18T21:55:57.000Z', text: 'Jane Doe second' }
        ]);
    }
});

test('spillman: a timestamp without a space before the colon', () => {
    const narrative = parseNarrative('15 54 54 09 18 2026: Jane Doe first 15 55 57 09 18 2026: Jane Doe second', ZONE);

    assert.deepEqual(narrative.entries.map((e) => e.text), ['Jane Doe first', 'Jane Doe second']);
});

test('spillman: truncated inside of a timestamp', () => {
    const narrative = parseNarrative('15 54 54 09 18 2026 :  Jane Doe first note 15 55 57 09', ZONE);

    assert.equal(narrative.parser, 'spillman');
    assert.deepEqual(narrative.entries, [
        { time: '2026-09-18T21:54:54.000Z', text: 'Jane Doe first note 15 55 57 09' }
    ]);
});

test('spillman: an impossible timestamp is kept as text', () => {
    const narrative = parseNarrative('15 54 54 09 18 2026 :  first 99 99 99 99 99 2026 :  second', ZONE);

    assert.deepEqual(narrative.entries, [
        { time: '2026-09-18T21:54:54.000Z', text: 'first' },
        { text: '99 99 99 99 99 2026 :  second' }
    ]);
});

test('raw: unknown formats are left as is', () => {
    assert.deepEqual(parseNarrative('  STRUCTURE FIRE\nSMOKE SHOWING  ', ZONE), {
        parser: 'raw',
        entries: [{ text: 'STRUCTURE FIRE\nSMOKE SHOWING' }],
        fields: {}
    });

    assert.deepEqual(parseNarrative('', ZONE), { parser: 'raw', entries: [], fields: {} });
});

test('raw: explicit parser', () => {
    assert.equal(parseNarrative(DATED_DASH, ZONE, 'raw').parser, 'raw');
});

test('raw: explicit parser that does not match the details', () => {
    assert.equal(parseNarrative(DATED_DASH, ZONE, 'spillman').parser, 'raw');
    assert.equal(parseNarrative(DATED_DASH, ZONE, 'unknown-parser').parser, 'raw');
});

test('renderRemarks: notes table with authors', () => {
    const remarks = renderRemarks({ Groups: 'EN31', Author: '' }, parseNarrative(DATED_DASH, ZONE), ZONE);

    assert.equal(remarks, [
        '**Groups:** EN31',
        '',
        '| Time | Author | Note |',
        '| --- | --- | --- |',
        '| 13:21:10 | jdoe | CO ALARM GOING OFF |',
        '| 13:21:23 | jdoe | NOT FEELING SICK |',
        '| 13:21:41 | jdoe | RP WILL WAIT OUTSIDE |',
        '',
        '**Time:** 9/18/2026 13:20:56'
    ].join('\n'));
});

test('renderRemarks: notes table without authors', () => {
    const remarks = renderRemarks({ Groups: 'MFPD2', Author: 'CAD' }, parseNarrative(SPILLMAN, ZONE), ZONE);

    assert.equal(remarks, [
        '**Groups:** MFPD2',
        '**Author:** CAD',
        '',
        '| Time | Note |',
        '| --- | --- |',
        '| 15:54:54 | Jane Doe is at the rec center in a white jeep, throwing up blood |',
        '| 15:55:57 | Jane Doe Chief Complaint Non: traumatic (medical) bleeding 1st Party Alone :  42: year: old, Female, Conscious, Breathing. |',
        '| 15:56:45 | Jane Doe Dispatch Code 21D05 (Abnormal breathing) Suffix M (MEDICAL) Un |',
        '',
        '**Dispatch:** New Call from Spillman at Dispatch'
    ].join('\n'));
});

test('renderRemarks: table cells are escaped', () => {
    const remarks = renderRemarks({}, {
        parser: 'dated-dash',
        entries: [{ author: 'jdoe', text: 'GATE CODE 12|34\nSECOND LINE' }],
        fields: {}
    }, ZONE);

    assert.equal(remarks.split('\n').pop(), '|  | jdoe | GATE CODE 12\\|34 SECOND LINE |');
});

test('renderRemarks: raw details are not put in a table', () => {
    const remarks = renderRemarks({ Groups: 'EN31' }, parseNarrative('STRUCTURE FIRE', ZONE), ZONE);

    assert.equal(remarks, '**Groups:** EN31\n\nSTRUCTURE FIRE');
});
