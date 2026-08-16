/**
 * The bar along the bottom: health, armor, the four ammo counts, key slots, the selected weapon,
 * plus the level stats/timer line. Drawn from the WAD's own art. See docs/hud.md § The HUD.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import {
  AMMO_TYPES,
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
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/**
 * The kill/item/secret totals the level-stats strip shows — see `WadFont`'s doc and
 * docs/hud.md § Level stats.
 */
export interface LevelStats {
  kills: number;
  totalKills: number;
  items: number;
  totalItems: number;
  secrets: number;
  totalSecrets: number;
  /** Wall-clock seconds spent in the level so far — see `Hud.drawTimer`'s doc for when this stops advancing. */
  elapsedSeconds: number;
}

/**
 * Sampled from `ARM1A0` (the green armor pickup) — there's no vanilla precedent for
 * highlighting a *completed* kill/item/secret category (vanilla's intermission screen prints
 * every percentage in the same font/color regardless of value), so this is a UI addition tuned
 * by feel; only the choice of color is WAD-derived, for the same reason `COLOR_YELLOW` is.
 *
 * Exported for `ui/hud/intermission.ts`, which applies the same complete-category cue to its
 * percentages.
 */
export const LEVEL_STATS_GREEN: readonly [number, number, number] = [111, 239, 103];

/**
 * `hh:mm:ss`, shared by the HUD clock and the intermission's "your time" line so the two can never
 * disagree about the same `Game.levelTime`.
 */
