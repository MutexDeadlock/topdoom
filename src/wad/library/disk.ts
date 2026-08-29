/**
 * The player's own WAD folder: picking it, holding on to the permission, walking it for `.wad`
 * files, and turning what it holds into `WadSource`s the menu lists beside the server's own.
 * The scan reads a few hundred KB per file (`describe.ts`) and memoizes the answer by size and
 * mtime, so re-opening the library costs no reads at all.
 * See docs/wad.md § The player's own library.
 */
import type { WadSource } from '../library.ts';
import { bytesOfFile, describeWad } from '../describe.ts';
import {
  clearRoot,
  readDescriptors,
  readRootHandle,
  writeDescriptor,
  writeDescriptors,
  writeRootHandle,
  type LibraryDescriptor,
} from './store.ts';

/**
 * Depth and count caps on the walk. A player who points this at their home directory should get a
 * truncated list rather than a hung menu; nobody's WAD collection is 8 levels deep or 2000 files.
 */
const MAX_DEPTH = 8;
const MAX_FILES = 2000;

/**
 * How many files a scan reads at once. Every file costs a `getFile()` plus up to four short slice
 * reads (`describeWad`), all of them round trips this thread spends waiting on rather than working
 * — so one at a time leaves nearly all of the wait unused, and at the `MAX_FILES` cap that is the
 * one wait the player watches. Bounded rather than unbounded: past a dozen or so in flight it is
 * the disk that limits the scan, and 2000 open files at once is a way to be refused outright.
 */
const SCAN_WIDTH = 12;

/**
 * The File System Access bits `lib.dom` doesn't declare yet. Both are Chromium-only, which is the
 * whole reason `pickerBlock` exists — Firefox and Safari go through the `webkitdirectory`
 * fallback (`adoptFolderFiles`) and get no handle to remember.
 */
