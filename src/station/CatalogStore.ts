import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceConfig } from './StationConfig.js';

export interface StoredCatalog {
  stationId: string;
  catalogVersion: string;
  acceptedAt: string;
  services: ServiceConfig[];
}

/**
 * The service catalog this station last accepted, kept on disk - the simulator's NVS.
 *
 * spec/profiles/device-management/update-service-catalog.md, rule 5: "The station MUST persist the
 * catalog to non-volatile storage so it survives reboots"; the device-management README and reset.md
 * say the same ("everything persisted - credentials, configuration, catalog ... survives"). A server
 * is entitled to rely on it: csms-server's PublishFirstCatalogOnBoot pushes a catalog only to a station
 * that has never been sent one, and nothing lets a station ask for it again - UpdateServiceCatalog is
 * Server -> Station, and the BootNotification response carries no catalog.
 *
 * Beside the station's certificates, like TopologyStore: the state it already keeps on disk. Written
 * as a WHOLE REPLACEMENT (rule 2, "atomic replacement"): a temporary file renamed over the old one, so
 * a crash mid-write leaves the previous catalog, never half of the new one.
 *
 * A file that cannot be read is REFUSED, never silently replaced by the seed: a station that quietly
 * sold its seed after a corrupt write would refuse every service the server priced, 3004, with nothing
 * saying why.
 */
export class CatalogStore {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly stationId: string,
  ) {
    this.file = join(dir, `${stationId}-catalog.json`);
  }

  get path(): string {
    return this.file;
  }

  /** The catalog last accepted, or null when this station has never accepted one. */
  async load(): Promise<StoredCatalog | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as StoredCatalog;
      if (typeof parsed.catalogVersion !== 'string' || parsed.catalogVersion === '') {
        throw new Error('missing catalogVersion');
      }
      if (!Array.isArray(parsed.services) || parsed.services.length === 0) {
        throw new Error('missing services[]');
      }
      for (const service of parsed.services) {
        if (typeof service.serviceId !== 'string' || typeof service.serviceName !== 'string' || typeof service.available !== 'boolean') {
          throw new Error('a service without serviceId, serviceName and available');
        }
      }

      return parsed;
    } catch (err) {
      throw new Error(
        `Stored service catalog at ${this.file} is unreadable and will NOT be replaced by the seed: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Publish the catalog to the station again after repairing or deleting the file.',
      );
    }
  }

  /** Replace the stored catalog with the one just accepted - whole, never merged. */
  async save(catalogVersion: string, services: ServiceConfig[]): Promise<void> {
    const record: StoredCatalog = {
      stationId: this.stationId,
      catalogVersion,
      acceptedAt: new Date().toISOString(),
      services,
    };

    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
