/**
 * The WAD Library overlay: a folder tree over everything the menu can offer — the WADs the server
 * ships, a folder the player nominates from their own disk, and anything dropped on the menu — with
 * the picking done in place. The picks are **staged**: ticking a row edits a draft, `Apply` hands
 * the whole set to the menu and `Close` discards it. Owned by `Menu`, which it reaches only through
 * `LibraryHooks`. See docs/menu.md § WAD Library.
 */
import {
  acceptableWads,
  adoptFolderFiles,
  ensureLibraryAccess,
  fitsGameWad,
  forgetLibrary,
  libraryName,
  libraryPicked,
  librarySkips,
  librarySources,
  mapStyle,
  pickerBlock,
  pickLibraryFolder,
  pwadsFor,
  rescanLibrary,
  servedFolder,
  type LibrarySkip,
  type WadSource,
} from '../../wad/library.ts';
import { nothingLoads } from '../../wad/support.ts';
import { confirmOnHold } from './hold.ts';
import { sourceColumnSpans } from './labels.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** What the overlay needs from the menu underneath it. */
export interface LibraryHooks {
  /** Every source the menu knows, in its own order. */
  sources(): readonly WadSource[];
  /** The game WAD, or null when none is picked. */
  iwad(): WadSource | null;
  /** The add-ons, in merge order. */
  pwads(): readonly WadSource[];
  /**
   * Hands the menu the whole pick at once — the overlay stages its ticks and commits them here,
   * on Apply and nowhere else. One call rather than one per row, because a set is what the menu
   * resolves against: the game WAD decides which add-ons may stay, so half a set applied is a
   * prune the player never asked for.
   */
  applyPicks(iwad: WadSource | null, pwads: readonly WadSource[]): void | Promise<void>;
  /** Hands the menu the library's current contents, replacing whatever it held before. */
  setLibrarySources(sources: WadSource[]): void;
  /**
   * Opens the plain multi-file picker, for loose WADs that sit in no library folder. What it reads
   * comes back through `stage`, not from here: the menu routes files added while the overlay is up
   * into the draft rather than adopting them behind it.
   */
  pickFiles(): void;
}

/**
 * One row of the left-hand tree. The two counts are deliberately different things:
 *
 * - **`sources` is the folder's own WADs**, and only those — what the file pane lists when the row
 *   is picked, the way a file manager behaves.
 * - **`total` is every WAD at or below it**, which is what the row's count shows and what decides
 *   whether the row is worth drawing at all. A folder holding nothing but subfolders has no
 *   `sources` of its own, and dropping it on that basis would orphan the rows nested under it.
 */
export interface FolderNode {
  id: string;
  label: string;
  depth: number;
  sources: WadSource[];
  total: number;
  /** The row this one nests under, which is what collapsing walks. Absent for a top-level group. */
  parent?: string;
}

/**
 * The lookups every walk over the tree needs, built once per render and threaded down. Rebuilding
 * either inside the walk that wants it — a `byId` per row in `hiddenByCollapse`, a `nodes.some` per
 * row in `folderRow` — makes one render quadratic in the row count, on every keystroke in the
 * filter box.
 */
interface TreeIndex {
  byId: Map<string, FolderNode>;
  /** Ids with at least one child row, so a folder knows whether it is foldable at all. */
  parents: Set<string>;
}

function indexTree(nodes: readonly FolderNode[]): TreeIndex {
  const byId = new Map<string, FolderNode>();
  const parents = new Set<string>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.parent !== undefined) parents.add(node.parent);
  }
  return { byId, parents };
}

/**
 * The chain of rows from `id` upwards, nearest first. Walked by `parent`, never by id prefix:
 * `library:mega` is a prefix of `library:megawads` without being its parent, so a prefix test would
 * take a sibling for an ancestor.
 */
function* ancestors(tree: TreeIndex, id: string | undefined): Generator<string> {
  for (let at = id; at !== undefined; at = tree.byId.get(at)?.parent) yield at;
}

/** The top-level groups, in the order they are shown. */
const SERVER_IWADS = 'server:iwad';
const SERVER_PWADS = 'server:pwad';
const LIBRARY_ROOT = 'library';
const UPLOADS = 'uploads';

/**
 * How long the fallback `<input webkitdirectory>` is given to answer before the overlay says it
 * hasn't. Generous, because it is racing a human browsing their disk, not a machine: too short and
 * it cries wolf over a player taking their time in the dialog.
 */
const PICKER_TIMEOUT = 30_000;

/** Every row that is a root of its own subtree — the ones that start unfolded. */
const TOP_LEVEL_FOLDERS = [SERVER_IWADS, SERVER_PWADS, LIBRARY_ROOT, UPLOADS];

/**
 * The tree, flattened to rows carrying their own depth: the server's two folders and whatever
 * subfolders they hold, the player's library the same way, and anything dropped on the menu.
 *
 * There is no `topdoom` row above the served pair, and no `Your library` row above the player's
 * folders: which panel a row sits in already says that, and the panel headings carry the totals.
 *
 * **A folder with no WAD beneath it is not a row.** An empty `Game WADs` is nothing the player can
 * act on, and neither is a library root with no folder behind it — the `Your Library` heading and
 * the `Choose folder…` button under it are already the whole invitation, and a row saying the same
 * thing a third time is one more place to click that does nothing. Once a folder *is* set the root
 * stays even while it is empty, because then it is reporting something: that folder held no WADs.
 *
 * Pure, and separate from `LibraryUi` so it can be tested without a DOM — docs/menu.md § WAD Library.
 */
