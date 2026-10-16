import test from 'node:test';
import assert from 'node:assert';
import type { CloudTAKAPI, CoreEvent, CoreEventAssignment, CoreEventCreate, CoreEventUpdate, CoreEventAssignmentCreate, CoreEventAssignmentUpdate, CoreEventListQuery } from '@tak-ps/etl';
import { EventSync, priorityOf, clampName, expiresAfter } from '../lib/events.js';
import type { EventCache, SyncedCall } from '../lib/events.js';

const SYSTEM = 'test';
const MARKER = 'Test Response';
const HOUR = 60 * 60 * 1000;

class NotFound extends Error {
    status = 404;
}

/** The SDK operations the sync uses */
type EventAPI = {
    Event: Pick<CloudTAKAPI['Event'], 'list' | 'create' | 'update'>;
    Assignment: Pick<CloudTAKAPI['Assignment'], 'list' | 'create' | 'update' | 'delete'>;
};

/** In-memory stand in for the CloudTAK Event & Assignment API */
class FakeAPI implements EventAPI {
    events = new Map<string, CoreEvent>();
    assignments = new Map<string, Map<string, CoreEventAssignment>>();
    log: string[] = [];
    seq = 0;

    Event = {
        list: async (query: Partial<CoreEventListQuery> = {}) => {
            this.log.push(`list ${query.page ?? 0}`);
            const items = [...this.events.values()].reverse();
            const limit = query.limit ?? 10;
            const page = query.page ?? 0;
            return { total: items.length, items: items.slice(page * limit, (page + 1) * limit) };
        },
        create: async (body: CoreEventCreate) => {
            this.log.push('create');
            const { external_id, ...rest } = body;
            const external = external_id && typeof external_id === 'object' ? { [external_id.system]: external_id.value } : {};
            const event = { id: `event-${++this.seq}`, active: true, ...rest, external_ids: external } as unknown as CoreEvent;
            this.events.set(event.id, event);
            this.assignments.set(event.id, new Map());
            return event;
        },
        update: async (id: string, body: CoreEventUpdate) => {
            this.log.push(`update ${id} ${Object.keys(body).join(',')}`);
            const event = this.events.get(id);
            if (!event) throw new NotFound('Not Found');
            Object.assign(event, body);
            return event;
        }
    };

    Assignment = {
        list: async (event: string) => {
            this.log.push(`assignments ${event}`);
            const items = [...this.assignments.get(event)!.values()];
            return { total: items.length, items };
        },
        create: async (event: string, body: CoreEventAssignmentCreate) => {
            this.log.push(`assign ${event} ${body.name}`);
            const assignment = { id: `assignment-${++this.seq}`, event, uid: null, ...body } as unknown as CoreEventAssignment;
            this.assignments.get(event)!.set(assignment.id, assignment);
            return assignment;
        },
        update: async (event: string, id: string, body: CoreEventAssignmentUpdate) => {
            this.log.push(`reassign ${event} ${id}`);
            const assignment = this.assignments.get(event)!.get(id)!;
            Object.assign(assignment, body);
            return assignment;
        },
        delete: async (event: string, id: string) => {
            this.log.push(`unassign ${event} ${id}`);
            this.assignments.get(event)!.delete(id);
            return { status: 200, message: 'Assignment Deleted' };
        }
    };

    byExternal(value: string): CoreEvent {
        const event = [...this.events.values()].find((e) => e.external_ids[SYSTEM] === value);
        assert.ok(event, `event ${value}`);
        return event;
    }

    names(event: string): Array<[string, string]> {
        return [...this.assignments.get(event)!.values()].map((a) => [a.name, a.role] as [string, string]).sort();
    }
}

function call(external: string, assignees: Array<[string, string]>, remarks = 'remarks', ended?: string): SyncedCall {
    return {
        external,
        ended,
        event: {
            name: `Call ${external}`,
            type: '10034000001100000000',
            priority: 'none',
            geometry: { type: 'Point', coordinates: [-105, 40] },
            location: '1 Main St',
            remarks,
            metadata: { external }
        },
        assignees: assignees.map(([name, role]) => ({ name, role }))
    };
}

function within(iso: string | null | undefined, ms: number, tolerance = 60 * 1000): boolean {
    return typeof iso === 'string' && Math.abs(new Date(iso).getTime() - (Date.now() + ms)) < tolerance;
}

async function run(api: FakeAPI, cache: EventCache, calls: SyncedCall[], end = true): Promise<EventSync> {
    api.log = [];
    const sync = new EventSync(api as unknown as CloudTAKAPI, cache, { system: SYSTEM, marker: MARKER, expireHours: 1 });
    for (const c of calls) await sync.sync(c);
    if (end) await sync.end();
    return sync;
}

test('priorityOf', () => {
    assert.equal(priorityOf('1'), 'critical');
    assert.equal(priorityOf('P2'), 'high');
    assert.equal(priorityOf('Priority 3'), 'medium');
    assert.equal(priorityOf('4'), 'low');
    assert.equal(priorityOf('High'), 'high');
    assert.equal(priorityOf(''), 'none');
    assert.equal(priorityOf(undefined), 'none');
    assert.equal(priorityOf('Routine'), 'none');
});

test('clampName', () => {
    assert.equal(clampName('short'), 'short');
    assert.equal(clampName('x'.repeat(80)).length, 64);
});

