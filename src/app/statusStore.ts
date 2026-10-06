import type { StatusSnapshot, StatusStore } from './api';

const INITIAL: StatusSnapshot = Object.freeze({ zoom: 100, x: 0, y: 0, rotation: 0, measurement: null, source: '' });

/**
 * Pointer-rate canvas status (P01). `publish` is O(1): it compares the DISPLAYED precision (zoom whole percent,
 * coordinates 0.01 mm, measurement 0.001 mm, rotation as is) and only allocates a snapshot and notifies when one of
 * those values differs, so a pointer moving by sub-pixel amounts costs nothing downstream.
 */
export function createStatusStore(): StatusStore {
  let snapshot: StatusSnapshot = INITIAL;
  let zoomKey = Math.round(INITIAL.zoom), xKey = 0, yKey = 0;
  let measurementKey: number | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next) {
      const zoom = Math.round(next.zoom), x = Math.round(next.x * 100), y = Math.round(next.y * 100);
      const measurement = next.measurement === null ? null : Math.round(next.measurement * 1000);
      if (Object.is(zoom, zoomKey) && Object.is(x, xKey) && Object.is(y, yKey) && Object.is(measurement, measurementKey) && next.rotation === snapshot.rotation) return;
      zoomKey = zoom; xKey = x; yKey = y; measurementKey = measurement;
      snapshot = { zoom: next.zoom, x: next.x, y: next.y, rotation: next.rotation, measurement: next.measurement, source: snapshot.source };
      emit();
    },
    setSource(source) {
      if (source === snapshot.source) return;
      snapshot = { ...snapshot, source };
      emit();
    },
  };
}
