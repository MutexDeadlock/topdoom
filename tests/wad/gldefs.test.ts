import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyGldefs, lightForFrame, parseGldefs } from '../../src/wad/gldefs.ts';

/**
 * The GLDEFS grammar: the four frame-bindable light types, the `object`/`frame` blocks that bind
 * them, and the tolerance that keeps a PWAD's GLDEFS from breaking a level load.
 * docs/lights.md § The grammar.
 */
describe('GLDEFS · the grammar', () => {
  test('each of the four light types parses with its own keys', () => {
    const g = parseGldefs(`
      pointlight PL { color 1.0 0.7 0.0  size 84  attenuate 1 }
      pulselight PU { color 0.8 0.8 1.0  size 96  secondarySize 99  interval 0.4 }
      flickerlight FL { color 0.5 0.5 0.0  size 9  secondarySize 12  chance 0.8 }
      flickerlight2 F2 { color 0.7 0.35 0.14  size 90  secondarySize 99  interval 0.1 }
    `);
    assert.deepEqual(
      [...g.lights].map(([name, d]) => [name, d.kind, d.size, d.secondarySize]),
      [
        ['PL', 'point', 84, 84],
        ['PU', 'pulse', 96, 99],
        ['FL', 'flicker', 9, 12],
        ['F2', 'flicker2', 90, 99],
      ],
    );
    assert.deepEqual(
      [g.lights.get('PL')!.r, g.lights.get('PL')!.g, g.lights.get('PL')!.b],
      [1.0, 0.7, 0.0],
    );
    assert.equal(g.lights.get('PU')!.interval, 0.4);
    assert.equal(g.lights.get('FL')!.chance, 0.8);
  });

  test('a point light with no secondarySize takes its own size for both', () => {
    const g = parseGldefs('pointlight P { color 1 1 1  size 40 }');
    assert.equal(g.lights.get('P')!.secondarySize, 40);
  });

  test("offset's middle argument is the vertical one", () => {
    // `offset x up y` — reading it as x/y/z puts every torch flame on the floor.
    const g = parseGldefs('pointlight P { color 1 1 1  size 40  offset 1 44 2 }');
    const d = g.lights.get('P')!;
    assert.deepEqual([d.offX, d.offY, d.offZ], [1, 2, 44]);
  });

  test('size is clamped to GZDoom\'s 1..1024', () => {
    const g = parseGldefs(`
      pointlight TOOBIG { color 1 1 1  size 9000 }
      pointlight TOOSMALL { color 1 1 1  size 0 }
    `);
    assert.equal(g.lights.get('TOOBIG')!.size, 1024);
    assert.equal(g.lights.get('TOOSMALL')!.size, 1);
  });

  test('the flag keys are read, whether or not they carry a value', () => {
    const g = parseGldefs('pulselight P { color 1 1 1  size 20  dontlightself 1  subtractive 1 }');
    const d = g.lights.get('P')!;
    assert.equal(d.dontLightSelf, true);
    assert.equal(d.subtractive, true);
    const off = parseGldefs('pulselight Q { color 1 1 1  size 20  dontlightself 0 }');
    assert.equal(off.lights.get('Q')!.dontLightSelf, false);
  });

  test('keywords and names are case-insensitive, and names are stored uppercased', () => {
    const g = parseGldefs(`
      PointLight MixedCase { COLOR 1 1 1  Size 40 }
      Object Thing { Frame abcd { Light mixedcase } }
    `);
    assert.ok(g.lights.has('MIXEDCASE'));
    assert.equal(g.frames.get('ABCD'), 'MIXEDCASE');
  });

  test('a light defined twice is the later one — GZDoom layers its lumps', () => {
    const g = parseGldefs(`
      pointlight P { color 1 1 1  size 10 }
      pointlight P { color 1 1 1  size 20 }
    `);
    assert.equal(g.lights.get('P')!.size, 20);
  });
});

describe('GLDEFS · tolerance', () => {
  test('a block-commented object binds nothing', () => {
    // The stock file comments out its Spectre binding exactly this way; parsing it anyway would
    // light every spectre in the game.
    const g = parseGldefs(`
      pointlight P { color 1 1 1  size 40 }
      /*
      object Spectre { frame SARG { light P } }
      */
      object Imp { frame TROO { light P } }
    `);
    assert.equal(g.frames.get('SARG'), undefined);
    assert.equal(g.frames.get('TROO'), 'P');
  });

  test('a line comment ends at the newline', () => {
    const g = parseGldefs(`
      // pointlight COMMENTED { color 1 1 1  size 40 }
      pointlight REAL { color 1 1 1  size 40 }
    `);
    assert.deepEqual([...g.lights.keys()], ['REAL']);
  });

  test('block types this engine does not read are skipped whole, nesting included', () => {
    const g = parseGldefs(`
      glow { flats { LAVA1 } }
      brightmap texture SOMETEX { map "bm.png" iwad disablefullbright }
      hardwareshader postprocess scene { shader "x.fp" { uniform float amount } }
      sectorlight SL { color 1 1 1  scale 0.5 }
      pointlight REAL { color 1 1 1  size 40 }
    `);
    assert.deepEqual([...g.lights.keys()], ['REAL']);
  });

  test('an unrecognised key inside a light drops its arguments and parsing carries on', () => {
    const g = parseGldefs(`
      pointlight P { color 1 1 1  spot 10 25  intensity 2  noshadowmap 1  size 40 }
    `);
    assert.equal(g.lights.get('P')!.size, 40);
  });
});