export function buildFolderTree(
  sources: readonly WadSource[],
  libraryLabel: string,
  libraryPicked: boolean,
): FolderNode[] {
  const server = sources.filter((s) => s.origin === 'server');
  const uploads = sources.filter((s) => s.origin === 'upload');
  const library = sources.filter((s) => s.origin === 'library');
  // How a served path splits into root and subfolder is `wad/library.ts`'s to know, not the menu's.
  const under = (s: WadSource) => servedFolder(s).under;
  const iwads = server.filter((s) => servedFolder(s).root === 'iwad');
  const pwads = server.filter((s) => servedFolder(s).root !== 'iwad');

  const nodes: FolderNode[] = [
    ...rootedSubtree(SERVER_IWADS, 'Game WADs', iwads, under),
    ...rootedSubtree(SERVER_PWADS, 'Add-ons', pwads, under),
    ...rootedSubtree(LIBRARY_ROOT, libraryLabel, library, (s) => s.folder ?? ''),
  ];

  if (uploads.length > 0) nodes.push(folder(UPLOADS, 'Dropped on the menu', 0, uploads));
  return nodes.filter((n) => n.total > 0 || (n.id === LIBRARY_ROOT && libraryPicked));
}

/**
 * One root row plus a row for every folder beneath it. Shared by the two served folders and the
 * player's library, which differ only in where their paths are rooted — so subfolders behave
 * identically in `public/wads/pwad/` and in the folder the player nominated.
 *
 * Ancestors are synthesized: a file whose path is `mega/scythe` names only that, and without a
 * `mega` row its own would be indented under a parent that isn't there and would have nothing to
 * fold into.
 */
function rootedSubtree(
  rootId: string,
  rootLabel: string,
  sources: readonly WadSource[],
  pathOf: (source: WadSource) => string,
): FolderNode[] {
  // One pass files each source under its own path and counts it against every folder above it, so
  // neither the folder's own list nor its subtree total costs a scan of `sources` per folder.
  const own = new Map<string, WadSource[]>();
  const beneath = new Map<string, number>();
  const paths = new Set<string>();
  for (const source of sources) {
    const path = pathOf(source);
    const here = own.get(path);
    if (here) here.push(source);
    else own.set(path, [source]);

    const segments = path ? path.split('/') : [];
    for (let i = 1; i <= segments.length; i++) {
      const above = segments.slice(0, i).join('/');
      paths.add(above);
      beneath.set(above, (beneath.get(above) ?? 0) + 1);
    }
  }
  const at = (path: string) => own.get(path) ?? [];

  const out: FolderNode[] = [folder(rootId, rootLabel, 0, at(''), sources.length)];

  // Siblings sorted A-Z by their own name, then emitted depth-first so a parent always precedes its
  // children. Deliberately *not* one flat sort of the full paths: that would have to get both the
  // alphabetical order and the parent-first grouping out of the same comparison, and how a collation
  // ranks `/` against letters decides whether `a/b` lands under `a` or after `aa`. Sorting one level
  // at a time needs no such guarantee.
  const byParent = new Map<string, string[]>();
  for (const path of paths) {
    const cut = path.lastIndexOf('/');
    const parent = cut < 0 ? '' : path.slice(0, cut);
    byParent.set(parent, [...(byParent.get(parent) ?? []), path]);
  }
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const emit = (parentPath: string): void => {
    const children = [...(byParent.get(parentPath) ?? [])].sort((a, b) =>
      nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true }),
    );
    for (const path of children) {
      const segments = path.split('/');
      out.push({
        ...folder(`${rootId}/${path}`, nameOf(path), segments.length, at(path), beneath.get(path) ?? 0),
        parent: segments.length === 1 ? rootId : `${rootId}/${segments.slice(0, -1).join('/')}`,
      });
      emit(path);
    }
  };
  emit('');
  return out;
}

/** Which rows a filter leaves on screen, and which of them it opens wholesale. */
export interface FilterMatch {
  /** Every row still drawn — a match, an ancestor of one, or a row a matching folder contains. */
  rows: Set<string>;
  /**
   * Rows matched **by folder name** (their own or an ancestor's), whose files are therefore all
   * shown rather than only the ones matching. Asking for a folder by name is asking for what's in
   * it; filtering its contents down again would answer a question nobody asked.
   */
  whole: Set<string>;
  /**
   * The rows the filter actually *found*, as opposed to the ones on screen for another reason. Only
   * these are worth aiming the file pane at: the game WADs are exempt from filtering (below), so
   * without this distinction every search would land on them rather than on what it found.
   */
  hits: Set<string>;
}

/**
 * Applies the header's filter to the tree. A row survives if its own name matches, if a folder
 * above it matched, or if it holds a matching WAD at or below it — so searching for a file still
 * shows the folders it lives in, and searching for a folder shows the folder.
 *
 * **The game WADs are exempt**, and stay listed in full whatever the filter says. Finding an add-on
 * and seeing that it wants the other game is a normal outcome of a search, and having to clear the
 * filter to go and switch game WAD — then type it again — turns one decision into three.
 *
 * Pure, and separate from `LibraryUi` so it can be tested without a DOM — docs/menu.md § WAD Library.
 */
