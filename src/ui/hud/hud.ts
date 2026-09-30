/**
 * The in-game readouts pinned to the view's edges: health, armor and the level stats bottom-left,
 * the ammo counts, keys and powerups bottom-right, the owned weapons right of centre, the clock
 * top-right. Drawn from the WAD's own art. See docs/hud.md § The HUD.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import {
  AMMO_TYPES,
  ammoMax,
  hasPower,
  KEY_COLORS,
  POWER_IDS,
  type AmmoType,
  type Inventory,
  type KeyColor,
  type KeySlot,
  type PowerId,
  type WeaponId,
} from '../../game/inventory.ts';
import { WEAPON_CYCLE, WEAPONS } from '../../game/weapons.ts';
import {
  WadFont,
  WadNumbers,
  COLOR_BLUE,
  COLOR_YELLOW,
  type DigitRun,
  type WadFontRecolor,
} from './wadfont.ts';

/** The kill/item/secret totals the level-stats strip shows — docs/hud.md § Level stats. */
export interface LevelStats {
  kills: number;
  totalKills: number;
  items: number;
  totalItems: number;
  secrets: number;
  totalSecrets: number;
  /**
   * Simulated seconds spent in the level so far (`Level.time`) — see {@link Hud.drawTimer}'s doc
   * for when this stops advancing.
   */
  elapsedSeconds: number;
}

/**
 * Sampled from `ARM1A0` (the green armor pickup) for a completed kill/item/secret category — a UI
 * addition with no vanilla precedent, tuned by feel; only the choice of color is WAD-derived, for
 * the same reason {@link COLOR_YELLOW} is. docs/hud.md § Level stats.
 */
export const LEVEL_STATS_GREEN: readonly [number, number, number] = [111, 239, 103];

/**
 * How much health/armor is left, read as a color: over 100 blue, then green, then yellow, and
 * `STTNUM`'s own undyed red once it's low enough to be the thing you're watching. The tiers are
 * this engine's addition and **tuned by feel**; only the colors are WAD-derived (`ARM2A0`,
 * `ARM1A0`, `STYSNUM1`). docs/hud.md § The HUD.
 *
 * Ordered high to low: {@link TieredNumbers} takes the first tier the value reaches, and the undyed
 * red below all of them.
 */
const VALUE_TIERS: readonly { atLeast: number; recolor: WadFontRecolor }[] = [
  { atLeast: 101, recolor: COLOR_BLUE },
  { atLeast: 50, recolor: LEVEL_STATS_GREEN },
  { atLeast: 25, recolor: COLOR_YELLOW },
];

/**
 * `hh:mm:ss`, shared by the HUD clock and the intermission's "your time" line so the two can never
 * disagree about the same `Level.time`.
 */
export function formatClock(elapsedSeconds: number): string {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * One of the intermission's three percentages. Truncating rather than rounding is `wi_stuff.c`'s
 * own `plrs[me].skills * 100 / wbs->maxkills` — C integer division — so 99 of 100 kills reads 99%.
 *
 * A total of 0 reads 100%, where vanilla would divide by zero: "nothing to find, so you found it
 * all" is the rule the HUD strip's `found >= total` completion cue already applies.
 */
export function percentOf(found: number, total: number): number {
  return total <= 0 ? 100 : Math.floor((found * 100) / total);
}

const AMMO_ICONS: Record<AmmoType, string> = {
  bullets: 'CLIPA0',
  shells: 'SHELA0',
  rockets: 'ROCKA0',
  cells: 'CELLA0',
};

const KEY_ICONS: Record<KeyColor, string> = {
  blue: 'BKEYA0',
  red: 'RKEYA0',
  yellow: 'YKEYA0',
};

/**
 * The skull keys' own pickup sprites — shown in a color's slot when only the skull of that color is
 * owned. docs/hud.md § The HUD.
 */
const KEY_SKULL_ICONS: Record<KeyColor, string> = {
  blue: 'BSKUA0',
  red: 'RSKUA0',
  yellow: 'YSKUA0',
};

/**
 * The two slot names per color, pre-built: {@link Hud.update} runs every frame and must not
 * compose them per call.
 */
const KEY_SLOTS_BY_COLOR: Record<KeyColor, { card: KeySlot; skull: KeySlot }> = {
  blue: { card: 'blueCard', skull: 'blueSkull' },
  red: { card: 'redCard', skull: 'redSkull' },
  yellow: { card: 'yellowCard', skull: 'yellowSkull' },
};

/**
 * Each powerup's own ground-pickup sprite, the same convention every other icon here follows: the
 * powerup strip is the only way to know one is running. Berserk never gets a row
 * ({@link STRIP_POWER_IDS}) — its sprite swaps in for the health icon instead.
 * docs/hud.md § The HUD.
 */
const POWER_ICONS: Record<PowerId, string> = {
  invulnerability: 'PINVA0',
  berserk: 'PSTRA0',
  invisibility: 'PINSA0',
  radiationSuit: 'SUITA0',
  computerMap: 'PMAPA0',
  lightVisor: 'PVISA0',
};

/**
 * The powerup strip's own rows — every power except berserk, which swaps the health icon instead
 * (see {@link POWER_ICONS}'s doc).
 */
const STRIP_POWER_IDS = POWER_IDS.filter((p) => p !== 'berserk');

/** The backpack sits in the key row: held for good, with no number of its own. */
const BACKPACK_ICON = 'BPAKA0';

/**
 * Draws a WAD picture lump into a canvas at its native pixel size; CSS scales it up with
 * `image-rendering: pixelated`. docs/hud.md § The HUD.
 *
 * @returns whether the lump was there to draw — `ui/hud/levelcard.ts` shares this to blit a
 *          level-name patch, and falls back to its own text when it isn't
 */
export function drawIcon(canvas: HTMLCanvasElement, gfx: GraphicsBank, lump: string): boolean {
  const bmp = gfx.picture(lump);
  if (!bmp) return false;
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bmp.data), bmp.width, bmp.height), 0, 0);
  return true;
}

