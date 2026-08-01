import {
  describeSource,
  fetchLibrary,
  mergedMaps,
  uploadedSource,
  type WadSource,
} from '../wad/library.ts';

export interface Selection {
  iwad: WadSource;
  pwads: WadSource[];
  map: string;
}

export interface MenuDefaults {
  /** Preselect by file name, as given in ?wad= / ?pwad=. */
  iwad?: string | null;
  pwads?: string[];
  map?: string | null;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The start screen: pick a game WAD, stack any add-ons on top, choose a level.
 * WADs come either from public/wads/ or straight off the user's disk.
 */
export class Menu {
  private root = el<HTMLDivElement>('menu');
  private iwadList = el<HTMLDivElement>('iwad-list');
  private pwadList = el<HTMLDivElement>('pwad-list');
  private levelSelect = el<HTMLSelectElement>('level-select');
  private startButton = el<HTMLButtonElement>('start-button');
  private statusEl = el<HTMLSpanElement>('menu-status');
  private fileInput = el<HTMLInputElement>('file-input');

  private sources: WadSource[] = [];
  private selectedIwad: WadSource | null = null;
  /** Ordered: add-ons are merged in the order the user picked them. */
  private selectedPwads: WadSource[] = [];
  /** Where an upload should land once the file dialog returns. */
  private uploadTarget: 'IWAD' | 'PWAD' = 'IWAD';

  private onStart: (selection: Selection) => void;

  constructor(onStart: (selection: Selection) => void) {
    this.onStart = onStart;

    el<HTMLButtonElement>('iwad-upload').addEventListener('click', () => this.pickFile('IWAD'));
    el<HTMLButtonElement>('pwad-upload').addEventListener('click', () => this.pickFile('PWAD'));
    this.fileInput.addEventListener('change', () => void this.onFilesChosen());
    this.levelSelect.addEventListener('change', () => this.refreshStartButton());
    this.startButton.addEventListener('click', () => this.start());
    this.installDropTarget();
  }

  /** Reads the server library and applies whatever the URL asked for. */
  async init(defaults: MenuDefaults): Promise<void> {
    this.setStatus('Scanning public/wads/ …');
    this.sources = await fetchLibrary();

    const byKey = (name: string) =>
      this.sources.find((s) => s.key.toLowerCase() === name.toLowerCase());

    this.selectedIwad =
      (defaults.iwad ? byKey(defaults.iwad) : undefined) ??
      this.sources.find((s) => s.type === 'IWAD') ??
      null;

    this.selectedPwads = (defaults.pwads ?? [])
      .map(byKey)
      .filter((s): s is WadSource => s !== undefined && s !== this.selectedIwad);

    this.render();
    if (defaults.map) this.selectLevel(defaults.map);

    this.setStatus(
      this.sources.length === 0
        ? 'No WADs found on the server — load one from disk.'
        : `${this.sources.length} WAD${this.sources.length === 1 ? '' : 's'} available`,
    );
  }

  open(): void {
    this.root.classList.remove('hidden');
    this.refreshStartButton();
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** True once a level can actually be started. */
  get isReady(): boolean {
    return this.selectedIwad !== null && this.levelSelect.value !== '';
  }

  setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', isError);
  }

  private render(): void {
    this.renderIwads();
    this.renderPwads();
    this.renderLevels();
  }

  private renderIwads(): void {
    this.iwadList.replaceChildren();
    for (const source of this.sources) {
      if (source.type !== 'IWAD') continue;
      const selected = source === this.selectedIwad;
      this.iwadList.append(
        this.makeRow('radio', source, selected, () => {
          this.selectedIwad = source;
          this.selectedPwads = this.selectedPwads.filter((p) => p !== source);
          this.render();
        }),
      );
    }
  }

  private renderPwads(): void {
    this.pwadList.replaceChildren();
    for (const source of this.sources) {
      // A PWAD uploaded via the "game WAD" picker still lands in selectedIwad
      // (see addFiles) and shouldn't also show up here as an add-on.
      if (source.type !== 'PWAD' || source === this.selectedIwad) continue;
      const index = this.selectedPwads.indexOf(source);
      const row = this.makeRow('checkbox', source, index >= 0, () => {
        if (index >= 0) this.selectedPwads.splice(index, 1);
        else this.selectedPwads.push(source);
        this.render();
      });
      if (index >= 0) {
        const order = document.createElement('span');
        order.className = 'meta';
        order.textContent = `#${index + 1}`;
        row.append(order);
      }
      this.pwadList.append(row);
    }
  }