test('EventSync: create, skip unchanged, extend, update, end', async () => {
    const api = new FakeAPI();
    const cache: EventCache = {};

    let sync = await run(api, cache, [call('A', [['E1', 'Respond'], ['E2', 'Unavailable']]), call('B', [])]);
    assert.deepEqual(sync.counts, { created: 2, updated: 0, extended: 0, unchanged: 0, ended: 0, failed: 0 });
    assert.deepEqual(api.log.filter((l) => l.startsWith('list')), ['list 0'], 'index built once on the first miss');

    const a = api.byExternal('A');
    const b = api.byExternal('B');
    assert.ok(within(a.ended, HOUR), 'expiry an hour out');
    assert.deepEqual(a.external_ids, { test: 'A' });
    assert.deepEqual(api.names(a.id), [['E1', 'Respond'], ['E2', 'Unavailable']]);
    assert.ok(within(cache.A.expires, HOUR));

    // A user assigns someone by hand
    api.assignments.get(a.id)!.set('user', { id: 'user', event: a.id, name: 'Jane IC', role: 'IC', remarks: '', uid: null } as unknown as CoreEventAssignment);

    sync = await run(api, cache, [call('A', [['E1', 'Respond'], ['E2', 'Unavailable']]), call('B', [])]);
    assert.deepEqual(sync.counts, { created: 0, updated: 0, extended: 0, unchanged: 2, ended: 0, failed: 0 });
    assert.deepEqual(api.log, []);

    // Inside half the window only the expiry is pushed out
    cache.A.expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    sync = await run(api, cache, [call('A', [['E1', 'Respond'], ['E2', 'Unavailable']]), call('B', [])]);
    assert.deepEqual(sync.counts, { created: 0, updated: 0, extended: 1, unchanged: 1, ended: 0, failed: 0 });
    assert.deepEqual(api.log, [`update ${a.id} ended`]);
    assert.ok(within(a.ended, HOUR));
    assert.ok(within(cache.A.expires, HOUR));

    // Responders change & B leaves the window
    sync = await run(api, cache, [call('A', [['E1', 'On Scene'], ['E3', 'Respond']])]);
    assert.deepEqual(sync.counts, { created: 0, updated: 1, extended: 0, unchanged: 0, ended: 1, failed: 0 });
    assert.deepEqual(api.names(a.id), [['E1', 'On Scene'], ['E3', 'Respond'], ['Jane IC', 'IC']]);
    assert.equal(b.active, false);
    assert.deepEqual(Object.keys(cache), ['A']);
    assert.ok(api.log.includes(`update ${a.id} name,type,priority,geometry,location,remarks,metadata,ended`));

    // Cache lost - the Event is found through the index, not duplicated
    for (const key of Object.keys(cache)) delete cache[key];
    sync = await run(api, cache, [call('A', [['E1', 'On Scene'], ['E3', 'Respond']])]);
    assert.deepEqual(sync.counts, { created: 0, updated: 1, extended: 0, unchanged: 0, ended: 0, failed: 0 });
    assert.equal(api.events.size, 2);
    assert.deepEqual(Object.keys(cache), ['A']);

    // Deleted upstream - recreated
    api.events.delete(a.id);
    sync = await run(api, cache, [call('A', [])]);
    assert.deepEqual(sync.counts, { created: 1, updated: 0, extended: 0, unchanged: 0, ended: 0, failed: 0 });
    assert.equal(api.events.size, 2);
    assert.notEqual(cache.A.id, a.id);
});

test('expiresAfter', () => {
    const sent = new Date(Date.now() - HOUR).toISOString();
    assert.ok(within(expiresAfter(6, sent), 5 * HOUR), 'a fixed window after the start');
    assert.equal(expiresAfter(6, 'Invalid date', { expires: 'kept' }), 'kept', 'an unknown start keeps the cached expiry');
    assert.ok(within(expiresAfter(6, undefined), 6 * HOUR), 'an unknown start with no cache is a window from now');
});

test('EventSync: a record with its own ended is never extended & ends on its own', async () => {
    const api = new FakeAPI();
    const cache: EventCache = {};
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 2 * HOUR).toISOString();

    await run(api, cache, [call('A', [], 'remarks', soon)]);
    const a = api.byExternal('A');
    assert.equal(a.ended, soon);
    assert.equal(cache.A.expires, soon);

    let sync = await run(api, cache, [call('A', [], 'remarks', soon)]);
    assert.deepEqual(sync.counts, { created: 0, updated: 0, extended: 0, unchanged: 1, ended: 0, failed: 0 });
    assert.deepEqual(api.log, [], 'an expiry inside the window is not pushed out');

    sync = await run(api, cache, [call('A', [], 'remarks', later)]);
    assert.deepEqual(sync.counts, { created: 0, updated: 1, extended: 0, unchanged: 0, ended: 0, failed: 0 });
    assert.equal(a.ended, later);

    cache.A.expires = new Date(Date.now() - 1000).toISOString();
    sync = await run(api, cache, []);
    assert.deepEqual(sync.counts, { created: 0, updated: 0, extended: 0, unchanged: 0, ended: 1, failed: 0 });
    assert.deepEqual(api.log, [], 'an Event past its expiry is not patched');
    assert.deepEqual(cache, {});
});

test('EventSync: a failing record does not stop the rest & end() is skippable', async () => {
    const api = new FakeAPI();
    const cache: EventCache = {};

    await run(api, cache, [call('A', []), call('B', [])]);

    api.Event.update = async () => { throw new Error('boom'); };

    const sync = await run(api, cache, [call('A', [], 'changed'), call('B', [], 'changed')], false);
    assert.deepEqual(sync.counts, { created: 0, updated: 0, extended: 0, unchanged: 0, ended: 0, failed: 2 });
    assert.deepEqual(Object.keys(cache).sort(), ['A', 'B']);
});

test('EventSync: duplicate external IDs within a run are written once', async () => {
    const api = new FakeAPI();
    const sync = await run(api, {}, [call('A', []), call('A', [])]);
    assert.deepEqual(sync.counts.created, 1);
});