export function filterTree(nodes: readonly FolderNode[], filter: string): FilterMatch {
  const rows = new Set<string>();
  const whole = new Set<string>();
  if (!filter) {
    for (const node of nodes) {
      rows.add(node.id);
      whole.add(node.id);
    }
    return { rows, whole, hits: new Set(rows) };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hits = (text: string) => text.toLowerCase().includes(filter);

  // Parent-first, so a matched folder hands `whole` down to everything nested inside it.
  for (const node of nodes) {
    if (hits(node.label) || (node.parent !== undefined && whole.has(node.parent))) whole.add(node.id);
  }
  // Backwards for the opposite reason: a surviving row pulls its ancestors on screen with it, and
  // walking from the leaves means those ancestors are reached before they are themselves tested.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const kept = rows.has(node.id) || whole.has(node.id) || node.sources.some((s) => hits(s.label));
    if (!kept) continue;
    rows.add(node.id);
    for (let at = node.parent; at !== undefined; at = byId.get(at)?.parent) rows.add(at);
  }

  // Snapshotted before the exemption goes in, so `hits` stays what the filter itself found.
  const found = new Set(rows);
  // The game WADs and anything nested under them, on screen and listed entire whatever was typed.
  // Parent-first again, so one pass carries the exemption down the subtree.
  const exempt = new Set<string>();
  for (const node of nodes) {
    if (node.id !== SERVER_IWADS && !(node.parent !== undefined && exempt.has(node.parent))) continue;
    exempt.add(node.id);
    rows.add(node.id);
    whole.add(node.id);
  }
  return { rows, whole, hits: found };
}

export class LibraryUi {
  private root = el<HTMLDivElement>('wadlibrary');
  private servedEl = el<HTMLDivElement>('wadlibrary-served');
  private servedHeader = el<HTMLHeadingElement>('wadlibrary-served-header');
  private libraryHeader = el<HTMLHeadingElement>('wadlibrary-library-header');
  private treeEl = el<HTMLDivElement>('wadlibrary-tree');
  private controlsEl = el<HTMLDivElement>('wadlibrary-controls');
  private filesEl = el<HTMLDivElement>('wadlibrary-files');
  private filterInput = el<HTMLInputElement>('wadlibrary-filter');
  private summaryEl = el<HTMLSpanElement>('wadlibrary-summary');
  private statusEl = el<HTMLSpanElement>('wadlibrary-status');
  private folderInput = el<HTMLInputElement>('folder-input');

  private hooks: LibraryHooks;
  /**
   * Which tree row is showing its files. Survives a re-render; falls back to the first row that has
   * files of its own — it must not start on a *container* row, one owning no WADs directly, or the
   * overlay would open on an empty pane.
   *
   * It opens on the served **add-ons**, not on the game WADs: a game WAD is already picked by the
   * time anyone opens this — the select on the New Game tab carries it — so add-ons are what the
   * overlay is being opened to browse.
   */
  private selectedFolder = SERVER_PWADS;
  private filter = '';
  /**
   * The pick being assembled, **not the menu's**. Every tick in here edits this pair and nothing
   * else; `Apply` hands it to the menu and `Close` throws it away, so browsing a library — trying a
   * game WAD on to see which add-ons it allows, ticking half a set and thinking better of it —
   * costs the player nothing. Snapshotted from the menu on every `open`, so the overlay always
   * starts from what is actually selected.
   */
  private draftIwad: WadSource | null = null;
  private draftPwads: WadSource[] = [];
  /**
   * Folder rows whose children are shown. Tracked as *expanded* rather than collapsed so the
   * default is a property of this set alone: a collapsed-id set could not express "folded by
   * default", since a folder the player has never touched is absent from it and would read as open.
   *
   * Seeded with every top-level row, which start open — folding those would leave the overlay
   * showing a handful of bare headings and nothing to act on. Everything below them starts folded.
   */
  private expanded = new Set<string>(TOP_LEVEL_FOLDERS);
  /** True while a scan is running, so a second click can't start an overlapping walk. */
  private scanning = false;
  /** The `PICKER_TIMEOUT` watchdog on an open fallback dialog; 0 when none is pending. */
  private pickTimer = 0;