describe('GLDEFS · binding a light to a frame', () => {
  test('a 4-character frame name covers the sprite, a 5-character one a single frame', () => {
    const g = parseGldefs(`
      pointlight WIDE { color 1 1 1  size 10 }
      pointlight ONE { color 1 1 1  size 20 }
      object Torch { frame TRED { light WIDE } }
      object Puff { frame PUFFA { light ONE } }
    `);
    assert.equal(lightForFrame(g, 'TREDA')!.size, 10);
    assert.equal(lightForFrame(g, 'TREDD')!.size, 10);
    assert.equal(lightForFrame(g, 'PUFFA')!.size, 20);
    assert.equal(lightForFrame(g, 'PUFFB'), null);
  });

  test('an exact frame binding beats the sprite-wide one', () => {
    // The stock file's blur sphere: `PINS` covers the sprite, `PINSA`.. override single frames.
    const g = parseGldefs(`
      pointlight WIDE { color 1 1 1  size 60 }
      pointlight NARROW { color 1 1 1  size 48 }
      object BlurSphere {
        frame PINS { light WIDE }
        frame PINSA { light NARROW }
      }
    `);
    assert.equal(lightForFrame(g, 'PINSA')!.size, 48);
    assert.equal(lightForFrame(g, 'PINSB')!.size, 60);
  });

  test('the class name is ignored — two classes may bind the same sprite', () => {
    const g = parseGldefs(`
      pointlight P { color 1 1 1  size 10 }
      object Rocket { frame MISLA { light P } }
      object FatShot { frame MISLB { light P } }
    `);
    assert.equal(lightForFrame(g, 'MISLA')!.size, 10);
    assert.equal(lightForFrame(g, 'MISLB')!.size, 10);
  });

  test('a frame past Z binds under the character vanilla spells it with', () => {
    // The arch-vile's resurrection frames are 26..28, which `String.fromCharCode(65 + frame)`
    // renders as `[`, `\` and `]` — the same characters GLDEFS writes.
    const g = parseGldefs(`
      pulselight ARCHRES { color 0.6 0.3 0.3  size 96 }
      object Archvile { frame VILE[ { light ARCHRES }  frame VILE] { light ARCHRES } }
    `);
    assert.equal(lightForFrame(g, 'VILE[')!.size, 96);
    assert.equal(lightForFrame(g, 'VILE]')!.size, 96);
    assert.equal(lightForFrame(g, 'VILEA'), null);
  });

  test('a binding naming a light that does not exist resolves to nothing', () => {
    const g = parseGldefs('object Thing { frame TROO { light NOSUCH } }');
    assert.equal(lightForFrame(g, 'TROOA'), null);
  });

  test('an empty set and a too-short key resolve to nothing rather than throwing', () => {
    assert.equal(lightForFrame(emptyGldefs(), 'TROOA'), null);
    assert.equal(lightForFrame(parseGldefs('pointlight P { size 4 }'), 'AB'), null);
  });

  test('parsing into an existing set layers over it, replacing by name and by frame', () => {
    const base = parseGldefs(`
      pointlight P { color 1 1 1  size 10 }
      object Thing { frame TROO { light P } }
    `);
    parseGldefs(
      `
      pointlight P { color 1 1 1  size 99 }
      object Thing { frame TROO { light P }  frame SARG { light P } }
    `,
      base,
    );
    assert.equal(lightForFrame(base, 'TROOA')!.size, 99);
    assert.equal(lightForFrame(base, 'SARGA')!.size, 99);
  });
});

describe('GLDEFS · the stock file', () => {
  // Read from `public/` deliberately: this is a committed text asset the feature ships with, not
  // game content — the "tests never read public/wads" rule is about WADs.
  const STOCK = fileURLToPath(new URL('../../public/game/gldefs.txt', import.meta.url));

  test('the shipped definitions parse, and spot checks land on the right light', () => {
    const g = parseGldefs(readFileSync(STOCK, 'latin1'));
    assert.equal(g.lights.size, 104);

    // A rocket in flight: a plain point light.
    const rocket = lightForFrame(g, 'MISLA')!;
    assert.equal(rocket.kind, 'point');
    assert.equal(rocket.size, 84);

    // The tall red torch, bound sprite-wide, with its flame 60 units up.
    const torch = lightForFrame(g, 'TREDB')!;
    assert.equal(torch.kind, 'flicker2');
    assert.equal(torch.offZ, 60);

    // The zombieman's firing frame — the muzzle flash, and the same light the player's `PLAY F`
    // gets (docs/lights.md § What emits).
    assert.ok(lightForFrame(g, 'POSSF'));
    assert.ok(lightForFrame(g, 'PLAYF'));

    // The barrel's idle glow does not light the barrel itself.
    assert.equal(lightForFrame(g, 'BAR1A')!.dontLightSelf, true);

    // The commented-out Spectre binding is not in force.
    assert.equal(lightForFrame(g, 'SARGA'), null);
  });
});
