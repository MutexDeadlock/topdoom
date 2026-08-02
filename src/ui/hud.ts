import type { GraphicsBank } from '../wad/graphics.ts';
import { AMMO_TYPES, KEY_COLORS, type AmmoType, type Inventory, type KeyColor, type WeaponId } from '../game/inventory.ts';
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
  private armorValue = this.root.querySelector<HTMLElement>('.hud-armor .value')!;
  private armorPanel = this.root.querySelector<HTMLElement>('.hud-armor')!;
  private armorIconGreen = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-green')!;
  private armorIconBlue = this.root.querySelector<HTMLCanvasElement>('.hud-armor .icon-blue')!;
  private ammoValues: Record<AmmoType, HTMLElement>;
  private keyPanels: Record<KeyColor, HTMLElement>;
  private weaponIcons: Record<WeaponId, HTMLCanvasElement>;
  private currentWeaponShown: WeaponId | null = null;

  constructor(gfx: GraphicsBank) {
    drawIcon(this.root.querySelector<HTMLCanvasElement>('.hud-health canvas')!, gfx, 'MEDIA0');
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
    const weaponPanel = this.root.querySelector<HTMLElement>('.hud-weapon')!;
    this.weaponIcons = {} as Record<WeaponId, HTMLCanvasElement>;
    for (const w of WEAPON_CYCLE) {
      const canvas = document.createElement('canvas');
      canvas.className = 'icon hidden';
      drawIcon(canvas, gfx, WEAPONS[w].iconLump);
      weaponPanel.appendChild(canvas);
      this.weaponIcons[w] = canvas;
    }
  }

  update(inv: Inventory): void {
    this.healthValue.textContent = String(Math.max(0, Math.round(inv.health)));
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
  }
}
