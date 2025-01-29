import { Static, Type, TSchema } from '@sinclair/typebox';
import { CookieJar } from 'tough-cookie';
import { CookieAgent } from 'http-cookie-agent/undici';
import moment from 'moment-timezone';
import ETL, { Event, SchemaType, handler as internal, local, InputFeatureCollection, InvocationType, DataFlowType } from '@tak-ps/etl';
import { parse } from 'csv-parse/sync'

const Env = Type.Object({
    Username: Type.String({ description: 'Active911 Username' }),
    Password: Type.String({ description: 'Active911 Password' }),
    Agencies: Type.Array(Type.Object({
        AgencyId: Type.String()
    })),
    DEBUG: Type.Boolean({ description: 'Print ADSBX results in logs', default: false })
});

const OutputSchema = Type.Object({
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

export default class Task extends ETL {
    static name = 'etl-active911'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return Env;
            } else {
                return OutputSchema
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(Env);

        const jar = new CookieJar();
        const agent = new CookieAgent({ cookies: { jar } });
        const { agencies, token } = await this.controlLogin(agent, env);

        const filteredAgencies: number[] = [];
        if (Array.isArray(env.Agencies) && env.Agencies.length) {
            for (const a of env.Agencies) {
                const id = parseInt(a.AgencyId);
                if (!agencies.includes(id)) throw new Error(`Current user account does not provide access to agency: ${id}`);
                filteredAgencies.push(id);
            }
        } else {
            filteredAgencies.push(...agencies);
        }

        const fc: Static<typeof InputFeatureCollection> = {
            type: 'FeatureCollection',
            features: []
        };

        const errs: Error[] = [];
        for (let i = 0; i < filteredAgencies.length; i++) {
            const agency = filteredAgencies[i];
            console.error(`ok - getting alerts from ${agency}`);

            try {
                const agencyForm = new FormData();
                agencyForm.append('operation', 'get_archived_alerts_csv');
                agencyForm.append('auth', token);
                agencyForm.append('post_data', JSON.stringify({
                    agency_id: agency,
                    from_date: moment().subtract(6, 'hours').unix() * 1000,
                    to_date:   moment().unix() * 1000
                }));

                const alerts_res = await fetch(`https://interface.active911.com/interface/interface.ajax.php?callback=jQuery${+new Date()}`, {
                    // @ts-expect-error Not In Fetch Type Def
                    dispatcher: agent,
                    headers: {
                        Origin: 'https://interface.active911.com',
                    },
                    referrer: "https://interface.active911.com/interface/",
                    method: "POST",
                    body: agencyForm
                })

                if (!alerts_res.ok) {
                    errs.push(new Error(await alerts_res.text()));
                    continue;
                }

                const alerts = JSON.parse(
                    (await alerts_res.text())
                        .trim()
                        .replace(/^.*?\(/, '')
                        .replace(/\)$/, '')
                    )

                if (alerts.result === 'error') {
                    errs.push(new Error(alerts.message));
                    continue;
                }

                const parsed = parse(alerts.message, { columns: true });

                for (const p of parsed) {
                     const activeAlert = this.type(OutputSchema, p)

                    if (activeAlert.place.trim().length) {
                        const coords = activeAlert.place
                            .trim()
                            .split(',')
                            .map((c: string) => { return Number(c) })
                            .slice(0, 2);

                        if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
                            fc.features.push({
                                id: `active911-${activeAlert.id}-staging`,
                                type: 'Feature',
                                properties: {
                                    callsign: `Staging: ${activeAlert.description}`,
                                    time: moment(activeAlert.sent).toISOString(),
                                    remarks: `Groups: ${activeAlert.units}\n Author: ${activeAlert.source}\n ${activeAlert.details}`
                                },
                                geometry: {
                                    type: 'Point',
                                    coordinates: [coords[1], coords[0]]
                                }
                            });
                        }
                    }

                    if (Number(activeAlert.lon) === 0 ||  Number(activeAlert.lat) === 0) {
                        continue;
                    }

                    fc.features.push({
                        id: `active911-${activeAlert.id}`,
                        type: 'Feature',
                        properties: {
                            callsign: `${activeAlert.description}`,
                            time: moment(activeAlert.sent).toISOString(),
                            remarks: `
                                Groups: ${activeAlert.units}
                                Author: ${activeAlert.source}
                                ${activeAlert.details}
                            `
                        },
                        geometry: {
                            type: 'Point',
                            coordinates: [Number(activeAlert.lon), Number(activeAlert.lat)]
                        }
                    });
                }
            } catch(err) {
                errs.push(err);
            }
        }

        await this.submit(fc);

        if (errs.length) {
            throw new Error(JSON.stringify(errs.map((e) => { return e.message })));
        }
    }

    async controlLogin(agent: CookieAgent, env: Static<typeof Env>): Promise<{
        token: string;
        agencies: number[];
    }> {
        console.error('ok - Attempting Login');
        const loginForm = new FormData();
        loginForm.append('operation', 'login');
        loginForm.append('post_data', JSON.stringify({
            username: env.Username,
            password: env.Password,
            permanent: 0,
            timeInitiated: +new Date() / 1000
        }));

        const login_res = await fetch("https://interface.active911.com/interface/interface.ajax.php", {
            // @ts-expect-error Not In Fetch Type Def
            dispatcher: agent,
            referrer: "https://interface.active911.com/interface/",
            method: 'POST',
            body: loginForm,
        })

        const login = JSON.parse((await login_res.text())
            .trim()
            .replace(/^\(/, '')
            .replace(/\)$/, '')
        ).message

        return {
            token: login.jwt,
            agencies: login.agencies.map((a: { id: number }) => {
                return a.id;
            })
        };
    }

}

await local(new Task(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