/**
 * Draws one line of {@link WadFont} text into a canvas sized to fit it exactly, at native pixel
 * size for CSS to scale like {@link drawIcon}'s art. The shared half of every card and popup that
 * prints a line, which is why it sits here beside {@link drawIcon} rather than in any one of them.
 * See docs/hud.md.
 */
export function drawText(canvas: HTMLCanvasElement, font: WadFont, text: string): void {
  canvas.width = Math.max(1, font.measure(text));
  canvas.height = Math.max(1, font.height);
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  font.draw(ctx, 0, 0, text);
}

/**
 * How many digit cells every readout in `#game-hud` reserves, whatever the value — vanilla's own
 * `ST_HEALTHWIDTH` / `ST_ARMORWIDTH` / `ST_AMMOWIDTH` (`st_stuff.c`), all 3. docs/hud.md § The HUD.
 */
const NUMBER_CELLS = 3;

/**
 * What a {@link NumberField} draws through: {@link WadNumbers} itself where the readout prints in
 * one color, {@link TieredNumbers} for health and armor, which pick theirs from the value.
 */
interface NumberSource {
  readonly height: number;
  measure(cells: number): number;
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, run: DigitRun): void;
}

/**
 * The tall digits, colored by {@link VALUE_TIERS}. A recolor bakes into the glyphs, so this holds
 * one built {@link WadNumbers} per tier and picks between them per value; all of them measure the
 * same, so the choice stays inside here and callers see one digit set.
 */
class TieredNumbers implements NumberSource {
  readonly height: number;
  /** The undyed set: vanilla's own color, and what a value below every tier prints in. */
  private red: WadNumbers;
  private tiers: readonly { atLeast: number; font: WadNumbers }[];

  constructor(gfx: GraphicsBank) {
    this.red = new WadNumbers(gfx, 'tall');
    this.tiers = VALUE_TIERS.map((tier) => ({ atLeast: tier.atLeast, font: new WadNumbers(gfx, 'tall', tier.recolor) }));
    this.height = this.red.height;
  }

  measure(cells: number): number {
    return this.red.measure(cells);
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, run: DigitRun): void {
    let font = this.red;
    for (const tier of this.tiers) {
      if (run.value >= tier.atLeast) {
        font = tier.font;
        break;
      }
    }
    font.draw(ctx, x, y, run);
  }
}

/**
 * One sprite-digit readout: its canvas, the digit set it draws with, and the value last drawn
 * into it. {@link Hud.update} runs every frame while almost none of these change from one to the
 * next, so the memo is what keeps the rasterizing to the numbers that actually moved. A `null`
 * value hides the canvas rather than leaving a blank block (docs/hud.md § The HUD).
 */
