import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CatalogStore } from '../../station/CatalogStore.js';

/*
 * The simulator's NVS for the service catalog (update-service-catalog.md rules 2 and 5): the catalog
 * last accepted, replaced whole, read back at the next start - and a file that cannot be read is
 * refused rather than quietly replaced by the seed.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'catalog-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WASH = { serviceId: 'svc_wash', serviceName: 'Spalare', available: true };
const FOAM = { serviceId: 'svc_foam', serviceName: 'Spuma', available: false };

describe('CatalogStore', () => {
  it('reads nothing for a station that never accepted a catalog', async () => {
    expect(await new CatalogStore(dir, 'stn_a0000001').load()).toBeNull();
  });

  it('reads back, in a new store - a new process - the catalog it saved', async () => {
    await new CatalogStore(dir, 'stn_a0000001').save('3', [WASH, FOAM]);

    const stored = await new CatalogStore(dir, 'stn_a0000001').load();
    expect(stored?.catalogVersion).toBe('3');
    expect(stored?.services).toEqual([WASH, FOAM]);
  });

  it('replaces the catalog whole, and leaves no temporary file behind', async () => {
    const store = new CatalogStore(dir, 'stn_a0000001');
    await store.save('3', [WASH, FOAM]);
    await store.save('4', [WASH]);

    expect((await store.load())?.services).toEqual([WASH]);
    expect(await readdir(dir)).toEqual(['stn_a0000001-catalog.json']);
  });

  it('keeps one station\'s catalog apart from another\'s', async () => {
    await new CatalogStore(dir, 'stn_a0000001').save('3', [WASH]);

    expect(await new CatalogStore(dir, 'stn_b0000002').load()).toBeNull();
  });

  it('refuses a file it cannot read, rather than falling back to the seed', async () => {
    const store = new CatalogStore(dir, 'stn_a0000001');
    await writeFile(store.path, '{"catalogVersion": "3", "services": [');

    await expect(store.load()).rejects.toThrow(/will NOT be replaced by the seed/);
  });

  it('refuses a file whose catalog has no services', async () => {
    const store = new CatalogStore(dir, 'stn_a0000001');
    await writeFile(store.path, JSON.stringify({ stationId: 'stn_a0000001', catalogVersion: '3', services: [] }));

    await expect(store.load()).rejects.toThrow(/missing services/);
  });

  it('writes the file readable by its owner only', async () => {
    const store = new CatalogStore(dir, 'stn_a0000001');
    await store.save('3', [WASH]);

    const { stat } = await import('node:fs/promises');
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, 'utf-8')).stationId).toBe('stn_a0000001');
  });
});
