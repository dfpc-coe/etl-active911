import moment from 'moment-timezone';

export const TIMEZONE_MAPPINGS: Record<string, string> = {
    'EDT': 'America/New_York',
    'EST': 'America/New_York',
    'CDT': 'America/Chicago',
    'CST': 'America/Chicago',
    'MDT': 'America/Denver',
    'MST': 'America/Denver',
    'PDT': 'America/Los_Angeles',
    'PST': 'America/Los_Angeles',
    'AKDT': 'America/Anchorage',
    'AKST': 'America/Anchorage',
    'HDT': 'Pacific/Honolulu',
    'HST': 'Pacific/Honolulu',
    'ADT': 'America/Halifax',
    'AST': 'America/Halifax',
    'NDT': 'America/St_Johns',
    'NST': 'America/St_Johns',
    'UTC': 'UTC',
    'GMT': 'Etc/GMT'
};

/** IANA zone of an Active911 timestamp ie: `12/08/2025 18:27:47 MST` - UTC if it isn't a known abbreviation */
export function parseZone(timeStr: string): string {
    const parts = timeStr.trim().split(' ');
    return TIMEZONE_MAPPINGS[parts[parts.length - 1]] || 'UTC';
}

export function parseTime(timeStr: string): string {
    const parts = timeStr.trim().split(' ');
    const tzAbbr = parts[parts.length - 1];

    if (TIMEZONE_MAPPINGS[tzAbbr]) {
        const datePart = parts.slice(0, -1).join(' ');
        return moment.tz(datePart, 'MM/DD/YYYY HH:mm:ss', TIMEZONE_MAPPINGS[tzAbbr]).toISOString();
    }

    return moment.tz(timeStr, 'MM/DD/YYYY HH:mm:ss z', 'UTC').toISOString();
}