  constructor(hooks: LibraryHooks) {
    this.hooks = hooks;

    el<HTMLButtonElement>('wadlibrary-close').addEventListener('click', () => this.close());
    el<HTMLButtonElement>('wadlibrary-done').addEventListener('click', () => void this.apply());
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      // A filter re-aims the file pane: the row that was selected is often still on screen as a
      // *route* to a match rather than as a match — the parent of the folder that hit — and leaving
      // it selected answers a search with an empty pane. Clearing the filter leaves the selection
      // alone, since by then it is wherever the player last looked.
      if (this.filter) this.selectedFolder = '';
      this.render();
    });
    this.folderInput.addEventListener('change', () => void this.onFolderChosen());
    this.folderInput.addEventListener('cancel', () => this.onFolderCancelled());
  }

  open(): void {
    this.root.classList.remove('hidden');
    this.filterInput.value = '';
    this.filter = '';
    this.draftIwad = this.hooks.iwad();
    this.draftPwads = [...this.hooks.pwads()];
    this.render();
    this.filterInput.focus();
  }

  /**
   * Commits the draft and closes. The one path out that changes anything the menu holds — `close`
   * is a discard, whether it came from the button, the backdrop or Esc.
   *
   * Closed *first*: applying redraws the menu, which redraws this overlay, and a set whose files
   * still need hashing leaves the panel up and frozen for the length of a disk read.
   */
  private async apply(): Promise<void> {
    this.close();
    await this.hooks.applyPicks(this.draftIwad, this.draftPwads);
  }

  /**
   * Closes the overlay **without applying anything**, reporting whether it *was* open — `main.ts`'s
   * Esc handler asks this first, so one Esc dismisses the overlay and leaves the menu (and a paused
   * level) alone. The same explicit hand-off `closeChangelog` gets, rather than two listeners
   * racing over one key.
   */
  close(): boolean {
    if (this.root.classList.contains('hidden')) return false;
    this.root.classList.add('hidden');
    return true;
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /**
   * Redraws if it's up. `Menu.render` calls this, so a source list that moved under the overlay —
   * an upload, a scan — is on screen at once, and it is the one place the draft is re-bound to
   * those sources. What the draft *means* is never touched here: only `open` fills it from the
   * menu, and only `Apply` sends it back.
   */
  refresh(): void {
    if (!this.isOpen) return;
    this.carryDraft();
    this.render();
  }

  /**
   * Ticks freshly added sources into the draft. `Menu.addFiles` routes here while the overlay is up
   * — whether they came from `Add single WADs…` or were dropped on the panel — so a file added from
   * in here is a pick like any other, and still only a pick until Apply.
   */
  stage(sources: readonly WadSource[]): void {
    if (!this.isOpen) return;
    for (const source of sources) this.draftTake(source);
    this.render();
  }

  /**
   * The overlay's footer line, and **the only place anything raised while the overlay is up is
   * reported**. The overlay covers `#menu` completely, so a message sent to `#menu-status` from
   * behind it is reported to a line nobody can see — and one that outlives the overlay turns up on
   * the New Game tab out of context, talking about buttons that tab doesn't have.
   *
   * Public because it works the other way too: `Menu.setStatus` routes here while `isOpen`, so the
   * menu's own messages — what `Add single WADs…` just loaded, and anything else the overlay set in
   * motion — land in front of the player rather than behind them.
   */
  showStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    // The line is clamped to two (library.css), so the full text has to stay reachable somewhere —
    // a message long enough to be clipped is a message that was explaining something.
    this.statusEl.title = text;
    this.statusEl.classList.toggle('error', isError);
  }

  private render(): void {
    const nodes = buildFolderTree(this.hooks.sources(), libraryName() || 'Your library', libraryPicked());
    const tree = indexTree(nodes);
    const match = filterTree(nodes, this.filter);
    // A filter overrides the fold state: a row it kept but a collapsed parent hides would be a
    // match the player is told about and cannot see. Clearing the filter restores the folds intact,
    // which is why this reads `expanded` rather than writing it.
    const visible = nodes.filter((n) => match.rows.has(n.id));
    const shown = this.filter ? visible : visible.filter((n) => !this.hiddenByCollapse(n, tree));
    const picked = this.foldersHoldingPicks(nodes, tree);
    if (!shown.some((n) => n.id === this.selectedFolder)) {
      const holds = (n: FolderNode) => this.visibleSources(n, match.whole.has(n.id)).length > 0;
      const found = shown.find((n) => match.hits.has(n.id) && holds(n));
      this.selectedFolder = (found ?? shown.find(holds) ?? shown[0])?.id ?? SERVER_PWADS;
    }
    this.renderTree(nodes, shown, picked, tree);
    // Looked up among the rows the filter kept, not among all of them: with nothing matching, the
    // fallback id above can name a row that is no longer on screen, and listing its contents would
    // answer a search that found nothing with a pane full of files.
    const selected = visible.find((n) => n.id === this.selectedFolder);
    this.renderFiles(selected, selected !== undefined && match.whole.has(selected.id));
    this.renderSummary();
  }

  /**
   * Which folder rows hold a picked WAD — the folder itself and **every folder above it**, so a
   * folded parent still shows that something inside it is in the set.
   */
  private foldersHoldingPicks(nodes: readonly FolderNode[], tree: TreeIndex): Set<string> {
    const chosen = new Set<WadSource>(this.draftPwads);
    if (this.draftIwad) chosen.add(this.draftIwad);

    const marked = new Set<string>();
    for (const node of nodes) {
      if (!node.sources.some((s) => chosen.has(s))) continue;
      for (const at of ancestors(tree, node.id)) marked.add(at);
    }
    return marked;
  }

  /**
   * Whether any folder above this one is folded — every ancestor has to be expanded for a row to
   * show.
   */
  private hiddenByCollapse(node: FolderNode, tree: TreeIndex): boolean {
    for (const at of ancestors(tree, node.parent)) {
      if (!this.expanded.has(at)) return true;
    }
    return false;
  }

  /**
   * Folds or unfolds one folder. Folding one the selection sits under moves the selection up to it
   * rather than leaving a row selected that can no longer be seen — and costs nothing, since a
   * folder already lists every WAD beneath it.
   */
  private toggleCollapsed(node: FolderNode, tree: TreeIndex): void {
    if (this.expanded.delete(node.id)) {
      for (const at of ancestors(tree, tree.byId.get(this.selectedFolder)?.parent)) {
        if (at === node.id) {
          this.selectedFolder = node.id;
          break;
        }
      }
    } else {
      this.expanded.add(node.id);
    }
    this.render();
  }

  /**
   * The sidebar, as three boxes rather than one scroller: what the server ships is a fixed three
   * rows, the buttons under it must stay put, and only the player's own folders can grow without
   * bound — so only that middle box scrolls, and the overlay keeps one height whatever a library
   * holds. `Dropped on the menu` rides with the server's rows: like them, it is a place the player
   * never chose and never needs to scroll past their own folders to reach.
   */
  private renderTree(
    nodes: readonly FolderNode[],
    shown: readonly FolderNode[],
    picked: ReadonlySet<string>,
    tree: TreeIndex,
  ): void {
    // Exact match or a real path segment below it — a bare `startsWith` would also claim a future
    // top-level row whose id merely began with the same letters.
    const isLibrary = (node: FolderNode) => node.id === LIBRARY_ROOT || node.id.startsWith(`${LIBRARY_ROOT}/`);
    const row = (node: FolderNode) => this.folderRow(node, tree, picked.has(node.id));
    this.servedEl.replaceChildren(...shown.filter((n) => !isLibrary(n)).map(row));

    const scrollTop = this.treeEl.scrollTop;
    this.treeEl.replaceChildren(...shown.filter(isLibrary).map(row));
    this.treeEl.scrollTop = scrollTop;

    // Each heading counts everything in its panel, so no row inside it has to carry a total.
    const total = (from: (n: FolderNode) => boolean) =>
      nodes.filter((n) => from(n) && n.parent === undefined).reduce((sum, n) => sum + n.total, 0);
    header(this.servedHeader, 'topdoom built-in', total((n) => !isLibrary(n)));
    header(this.libraryHeader, 'Your Library', total(isLibrary));

    this.controlsEl.replaceChildren(...this.folderControls());
  }

  private folderRow(node: FolderNode, tree: TreeIndex, picked: boolean): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'folder' + (node.id === this.selectedFolder ? ' active' : '') + (picked ? ' picked' : '');
    row.style.paddingLeft = `${8 + node.depth * 12}px`;

    // A `<span>` rather than a nested button — a button inside a button is invalid markup, and the
    // row itself has to stay one focusable control. The click is stopped from reaching the row, so
    // the icon only ever folds and the label only ever selects.
    //
    // U+1F4C2 / U+1F4C1 (open and closed file folder) each with the text-presentation selector
    // U+FE0E, the same request `savegames.ts` makes of its wastebasket: render as a glyph in the
    // menu's own colour rather than as a colour emoji. One glyph carries both jobs a tree needs —
    // "this is a folder" and "it is open" — where a separate disclosure triangle would have cost a
    // second column in a sidebar this narrow.
    const collapsible = tree.parents.has(node.id);
    // While a filter is up every kept row is shown, so the icon has to say open or it would claim
    // to be hiding children that are right there underneath it.
    const folded = !this.expanded.has(node.id) && !this.filter;
    const icon = document.createElement('span');
    icon.className = collapsible ? 'icon' : 'icon leaf';
    icon.textContent = collapsible && !folded ? '📂︎' : '📁︎';
    if (collapsible) {
      icon.title = folded ? `Expand ${node.label}` : `Collapse ${node.label}`;
      icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleCollapsed(node, tree);
      });
    }

    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = node.label;

    const count = document.createElement('span');
    count.className = 'meta';
    // The folder's *own* WADs — what selecting it lists. `total` decides whether the row exists
    // at all (a container folder holds none of its own), but is not what the number means.
    count.textContent = node.sources.length > 0 ? String(node.sources.length) : '';

    row.append(icon, label, count);
    row.addEventListener('click', () => {
      this.selectedFolder = node.id;
      this.render();
    });
    return row;
  }

  /** The folder buttons under the tree, plus the note about what this browser can remember. */
  private folderControls(): HTMLElement[] {
    const box: HTMLElement[] = [];

    // Everything that acts on the folder itself in one row — picking it, re-reading it, dropping it.
    const folderRow = document.createElement('div');
    folderRow.className = 'folder-buttons';
    // With no folder set this is the only thing in the panel that does anything, and the panel above
    // it is empty — so it carries the primary weight until it has been used, and drops back to a
    // ghost like its neighbours once there is a folder to change.
    const pick = this.controlButton(libraryPicked() ? 'Change…' : 'Choose folder…', () => void this.choose());
    if (!libraryPicked()) pick.classList.add('primary');
    folderRow.append(pick);
    if (libraryPicked()) {
      folderRow.append(this.controlButton('Rescan', () => void this.rescan()));
      folderRow.append(this.forgetButton());
    }
    box.push(folderRow);

    box.push(this.controlButton('Add single WADs…', () => this.hooks.pickFiles()));

    // Only the *warning* is worth a line. A browser that does remember the folder needs no note:
    // it is what the player already expects, and saying so is one more thing to read every visit.
    // The two reasons it can't get different notes: one is the browser and nothing helps, the other
    // is this window and says what to do about it.
    const block = pickerBlock();
    if (block !== '') {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent =
        block === 'framed'
          ? "This page is running inside another window, where the browser won't open its folder picker. Folders picked here last for this session only — open the game in its own browser tab to have one remembered."
          : "This browser can't remember a folder — you'll need to pick it again after a reload.";
      box.push(note);
    }
    return box;
  }

  /**
   * Forget, as a press-and-hold — the one button here that destroys something, and the same confirm
   * the save list's Delete and Overwrite carry (`hold.ts`). No click handler at all: the hold is the
   * only way in, so a stray click on a button sitting between Change and Rescan costs nothing.
   */
  private forgetButton(): HTMLButtonElement {
    const button = this.controlButton('Forget');
    button.title = 'Hold to forget your WAD folder';
    confirmOnHold(button, 'Hold Forget to drop your WAD folder.', (text) => this.showStatus(text), () =>
      void this.forget(),
    );
    return button;
  }

  private controlButton(label: string, onClick?: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = label;
    button.disabled = this.scanning;
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  private renderFiles(node: FolderNode | undefined, wholeFolder: boolean): void {
    const scrollTop = this.filesEl.scrollTop;
    this.filesEl.replaceChildren();

    // No row survived the filter, so there is no folder to be inside — a blank pane under a blank
    // tree is the overlay looking broken rather than looking empty.
    if (!node) {
      this.filesEl.append(empty(this.filter ? 'Nothing matches that filter.' : 'No folder selected.'));
      return;
    }
    const shown = this.visibleSources(node, wholeFolder);
    if (shown.length === 0) {
      this.filesEl.append(empty(this.filter ? 'Nothing here matches the filter.' : 'No WADs in this folder.'));
      return;
    }

    const iwad = this.draftIwad;
    const pwads = this.draftPwads;

    for (const source of shown) {
      // A game WAD is a choice of one, an add-on is a stack — so the control says which it is.
      this.filesEl.append(
        source.type === 'IWAD'
          ? this.iwadRow(source, source === iwad)
          : this.pwadRow(source, pwads.indexOf(source), iwad, source === iwad),
      );
    }
    this.filesEl.scrollTop = scrollTop;
  }

  /**
   * What one folder's file pane shows under the current filter. `wholeFolder` is the filter having
   * matched the folder's *name*: it was asked for by name, so it lists entire rather than having
   * its contents filtered down a second time.
   */
  private visibleSources(node: FolderNode, wholeFolder: boolean): WadSource[] {
    return node.sources.filter((s) => wholeFolder || s.label.toLowerCase().includes(this.filter));
  }

  private iwadRow(source: WadSource, chosen: boolean): HTMLLabelElement {
    const dead = unplayable(source);
    const mark = dead ? badge(REFUSED, 'reason') : badge('game WAD', chosen ? '' : 'quiet');
    const row = this.baseRow(source, chosen, mark, dead);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'wadlibrary-iwad';
    input.checked = chosen;
    input.disabled = dead;
    input.addEventListener('change', () => this.draftIwadPick(source));
    row.prepend(input);
    return row;
  }

  private pwadRow(
    source: WadSource,
    index: number,
    iwad: WadSource | null,
    isGameWad: boolean,
  ): HTMLLabelElement {
    // The rule itself is `wad/library.ts`'s, shared with the prune that runs when a game WAD is
    // picked — so a row this pane offers is one the menu will still be holding afterwards.
    const incompatible = !fitsGameWad(iwad, source);
    const dead = unplayable(source);
    // One rule behind both the greying-out and the input: a row that looks pickable and isn't
    // would be the failure mode of letting these two drift.
    const refused = incompatible || isGameWad || dead;

    // No merge-order number here: the order is a property of the *set* being assembled, which the
    // New Game tab's add-on list owns and shows. Repeating it against a browser row would number
    // files by something the browser has no say over.
    //
    // `dead` outranks `incompatible`: which game WAD is picked is a decision the player can revisit
    // from this very pane, and a file that will not load is not.
    const mark = dead
      ? badge(REFUSED, 'reason')
      : isGameWad
        ? badge('game WAD')
        : incompatible
          ? badge(mapStyle(source) === 'doom1' ? 'DOOM 1 maps' : 'DOOM II maps', 'reason')
          : badge('');
    const row = this.baseRow(source, index >= 0, mark, refused);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = index >= 0;
    input.disabled = refused;
    input.addEventListener('change', () => this.draftPwadToggle(source));
    row.prepend(input);
    return row;
  }

   /**
   * Name, badge, detail. The badge leads the fixed-width block because what it carries is the
   * *reason a row can't be picked*, which has to be read before the file's stats rather than after
   * them — and it is **always present even when it says nothing**, or the columns behind it would
   * slide to a different place on every row, which is the whole point of their being columns.
   */
  private baseRow(
    source: WadSource,
    selected: boolean,
    mark: HTMLSpanElement,
    disabled = false,
  ): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'row' + (selected ? ' selected' : '') + (disabled ? ' disabled' : '');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.label;

    row.append(name, mark, ...sourceColumnSpans(source));
    return row;
  }

  /** The game-WAD radio: the pick, plus the redraw that shows what it did to the add-ons. */
  private draftIwadPick(source: WadSource): void {
    this.draftTake(source);
    this.render();
  }

  /** Adds or removes an add-on in the draft, keeping the tick order that decides the merge order. */
  private draftPwadToggle(source: WadSource): void {
    const index = this.draftPwads.findIndex((p) => p.key === source.key);
    if (index >= 0) this.draftPwads.splice(index, 1);
    else this.draftTake(source);
    this.render();
  }

  /**
   * Takes one source into the draft the way its type asks to be taken — a game WAD replaces the
   * pick and drops the add-ons it can't be merged with, anything else joins them. The prune is
   * `pwadsFor`, the rule the menu itself applies on Apply, run here so the rows say now what the
   * set will be rather than reporting the loss once the overlay is gone.
   *
   * No redraw of its own, so a batch draws once. Membership is by **key**, not identity: a file
   * added twice, or re-read by a scan, is a fresh `WadSource` for the same WAD (see `carryDraft`).
   */
  private draftTake(source: WadSource): void {
    // The one place a file can reach the draft without going through a row: `stage`, for a file
    // dropped on the open overlay. A row for it would be greyed out, so it must not arrive ticked.
    if (unplayable(source)) return;
    if (source.type === 'IWAD') {
      this.draftIwad = source;
      this.draftPwads = pwadsFor(source, this.draftPwads);
    } else if (!this.draftPwads.some((p) => p.key === source.key)) {
      this.draftPwads.push(source);
    }
  }

  /**
   * Re-resolves the draft against the sources the menu now holds, by key: a rescan (and a re-upload
   * of a file already known) builds fresh `WadSource` objects for the same files, and the draft
   * holds them by identity, so without this a scan would silently untick everything it just
   * re-read. A file the folder no longer has drops out — there is nothing left to apply. Called
   * from `refresh` alone, which is every path by which the sources can move under the overlay.
   */
  private carryDraft(): void {
    const byKey = new Map(this.hooks.sources().map((s) => [s.key, s]));
    this.draftIwad = this.draftIwad ? (byKey.get(this.draftIwad.key) ?? null) : null;
    this.draftPwads = this.draftPwads
      .map((p) => byKey.get(p.key))
      .filter((p): p is WadSource => p !== undefined);
  }

  private renderSummary(): void {
    const iwad = this.draftIwad;
    const addons = this.draftPwads.length === 1 ? '1 add-on' : `${this.draftPwads.length} add-ons`;
    const set = iwad ? `${iwad.label} · ${addons}` : 'No game WAD picked yet';
    // Nothing here is live until Apply, and a footer that read like the menu's own selection would
    // make Close look harmless when it is a discard. Only said when there is something to lose.
    this.summaryEl.textContent = this.draftIsDirty() ? `${set} — not applied yet` : set;
  }

  /** Whether the draft has drifted from what the menu holds — what Close would throw away. */
  private draftIsDirty(): boolean {
    const pwads = this.hooks.pwads();
    return (
      this.draftIwad !== this.hooks.iwad() ||
      this.draftPwads.length !== pwads.length ||
      this.draftPwads.some((p, i) => p !== pwads[i])
    );
  }

  /** Opens the folder picker, or the `webkitdirectory` input where there is none. */
  private async choose(): Promise<void> {
    const block = pickerBlock();
    if (block !== '') {
      this.showStatus(
        block === 'framed'
          ? "This window can't open a folder picker — asking for a one-off folder, forgotten on reload."
          : 'This browser has no folder picker — asking for a one-off folder, forgotten on reload.',
      );
      this.chooseWithoutPicker();
      return;
    }

    let handle: Awaited<ReturnType<typeof pickLibraryFolder>>;
    try {
      handle = await pickLibraryFolder();
    } catch (err) {
      // The picker exists but refused — a permissions policy, or an embedding `pickerBlock` did not
      // catch. The plain input still works, so fall through to it rather than leaving the button
      // dead, but say what happened: an unexplained fallback is itself a thing to debug.
      this.showStatus(`The folder picker refused (${(err as Error).message}) — asking for a one-off folder.`, true);
      this.chooseWithoutPicker();
      return;
    }
    if (!handle) {
      // An `AbortError` covers two very different things and the API gives no way to tell them
      // apart: the player dismissing the dialog, and the browser refusing the folder they chose
      // (Chromium blocks system and home directories outright). So the line covers both.
      this.showStatus(
        'No folder came back. If you picked one, the browser refused it — system and home folders are blocked.',
        true,
      );
      return;
    }
    await this.rescan();
  }

  /**
   * The `<input webkitdirectory>` path: a folder for this session only, with no handle to store.
   *
   * All three of its outcomes are answered — the folder (`change`), a dismissed dialog (`cancel`),
   * and **the dialog never opening at all**, which is what an embedding that blocks file choosers
   * looks like from in here and has no event of its own. The last is a watchdog rather than a real
   * signal, so it says what it actually knows; a `change` or `cancel` that arrives later overwrites
   * it. Silence is the one answer the player can't act on.
   */
  private chooseWithoutPicker(): void {
    this.folderInput.value = '';
    window.clearTimeout(this.pickTimer);
    this.pickTimer = window.setTimeout(() => {
      this.showStatus(
        `No answer from the folder picker after ${PICKER_TIMEOUT / 1000}s — if no dialog opened, this window is blocking it.`,
        true,
      );
    }, PICKER_TIMEOUT);
    this.folderInput.click();
  }

  /**
   * The dialog handed nothing back. Fires on Chromium and Firefox; the watchdog covers the rest.
   *
   * Worded for the case that isn't a dismissal: a directory `<input>` needs a second, browser-drawn
   * confirmation after the folder is chosen, and a window that suppresses it turns a *successful*
   * pick into this event — which is how a player who did choose a folder gets told nobody chose one.
   * There is no way to tell the two apart from here, so the line names both and offers the route
   * that needs no confirmation.
   */
  private onFolderCancelled(): void {
    window.clearTimeout(this.pickTimer);
    this.showStatus(
      'No folder came back. If you picked one, this window blocked it — open the game in its own tab.',
      true,
    );
  }

  /**
   * The `webkitdirectory` input came back. **Every path here reports something**, a folder that
   * yields no files at all (or none with a `.wad` in it) included: a silent `return` looks from the
   * outside like a picker that did nothing, the hardest kind of failure to tell apart from a bug.
   */
  private async onFolderChosen(): Promise<void> {
    window.clearTimeout(this.pickTimer);
    const files = [...(this.folderInput.files ?? [])];
    if (files.length === 0) {
      this.showStatus('The browser handed back no files for that folder.', true);
      return;
    }

    // Counted by the rule the scan itself applies, never a second copy of it: a folder whose WADs
    // are all too deep to be taken must not be told that they are about to be read.
    const wads = acceptableWads(files);
    if (wads.length === 0) {
      this.showStatus(`No usable .wad files in that folder — it held ${files.length} other file${files.length === 1 ? '' : 's'}.`, true);
      return;
    }

    await this.withScan(`Reading ${wads.length} WADs …`, (progress) => adoptFolderFiles(files, progress));
  }

  private async rescan(): Promise<void> {
    if (!(await ensureLibraryAccess())) {
      this.showStatus('Permission to read your WAD folder was refused.', true);
      return;
    }
    await this.withScan('Scanning your WAD folder …', (progress) => rescanLibrary(progress));
  }

  private async forget(): Promise<void> {
    await forgetLibrary();
    this.hooks.setLibrarySources([]);
    this.showStatus('Forgot your WAD folder.');
    this.render();
  }

  /**
   * The one place a scan's progress, its status line and its re-render live, so the two ways into
   * one (the picker and the fallback input) can't report differently.
   */
  private async withScan(
    initial: string,
    work: (progress: (done: number, total: number) => void) => Promise<void>,
  ): Promise<void> {
    this.scanning = true;
    this.render();
    this.showStatus(initial);
    try {
      await work((done, total) => {
        if (total > 0 && done % 16 === 0) this.showStatus(`Reading WADs … ${done}/${total}`);
      });
      const found = librarySources();
      // Hands the menu the new list, whose render re-binds the draft to it (`refresh`).
      this.hooks.setLibrarySources(found);
      this.showStatus(...scanResult(found.length, librarySkips()));
      this.selectedFolder = LIBRARY_ROOT;
    } catch (err) {
      this.showStatus(`Could not read that folder: ${(err as Error).message}`, true);
    } finally {
      this.scanning = false;
      this.render();
    }
  }
}

