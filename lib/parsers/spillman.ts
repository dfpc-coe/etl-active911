import moment from 'moment-timezone';
import type { DetailParser, NarrativeEntry, ParsedDetails } from './types.js';

const SIGNATURE = /^\s*\d{2} \d{2} \d{2} \d{2} \d{2} \d{4} :/;
const DETAILS = /^(.*?)(?:\s*Dispatch:\s*(.*?)\|?)?\s*$/s;
const NOTE_BOUNDARY = /\s+(?=\d{2} \d{2} \d{2} \d{2} \d{2} \d{4} :)/;
const NOTE = /^(\d{2}) (\d{2}) (\d{2}) (\d{2}) (\d{2}) (\d{4}) :\s*(.*)$/s;

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
        const match = DETAILS.exec(details);
        if (!match) return { entries: [{ text: details.trim() }], fields: {} };

        const [, body, dispatch] = match;

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
            fields: dispatch ? { Dispatch: dispatch.trim() } : {}
        };
    }
};

export default parser;
