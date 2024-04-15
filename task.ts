import fs from 'node:fs';
import { Type, TSchema } from '@sinclair/typebox';
import moment from 'moment-timezone';
import { FeatureCollection } from 'geojson';
import ETL, { Event, SchemaType, handler as internal, local, env } from '@tak-ps/etl';
import { parse } from 'csv-parse/sync'

export default class Task extends ETL {
    static async schema(type: SchemaType = SchemaType.Input): Promise<TSchema> {
        if (type === SchemaType.Input) {
            return Type.Object({
                Username: Type.String({ description: 'Active911 Username' }),
                Password: Type.String({ description: 'Active911 Password' }),
                DEBUG: Type.Boolean({ description: 'Print ADSBX results in logs', default: false })
            })
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const layer = await this.fetchLayer();

        const loginForm = new FormData();
        loginForm.append('operation', 'login');
        loginForm.append('post_data', JSON.stringify({
            username: layer.environment.Username,
            password: layer.environment.Password,
            permanent: 0,
            timeInitiated: +new Date() / 1000
        }));

        const login = JSON.parse((await (await fetch("https://interface.active911.com/interface/interface.ajax.php", {
            referrer: "https://interface.active911.com/interface/",
            method: 'POST',
            body: loginForm,
        })).text())
            .trim()
            .replace(/^\(/, '')
            .replace(/\)$/, '')
        ).message;

        const fc: FeatureCollection = {
            type: 'FeatureCollection',
            features: []
        };

        for (const agency of login.agencies) {
            const agencyForm = new FormData();
            agencyForm.append('operation', 'get_archived_alerts_csv');
            agencyForm.append('auth', login.jwt);
            agencyForm.append('post_data', JSON.stringify({
                agency_id: agency.id,
                from_date: moment().subtract(6, 'hours').unix() * 1000,
                to_date:   moment().unix() * 1000
            }));

            const alerts = JSON.parse((await (await fetch("https://interface.active911.com/interface/interface.ajax.php", {
                referrer: "https://interface.active911.com/interface/",
                method: "POST",
                body: agencyForm
            })).text())
                .trim()
                .replace(/^\(/, '')
                .replace(/\)$/, '')
            ).message;

            const parsed = parse(alerts, { columns: true });

            for (const p of parsed) {
                if (p.place.trim().length) {
                    const coords = p.place
                        .trim()
                        .split(',')
                        .map((c: string) => { return Number(c) })
                        .slice(0, 2);

                    if (coords.length === 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
                        fc.features.push({
                            id: `active911-${p.id}-staging`,
                            type: 'Feature',
                            properties: {
                                callsign: `Staging: ${p.description}`,
                                time: moment(p.send).toISOString(),
                                remarks: `Groups: ${p.units}\n Author: ${p.source}\n ${p.details}`
                            },
                            geometry: {
                                type: 'Point',
                                coordinates: [coords[1], coords[0]]
                            }
                        });
                    }
                }

                if (Number(p.lon) === 0 ||  Number(p.lat) === 0) {
                    continue;
                }

                fc.features.push({
                    id: `active911-${p.id}`,
                    type: 'Feature',
                    properties: {
                        callsign: `${p.description}`,
                        time: moment(p.send).toISOString(),
                        remarks: `
                            Groups: ${p.units}
                            Author: ${p.source}
                            ${p.details}
                        `
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [Number(p.lon), Number(p.lat)]
                    }
                });
            }

        }

        await this.submit(fc);
    }
}

env(import.meta.url)
await local(new Task(), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(), event);
}