export function formatClock(elapsedSeconds: number): string {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * One of the intermission's three percentages. Truncating rather than rounding is
 * `wi_stuff.c`'s own `plrs[me].skills * 100 / wbs->maxkills` — C integer division — so 99 of 100
 * kills reads 99%, not 100%.
 *
 * A total of 0 reads 100%: vanilla would divide by zero there (no map it shipped has a zero
 * total), and "nothing to find, so you found it all" is the same rule the HUD strip's
 * `found >= total` completion cue already applies.
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
 * The skull keys' own pickup sprites — shown in a color's slot when only the
 * skull of that color is owned (cards and skulls are separate pickups now that
 * Boom's generalized locks can tell them apart; a color's panel lights for
 * either). docs/hud.md § The HUD.
 */
const KEY_SKULL_ICONS: Record<KeyColor, string> = {
  blue: 'BSKUA0',
  red: 'RSKUA0',
  yellow: 'YSKUA0',
};

/** The two slot names per color, pre-built: `update` runs every frame and must not compose them per call. */
const KEY_SLOTS_BY_COLOR: Record<KeyColor, { card: KeySlot; skull: KeySlot }> = {
  blue: { card: 'blueCard', skull: 'blueSkull' },
  red: { card: 'redCard', skull: 'redSkull' },
  yellow: { card: 'yellowCard', skull: 'yellowSkull' },
};

/**
 * Each powerup's own ground-pickup sprite, the same convention every other
 * icon here already follows. A powerup has no other on-screen presence at all
 * — unlike health or ammo there's no number that changes, and unlike a key
 * there's no door that opens — so this strip is the only way to know one is
 * running, and (for the timed ones) how much of it is left.
 *
 * Berserk is the one exception: it never gets a row in the strip at all (see
 * `STRIP_POWER_IDS`) since it already has an on-screen presence — the health
 * icon itself swaps to `PSTRA0` while it's held, the same idea as the armor
 * icon already swapping between green/blue by type.
 */
const POWER_ICONS: Record<PowerId, string> = {
  invulnerability: 'PINVA0',
  berserk: 'PSTRA0',
  invisibility: 'PINSA0',
  radiationSuit: 'SUITA0',
  computerMap: 'PMAPA0',
  lightVisor: 'PVISA0',
};

/** The powerup strip's own rows — every power except berserk, which swaps the health icon instead (see `POWER_ICONS`'s doc). */
const STRIP_POWER_IDS = POWER_IDS.filter((p) => p !== 'berserk');

/** The backpack shares the powerup strip: it's the same kind of "you have this for good now" status, and has no number of its own either. */
const BACKPACK_ICON = 'BPAKA0';

/**
 * Draws a WAD picture lump into a canvas at its native pixel size; CSS scales
 * it up with `image-rendering: pixelated`. Reusing the same pickup-sprite
 * graphics the world renders items with (rather than hand-drawn icons) keeps
 * the HUD visually consistent with whichever WAD is loaded. Returns whether the
 * lump was there to draw — `ui/hud/levelcard.ts` shares this to blit a level-name
 * patch, and falls back to its own text when it isn't.
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
 * The in-game status readout: health, armor, ammo, collected keys, and the kill/item/secret
 * strip. Static markup lives in index.html (`#hud-bar`, containing `#hud-levelstats` and
 * `#game-hud` as siblings — the strip sits outside `#game-hud`'s own bordered box); this class
 * only draws the WAD icons once per level load and pushes numbers/visibility on every frame.
 */
export class Hud {
  private root = document.getElementById('game-hud')!;
  private redFont: WadFont;
  private yellowFont: WadFont;
  private greenFont: WadFont;
  private labelColumnWidth: number;
  /** Sits outside `#game-hud`'s own bordered box — a plain sibling immediately to its left inside `#hud-bar` — so it isn't `this.root`-scoped like everything else here. */
  private levelStatsRoot = document.getElementById('hud-levelstats')!;
  private killsCanvas = this.levelStatsRoot.querySelector<HTMLCanvasElement>('.line-kills')!;
  private itemsCanvas = this.levelStatsRoot.querySelector<HTMLCanvasElement>('.line-items')!;
  private secretsCanvas = this.levelStatsRoot.querySelector<HTMLCanvasElement>('.line-secrets')!;
  /** Mirrors `levelStatsRoot`: a plain sibling of `#game-hud` inside `#hud-bar`, on its right this time. */
  private timerCanvas = document.getElementById('hud-timer') as HTMLCanvasElement;
  private healthValue = this.root.querySelector<HTMLElement>('.hud-health .value')!;
  private healthIconNormal = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-normal')!;
  private healthIconBerserk = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-berserk')!;
  private armorValue = this.root.querySelector<HTMLElement>('.hud-armor .value')!;
  private armorPanel = this.root.querySelector<HTMLElement>('.hud-armor')!;
  private armorIconGreen = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-green')!;
  private armorIconBlue = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-blue')!;
  private ammoValues: Record<AmmoType, HTMLElement>;
  private keyPanels: Record<KeyColor, HTMLElement>;
  private keyVariantShown: Record<KeyColor, 'card' | 'skull'>;
  private gfx: GraphicsBank;
  private weaponIcons: Record<WeaponId, HTMLCanvasElement>;
  private currentWeaponShown: WeaponId | null = null;
  private powerPanel = this.root.querySelector<HTMLElement>('.hud-powers')!;
  private powerRows: Partial<Record<PowerId, { row: HTMLElement; value: HTMLElement }>>;
  private backpackRow: HTMLElement;

  constructor(gfx: GraphicsBank) {
    this.redFont = new WadFont(gfx);
    this.yellowFont = new WadFont(gfx, COLOR_YELLOW);
    this.greenFont = new WadFont(gfx, LEVEL_STATS_GREEN);
    // The widest of the three labels ("M: "/"I: "/"S: ", proportionally spaced) — every line's
    // number starts here rather than right after its own label, so the numbers form a flush
    // column instead of each starting wherever its own (differently-wide) label happens to end.
    this.labelColumnWidth = Math.max(this.redFont.measure('M: '), this.redFont.measure('I: '), this.redFont.measure('S: '));
    drawIcon(this.healthIconNormal, gfx, 'MEDIA0');
    drawIcon(this.healthIconBerserk, gfx, POWER_ICONS.berserk);
    drawIcon(this.armorIconGreen, gfx, 'ARM1A0');
    drawIcon(this.armorIconBlue, gfx, 'ARM2A0');

    this.ammoValues = {} as Record<AmmoType, HTMLElement>;
    for (const t of AMMO_TYPES) {
      const row = this.root.querySelector<HTMLElement>(`.hud-ammo .row-${t}`)!;
      drawIcon(row.querySelector('canvas')!, gfx, AMMO_ICONS[t]);
      this.ammoValues[t] = row.querySelector<HTMLElement>('.value')!;
    }

    this.gfx = gfx;
    this.keyPanels = {} as Record<KeyColor, HTMLElement>;
    this.keyVariantShown = { blue: 'card', red: 'card', yellow: 'card' };
    for (const c of KEY_COLORS) {
      const panel = this.root.querySelector<HTMLElement>(`.hud-keys .key-${c}`)!;
      drawIcon(panel.querySelector('canvas')!, gfx, KEY_ICONS[c]);
      this.keyPanels[c] = panel;
    }

    // The weapon set is fixed at compile time (game/weapons.ts's WEAPON_CYCLE),
    // unlike ammo/keys there's no small fixed handful worth hand-authoring in
    // index.html — built here instead, one hidden icon per weapon, same as
    // hud-armor's two icons toggling by `.hidden`.
    // `replaceChildren` (rather than plain appends) because the markup is
    // static and shared: starting a second game from the menu builds a new Hud
    // against the same #game-hud element, and appending would stack a second
    // full set of icons onto the first.
    const weaponPanel = this.root.querySelector<HTMLElement>('.hud-weapon')!;
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
    this.backpackRow = this.addPowerRow(gfx, BACKPACK_ICON).row;
  }

  /** One hidden icon (+ its countdown slot) in the powerup strip, in STRIP_POWER_IDS order. */
  private addPowerRow(gfx: GraphicsBank, lump: string): { row: HTMLElement; value: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'hidden';
    const canvas = document.createElement('canvas');
    canvas.className = 'icon';
    drawIcon(canvas, gfx, lump);
    const value = document.createElement('span');
    value.className = 'value';
    row.append(canvas, value);
    this.powerPanel.appendChild(row);
    return { row, value };
  }

  /**
   * Composes one `hud-levelstats` line — a red `"<label>: "` run, then a `"<found>/<total>"` run
   * starting at `labelColumnWidth` rather than wherever this line's own (proportionally-spaced,
   * so differently-wide) label happens to end, so the three lines' numbers form a flush column
   * instead of drifting with each label's width. The number run switches from yellow to green
   * once `found` reaches `total` — a hit-your-goal cue with no vanilla equivalent (see
   * `LEVEL_STATS_GREEN`'s doc). Same "canvas sized to its content, CSS scales it" pattern
   * `drawIcon` uses for a WAD picture lump.
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
   * Draws the level clock, right of `#game-hud`, in the same native STCFN red as the strip's
   * labels. `elapsedSeconds` is `Game`'s to freeze (on death or level completion) — this method
   * only ever formats whatever it's handed.
   */
  private drawTimer(elapsedSeconds: number): void {
    const text = formatClock(elapsedSeconds);
    this.timerCanvas.width = this.redFont.measure(text);
    this.timerCanvas.height = this.redFont.height;
    this.redFont.draw(this.timerCanvas.getContext('2d')!, 0, 0, text);
  }

  update(inv: Inventory, stats: LevelStats): void {
    this.drawStatLine(this.killsCanvas, 'M', stats.kills, stats.totalKills);
    this.drawStatLine(this.itemsCanvas, 'I', stats.items, stats.totalItems);
    this.drawStatLine(this.secretsCanvas, 'S', stats.secrets, stats.totalSecrets);
    this.drawTimer(stats.elapsedSeconds);
    this.healthValue.textContent = String(Math.max(0, Math.round(inv.health)));
    const berserk = hasPower(inv, 'berserk');
    this.healthIconNormal.classList.toggle('hidden', berserk);
    this.healthIconBerserk.classList.toggle('hidden', !berserk);
    this.armorValue.textContent = String(Math.round(inv.armor));
    this.armorIconGreen.classList.toggle('hidden', inv.armorType !== 1);
    this.armorIconBlue.classList.toggle('hidden', inv.armorType !== 2);
    this.armorPanel.classList.toggle('empty', inv.armorType === 0);
    for (const t of AMMO_TYPES) this.ammoValues[t].textContent = String(inv.ammo[t]);
    for (const c of KEY_COLORS) {
      const card = inv.keys.has(KEY_SLOTS_BY_COLOR[c].card);
      const skull = inv.keys.has(KEY_SLOTS_BY_COLOR[c].skull);
      this.keyPanels[c].classList.toggle('collected', card || skull);
      // Skull art only when the skull is all we have of the color; a card
      // (or nothing yet) shows the card icon, the panel's resting state.
      const variant = skull && !card ? 'skull' : 'card';
      if (variant !== this.keyVariantShown[c]) {
        drawIcon(this.keyPanels[c].querySelector('canvas')!, this.gfx, variant === 'skull' ? KEY_SKULL_ICONS[c] : KEY_ICONS[c]);
        this.keyVariantShown[c] = variant;
      }
    }

    if (inv.currentWeapon !== this.currentWeaponShown) {
      if (this.currentWeaponShown) this.weaponIcons[this.currentWeaponShown].classList.add('hidden');
      this.weaponIcons[inv.currentWeapon].classList.remove('hidden');
      this.currentWeaponShown = inv.currentWeapon;
    }
    const currentAmmoType = WEAPONS[inv.currentWeapon].ammoType;
    for (const t of AMMO_TYPES) this.ammoValues[t].classList.toggle('current', t === currentAmmoType);

    let anyPower = inv.backpack;
    for (const p of STRIP_POWER_IDS) {
      const left = inv.powers[p];
      const { row, value } = this.powerRows[p]!;
      row.classList.toggle('hidden', left <= 0);
      if (left <= 0) continue;
      anyPower = true;
      // The computer map never runs out (Infinity), so it shows as a bare
      // icon — a countdown there would only ever read the same number.
      value.textContent = Number.isFinite(left) ? String(Math.ceil(left)) : '';
    }
    this.backpackRow.classList.toggle('hidden', !inv.backpack);
    // Collapsed entirely while nothing is active, so the panel's own gap in
    // #game-hud's flex row doesn't leave a hole between the weapon icon and
    // the HUD's right edge.
    this.powerPanel.classList.toggle('hidden', !anyPower);
  }
}
