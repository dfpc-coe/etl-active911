import fs from 'fs';

try {
    const dotfile = new URL('.env', import.meta.url);

    fs.accessSync(dotfile);

    Object.assign(process.env, JSON.parse(fs.readFileSync(dotfile)));
    console.log('ok - .env file loaded');
} catch (err) {
    console.log('ok - no .env file loaded');
}

export default class Task {
    constructor() {
        this.token = process.env.COTRIP_TOKEN;
        this.api = 'https://data.cotrip.org/';

        this.etl = {
            api: process.env.ETL_API,
            layer: process.env.ETL_LAYER,
            token: process.env.ETL_TOKEN
        };

        if (!this.token) throw new Error('No COTrip API Token Provided');
        if (!this.etl.api) throw new Error('No ETL API URL Provided');
        if (!this.etl.layer) throw new Error('No ETL Layer Provided');
        //if (!this.etl.token) throw new Error('No ETL Token Provided');
    }

    async control() {
        const incidents = [];
        let batch = -1;
        let res;
        do {
            console.log(`ok - fetching ${++batch} of incidents`);
            const url = new URL('/api/v1/incidents', this.api);
            url.searchParams.append('apiKey', this.token);
            if (res) url.searchParams.append('offset', res.headers.get('next-offset'));

            res = await fetch(url);

            incidents.push(...(await res.json()).features);
        } while (res.headers.has('next-offset') && res.headers.get('next-offset') !== 'None');
        console.log(`ok - fetched ${incidents.length} incidents`);

        const features = [];
        for (const feature of incidents.map((incident) => {
            incident.id = incident.properties.id;
            incident.properties.remarks = incident.properties.travelerInformationMessage;
            incident.properties.callsign = incident.properties.type;
            return incident;
        })) {
            if (feature.geometry.type.startsWith('Multi')) {
                const feat = JSON.stringify(feature);
                const type = feature.geometry.type.replace('Multi', '');

                let i = 0;
                for (const coordinates of feature.geometry.coordinates) {
                    const new_feat = JSON.parse(feat);
                    new_feat.geometry = { type, coordinates };
                    new_feat.id = new_feat.id + '-' + i;
                    features.push(new_feat);
                    ++i;
                }
            } else {
                features.push(feature);
            }
        };

        const fc = {
            type: 'FeatureCollection',
            features: features
        };

        if (process.env.DEBUG) for (const feat of fc.features) console.error(JSON.stringify(feat));

        const post = await fetch(new URL(`/api/layer/${this.etl.layer}/cot`, this.etl.api), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.etl.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(fc)
        });

        if (!post.ok) {
            console.error(await post.text());
            throw new Error('Failed to post layer to ETL');
        } else {
            console.log(await post.json());
        }
    }
}

export async function handler() {
    const task = new Task();
    await task.control();
}

if (import.meta.url === `file://${process.argv[1]}`) handler();
