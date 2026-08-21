import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureLibraryAccess,
  forgetLibrary,
  pickerBlock,
  pickLibraryFolder,
} from '../../src/wad/library.ts';

/**
 * The folder-picker call into the File System Access API (docs/wad.md § The player's own library).
 * The stub brand-checks its receiver the way the real native method does: `showDirectoryPicker`
 * detached from `window` throws "Illegal invocation" before any dialog opens, and with the cancel
 * catch swallowing it, every folder pick was a silent no-op — a failure an ordinary arrow-function
 * stub can never reproduce.
 */
function stubPicker(impl: (this: unknown) => Promise<unknown>): () => void {
  const g = globalThis as { showDirectoryPicker?: unknown };
  g.showDirectoryPicker = function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return impl.call(this);
  };
  return () => delete g.showDirectoryPicker;
}

describe('WAD library · the folder picker', () => {
  test('the picker keeps its receiver, and a dismissed dialog is null rather than an error', async () => {
    // One stub covers both: a detached call dies on the brand check before the impl runs — an
    // "Illegal invocation" here would propagate and fail the assert — while a call that survives
    // it rejects as a dismissal, which must come back as the quiet null.
    const restore = stubPicker(() => Promise.reject(abortError()));
    try {
      assert.equal(pickerBlock(), '');
      assert.equal(await pickLibraryFolder(), null);
    } finally {
      restore();
    }
  });

  test('a picker failure that is not a cancel propagates instead of being swallowed', async () => {
    const restore = stubPicker(() => Promise.reject(new TypeError('SecurityError-shaped failure')));
    try {
      await assert.rejects(() => pickLibraryFolder(), /SecurityError-shaped failure/);
    } finally {
      restore();
    }
  });

  test('no picker in the environment is null, and pickerBlock says why', async () => {
    assert.notEqual(pickerBlock(), '');
    assert.equal(await pickLibraryFolder(), null);
  });
});

/**
 * `queryPermission`/`requestPermission` are non-standard and not present in every implementation —
 * Electron's partial one is the case that bites, and VS Code is Electron. Their absence means there
 * is nothing to ask, not that the answer is no: treating it as a refusal killed a handle the player
 * had just picked, with the pick appearing to do nothing.
 */
describe('WAD library · a handle with no permission methods', () => {
  async function adopt(handle: Record<string, unknown>): Promise<boolean> {
    const g = globalThis as Record<string, unknown>;
    const before = g.showDirectoryPicker;
    g.showDirectoryPicker = function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(handle);
    };
    try {
      assert.ok(await pickLibraryFolder(), 'the picker should hand back the handle');
      return await ensureLibraryAccess();
    } finally {
      if (before === undefined) delete g.showDirectoryPicker;
      else g.showDirectoryPicker = before;
      await forgetLibrary();
    }
  }

  test('a handle exposing neither method is usable, not refused', async () => {
    assert.equal(await adopt({ name: 'wads', kind: 'directory' }), true);
  });

  test('a handle that does expose them is still asked', async () => {
    let asked = false;
    const granted = await adopt({
      name: 'wads',
      kind: 'directory',
      queryPermission: () => {
        asked = true;
        return Promise.resolve('granted');
      },
      requestPermission: () => Promise.resolve('denied'),
    });
    assert.equal(granted, true);
    assert.equal(asked, true, 'queryPermission should have been consulted');
  });

  test('a handle that answers "denied" to both is refused', async () => {
    const granted = await adopt({
      name: 'wads',
      kind: 'directory',
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: () => Promise.resolve('denied'),
    });
    assert.equal(granted, false);
  });
});

/**
 * The File System Access pickers run in a top-level document or a *same-origin* frame only; a
 * cross-origin one gets a `SecurityError`. So the method existing on `window` does not mean it can
 * be called, and `pickerBlock` has to say why — otherwise the overlay offers the picker, the
 * call throws, and the button reads as dead. The case that hits real users is VS Code's Simple
 * Browser, which frames the dev server inside a `vscode-webview://` page.
 */
describe('WAD library · framed in another origin', () => {
  function frame(top: unknown): () => void {
    const g = globalThis as Record<string, unknown>;
    const before = { self: g.self, top: g.top, location: g.location, picker: g.showDirectoryPicker };
    g.showDirectoryPicker = () => Promise.resolve({});
    g.self = { name: 'inner' };
    g.top = top;
    g.location = { origin: 'http://localhost:5173' };
    return () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete g[key === 'picker' ? 'showDirectoryPicker' : key];
        else g[key === 'picker' ? 'showDirectoryPicker' : key] = value;
      }
    };
  }

  test('a cross-origin framing page — reading its origin throws — means no picker', () => {
    const restore = frame({
      get location(): never {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.');
      },
    });
    try {
      assert.notEqual(pickerBlock(), '');
    } finally {
      restore();
    }
  });

  test('a framing page of a different origin means no picker', () => {
    const restore = frame({ location: { origin: 'vscode-webview://abc123' } });
    try {
      assert.notEqual(pickerBlock(), '');
    } finally {
      restore();
    }
  });

  test('a same-origin frame keeps the picker — only *cross*-origin is refused', () => {
    const restore = frame({ location: { origin: 'http://localhost:5173' } });
    try {
      assert.equal(pickerBlock(), '');
    } finally {
      restore();
    }
  });

  // The two reasons are told apart, not merged into one "no picker": a framed window is fixed by
  // opening the game in a tab, a browser without the API is not, and the overlay says which.
  test('being framed and having no API are separate answers', () => {
    assert.equal(pickerBlock(), 'unsupported');
    const restore = frame({ location: { origin: 'vscode-webview://abc123' } });
    try {
      assert.equal(pickerBlock(), 'framed');
    } finally {
      restore();
    }
  });
});

/** The real dialog rejects with a DOMException named AbortError; the name is all the code reads. */
function abortError(): Error {
  return Object.assign(new Error('the user dismissed the dialog'), { name: 'AbortError' });
}
