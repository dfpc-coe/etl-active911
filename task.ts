import { Static, Type, TSchema } from '@sinclair/typebox';
import { CookieJar } from 'tough-cookie';
import type { SerializedCookieJar } from 'tough-cookie';
// The dispatcher of undici@8 can't be given to the fetch that is built into Node 24 (undici@7) - the request never
// completes. FormData has to come from undici as well or its fetch sends it as the text `[object FormData]`
import { fetch, FormData } from 'undici';
import { CookieAgent } from 'http-cookie-agent/undici';
import type { CookieOptions } from 'http-cookie-agent/undici';
import moment from 'moment-timezone';
import ETL, { Event, SchemaType, handler as internal, local, InvocationType, DataFlowType, SubmitFeatureCollection } from '@tak-ps/etl';
import type { NamedSchema } from '@tak-ps/etl';
import { parse } from 'csv-parse/sync'
import { parseTime, parseZone } from './lib/time.js';
import { PARSER_NAMES, parseNarrative, renderRemarks } from './lib/parsers/index.js';

const Env = Type.Object({
    Username: Type.String({ description: 'Active911 Username' }),
    Password: Type.String({ description: 'Active911 Password' }),
    Agencies: Type.Array(Type.Object({
        AgencyId: Type.String(),
        Parser: Type.String({
            description: 'CAD format used to parse alert details into individual notes - auto detects the format & raw leaves the details as is',
            enum: PARSER_NAMES,
            default: 'auto'
        })
    })),
    DEBUG: Type.Boolean({ description: 'Print the start of details that were not parsed in logs - CAD notes contain names & medical information', default: false })
});

// Used when the JWT doesn't carry an `exp` claim
const SESSION_LIFETIME_MS = 60 * 60 * 1000;
const SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface Session {
    agent: CookieAgent;
    token: string;
    agencies: number[];
    /** Restored from the ephemeral store rather than a fresh login */
    cached: boolean;
}

const AlertSchema = Type.Object({
    id: Type.String(),
    received: Type.String(),
    sent: Type.String(),
    priority: Type.String(),
    description: Type.String(),
    details: Type.String(),
    external_data: Type.String(),
    place: Type.String(),
    address: Type.String(),
    unit: Type.String(),
    cross_street: Type.String(),
    city: Type.String(),
    state: Type.String(),
    lat: Type.String(),
    lon: Type.String(),
    coordinate_source: Type.String(),
    source: Type.String(),
    units: Type.String(),
    cad_code: Type.String(),
    map_code: Type.String(),
    map_id: Type.String(),
    alert_key: Type.String(),
    messages: Type.String(),
    responses: Type.String(),
});

const OutputSchema = Type.Composite([AlertSchema, Type.Object({
    narrative: Type.Object({
        parser: Type.String({ description: 'Parser that produced the narrative - raw if the details were not parsed' }),
        entries: Type.Array(Type.Object({
            time: Type.Optional(Type.String()),
            author: Type.Optional(Type.String()),
            text: Type.String()
        })),
        fields: Type.Record(Type.String(), Type.String())
    })
})]);

