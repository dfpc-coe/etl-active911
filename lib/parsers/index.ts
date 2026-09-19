import moment from 'moment-timezone';
import type { DetailParser, NarrativeEntry, ParsedDetails } from './types.js';
import datedDash from './dated-dash.js';
import spillman from './spillman.js';

export type { DetailParser, NarrativeEntry, ParsedDetails };

/** In the order that `auto` detection tests them */
export const PARSERS: DetailParser[] = [
    spillman,
    datedDash
];

/** Values of the per-agency `Parser` environment option */
export const PARSER_NAMES = ['auto', 'raw', ...PARSERS.map((p) => p.name)];

export interface Narrative extends ParsedDetails {
    /** Parser that produced the narrative - `raw` when the details were left as is */
    parser: string;
}

function raw(details: string): Narrative {
    const text = details.trim();
    return { parser: 'raw', entries: text ? [{ text }] : [], fields: {} };
}

/**
 * Parse the free text details of an alert into individual CAD notes
 *
 * An alert must always make it to the map so this never throws - details that
 * a parser doesn't recognise or fails on are returned as a single `raw` note
 *
 * @param details   Raw Active911 details
 * @param zone      IANA Zone that CAD timestamps are local to
 * @param name      Parser name, `raw` to disable parsing or `auto` to detect the format
 */
export function parseNarrative(details: string, zone: string, name = 'auto'): Narrative {
    if (name === 'raw') return raw(details);

    const parser = name === 'auto'
        ? PARSERS.find((p) => p.test(details))
        : PARSERS.find((p) => p.name === name && p.test(details));

    if (!parser) return raw(details);

    try {
        const parsed = parser.parse(details, zone);
        if (!parsed.entries.length) return raw(details);

        return { parser: parser.name, ...parsed };
    } catch (err) {
        console.error(`not ok - ${parser.name} parser failed: ${err instanceof Error ? err.message : String(err)}`);
        return raw(details);
    }
}

function cell(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
}

function notesTable(entries: NarrativeEntry[], zone: string): string {
    const authored = entries.some((e) => e.author);

    const days = new Set(entries
        .filter((e) => e.time)
        .map((e) => moment.tz(e.time, zone).format('YYYY-MM-DD')));

    const format = days.size > 1 ? 'MM/DD HH:mm:ss' : 'HH:mm:ss';

    const rows = entries.map((e) => {
        const cells = [e.time ? moment.tz(e.time, zone).format(format) : ''];
        if (authored) cells.push(cell(e.author || ''));
        cells.push(cell(e.text));
        return `| ${cells.join(' | ')} |`;
    });

    return [
        authored ? '| Time | Author | Note |' : '| Time | Note |',
        authored ? '| --- | --- | --- |' : '| --- | --- |',
        ...rows
    ].join('\n');
}

/**
 * Markdown remarks for an alert - CAD notes are rendered as a table
 *
 * @param header    Labelled values shown above the notes - empty values are dropped
 */
export function renderRemarks(
    header: Record<string, string>,
    narrative: Narrative,
    zone: string
): string {
    const labelled = (fields: Record<string, string>): string => {
        return Object.entries(fields)
            .filter(([, value]) => value && value.trim())
            .map(([label, value]) => `**${label}:** ${value.trim()}`)
            .join('\n');
    };

    const notes = narrative.parser === 'raw'
        ? narrative.entries.map((e) => e.text).join('\n')
        : notesTable(narrative.entries, zone);

    return [
        labelled(header),
        notes,
        labelled(narrative.fields)
    ].filter((section) => section.length).join('\n\n');
}