class NumberField {
  private ctx: CanvasRenderingContext2D;
  private font: NumberSource;
  private shown: number | null | undefined = undefined;

  constructor(canvas: HTMLCanvasElement, font: NumberSource) {
    canvas.width = Math.max(1, font.measure(NUMBER_CELLS));
    canvas.height = Math.max(1, font.height);
    this.ctx = canvas.getContext('2d')!;
    this.font = font;
  }

  set(value: number | null): void {
    if (value === this.shown) return;
    this.shown = value;
    this.ctx.canvas.classList.toggle('hidden', value === null);
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    if (value !== null) this.font.draw(this.ctx, 0, 0, { value, cells: NUMBER_CELLS });
  }
}

/**
 * The in-game status readout: health, armor, ammo, keys, powerups, the owned weapons, the
 * kill/item/secret strip and the clock. Static markup lives in `hud.html` (`#game-hud`); this class
 * only draws the WAD icons once per level load and pushes numbers/visibility on every frame.
 */
export class Hud {
  private root = document.getElementById('game-hud')!;
  private redFont: WadFont;
  private yellowFont: WadFont;
  private greenFont: WadFont;
  private labelColumnWidth: number;
  private killsCanvas = this.root.querySelector<HTMLCanvasElement>('#hud-levelstats .line-kills')!;
  private itemsCanvas = this.root.querySelector<HTMLCanvasElement>('#hud-levelstats .line-items')!;
  private secretsCanvas = this.root.querySelector<HTMLCanvasElement>('#hud-levelstats .line-secrets')!;
  private timerCanvas = this.root.querySelector<HTMLCanvasElement>('#hud-timer')!;
  /** What {@link Hud.drawTimer} last drew, so an unchanged second isn't rasterized again. */
  private timerShown: string | null = null;
  private timerOverBest = false;
  private recordingEl = this.root.querySelector<HTMLElement>('#hud-recording')!;
  private tallNumbers: TieredNumbers;
  private shortNumbers: WadNumbers;
  private healthValue: NumberField;
  private healthIconNormal = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-normal')!;
  private healthIconBerserk = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-berserk')!;
  private armorValue: NumberField;
  private armorPanel = this.root.querySelector<HTMLElement>('.hud-armor')!;
  private armorIconGreen = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-green')!;
  private armorIconBlue = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-blue')!;
  private ammoRows: Record<AmmoType, { row: HTMLElement; value: NumberField; max: NumberField }>;
  private keyIcons: Record<KeyColor, HTMLCanvasElement>;
  private keyVariantShown: Record<KeyColor, 'card' | 'skull'>;
  private gfx: GraphicsBank;
  private weaponIcons: Record<WeaponId, HTMLCanvasElement>;
  private powerPanel = this.root.querySelector<HTMLElement>('.hud-powers')!;
  private powerRows: Partial<Record<PowerId, { row: HTMLElement; value: NumberField }>>;
  private backpackIcon = this.root.querySelector<HTMLCanvasElement>('.hud-keys .backpack')!;