  private makeRow(
    kind: 'radio' | 'checkbox',
    source: WadSource,
    selected: boolean,
    onPick: () => void,
  ): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'row' + (selected ? ' selected' : '');

    const input = document.createElement('input');
    input.type = kind;
    input.checked = selected;
    if (kind === 'radio') input.name = 'iwad';
    input.addEventListener('change', onPick);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.label;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = describeSource(source);

    row.append(input, name, meta);
    return row;
  }

  private renderLevels(): void {
    const previous = this.levelSelect.value;
    this.levelSelect.replaceChildren();

    if (!this.selectedIwad) {
      this.levelSelect.disabled = true;
      this.refreshStartButton();
      return;
    }

    const maps = mergedMaps(this.selectedIwad, this.selectedPwads);
    this.levelSelect.disabled = maps.length === 0;

    // DOOM 1 names maps E<episode>M<mission>, so group them by episode.
    let group: HTMLOptGroupElement | null = null;
    let groupKey = '';
    for (const map of maps) {
      const key = /^E(\d)M\d$/.exec(map.name)?.[1] ?? '';
      if (!group || key !== groupKey) {
        group = document.createElement('optgroup');
        group.label = key ? `Episode ${key}` : 'Maps';
        groupKey = key;
        this.levelSelect.append(group);
      }
      const option = document.createElement('option');
      option.value = map.name;
      // Only worth naming the provider when an add-on took the map over.
      option.textContent =
        map.provider === this.selectedIwad.label ? map.name : `${map.name}  —  ${map.provider}`;
      group.append(option);
    }

    if (maps.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'This WAD contains no maps';
      this.levelSelect.append(option);
    }

    if (previous && maps.some((m) => m.name === previous)) this.levelSelect.value = previous;
    this.refreshStartButton();
  }

  private selectLevel(name: string): void {
    const upper = name.toUpperCase();
    if ([...this.levelSelect.options].some((o) => o.value === upper)) {
      this.levelSelect.value = upper;
      this.refreshStartButton();
    }
  }

  private refreshStartButton(): void {
    this.startButton.disabled = !this.isReady;
  }

  private pickFile(target: 'IWAD' | 'PWAD'): void {
    this.uploadTarget = target;
    this.fileInput.multiple = target === 'PWAD';
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private async onFilesChosen(): Promise<void> {
    const files = [...(this.fileInput.files ?? [])];
    if (files.length > 0) await this.addFiles(files, this.uploadTarget);
  }

  /**
   * Adds files from disk. `prefer` decides where an ambiguous pick lands; a file
   * that declares itself an IWAD is never silently treated as an add-on.
   */
  async addFiles(files: File[], prefer: 'IWAD' | 'PWAD' | 'auto' = 'auto'): Promise<void> {
    const added: string[] = [];
    for (const file of files) {
      try {
        const source = uploadedSource(file.name, await file.arrayBuffer());
        const existing = this.sources.findIndex((s) => s.key === source.key);
        if (existing >= 0) this.sources.splice(existing, 1, source);
        else this.sources.unshift(source);

        const asIwad = prefer === 'IWAD' || (prefer === 'auto' && source.type === 'IWAD');
        if (asIwad) {
          this.selectedIwad = source;
          this.selectedPwads = this.selectedPwads.filter((p) => p.key !== source.key);
        } else if (!this.selectedPwads.some((p) => p.key === source.key)) {
          this.selectedPwads.push(source);
        }
        added.push(`${file.name} (${source.type})`);
      } catch (err) {
        this.setStatus(`${file.name}: ${(err as Error).message}`, true);
      }
    }

    if (added.length > 0) {
      this.render();
      this.setStatus(`Added ${added.join(', ')}`);
    }
  }

  private installDropTarget(): void {
    for (const type of ['dragenter', 'dragover']) {
      this.root.addEventListener(type, (e) => {
        e.preventDefault();
        this.root.classList.add('dragging');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      this.root.addEventListener(type, () => this.root.classList.remove('dragging'));
    }
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
      if (files.length > 0) void this.addFiles(files);
    });
  }

  /** Starts with whatever is currently selected — used by ?map= deep links. */
  submit(): void {
    this.start();
  }

  private start(): void {
    if (!this.selectedIwad || !this.isReady) return;
    this.onStart({
      iwad: this.selectedIwad,
      pwads: [...this.selectedPwads],
      map: this.levelSelect.value,
    });
  }
}
