export type Placement = {
    coordinates: [number, number];
    /** Where the position came from - alerts without one are placed at the configured fallback */
    source: 'alert' | 'place' | 'fallback';
};

function toCoordinate(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num === 0) return null;
    return num;
}

/**
 * Parse the FallbackCoordinates input - Latitude,Longitude - returning null
 * when unset or unusable so unlocated alerts are skipped
 */
export function fallback(value?: string): [number, number] | null {
    if (!value || !value.trim()) return null;

    const [lat, lon, ...rest] = value.split(',').map((part) => toCoordinate(part.trim()));

    if (rest.length || lat === null || lat === undefined || lon === null || lon === undefined) {
        console.error(`not ok - invalid FallbackCoordinates: ${value}`);
        return null;
    }

    return [lon, lat];
}

/**
 * Position of an alert as [lon, lat] - Active911 reports 0,0 for an alert it
 * could not geocode, which sometimes carries coordinates in its place field
 */
export function coordinates(
    alert: { lat: string; lon: string; place: string },
    fallbackCoordinates: [number, number] | null
): Placement | null {
    const lon = toCoordinate(alert.lon);
    const lat = toCoordinate(alert.lat);
    if (lon !== null && lat !== null) return { coordinates: [lon, lat], source: 'alert' };

    const place = alert.place.trim().split(',').map((part) => toCoordinate(part.trim()));
    if (place.length === 2 && place[0] !== null && place[1] !== null) {
        return { coordinates: [place[1], place[0]], source: 'place' };
    }

    if (fallbackCoordinates) return { coordinates: fallbackCoordinates, source: 'fallback' };

    return null;
}