/**
 * What a finished scan says, as `say`'s two arguments. A scan that read nothing is reported by what
 * it *walked past* wherever it can be: "no WADs here" and "every WAD here was unreadable" look the
 * same from the tree and call for completely different things from the player, so the first skipped
 * file's own reason is quoted rather than counted.
 *
 * Pure, so the wording is testable without a DOM — docs/menu.md § WAD Library.
 */
export function scanResult(found: number, skipped: readonly LibrarySkip[]): [string, boolean] {
  const first = skipped[0];
  if (found === 0) {
    return first
      ? [`No readable WADs — ${skipped.length} skipped, e.g. ${first.path}: ${first.reason}`, true]
      : ['No WADs found in that folder.', true];
  }
  const wads = found === 1 ? '1 WAD' : `${found} WADs`;
  return first
    ? [`Found ${wads}; skipped ${skipped.length} (e.g. ${first.path}: ${first.reason}).`, false]
    : [`Found ${wads}.`, false];
}

/** `total` defaults to the folder's own count — the leaf case; a folder with subfolders passes its
    whole subtree's, which is what the row's number is for (see `FolderNode`). */
function folder(
  id: string,
  label: string,
  depth: number,
  sources: WadSource[],
  total = sources.length,
): FolderNode {
  return { id, label, depth, sources, total };
}

