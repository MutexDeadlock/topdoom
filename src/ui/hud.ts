import type { GraphicsBank } from '../wad/graphics.ts';
import {
  AMMO_TYPES,
  hasPower,
  KEY_COLORS,
  POWER_IDS,
  type AmmoType,
  type Inventory,
  type KeyColor,
  type PowerId,
  type WeaponId,
} from '../game/inventory.ts';
import { WEAPON_CYCLE, WEAPONS } from '../game/weapons.ts';

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
 * the HUD visually consistent with whichever WAD is loaded.
 */
function drawIcon(canvas: HTMLCanvasElement, gfx: GraphicsBank, lump: string): void {
  const bmp = gfx.picture(lump);
  if (!bmp) return;
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bmp.data), bmp.width, bmp.height), 0, 0);
}

/**
 * The in-game status readout: health, armor, ammo and collected keys. Static
 * markup lives in index.html (`#game-hud`); this class only draws the WAD
 * icons once per level load and pushes numbers/visibility on every frame.
 */
export class Hud {
  private root = document.getElementById('game-hud')!;
  private healthValue = this.root.querySelector<HTMLElement>('.hud-health .value')!;
  private healthIconNormal = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-normal')!;
  private healthIconBerserk = this.root.querySelector<HTMLCanvasElement>('.hud-health .icon-berserk')!;
  private armorValue = this.root.querySelector<HTMLElement>('.hud-armor .value')!;
  private armorPanel = this.root.querySelector<HTMLElement>('.hud-armor')!;
  private armorIconGreen = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-green')!;
  private armorIconBlue = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-blue')!;
  private ammoValues: Record<AmmoType, HTMLElement>;
  private keyPanels: Record<KeyColor, HTMLElement>;
  private weaponIcons: Record<WeaponId, HTMLCanvasElement>;
  private currentWeaponShown: WeaponId | null = null;
  private powerPanel = this.root.querySelector<HTMLElement>('.hud-powers')!;
  private powerRows: Partial<Record<PowerId, { row: HTMLElement; value: HTMLElement }>>;
  private backpackRow: HTMLElement;

  constructor(gfx: GraphicsBank) {
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

    this.keyPanels = {} as Record<KeyColor, HTMLElement>;
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

  update(inv: Inventory): void {
    this.healthValue.textContent = String(Math.max(0, Math.round(inv.health)));
    const berserk = hasPower(inv, 'berserk');
    this.healthIconNormal.classList.toggle('hidden', berserk);
    this.healthIconBerserk.classList.toggle('hidden', !berserk);
    this.armorValue.textContent = String(Math.round(inv.armor));
    this.armorIconGreen.classList.toggle('hidden', inv.armorType !== 1);
    this.armorIconBlue.classList.toggle('hidden', inv.armorType !== 2);
    this.armorPanel.classList.toggle('empty', inv.armorType === 0);
    for (const t of AMMO_TYPES) this.ammoValues[t].textContent = String(inv.ammo[t]);
    for (const c of KEY_COLORS) this.keyPanels[c].classList.toggle('collected', inv.keys.has(c));

    if (inv.currentWeapon !== this.currentWeaponShown) {
      if (this.currentWeaponShown) this.weaponIcons[this.currentWeaponShown].classList.add('hidden');
      this.weaponIcons[inv.currentWeapon].classList.remove('hidden');
      this.currentWeaponShown = inv.currentWeapon;
    }

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
