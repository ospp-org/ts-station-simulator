import type { BayConfig } from '../station/StationConfig.js';

export interface DeriveBaysResult {
  bays: BayConfig[];
  warnings: string[];
}

const BAY_KEY_RE = /^bayId_(\d+)$/;

export function deriveBays(
  stationId: string,
  bayCount: number,
  userVars: Map<string, string>,
): DeriveBaysResult {
  const stationHex = stationId.replace(/^stn_/, '');
  const bays: BayConfig[] = [];
  for (let i = 1; i <= bayCount; i++) {
    const defaultBayId = `bay_${stationHex}${String(i).padStart(2, '0')}`;
    const overrideBayId = userVars.get(`bayId_${i}`);
    bays.push({
      bayId: overrideBayId ?? defaultBayId,
      bayNumber: i,
      // Programs are firmware constants the station owns; services are what the
      // server pushed. Both are declared here because the simulator plays both
      // halves, but only programs go on the wire in a StatusNotification.
      programs: [{ programNumber: 1, label: 'Basic Wash', available: true }],
      services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
    });
  }

  const warnings: string[] = [];
  for (const key of userVars.keys()) {
    const m = key.match(BAY_KEY_RE);
    if (!m) {
      warnings.push(`--var ${key}=... not recognized by connect mode (only bayId_<N> is honored; ignored)`);
      continue;
    }
    const index = Number.parseInt(m[1], 10);
    if (index < 1 || index > bayCount) {
      warnings.push(
        `--var ${key}=... out of range (bayCount=${bayCount}, requested bay #${index}; ignored)`,
      );
    }
  }

  return { bays, warnings };
}