  constructor(gfx: GraphicsBank) {
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
    this.greenFont = new WadFont(gfx, LEVEL_STATS_GREEN);
    // Health and armor in the tall digits vanilla prints them in, and the ammo counts in the small
    // yellow ones its own ammo list uses. See `WadNumberSet`.
    this.tallNumbers = new TieredNumbers(gfx);
    this.shortNumbers = new WadNumbers(gfx, 'short');
    this.healthValue = new NumberField(this.root.querySelector<HTMLCanvasElement>('.hud-health .value')!, this.tallNumbers);
    this.armorValue = new NumberField(this.root.querySelector<HTMLCanvasElement>('.hud-armor .value')!, this.tallNumbers);
    // The widest of the three labels ("M: "/"I: "/"S: ", proportionally spaced) — every line's
    // number starts here rather than right after its own label, so the numbers form a flush
    // column instead of each starting wherever its own (differently-wide) label happens to end.
    this.labelColumnWidth = Math.max(this.redFont.measure('M: '), this.redFont.measure('I: '), this.redFont.measure('S: '));
    drawIcon(this.healthIconNormal, gfx, 'MEDIA0');
    drawIcon(this.healthIconBerserk, gfx, POWER_ICONS.berserk);
    drawIcon(this.armorIconGreen, gfx, 'ARM1A0');
    drawIcon(this.armorIconBlue, gfx, 'ARM2A0');

    this.ammoRows = {} as Record<AmmoType, { row: HTMLElement; value: NumberField; max: NumberField }>;
    for (const t of AMMO_TYPES) {
      const row = this.root.querySelector<HTMLElement>(`.hud-ammo .row-${t}`)!;
      drawIcon(row.querySelector<HTMLCanvasElement>('.icon')!, gfx, AMMO_ICONS[t]);
      drawText(row.querySelector<HTMLCanvasElement>('.slash')!, this.yellowFont, '/');
      this.ammoRows[t] = {
        row,
        value: new NumberField(row.querySelector<HTMLCanvasElement>('.value')!, this.shortNumbers),
        max: new NumberField(row.querySelector<HTMLCanvasElement>('.max')!, this.shortNumbers),
      };
    }

    this.gfx = gfx;
    this.keyIcons = {} as Record<KeyColor, HTMLCanvasElement>;
    this.keyVariantShown = { blue: 'card', red: 'card', yellow: 'card' };
    for (const c of KEY_COLORS) {
      const icon = this.root.querySelector<HTMLCanvasElement>(`.hud-keys .key-${c}`)!;
      drawIcon(icon, gfx, KEY_ICONS[c]);
      this.keyIcons[c] = icon;
    }
    drawIcon(this.backpackIcon, gfx, BACKPACK_ICON);

    // The weapon set is fixed at compile time (game/weapons.ts's WEAPON_CYCLE),
    // unlike ammo/keys there's no small fixed handful worth hand-authoring in
    // hud.html — built here instead, one hidden icon per weapon, shown once
    // owned.
    // `replaceChildren` (rather than plain appends) because the markup is
    // static and shared: starting a second game from the menu builds a new Hud
    // against the same #game-hud element, and appending would stack a second
    // full set of icons onto the first.
    const weaponPanel = this.root.querySelector<HTMLElement>('.hud-weapons')!;
    weaponPanel.replaceChildren();
    this.weaponIcons = {} as Record<WeaponId, HTMLCanvasElement>;
    for (const w of WEAPON_CYCLE) {
      const canvas = document.createElement('canvas');
      canvas.className = 'icon hidden';
      drawIcon(canvas, gfx, WEAPONS[w].iconLump);
      weaponPanel.appendChild(canvas);
      this.weaponIcons[w] = canvas;
    }

    this.powerPanel.replaceChildren();
    this.powerRows = {};
    for (const p of STRIP_POWER_IDS) this.powerRows[p] = this.addPowerRow(gfx, POWER_ICONS[p]);
  }

