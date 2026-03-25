export enum StationLifecycle {
  OFFLINE = 'OFFLINE',
  ONLINE = 'ONLINE',
  REBOOTING = 'REBOOTING',
}

const VALID_TRANSITIONS = new Map<StationLifecycle, Set<StationLifecycle>>([
  [StationLifecycle.OFFLINE, new Set([StationLifecycle.ONLINE])],
  [StationLifecycle.ONLINE, new Set([StationLifecycle.OFFLINE, StationLifecycle.REBOOTING])],
  [StationLifecycle.REBOOTING, new Set([StationLifecycle.OFFLINE, StationLifecycle.ONLINE])],
]);

export function canTransition(from: StationLifecycle, to: StationLifecycle): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}