export default class Task extends ETL {
    static name = 'etl-active911'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema | Array<NamedSchema>> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return Env;
            } else {
                return [{ id: 'alert', schema: OutputSchema }];
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(Env);

        let session = await this.controlSession(env);

        const filteredAgencies: number[] = [];
        const parsers = new Map<number, string>();
        if (Array.isArray(env.Agencies) && env.Agencies.length) {
            for (const a of env.Agencies) {
                const id = parseInt(a.AgencyId);

                // The account may have been given access to the agency since the session was cached
                if (!session.agencies.includes(id) && session.cached) session = await this.controlSession(env, true);

                if (!session.agencies.includes(id)) throw new Error(`Current user account does not provide access to agency: ${id}`);
                filteredAgencies.push(id);
                parsers.set(id, a.Parser || 'auto');
            }
        } else {
            filteredAgencies.push(...session.agencies);
        }

        const fc: Static<typeof SubmitFeatureCollection> = {
            type: 'FeatureCollection',
            schema: 'alert',
            features: []
        };

        const RESPONSE_REGEX = /Got a response of (.+?) to (.+?)\((\d+)\) at (.+?)\./;

        const errs: Error[] = [];
        for (let i = 0; i < filteredAgencies.length; i++) {
            const agency = filteredAgencies[i];
            console.log(`ok - getting alerts from ${agency}`);

            try {
                let parsed: unknown[];
                const parsedBy = new Map<string, number>();

                try {
                    parsed = await this.controlAlerts(session, agency);
                } catch (err) {
                    // A cached session can be revoked before it expires - login again once
                    if (!session.cached) throw err;

                    console.log(`ok - cached session rejected: ${err instanceof Error ? err.message : String(err)}`);
                    session = await this.controlSession(env, true);
                    parsed = await this.controlAlerts(session, agency);
                }

                for (const p of parsed) {
                     const activeAlert = this.type(AlertSchema, p)

                     if (Number(activeAlert.lon) === 0 ||  Number(activeAlert.lat) === 0) {
                         const coords = activeAlert.place
                         .trim()
                         .split(',')
                         .map((c: string) => { return Number(c) })
                         .slice(0, 2);

                         if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
                             activeAlert.lon = coords[1].toString();
                             activeAlert.lat = coords[0].toString();
                         } else {
                             continue;
                         }
                     }

                    const linkMap = new Map<string, {
                        relation: string;
                        callsign: string;
                        remarks: string;
                        production_time?: string;
                    }>();

                    // Responses are in Chronological order
                    activeAlert.responses
                        .split('\n')
                        .filter((r) => { return r.startsWith('Got a response of ') })
                        .map((r) => {
                            // Example: (Can be in any timezone)
                            // Got a response of Respond to Nick Ingalls(123456) at 12/08/2025 18:28:20 MST.
                            const match = RESPONSE_REGEX.exec(r);

                            linkMap.set(match ? match[2].trim() : 'Unknown', {
                                relation: 't-s',
                                callsign: match ? match[2].trim() : 'Unknown',
                                remarks: match ? `${match[1].trim()}` : 'Unknown',
                                production_time: match ? parseTime(match[4].trim()) : undefined
                            })
                        });

                    // Date Format: 12/08/2025 18:27:47 MST
                    const start = parseTime(activeAlert.sent);

                    // CAD notes aren't timezone aware - they are local to the zone the alert was sent in
                    const zone = parseZone(activeAlert.sent);
                    const narrative = parseNarrative(activeAlert.details, zone, parsers.get(agency));
                    parsedBy.set(narrative.parser, (parsedBy.get(narrative.parser) || 0) + 1);

                    if (env.DEBUG && narrative.parser === 'raw' && activeAlert.details.trim()) {
                        console.log(`ok - alert ${activeAlert.id} not parsed: ${escaped(activeAlert.details.slice(0, 80))}`);
                    }

                    fc.features.push({
                        id: `active911-${activeAlert.id}`,
                        type: 'Feature',
                        properties: {
                            callsign: `${activeAlert.description}`,
                            start,
                            links: Array.from(linkMap.values()),
                            metadata: { ...activeAlert, narrative },
                            remarks: renderRemarks({
                                Groups: activeAlert.units,
                                Author: activeAlert.source
                            }, narrative, zone)
                        },
                        geometry: {
                            type: 'Point',
                            coordinates: [Number(activeAlert.lon), Number(activeAlert.lat)]
                        }
                    });
                }

                // Shows if remarks that aren't a table came from here or from a remarks template in the Layer styles
                console.log(`ok - ${agency} parsers: ${JSON.stringify(Object.fromEntries(parsedBy))}`);
            } catch(err) {
                errs.push(err instanceof Error ? err : new Error(String(err)));
            }
        }

        await this.submit(fc);

        if (errs.length) {
            throw new Error(JSON.stringify(errs.map((e) => { return e.message })));
        }
    }

    async controlAlerts(session: Session, agency: number): Promise<unknown[]> {
        const agencyForm = new FormData();
        agencyForm.append('operation', 'get_archived_alerts_spreadsheet');
        agencyForm.append('auth', session.token);
        agencyForm.append('post_data', JSON.stringify({
            agency_id: agency,
            from_date: moment().subtract(6, 'hours').unix() * 1000,
            to_date:   moment().unix() * 1000,
            file_type: 'Csv'
        }));

        const alerts_res = await fetch(`https://interface.active911.com/interface/interface.ajax.php?callback=jQuery${+new Date()}`, {
            dispatcher: session.agent,
            headers: {
                Origin: 'https://interface.active911.com',
            },
            referrer: "https://interface.active911.com/interface/",
            method: "POST",
            body: agencyForm
        })

        if (!alerts_res.ok) throw new Error(await alerts_res.text());

        const alerts = JSON.parse(
            (await alerts_res.text())
                .trim()
                .replace(/^[^{]+/, '')
                .replace(/[^}]+$/, '')
        );

        if (alerts.result === 'error') throw new Error(alerts.message);

        return parse(Buffer.from(alerts.message, 'base64').toString('utf8'), { columns: true });
    }

    /**
     * Session cached in the ephemeral store of the Layer, falling back to a
     * login when there isn't one, it has expired or it belongs to another user
     */
    async controlSession(env: Static<typeof Env>, force = false): Promise<Session> {
        const layer = await this.fetchLayer();
        const ephemeral = layer.incoming?.ephemeral ?? {};

        if (
            !force
            && ephemeral.username === env.Username
            && typeof ephemeral.token === 'string'
            && Array.isArray(ephemeral.agencies)
            && Number(ephemeral.expires) > +new Date()
        ) {
            try {
                const jar = CookieJar.deserializeSync(ephemeral.cookies as SerializedCookieJar);

                console.log('ok - using cached session');

                return {
                    agent: cookieAgent(jar),
                    token: ephemeral.token,
                    agencies: ephemeral.agencies.map(Number),
                    cached: true
                };
            } catch (err) {
                console.error(`not ok - failed to restore cached session: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        const jar = new CookieJar();
        const agent = cookieAgent(jar);
        const { token, agencies } = await this.controlLogin(agent, env);

        const lifetime = jwtExpires(token) - +new Date();
        const margin = Math.min(SESSION_REFRESH_MARGIN_MS, lifetime / 2);

        await this.setEphemeral({
            username: env.Username,
            token,
            agencies,
            cookies: jar.serializeSync(),
            expires: +new Date() + lifetime - margin
        });

        return { agent, token, agencies, cached: false };
    }

    async controlLogin(agent: CookieAgent, env: Static<typeof Env>): Promise<{
        token: string;
        agencies: number[];
    }> {
        console.log('ok - Attempting Login');
        const loginForm = new FormData();
        loginForm.append('operation', 'login');
        loginForm.append('post_data', JSON.stringify({
            username: env.Username,
            password: env.Password,
            permanent: 0,
            timeInitiated: +new Date() / 1000
        }));

        const login_res = await fetch("https://interface.active911.com/interface/interface.ajax.php", {
            dispatcher: agent,
            referrer: "https://interface.active911.com/interface/",
            method: 'POST',
            body: loginForm,
        })

        const body = JSON.parse((await login_res.text())
            .trim()
            .replace(/^\(/, '')
            .replace(/\)$/, '')
        );

        const login = body.message;

        // A failed login must never be cached as a session
        if (body.result === 'error' || !login || typeof login.jwt !== 'string' || !Array.isArray(login.agencies)) {
            throw new Error(`Active911 Login Failed: ${typeof login === 'string' ? login : 'No token returned'}`);
        }

        return {
            token: login.jwt,
            agencies: login.agencies.map((a: { id: number }) => {
                return a.id;
            })
        };
    }

}

/**
 * http-cookie-agent is CommonJS so its types resolve the CJS declarations of tough-cookie
 * which TypeScript treats as distinct from the identical ESM declarations imported here
 */
function cookieAgent(jar: CookieJar): CookieAgent {
    return new CookieAgent({ cookies: { jar: jar as unknown as CookieOptions['jar'] } });
}

/** Printable ASCII with everything else as a code point so that whitespace Active911 has substituted can be seen */
function escaped(text: string): string {
    return Array.from(text).map((c) => {
        return /[\x20-\x7e]/.test(c) ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`;
    }).join('');
}

/** Expiry of a JWT in ms from its `exp` claim - a default lifetime from now if it doesn't have one */
function jwtExpires(token: string): number {
    try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (typeof claims.exp === 'number') return claims.exp * 1000;
    } catch {
        // Not a decodable JWT - fall through to the default lifetime
    }

    return +new Date() + SESSION_LIFETIME_MS;
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
