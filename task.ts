import fs from 'node:fs';
import { FeatureCollection } from 'geojson';
import ETL, { Event, SchemaType } from '@tak-ps/etl';
import { JSONSchema6Object } from 'json-schema';

try {
    const dotfile = new URL('.env', import.meta.url);

    fs.accessSync(dotfile);

    Object.assign(process.env, JSON.parse(String(fs.readFileSync(dotfile))));
} catch (err) {
    console.log('ok - no .env file loaded');
}

export default class Task extends ETL {
    static async schema(type: SchemaType = SchemaType.Input): Promise<JSONSchema6Object> {
        if (type === SchemaType.Input) {
            return {
                type: 'object',
                required: ['RefreshToken'],
                properties: {
                    'RefreshToken': {
                        type: 'string',
                        description: 'Active911 Supplied API Token'

                    },
                    'DEBUG': {
                        type: 'boolean',
                        default: false,
                        description: 'Print ADSBX results in logs'
                    }
                }
            };
        } else {
            return {
                type: 'object',
                required: [],
                properties: {}
            };
        }
    }

    async control(): Promise<void> {
        const layer = await this.layer();

        Object.assign(layer.environment, process.env);

        /* Waiting on Application to Finalize
        if (!layer.environment.RefreshToken) throw new Error('No RefreshToken Provided');
        console.error(String(layer.environment.RefreshToken));
        let token = await fetch(new URL('https://access.active911.com/interface/open_api/token.php'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                scope: 'read_agency read_alert read_response read_device read_mapdata write_mapdata',
                refresh: String(layer.environment.RefreshToken)
            })
        });
        */


        let alerts = await fetch(new URL('https://access.active911.com/interface/open_api/api/alerts'), {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${process.env.Token}`
            }
        });

        if (!alerts.ok) throw new Error(await alerts.text());
        let alerts_body: any = await alerts.json();

        for (const a of alerts_body.message.alerts) {
            let alert = await fetch(new URL(a.uri), {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${process.env.Token}`
                }
            });

            if (!alert.ok) throw new Error(await alert.text());
            let alert_body = await alert.json();

            console.error(alert_body);
        }

        const fc: FeatureCollection = {
            type: 'FeatureCollection',
            features: []
        };

        await this.submit(fc);
    }
}

export async function handler(event: Event = {}) {
    if (event.type === 'schema:input') {
        return Task.schema(SchemaType.Input);
    } else if (event.type === 'schema:output') {
        return Task.schema(SchemaType.Output);
    } else {
        const task = new Task();
        await task.control();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