interface HandlePermissions {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/** What the library currently holds, and how its bytes are reached. */
interface LibraryState {
  /**
   * The remembered folder, on browsers that have one. Null on the fallback path and before any
   * pick.
   */
  handle: FileSystemDirectoryHandle | null;
  /** Session-only files, keyed by relative path — the fallback's answer to a handle. */
  files: Map<string, File>;
  descriptors: LibraryDescriptor[];
  /** The folder's own name, for the tree's root row. */
  name: string;
  /** What the last scan couldn't read, so a folder that yields nothing can say why. */
  skipped: LibrarySkip[];
}

/**
 * One file a scan walked past, and the reason — a WAD that won't parse, or one it couldn't open.
 */
export interface LibrarySkip {
  path: string;
  reason: string;
}

const state: LibraryState = { handle: null, files: new Map(), descriptors: [], name: '', skipped: [] };

/**
 * Why the File System Access picker can't be used here, or `''` when it can. Two separate reasons,
 * because they call for two different things from the player: `'unsupported'` is their browser and
 * nothing can change it, while `'framed'` is *this window* and opening the game in a tab of its own
 * fixes it. The overlay says which — an unexplained fallback is what made the embedded case read as
 * a broken button (docs/menu.md § WAD Library).
 *
 * `''` doubles as "this browser can remember the folder between visits": the persistence and the
 * picker are the same API, so they are one predicate rather than two names for it.
 */
export type PickerBlock = '' | 'unsupported' | 'framed';

export function pickerBlock(): PickerBlock {
  if (!('showDirectoryPicker' in globalThis)) return 'unsupported';
  return inCrossOriginFrame() ? 'framed' : '';
}

/**
 * Whether this document is framed by a page of another origin. The File System Access API refuses
 * to run there — the pickers are available to a top-level document or a *same-origin* frame only,
 * and a cross-origin one gets a `SecurityError` — so the method existing on `window` is not enough
 * to know it can be called.
 *
 * The case that hits real users is **VS Code's Simple Browser**, which loads the dev server into an
 * `<iframe>` inside a `vscode-webview://` page. Reading the framing page's origin is itself blocked
 * cross-origin, so the throw *is* the answer.
 */
function inCrossOriginFrame(): boolean {
  const win = globalThis as { self?: unknown; top?: { location: Location } | null; location?: Location };
  // Unframed, or no window at all (a test, a worker) — nothing to be blocked by.
  if (!win.top || win.self === win.top) return false;
  try {
    return win.top.location.origin !== win.location?.origin;
  } catch {
    return true;
  }
}

/** The folder's display name, or '' when none is set. */
export function libraryName(): string {
  return state.name;
}

/** Whether a folder is set at all, however it got here. */
export function libraryPicked(): boolean {
  return state.handle !== null || state.files.size > 0;
}

/**
 * Restores the remembered folder and its scan memo, without prompting for anything: `init` runs on
 * the boot path, where a permission dialog would be an ambush. The rows list from the memo alone;
 * `ensureLibraryAccess` is what a later user gesture pays for.
 *
 * Nothing is restored where there is no handle — a browser on the fallback path would list files
 * it has no way to read.
 */
export async function restoreLibrary(): Promise<void> {
  const handle = await readRootHandle();
  if (!handle) return;
  state.handle = handle;
  state.name = handle.name;
  state.descriptors = [...(await readDescriptors()).values()];
}

/** `state.handle` under the permission methods `lib.dom` doesn't declare. */
function permissionedHandle(): (FileSystemDirectoryHandle & HandlePermissions) | null {
  return state.handle;
}

/**
 * Whether the folder can already be read, asking for nothing — the half of the permission rule the
 * boot path can use, since it may not prompt. Absent `queryPermission` counts as usable, not as a
 * refusal (docs/wad.md § The player's own library).
 */
async function readPermissionStands(handle: FileSystemDirectoryHandle & HandlePermissions): Promise<boolean> {
  if (!handle.queryPermission) return true;
  return (await handle.queryPermission({ mode: 'read' })) === 'granted';
}

/**
 * Whether the folder can be read, prompting when the browser wants it. **Must be reached from a
 * user gesture** — Chromium refuses a permission request outside one, which is why
 * `Menu.startWithSkill` calls this before its first `await` (docs/menu.md § Session lifecycle).
 */
export async function ensureLibraryAccess(): Promise<boolean> {
  const handle = permissionedHandle();
  if (!handle) return state.files.size > 0;
  if (await readPermissionStands(handle)) return true;
  // A missing `requestPermission` is no refusal either, by the same rule — there is simply nothing
  // to ask with, and the handle came out of a picker the player just used.
  if (!handle.requestPermission) return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/**
 * Opens the folder picker and adopts what comes back, replacing any folder already set — including
 * its memo, since a different root's rows say nothing about this one. Null when the player
 * cancelled, which is not an error.
 */
export async function pickLibraryFolder(): Promise<FileSystemDirectoryHandle | null> {
  // Invoked *through* globalThis, never detached into a local first: a native window method is
  // brand-checked on its receiver, and calling a detached copy throws "Illegal invocation" before
  // any dialog opens. Detached, plus the AbortError catch below swallowing it, turns every folder
  // pick into a silent no-op.
  const g = globalThis as { showDirectoryPicker?: DirectoryPicker };
  if (!g.showDirectoryPicker) return null;

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await g.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    // `AbortError` is the dialog being dismissed — the player changed their mind, not a failure.
    // Anything else must propagate to somewhere visible (`LibraryUi.choose` reports it).
    if ((err as DOMException).name === 'AbortError') return null;
    throw err;
  }

  // Clear first, then store: a different root's memo says nothing about this one, and `clearRoot`
  // drops both stores.
  await clearRoot();
  await writeRootHandle(handle);
  state.handle = handle;
  state.files.clear();
  state.descriptors = [];
  state.skipped = [];
  state.name = handle.name;
  return handle;
}

/**
 * Which of a picked folder's files the library will actually take: a `.wad` by name, no deeper than
 * `MAX_DEPTH` below the folder, and no more than `MAX_FILES` of them. Exported because the overlay
 * has to say how many it is about to read *before* the scan starts, and a count taken by a second,
 * looser copy of this rule would promise files the scan then drops.
 */
export function acceptableWads(files: readonly File[]): File[] {
  return files
    .filter((f) => /\.wad$/i.test(f.name))
    .filter((f) => relativePath(f).split('/').length <= MAX_DEPTH)
    .slice(0, MAX_FILES);
}

/**
 * The `webkitdirectory` path, for the browsers with no picker: a flat `FileList` whose
 * `webkitRelativePath` carries the folder structure. Session-only — there is no handle to store,
 * so nothing is written to the memo and the folder must be picked again after a reload.
 */
export async function adoptFolderFiles(files: readonly File[], onProgress?: Progress): Promise<void> {
  const wads = acceptableWads(files);

  state.handle = null;
  state.files = new Map(wads.map((f) => [relativePath(f), f]));
  state.name = wads.length > 0 ? (wads[0].webkitRelativePath.split('/')[0] ?? 'Your library') : '';
  state.descriptors = await describeAll(
    wads.map((f) => ({ path: relativePath(f), open: () => Promise.resolve(f) })),
    new Map(),
    onProgress,
  );
}

/** How far a scan has got, so the overlay can say something while a big folder is read. */
export type Progress = (done: number, total: number) => void;

/**
 * Walks the remembered folder and re-describes whatever changed, then writes the memo back. The
 * caller must have `ensureLibraryAccess()`d first — this is reached from the overlay's own click.
 */
export async function rescanLibrary(onProgress?: Progress): Promise<void> {
  if (!state.handle) return;
  const started = performance.now();
  const found: Entry[] = [];
  await walk(state.handle, '', 0, found);

  const memo = new Map(state.descriptors.map((d) => [d.path, d]));
  const before = state.descriptors;
  state.descriptors = await describeAll(found, memo, onProgress);
  // A memo hit is reused by reference (`describeAll`), so identity alone says whether the scan
  // found anything new — and a folder nothing changed in costs no write at all.
  if (state.descriptors.length !== before.length || state.descriptors.some((d, i) => d !== before[i])) {
    await writeDescriptors(state.descriptors);
  }
  // Same shape as `game.ts`'s level-load line: what was scanned, then how long. The re-read count
  // is what makes the duration readable — a folder of memo hits and one of fresh files cost
  // different things for the same number of WADs.
  const reread = state.descriptors.filter((d) => memo.get(d.path) !== d).length;
  console.info(
    `library rescan: ${state.descriptors.length} WADs, ${reread} re-read, ` +
      `${state.skipped.length} skipped in ${Math.round(performance.now() - started)} ms`,
  );
}

/**
 * The boot path's rescan: the folder is walked again so a file added since the last visit is listed
 * without the player opening the overlay, but only where the read permission already stands — boot
 * prompts for nothing. See docs/wad.md § The player's own library.
 */
export async function rescanIfPermitted(): Promise<void> {
  const handle = permissionedHandle();
  if (!handle || !(await readPermissionStands(handle))) return;
  await rescanLibrary();
}

/** Forgets the folder entirely, memo included. */
export async function forgetLibrary(): Promise<void> {
  await clearRoot();
  state.handle = null;
  state.files.clear();
  state.descriptors = [];
  state.skipped = [];
  state.name = '';
}

/**
 * Everything the library holds, as sources the menu lists exactly like a server file's. `id` is
 * empty until `rememberLibraryId` fills it: the scan deliberately never hashed these files
 * (docs/wad.md § The player's own library).
 */
export function librarySources(): WadSource[] {
  return state.descriptors.map((descriptor) => {
    let cached: Promise<ArrayBuffer> | null = null;
    const cut = descriptor.path.lastIndexOf('/');
    return {
      key: `lib:${descriptor.path}`,
      id: descriptor.id ?? '',
      label: descriptor.path.slice(cut + 1),
      type: descriptor.type,
      maps: descriptor.maps,
      lumpCount: descriptor.lumpCount,
      dehacked: descriptor.dehacked,
      support: descriptor.support,
      levelNames: descriptor.levelNames,
      size: descriptor.size,
      origin: 'library' as const,
      folder: cut < 0 ? '' : descriptor.path.slice(0, cut),
      bytes() {
        cached ??= openLibraryFile(descriptor.path).then((file) => file.arrayBuffer());
        return cached;
      },
    };
  });
}

/**
 * What the last scan walked past and why — the overlay reports this when a folder yields little.
 */
export function librarySkips(): readonly LibrarySkip[] {
  return state.skipped;
}

/**
 * Persists a library file's content ID once something has computed it, so it is hashed once ever
 * rather than once per session. A no-op for any other kind of source.
 */
export async function rememberLibraryId(source: WadSource): Promise<void> {
  if (source.origin !== 'library' || !source.id) return;
  const descriptor = state.descriptors.find((d) => d.path === source.key.slice('lib:'.length));
  if (!descriptor) return;
  descriptor.id = source.id;
  // Only the handle path has a memo; the fallback's rows are session-only.
  if (state.handle) await writeDescriptor(descriptor);
}

/** One file the walk found, named by its path relative to the library root. */
interface Entry {
  path: string;
  open(): Promise<File>;
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  out: Entry[],
): Promise<void> {
  if (depth >= MAX_DEPTH || out.length >= MAX_FILES) return;

  const entries: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = [];
  try {
    for await (const entry of dir.entries()) entries.push(entry);
  } catch {
    // An unreadable subfolder costs its own contents, not the whole scan.
    return;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));

