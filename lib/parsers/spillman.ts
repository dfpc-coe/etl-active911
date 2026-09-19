import moment from 'moment-timezone';
import type { DetailParser, NarrativeEntry, ParsedDetails } from './types.js';

// Active911 isn't consistent about the whitespace it writes - a non-breaking space must not defeat detection
const GAP = '[^\\S\\r\\n]+';
const STAMP_SOURCE = ['\\d{2}', '\\d{2}', '\\d{2}', '\\d{2}', '\\d{2}', '\\d{4}'].join(GAP) + `(?:${GAP})?:`;
const STAMP_GROUPS = ['(\\d{2})', '(\\d{2})', '(\\d{2})', '(\\d{2})', '(\\d{2})', '(\\d{4})'].join(GAP) + `(?:${GAP})?:`;

const SIGNATURE = new RegExp(`^\\s*${STAMP_SOURCE}`);
const TRAILER = 'Dispatch:';
const STAMP = new RegExp(STAMP_SOURCE);
const NOTE_BOUNDARY = new RegExp(`\\s+(?=${STAMP_SOURCE})`);
const NOTE = new RegExp(`^${STAMP_GROUPS}\\s*(.*)$`, 's');

/**
 * Split the closing `Dispatch: ...|` from the notes
 *
 * Active911 writes a `-` as `: ` so `Dispatch:` also turns up inside of notes. Only the last one can be
 * the trailer, and only when no note follows it and it is closed by a `|` or on a line of its own -
 * details that were truncated before the trailer would otherwise lose the end of their last note to it
 */
function trailer(details: string): { body: string; dispatch?: string } {
    const at = details.lastIndexOf(TRAILER);
    if (at === -1) return { body: details };

    const tail = details.slice(at + TRAILER.length).trim();
    const closed = tail.endsWith('|') || /\n[ \t]*$/.test(details.slice(0, at));

    if (STAMP.test(tail) || !closed) return { body: details };

    return { body: details.slice(0, at), dispatch: tail.replace(/\|$/, '').trim() };
}

/**
 * Spillman (Motorola Flex) - each note is prefixed with `HH mm ss MM DD YYYY :`
 *
 * 15 54 54 09 18 2026 :  Jane Doe is at the rec center 15 55 57 09 18 2026 :  Jane Doe Chief Complaint ...
 * Dispatch: New Call from Spillman at Dispatch|
 *
 * The name of the call taker leads the text of each note but isn't delimited from it so it is left in place
 */
const parser: DetailParser = {
    name: 'spillman',

    test(details: string): boolean {
        return SIGNATURE.test(details);
    },

    parse(details: string, zone: string): ParsedDetails {
        const { body, dispatch } = trailer(details);

        const entries: NarrativeEntry[] = body.trim().split(NOTE_BOUNDARY).map((raw) => {
            const note = NOTE.exec(raw.trim());
            if (!note) return { text: raw.trim() };

            const [, hour, minute, second, month, date, year, text] = note;
            const stamp = moment.tz(`${year}-${month}-${date} ${hour}:${minute}:${second}`, 'YYYY-MM-DD HH:mm:ss', true, zone);
            if (!stamp.isValid()) return { text: raw.trim() };

            return { time: stamp.toISOString(), text: text.trim() };
        });

        return {
            entries,
            fields: dispatch ? { Dispatch: dispatch } : {}
        };
    }
};

export default parser;