/** Sets a panel heading to its name plus how many WADs the panel holds. */
function header(el: HTMLHeadingElement, label: string, count: number): void {
  el.replaceChildren();
  const name = document.createElement('span');
  name.textContent = label;
  const total = document.createElement('span');
  total.className = 'meta';
  total.textContent = String(count);
  el.append(name, total);
}

/**
 * A file this engine cannot run at all — no map in it will load, so there is nothing to pick it
 * for. The verdict and the rule are `wad/support.ts`'s (docs/wad.md § Will it run?); the overlay's
 * part is refusing the row. A file only *partly* broken stays pickable: see `nothingLoads`.
 */
function unplayable(source: WadSource): boolean {
  return source.support !== undefined && nothingLoads(source.support, source.maps.length);
}

/** The badge on a row refused for `unplayable`. The support column's tooltip carries the detail. */
const REFUSED = "won't load";

/**
 * A file row's badge. `'reason'` is why the row can't be picked and is the one thing here worth
 * interrupting for, so it is the only kind that carries the accent; `'quiet'` is an aside, and the
 * empty default is the spacer that keeps the columns behind it lined up.
 */
function badge(text: string, kind: '' | 'quiet' | 'reason' = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = kind ? `badge ${kind}` : 'badge';
  span.textContent = text;
  return span;
}

function empty(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}