  for (const [name, handle] of entries) {
    if (out.length >= MAX_FILES) return;
    if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`, depth + 1, out);
    else if (/\.wad$/i.test(name)) out.push({ path: prefix + name, open: () => handle.getFile() });
  }
}

/**
 * Describes each entry, reusing the memo for any file whose size and mtime are unchanged.
 *
 * A file that won't open or won't parse is dropped from the list rather than failing the scan — one
 * junk `.wad` must not cost the folder — but the reason is **kept** in `state.skipped`. A scan that
 * silently discarded every file was indistinguishable from an empty folder, which is precisely the
 * shape of failure the player can do nothing with.
 */
async function describeAll(
  entries: readonly Entry[],
  memo: ReadonlyMap<string, LibraryDescriptor>,
  onProgress?: Progress,
): Promise<LibraryDescriptor[]> {
  // Results are written by index, not pushed: the walk sorted `entries`, and the tree shows them in
  // that order, which a pool finishing out of order would otherwise scramble.
  const out: (LibraryDescriptor | null)[] = new Array(entries.length).fill(null);
  const skips: (LibrarySkip | null)[] = new Array(entries.length).fill(null);
  state.skipped = [];

  let next = 0;
  let done = 0;
  onProgress?.(0, entries.length);
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const index = next++;
      const entry = entries[index];
      try {
        const file = await entry.open();
        const hit = memo.get(entry.path);
        // `hit.support` too: a row predating the support column is re-read rather than listed with
        // no verdict (docs/wad.md § Will it run?).
        if (hit && hit.size === file.size && hit.lastModified === file.lastModified && hit.support) {
          out[index] = hit;
        } else {
          const described = await describeWad(entry.path.split('/').pop()!, bytesOfFile(file));
          out[index] = { path: entry.path, size: file.size, lastModified: file.lastModified, ...described };
        }
      } catch (err) {
        skips[index] = { path: entry.path, reason: (err as Error).message || String(err) };
      }
      onProgress?.(++done, entries.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_WIDTH, entries.length) }, worker));

  state.skipped = skips.filter((skip) => skip !== null);
  return out.filter((descriptor) => descriptor !== null);
}

/** Resolves a path back to its bytes, whichever way the folder got here. */
async function openLibraryFile(path: string): Promise<File> {
  const session = state.files.get(path);
  if (session) return session;

  if (!state.handle) throw new Error(`${path}: the WAD library folder is no longer open`);
  if (!(await ensureLibraryAccess())) {
    throw new Error(`${path}: permission to read the WAD library folder was refused`);
  }

  const segments = path.split('/');
  let dir = state.handle;
  for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
  return (await dir.getFileHandle(segments[segments.length - 1])).getFile();
}

/**
 * A `webkitdirectory` file's path below the picked folder — its own name when the browser gives
 * none.
 */
function relativePath(file: File): string {
  const full = file.webkitRelativePath;
  if (!full) return file.name;
  // The first segment is the picked folder itself, which is the tree's root row, not part of the
  // path.
  return full.split('/').slice(1).join('/') || file.name;
}
