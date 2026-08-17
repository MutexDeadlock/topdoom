/**
 * Every DOOM thing type (doomednum) this engine knows about, under a readable name.
 *
 * The number is what a map lump actually stores in `Thing.type` (`wad/map.ts`) and what every
 * type-keyed table in `things/tables.ts`, `monsters/tables.ts`, `things/defs.ts` and `inventory.ts` is
 * keyed on; this table only gives those numbers names, so a table entry says which monster it is
 * without a comment having to. Nothing here is a rule about behavior — the rules live in the tables
 * that use these names. See docs/sprites.md § Thing types have names.
 *
 * **Each entry cites its vanilla `mobjtype_t`**, read off `linuxdoom-1.10/info.c`'s `mobjinfo`
 * array (whose order is the `mobjtype_t` order and whose first field is the doomednum) — that
 * pairing, not the readable name, is what makes an entry checkable. The names themselves are the
 * standard editor names for those types.
 *
 * A leaf: this module imports nothing, so any table module can take it without a cycle.
 */
export const ThingType = {
  // Monsters
  zombieman: 3004, // MT_POSSESSED
  shotgunGuy: 9, // MT_SHOTGUY
  imp: 3001, // MT_TROOP
  demon: 3002, // MT_SERGEANT
  spectre: 58, // MT_SHADOWS
  lostSoul: 3006, // MT_SKULL
  cacodemon: 3005, // MT_HEAD
  baronOfHell: 3003, // MT_BRUISER
  hellKnight: 69, // MT_KNIGHT
  spiderMastermind: 7, // MT_SPIDER
  cyberdemon: 16, // MT_CYBORG
  painElemental: 71, // MT_PAIN
  heavyWeaponDude: 65, // MT_CHAINGUY
  revenant: 66, // MT_UNDEAD
  mancubus: 67, // MT_FATSO
  arachnotron: 68, // MT_BABY
  archVile: 64, // MT_VILE
  wolfensteinSS: 84, // MT_WOLFSS
  commanderKeen: 72, // MT_KEEN
  bossBrain: 88, // MT_BOSSBRAIN

  // Weapons
  shotgun: 2001, // MT_SHOTGUN
  superShotgun: 82, // MT_SUPERSHOTGUN
  chaingun: 2002, // MT_CHAINGUN
  rocketLauncher: 2003, // MT_MISC27
  plasmaRifle: 2004, // MT_MISC28
  chainsaw: 2005, // MT_MISC26
  bfg9000: 2006, // MT_MISC25

  // Ammo
  clip: 2007, // MT_CLIP
  boxOfBullets: 2048, // MT_MISC17
  rocket: 2010, // MT_MISC18
  boxOfRockets: 2046, // MT_MISC19
  cellCharge: 2047, // MT_MISC20
  cellChargePack: 17, // MT_MISC21
  shells: 2008, // MT_MISC22
  boxOfShells: 2049, // MT_MISC23
  backpack: 8, // MT_MISC24

  // Health & armor
  stimpack: 2011, // MT_MISC10
  medikit: 2012, // MT_MISC11
  soulsphere: 2013, // MT_MISC12
  healthBonus: 2014, // MT_MISC2
  armorBonus: 2015, // MT_MISC3
  greenArmor: 2018, // MT_MISC0
  blueArmor: 2019, // MT_MISC1
  megasphere: 83, // MT_MEGA

  // Keys
  blueKeycard: 5, // MT_MISC4
  blueSkullKey: 40, // MT_MISC9
  redKeycard: 13, // MT_MISC5
  redSkullKey: 38, // MT_MISC8
  yellowKeycard: 6, // MT_MISC6
  yellowSkullKey: 39, // MT_MISC7

  // Powerups
  invulnerability: 2022, // MT_INV
  berserk: 2023, // MT_MISC13
  invisibility: 2024, // MT_INS
  radiationSuit: 2025, // MT_MISC14
  computerMap: 2026, // MT_MISC15
  lightAmpVisor: 2045, // MT_MISC16

  // Obstacles & decorations
  barrel: 2035, // MT_BARREL
  floorLamp: 2028, // MT_MISC31
  candle: 34, // MT_MISC49
  candelabra: 35, // MT_MISC50
  tallGreenPillar: 30, // MT_MISC32
  shortGreenPillar: 31, // MT_MISC33
  tallRedPillar: 32, // MT_MISC34
  shortRedPillar: 33, // MT_MISC35
  shortGreenPillarHeart: 36, // MT_MISC37
  shortRedPillarSkull: 37, // MT_MISC36
  evilEye: 41, // MT_MISC38
  floatingSkullRock: 42, // MT_MISC39
  tallBlueTorch: 44, // MT_MISC41
  tallGreenTorch: 45, // MT_MISC42
  tallRedTorch: 46, // MT_MISC43
  shortBlueTorch: 55, // MT_MISC44
  shortGreenTorch: 56, // MT_MISC45
  shortRedTorch: 57, // MT_MISC46
  stalagmite: 47, // MT_MISC47
  techPillar: 48, // MT_MISC48
  burningBarrel: 70, // MT_MISC77
  tallTechnoLamp: 85, // MT_MISC29
  shortTechnoLamp: 86, // MT_MISC30
  burntTree: 43, // MT_MISC40
  largeBrownTree: 54, // MT_MISC76
  impaledHuman: 25, // MT_MISC74
  twitchingImpaledHuman: 26, // MT_MISC75
  skullOnPole: 27, // MT_MISC72
  fiveSkullShishKebab: 28, // MT_MISC70
  pileOfSkullsAndCandles: 29, // MT_MISC73

  // Gore & corpses — floor-standing
  bloodyMess: 10, // MT_MISC68
  bloodyMessAlt: 12, // MT_MISC69 — same art as bloodyMess under a second editor number
  deadPlayer: 15, // MT_MISC62
  deadZombieman: 18, // MT_MISC63
  deadShotgunGuy: 19, // MT_MISC67
  deadImp: 20, // MT_MISC66
  deadDemon: 21, // MT_MISC64
  deadCacodemon: 22, // MT_MISC61
  deadLostSoul: 23, // MT_MISC65
  poolOfBloodAndFlesh: 24, // MT_MISC71
  colonGibs: 79, // MT_MISC84
  smallPoolOfBlood: 80, // MT_MISC85
  brainStem: 81, // MT_MISC86

  // Gore — hangs from the ceiling (MF_SPAWNCEILING). The five `…NoBlock` twins are separate
  // vanilla types reusing the same art without MF_SOLID, at a wider radius — not duplicates.
  hangingVictimTwitching: 49, // MT_MISC51
  hangingVictimArmsOut: 50, // MT_MISC52
  hangingVictimOneLegged: 51, // MT_MISC53
  hangingPairOfLegs: 52, // MT_MISC54
  hangingLeg: 53, // MT_MISC55
  hangingVictimArmsOutNoBlock: 59, // MT_MISC56
  hangingPairOfLegsNoBlock: 60, // MT_MISC57
  hangingVictimOneLeggedNoBlock: 61, // MT_MISC58
  hangingLegNoBlock: 62, // MT_MISC59
  hangingVictimTwitchingNoBlock: 63, // MT_MISC60
  hangingVictimGutsRemoved: 73, // MT_MISC78
  hangingVictimGutsAndBrainRemoved: 74, // MT_MISC79
  hangingTorsoLookingDown: 75, // MT_MISC80
  hangingTorsoOpenSkull: 76, // MT_MISC81
  hangingTorsoLookingUp: 77, // MT_MISC82
  hangingTorsoBrainRemoved: 78, // MT_MISC83

  // Markers — spawn points only, never rendered, and deliberately absent from `THING_SPRITES`.
  playerStart: 1, // no mobjinfo entry: P_SpawnMapThing handles types 1-4 itself
  teleportDest: 14, // MT_TELEPORTMAN
  bossTarget: 87, // MT_BOSSTARGET
  bossShooter: 89, // MT_BOSSSPIT
  // Boom's point pusher/puller (MT_PUSH/MT_PULL): the source point a type-226
  // line's force radiates from or pulls toward — see docs/specials.md § Pushers.
  pointPusher: 5001,
  pointPuller: 5002,
} as const;
