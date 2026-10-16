import { createHash } from 'node:crypto';
import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type {
    CloudTAKAPI,
    CoreEvent,
    CoreEventCreate,
    CoreEventUpdate,
    CoreEventAssignment
} from '@tak-ps/etl';

/** CloudTAK Event ID, a digest of the last state written & the expiry last set, keyed by external ID */
export const EventCache = Type.Record(Type.String(), Type.Object({
    id: Type.String(),
    hash: Type.String(),
    expires: Type.Optional(Type.String())
}));

export type EventCache = Static<typeof EventCache>;

export type Priority = NonNullable<CoreEventUpdate['priority']>;

export type SyncedEvent = Pick<CoreEventCreate, 'name' | 'type' | 'priority' | 'geometry' | 'location' | 'remarks' | 'metadata'> & Pick<CoreEventUpdate, 'started'>;

export type Assignee = {
    name: string;
    role: string;
};

export type SyncedCall = {
    external: string;
    event: SyncedEvent;
    assignees: Array<Assignee>;
    /** A fixed time the Event ends - set when the source never closes a record, otherwise the expiry is extended on every write */
    ended?: string;
};

export type Counts = {
    created: number;
    updated: number;
    extended: number;
    unchanged: number;
    ended: number;
    failed: number;
};

export type EventSyncOptions = {
    /** External ID system the records are filed under */
    system: string;
    /** Remark that marks the Assignments the sync manages - other assignees are left alone */
    marker: string;
    /** Hours after the latest write at which an Event ends on its own - unused by records that carry their own `ended` */
    expireHours?: number;
};

/**
 * Keep CloudTAK Events & their Assignments in step with an external system's
 * records. A record that carries its own `ended` keeps it; otherwise every
 * write pushes the Event expiry out by expireHours so an Event ends on its own
 * should the task stop reporting - an unchanged record is only touched once
 * half of that window has elapsed, otherwise it costs no API calls
 */
export class EventSync {
    api: CloudTAKAPI;
    cache: EventCache;
    opts: EventSyncOptions;
    counts: Counts = { created: 0, updated: 0, extended: 0, unchanged: 0, ended: 0, failed: 0 };
    seen = new Set<string>();

    static NAME_MAX_LENGTH = 64;
    static INDEX_PAGE_SIZE = 100;
    static INDEX_MAX_PAGES = 20;

    constructor(api: CloudTAKAPI, cache: EventCache, opts: EventSyncOptions) {
        this.api = api;
        this.cache = cache;
        this.opts = opts;
    }

    static clampName(name: string): string {
        return name.length > this.NAME_MAX_LENGTH ? `${name.slice(0, this.NAME_MAX_LENGTH - 1)}…` : name;
    }

    /**
     * CAD priorities are agency configured but near universally numbered with 1 as
     * the most urgent - the first number found is mapped onto the CloudTAK scale,
     * a CloudTAK priority word is taken as is & anything else is left unprioritised
     */
    static priorityOf(value: string | null | undefined): Priority {
        const text = (value ?? '').trim().toLowerCase();
        if (!text) return 'none';

        for (const word of ['critical', 'high', 'medium', 'low'] as const) {
            if (text.includes(word)) return word;
        }

        const match = text.match(/\d+/);
        if (!match) return 'none';

        const level = Number(match[0]);
        if (level <= 1) return 'critical';
        if (level === 2) return 'high';
        if (level === 3) return 'medium';
        return 'low';
    }

    /**
     * The time an Event ends when the source never closes its records - a fixed
     * window after the record started, or after it was first seen when the start
     * is unknown
     */
    static expiresAfter(hours: number, started?: string, cached?: { expires?: string }): string {
        const window = hours * 60 * 60 * 1000;
        const start = started ? new Date(started).getTime() : NaN;

        if (!Number.isNaN(start)) return new Date(start + window).toISOString();

        return cached?.expires ?? new Date(Date.now() + window).toISOString();
    }

    private static digest(value: unknown): string {
        return createHash('sha256').update(JSON.stringify(value)).digest('hex');
    }

    private static statusOf(err: unknown): number | null {
        if (err instanceof Error && 'status' in err && typeof err.status === 'number') return err.status;
        return null;
    }

