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
                required: [],
                properties: {
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

        if (!layer.environment.ARCGIS_URL) throw new Error('No ArcGIS_URL Provided');

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