  /**
   * @param timeLeft  the whole seconds a deathmatch time limit leaves, which the clock reads in
   *                  place of the time spent; null with none (docs/multiplayer-deathmatch.md
   *                  § Limits)
   * @param bestTime  the level's stored best time in seconds, which the clock turns red past; null
   *                  with none
   */
  update(inv: Inventory, stats: LevelStats, recording: boolean, timeLeft: number | null, bestTime: number | null): void {
    this.recordingEl.classList.toggle('hidden', !recording);
    this.drawStatLine(this.killsCanvas, 'M', stats.kills, stats.totalKills);
    this.drawStatLine(this.itemsCanvas, 'I', stats.items, stats.totalItems);
    this.drawStatLine(this.secretsCanvas, 'S', stats.secrets, stats.totalSecrets);
    // A countdown is no run against the clock: it stays yellow.
    const overBest = timeLeft === null && bestTime !== null && stats.elapsedSeconds > bestTime;
    this.drawTimer(timeLeft ?? stats.elapsedSeconds, overBest);
    this.healthValue.set(Math.round(inv.health));
    const berserk = hasPower(inv, 'berserk');
    this.healthIconNormal.classList.toggle('hidden', berserk);
    this.healthIconBerserk.classList.toggle('hidden', !berserk);
    this.armorValue.set(Math.round(inv.armor));
    this.armorIconGreen.classList.toggle('hidden', inv.armorType !== 1);
    this.armorIconBlue.classList.toggle('hidden', inv.armorType !== 2);
    this.armorPanel.classList.toggle('empty', inv.armorType === 0);
    for (const t of AMMO_TYPES) {
      this.ammoRows[t].value.set(inv.ammo[t]);
      this.ammoRows[t].max.set(ammoMax(inv, t));
    }
    for (const c of KEY_COLORS) {
      const card = inv.keys.has(KEY_SLOTS_BY_COLOR[c].card);
      const skull = inv.keys.has(KEY_SLOTS_BY_COLOR[c].skull);
      this.keyIcons[c].classList.toggle('hidden', !card && !skull);
      // Skull art only when the skull is all we have of the color; a card
      // (or nothing yet) shows the card icon, the slot's resting state.
      const variant = skull && !card ? 'skull' : 'card';
      if (variant !== this.keyVariantShown[c]) {
        drawIcon(this.keyIcons[c], this.gfx, variant === 'skull' ? KEY_SKULL_ICONS[c] : KEY_ICONS[c]);
        this.keyVariantShown[c] = variant;
      }
    }
    this.backpackIcon.classList.toggle('hidden', !inv.backpack);

    for (const w of WEAPON_CYCLE) {
      const icon = this.weaponIcons[w];
      icon.classList.toggle('hidden', !inv.weapons.has(w));
      icon.classList.toggle('current', w === inv.currentWeapon);
    }
    const currentAmmoType = WEAPONS[inv.currentWeapon].ammoType;
    // The whole row lights, not just its number: sprite digits have no bold, and the row's own
    // dimming reads at a glance where a font-weight change no longer can.
    for (const t of AMMO_TYPES) this.ammoRows[t].row.classList.toggle('current', t === currentAmmoType);

    let anyPower = false;
    for (const p of STRIP_POWER_IDS) {
      const left = inv.powers[p];
      const { row, value } = this.powerRows[p]!;
      row.classList.toggle('hidden', left <= 0);
      if (left <= 0) continue;
      anyPower = true;
      // The computer map never runs out (Infinity), so it shows as a bare
      // icon — a countdown there would only ever read the same number.
      value.set(Number.isFinite(left) ? Math.ceil(left) : null);
    }
    // Collapsed entirely while nothing is active, so the panel's own gap in
    // the corner's column doesn't leave a hole above the key row.
    this.powerPanel.classList.toggle('hidden', !anyPower);
  }

  /**
   * One hidden icon (+ its countdown slot) in the powerup strip, in {@link STRIP_POWER_IDS} order.
   */
  private addPowerRow(gfx: GraphicsBank, lump: string): { row: HTMLElement; value: NumberField } {
    const row = document.createElement('div');
    row.className = 'hidden';
    const canvas = document.createElement('canvas');
    canvas.className = 'icon';
    drawIcon(canvas, gfx, lump);
    const value = document.createElement('canvas');
    value.className = 'value';
    row.append(canvas, value);
    this.powerPanel.appendChild(row);
    return { row, value: new NumberField(value, this.shortNumbers) };
  }

  /**
   * Composes one `hud-levelstats` line — a red `"<label>: "` run, then a `"<found>/<total>"` run
   * starting at {@link Hud.labelColumnWidth} so the three lines' numbers form a flush column.
   * The number run switches to green once `found` reaches `total` ({@link LEVEL_STATS_GREEN}).
   */
  private drawStatLine(canvas: HTMLCanvasElement, label: string, found: number, total: number): void {
    const redText = `${label}: `;
    const numberText = `${found}/${total}`;
    const numberFont = found >= total ? this.greenFont : this.yellowFont;
    canvas.width = this.labelColumnWidth + numberFont.measure(numberText);
    canvas.height = Math.max(this.redFont.height, numberFont.height);
    const ctx = canvas.getContext('2d')!;
    this.redFont.draw(ctx, 0, 0, redText);
    numberFont.draw(ctx, this.labelColumnWidth, 0, numberText);
  }

  /**
   * Draws the level clock, top-right: in the status bar's yellow, and in STCFN's own red once the
   * run is past the level's best time. Redrawn only when the text or the color changes.
   *
   * @param seconds   the time spent, or a time limit's time left — `Game`'s to freeze (on death or
   *                  level completion); this method only ever formats whatever it's handed
   * @param overBest  whether the run is already slower than the stored best
   */
  private drawTimer(seconds: number, overBest: boolean): void {
    const text = formatClock(seconds);
    if (text === this.timerShown && overBest === this.timerOverBest) return;
    this.timerShown = text;
    this.timerOverBest = overBest;
    const font = overBest ? this.redFont : this.yellowFont;
    this.timerCanvas.width = font.measure(text);
    this.timerCanvas.height = font.height;
    font.draw(this.timerCanvas.getContext('2d')!, 0, 0, text);
  }
}