    /**
     * Create or update the Event for a record - a failure is counted & logged
     * so one record never prevents the rest from being written
     */
    async sync(call: SyncedCall): Promise<void> {
        if (this.seen.has(call.external)) return;
        this.seen.add(call.external);

        try {
            await this.write(call);
        } catch (err) {
            this.counts.failed++;
            console.error(`not ok - ${this.opts.system} ${call.external}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Forget records whose Event has already ended on its own
     */
    prune(): void {
        for (const external of Object.keys(this.cache)) {
            const expires = this.cache[external].expires;
            if (expires === undefined || new Date(expires).getTime() > Date.now()) continue;

            delete this.cache[external];
            this.counts.ended++;
        }
    }

    /**
     * End the Events of cached records that were not synced this run
     */
    async end(): Promise<void> {
        this.prune();

        for (const external of Object.keys(this.cache)) {
            if (this.seen.has(external)) continue;

            try {
                await this.api.Event.update(this.cache[external].id, { active: false });
                this.counts.ended++;
            } catch (err) {
                if (EventSync.statusOf(err) !== 404) {
                    this.counts.failed++;
                    console.error(`not ok - ${this.opts.system} ${external} could not be ended: ${err instanceof Error ? err.message : String(err)}`);
                    continue;
                }
            }

            delete this.cache[external];
        }
    }

    summary(): string {
        const c = this.counts;
        return `${this.seen.size} records: ${c.created} created, ${c.updated} updated, ${c.extended} extended, ${c.unchanged} unchanged, ${c.ended} ended, ${c.failed} failed`;
    }

    private async write(call: SyncedCall): Promise<void> {
        const hash = EventSync.digest({ event: call.event, assignees: call.assignees, ended: call.ended });

        const now = Date.now();
        const window = !call.ended && this.opts.expireHours ? this.opts.expireHours * 60 * 60 * 1000 : 0;
        const ended = call.ended ?? (window ? new Date(now + window).toISOString() : undefined);

        let cached: EventCache[string] | undefined = this.cache[call.external];

        if (!cached) {
            const found = await this.find(call.external);
            if (found) cached = { id: found.id, hash: '' };
        }

        if (cached && cached.hash === hash) {
            const expires = cached.expires ? new Date(cached.expires).getTime() : 0;

            if (!window || expires - now > window / 2) {
                this.cache[call.external] = cached;
                this.counts.unchanged++;
                return;
            }

            try {
                await this.api.Event.update(cached.id, { ended });
                this.cache[call.external] = { ...cached, expires: ended };
                this.counts.extended++;
                return;
            } catch (err) {
                if (EventSync.statusOf(err) !== 404) throw err;
                cached = undefined;
                delete this.cache[call.external];
            }
        }

        let event: CoreEvent | null = null;

        if (cached) {
            try {
                event = await this.api.Event.update(cached.id, { ...call.event, ended });
            } catch (err) {
                if (EventSync.statusOf(err) !== 404) throw err;
                delete this.cache[call.external];
            }
        }

        if (event) {
            await this.assign(event.id, call.assignees, (await this.api.Assignment.list(event.id, { limit: 100 })).items);
            this.counts.updated++;
        } else {
            event = await this.api.Event.create({
                ...call.event,
                external_id: { system: this.opts.system, value: call.external },
                ended,
                editable: true,
                links: [],
                missions: [],
                style: {}
            });

            await this.assign(event.id, call.assignees, []);
            this.counts.created++;
        }

        this.cache[call.external] = { id: event.id, hash, expires: ended };
    }

    /**
     * Reconcile the Assignments this sync manages on an Event with the current
     * assignees - people assigned by users are left untouched
     */
    private async assign(event: string, assignees: Array<Assignee>, current: Array<CoreEventAssignment>): Promise<void> {
        const managed = new Map(current.filter((a) => a.remarks === this.opts.marker).map((a) => [a.name, a]));

        for (const assignee of assignees) {
            const existing = managed.get(assignee.name);

            if (!existing) {
                await this.api.Assignment.create(event, { name: assignee.name, role: assignee.role, remarks: this.opts.marker });
            } else {
                managed.delete(assignee.name);
                if (existing.role !== assignee.role) await this.api.Assignment.update(event, existing.id, { role: assignee.role });
            }
        }

        for (const stale of managed.values()) {
            await this.api.Assignment.delete(event, stale.id);
        }
    }

    /**
     * Find the Event previously created for a record when the cache has no
     * memory of it - the Events visible to the task are indexed by external
     * ID once per run, newest first, on the first miss
     */
    private async find(external: string): Promise<{ id: string } | null> {
        this.index ??= this.buildIndex();

        const id = (await this.index).get(external);

        return id ? { id } : null;
    }

    private index?: Promise<Map<string, string>>;

    private async buildIndex(): Promise<Map<string, string>> {
        const index = new Map<string, string>();

        for (let page = 0; page < EventSync.INDEX_MAX_PAGES; page++) {
            const list = await this.api.Event.list({ limit: EventSync.INDEX_PAGE_SIZE, page });

            for (const item of list.items) {
                const value = item.external_ids[this.opts.system];
                if (value && !index.has(value)) index.set(value, item.id);
            }

            if (list.items.length < EventSync.INDEX_PAGE_SIZE) break;
        }

        return index;
    }
}
