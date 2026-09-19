import moment from 'moment-timezone';
import type { DetailParser, NarrativeEntry, ParsedDetails } from './types.js';

const SIGNATURE = /^\s*\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+\S+ - /;
const DETAILS = /^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*?)(?:\s*TIME:\s*(.+?))?\s*$/s;
const NOTE_BOUNDARY = /\s+(?=\d{1,2}:\d{2}:\d{2}\s+\S+ - )/;
const NOTE = /^(\d{1,2}:\d{2}:\d{2})\s+(\S+) - (.*)$/s;

/**
 * The date is given once and followed by `HH:mm:ss user - text` notes
 *
 * 9/18/2026    13:21:10   jdoe - CO ALARM GOING OFF      13:21:23   jdoe - NOT FEELING SICK
 * TIME: 9/18/2026 13:20:56
 */
const parser: DetailParser = {
    name: 'dated-dash',

    test(details: string): boolean {
        return SIGNATURE.test(details);
    },

    parse(details: string, zone: string): ParsedDetails {
        const match = DETAILS.exec(details);
        if (!match) return { entries: [{ text: details.trim() }], fields: {} };

        const [, date, body, time] = match;

        const day = moment.tz(date, 'M/D/YYYY', zone);
        let previous: moment.Moment | undefined;

        const entries: NarrativeEntry[] = body.split(NOTE_BOUNDARY).map((raw) => {
            const note = NOTE.exec(raw.trim());
            if (!note) return { text: raw.trim() };

            const stamp = moment.tz(`${day.format('YYYY-MM-DD')} ${note[1].padStart(8, '0')}`, 'YYYY-MM-DD HH:mm:ss', true, zone);
            if (!stamp.isValid()) return { text: raw.trim() };

            // The date is only given once - a note earlier in the day than the one before it was written after midnight
            if (previous && stamp.isBefore(previous)) {
                day.add(1, 'day');
                stamp.add(1, 'day');
            }

            previous = stamp;

            return { time: stamp.toISOString(), author: note[2], text: note[3].trim() };
        });

        return {
            entries,
            fields: time ? { Time: time } : {}
        };
    }
};

export default parser;
