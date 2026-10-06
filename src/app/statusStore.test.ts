import { describe, expect, it, vi } from 'vitest';
import { createStatusStore } from './statusStore';

const status = (over: Partial<Parameters<ReturnType<typeof createStatusStore>['publish']>[0]> = {}) => ({ zoom: 120, x: 10, y: 20, rotation: 0, measurement: null, ...over });

describe('statusStore', () => {
  it('starts with a stable snapshot and notifies subscribers once per displayed change', () => {
    const store = createStatusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.publish(status());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ zoom: 120, x: 10, y: 20 });
    unsubscribe();
    store.publish(status({ zoom: 150 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dedupes by displayed precision: whole percent, 0.01 mm coordinates, 0.001 mm measurement', () => {
    const store = createStatusStore();
    store.publish(status({ zoom: 120.2, x: 10.001, y: 20.004, measurement: 1.2344 }));
    const listener = vi.fn();
    store.subscribe(listener);
    const snapshot = store.getSnapshot();
    store.publish(status({ zoom: 120.4, x: 10.0049, y: 19.9951, measurement: 1.2341 }));
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(snapshot);
    store.publish(status({ zoom: 120.6, x: 10.001, y: 20.004, measurement: 1.2344 }));
    expect(listener).toHaveBeenCalledTimes(1);
    store.publish(status({ zoom: 121, x: 10.02, y: 20.004, measurement: 1.2344 }));
    expect(listener).toHaveBeenCalledTimes(2);
    store.publish(status({ zoom: 121, x: 10.02, y: 20.004, measurement: 1.2354 }));
    expect(listener).toHaveBeenCalledTimes(3);
    store.publish(status({ zoom: 121, x: 10.02, y: 20.004, measurement: null }));
    expect(listener).toHaveBeenCalledTimes(4);
    store.publish(status({ zoom: 121, x: 10.02, y: 20.004, measurement: null, rotation: 90 }));
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('keeps the source label across publishes and dedupes setSource', () => {
    const store = createStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSource('KiCad PCB · mm');
    store.setSource('KiCad PCB · mm');
    expect(listener).toHaveBeenCalledTimes(1);
    store.publish(status());
    expect(store.getSnapshot().source).toBe('KiCad PCB · mm');
  });

  it('tolerates non-finite input without notifying forever', () => {
    const store = createStatusStore();
    store.publish(status({ x: NaN }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish(status({ x: NaN }));
    expect(listener).not.toHaveBeenCalled();
  });
});
