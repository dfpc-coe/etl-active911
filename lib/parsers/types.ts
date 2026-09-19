export interface NarrativeEntry {
    /** ISO Timestamp of the note */
    time?: string;
    /** CAD user that wrote the note, when the format delimits it */
    author?: string;
    text: string;
}

export interface ParsedDetails {
    entries: NarrativeEntry[];
    /** Labelled values that accompany the notes ie: `TIME: ...` or `Dispatch: ...` */
    fields: Record<string, string>;
}

/**
 * Parser for the free text `details` of a single CAD format
 *
 * Named for the CAD format and not the agency - many agencies share a CAD vendor
 */
export interface DetailParser {
    name: string;

    /** Cheap signature check used by `auto` detection */
    test(details: string): boolean;

    /**
     * Details can be truncated by Active911 mid-note so a parser should degrade
     * a note it can't match to `{ text }` instead of throwing
     *
     * @param details   Raw Active911 details
     * @param zone      IANA Zone that CAD timestamps are local to
     */
    parse(details: string, zone: string): ParsedDetails;
}
