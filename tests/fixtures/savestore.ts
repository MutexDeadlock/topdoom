/**
 * `SaveStoreBackend` as two Maps, exposed so a test can tamper with stored records the way
 * devtools (or a future build) could — the rig both the savegame and the replay store tests run
 * over. The gzip codec is *not* faked: `CompressionStream` is global in Node, so every test
 * compresses and decompresses for real. See docs/testing.md.
 */
import type { SaveStoreBackend, StoredState } from '../../src/game/savestore.ts';

export interface MemoryBackend extends SaveStoreBackend {
  metas: Map<string, unknown>;
  states: Map<string, StoredState>;
}

export function memoryBackend(): MemoryBackend {
  const metas = new Map<string, unknown>();
  const states = new Map<string, StoredState>();
  return {
    metas,
    states,
    listMeta: async () => [...metas.values()],
    readMeta: async (id) => metas.get(id),
    readState: async (id) => states.get(id),
    putSave: async (meta, state) => {
      metas.set((meta as { id: string }).id, meta);
      states.set(state.id, state);
    },
    putMeta: async (meta) => void metas.set((meta as { id: string }).id, meta),
    remove: async (id) => {
      metas.delete(id);
      states.delete(id);
    },
  };
}
