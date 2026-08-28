/**
 * Vanilla's frame table as data: `states[]`, `sprnames[]` and each `mobjinfo` row's eight state
 * pointers, transcribed mechanically from `linuxdoom-1.10/info.c` and `info.h`. This is what a
 * DEHACKED `Frame N` record indexes and what `dehacked/frames.ts` walks to re-derive the engine's
 * letter-list tables; it is never stepped at runtime. Read-side and import-free, so the menu can
 * classify a patch through it. See docs/dehacked.md § Frames.
 */

/**
 * One `state_t`: `[sprite, frame, tics, action, next, name]`. `sprite` indexes `SPRITE_NAMES`;
 * `frame`'s low bits are the letter (0 = `A`) and bit 15 is `FF_FULLBRIGHT`; `tics` of -1 holds
 * forever; `action` is the `A_*` name or `''` for `NULL` — kept because the walk loop's chase
 * count and the barrel's `A_Explode` position depend on it, not to run it; `next` is the
 * `nextstate` index; `name` is `info.h`'s `statenum_t` mnemonic, for reports and tests.
 */
export type StateRow = readonly [sprite: number, frame: number, tics: number, action: string, next: number, name: string];

/** `FF_FULLBRIGHT`, `p_pspr.h`: the bit in `state_t.frame` that draws the frame at full light. */
export const FF_FULLBRIGHT = 0x8000;

/** `sprnames[]`, all 138 in `spritenum_t` order. */
export const SPRITE_NAMES: readonly string[] = [
  'TROO', 'SHTG', 'PUNG', 'PISG', 'PISF', 'SHTF', 'SHT2', 'CHGG', 'CHGF', 'MISG',
  'MISF', 'SAWG', 'PLSG', 'PLSF', 'BFGG', 'BFGF', 'BLUD', 'PUFF', 'BAL1', 'BAL2',
  'PLSS', 'PLSE', 'MISL', 'BFS1', 'BFE1', 'BFE2', 'TFOG', 'IFOG', 'PLAY', 'POSS',
  'SPOS', 'VILE', 'FIRE', 'FATB', 'FBXP', 'SKEL', 'MANF', 'FATT', 'CPOS', 'SARG',
  'HEAD', 'BAL7', 'BOSS', 'BOS2', 'SKUL', 'SPID', 'BSPI', 'APLS', 'APBX', 'CYBR',
  'PAIN', 'SSWV', 'KEEN', 'BBRN', 'BOSF', 'ARM1', 'ARM2', 'BAR1', 'BEXP', 'FCAN',
  'BON1', 'BON2', 'BKEY', 'RKEY', 'YKEY', 'BSKU', 'RSKU', 'YSKU', 'STIM', 'MEDI',
  'SOUL', 'PINV', 'PSTR', 'PINS', 'MEGA', 'SUIT', 'PMAP', 'PVIS', 'CLIP', 'AMMO',
  'ROCK', 'BROK', 'CELL', 'CELP', 'SHEL', 'SBOX', 'BPAK', 'BFUG', 'MGUN', 'CSAW',
  'LAUN', 'PLAS', 'SHOT', 'SGN2', 'COLU', 'SMT2', 'GOR1', 'POL2', 'POL5', 'POL4',
  'POL3', 'POL1', 'POL6', 'GOR2', 'GOR3', 'GOR4', 'GOR5', 'SMIT', 'COL1', 'COL2',
  'COL3', 'COL4', 'CAND', 'CBRA', 'COL6', 'TRE1', 'TRE2', 'ELEC', 'CEYE', 'FSKU',
  'COL5', 'TBLU', 'TGRN', 'TRED', 'SMBT', 'SMGT', 'SMRT', 'HDB1', 'HDB2', 'HDB3',
  'HDB4', 'HDB5', 'HDB6', 'POB1', 'POB2', 'BRS1', 'TLMP', 'TLP2',
];

/**
 * `states[]`, all 967 in `statenum_t` order. Index 0 is `S_NULL`, the "no state" every
 * `mobjinfo` pointer that doesn't exist points at, and the state a chain that expires into nothing
 * steps to. A DEH `Frame N` is the 0-based index here.
 */
export const STATES: readonly StateRow[] = [
  [0, 0, -1, '', 0, 'S_NULL'], // 0
  [1, 4, 0, 'A_Light0', 0, 'S_LIGHTDONE'], // 1
  [2, 0, 1, 'A_WeaponReady', 2, 'S_PUNCH'], // 2
  [2, 0, 1, 'A_Lower', 3, 'S_PUNCHDOWN'], // 3
  [2, 0, 1, 'A_Raise', 4, 'S_PUNCHUP'], // 4
  [2, 1, 4, '', 6, 'S_PUNCH1'], // 5
  [2, 2, 4, 'A_Punch', 7, 'S_PUNCH2'], // 6
  [2, 3, 5, '', 8, 'S_PUNCH3'], // 7
  [2, 2, 4, '', 9, 'S_PUNCH4'], // 8
  [2, 1, 5, 'A_ReFire', 2, 'S_PUNCH5'], // 9
  [3, 0, 1, 'A_WeaponReady', 10, 'S_PISTOL'], // 10
  [3, 0, 1, 'A_Lower', 11, 'S_PISTOLDOWN'], // 11
  [3, 0, 1, 'A_Raise', 12, 'S_PISTOLUP'], // 12
  [3, 0, 4, '', 14, 'S_PISTOL1'], // 13
  [3, 1, 6, 'A_FirePistol', 15, 'S_PISTOL2'], // 14
  [3, 2, 4, '', 16, 'S_PISTOL3'], // 15
  [3, 1, 5, 'A_ReFire', 10, 'S_PISTOL4'], // 16
  [4, 32768, 7, 'A_Light1', 1, 'S_PISTOLFLASH'], // 17
  [1, 0, 1, 'A_WeaponReady', 18, 'S_SGUN'], // 18
  [1, 0, 1, 'A_Lower', 19, 'S_SGUNDOWN'], // 19
  [1, 0, 1, 'A_Raise', 20, 'S_SGUNUP'], // 20
  [1, 0, 3, '', 22, 'S_SGUN1'], // 21
  [1, 0, 7, 'A_FireShotgun', 23, 'S_SGUN2'], // 22
  [1, 1, 5, '', 24, 'S_SGUN3'], // 23
  [1, 2, 5, '', 25, 'S_SGUN4'], // 24
  [1, 3, 4, '', 26, 'S_SGUN5'], // 25
  [1, 2, 5, '', 27, 'S_SGUN6'], // 26
  [1, 1, 5, '', 28, 'S_SGUN7'], // 27
  [1, 0, 3, '', 29, 'S_SGUN8'], // 28
  [1, 0, 7, 'A_ReFire', 18, 'S_SGUN9'], // 29
  [5, 32768, 4, 'A_Light1', 31, 'S_SGUNFLASH1'], // 30
  [5, 32769, 3, 'A_Light2', 1, 'S_SGUNFLASH2'], // 31
  [6, 0, 1, 'A_WeaponReady', 32, 'S_DSGUN'], // 32
  [6, 0, 1, 'A_Lower', 33, 'S_DSGUNDOWN'], // 33
  [6, 0, 1, 'A_Raise', 34, 'S_DSGUNUP'], // 34
  [6, 0, 3, '', 36, 'S_DSGUN1'], // 35
  [6, 0, 7, 'A_FireShotgun2', 37, 'S_DSGUN2'], // 36
  [6, 1, 7, '', 38, 'S_DSGUN3'], // 37
  [6, 2, 7, 'A_CheckReload', 39, 'S_DSGUN4'], // 38
  [6, 3, 7, 'A_OpenShotgun2', 40, 'S_DSGUN5'], // 39
  [6, 4, 7, '', 41, 'S_DSGUN6'], // 40
  [6, 5, 7, 'A_LoadShotgun2', 42, 'S_DSGUN7'], // 41
  [6, 6, 6, '', 43, 'S_DSGUN8'], // 42
  [6, 7, 6, 'A_CloseShotgun2', 44, 'S_DSGUN9'], // 43
  [6, 0, 5, 'A_ReFire', 32, 'S_DSGUN10'], // 44
  [6, 1, 7, '', 46, 'S_DSNR1'], // 45
  [6, 0, 3, '', 33, 'S_DSNR2'], // 46
  [6, 32776, 5, 'A_Light1', 48, 'S_DSGUNFLASH1'], // 47
  [6, 32777, 4, 'A_Light2', 1, 'S_DSGUNFLASH2'], // 48
  [7, 0, 1, 'A_WeaponReady', 49, 'S_CHAIN'], // 49
  [7, 0, 1, 'A_Lower', 50, 'S_CHAINDOWN'], // 50
  [7, 0, 1, 'A_Raise', 51, 'S_CHAINUP'], // 51
  [7, 0, 4, 'A_FireCGun', 53, 'S_CHAIN1'], // 52
  [7, 1, 4, 'A_FireCGun', 54, 'S_CHAIN2'], // 53
  [7, 1, 0, 'A_ReFire', 49, 'S_CHAIN3'], // 54
  [8, 32768, 5, 'A_Light1', 1, 'S_CHAINFLASH1'], // 55
  [8, 32769, 5, 'A_Light2', 1, 'S_CHAINFLASH2'], // 56
  [9, 0, 1, 'A_WeaponReady', 57, 'S_MISSILE'], // 57
  [9, 0, 1, 'A_Lower', 58, 'S_MISSILEDOWN'], // 58
  [9, 0, 1, 'A_Raise', 59, 'S_MISSILEUP'], // 59
  [9, 1, 8, 'A_GunFlash', 61, 'S_MISSILE1'], // 60
  [9, 1, 12, 'A_FireMissile', 62, 'S_MISSILE2'], // 61
  [9, 1, 0, 'A_ReFire', 57, 'S_MISSILE3'], // 62
  [10, 32768, 3, 'A_Light1', 64, 'S_MISSILEFLASH1'], // 63
  [10, 32769, 4, '', 65, 'S_MISSILEFLASH2'], // 64
  [10, 32770, 4, 'A_Light2', 66, 'S_MISSILEFLASH3'], // 65
  [10, 32771, 4, 'A_Light2', 1, 'S_MISSILEFLASH4'], // 66
  [11, 2, 4, 'A_WeaponReady', 68, 'S_SAW'], // 67
  [11, 3, 4, 'A_WeaponReady', 67, 'S_SAWB'], // 68
  [11, 2, 1, 'A_Lower', 69, 'S_SAWDOWN'], // 69
  [11, 2, 1, 'A_Raise', 70, 'S_SAWUP'], // 70
  [11, 0, 4, 'A_Saw', 72, 'S_SAW1'], // 71
  [11, 1, 4, 'A_Saw', 73, 'S_SAW2'], // 72
  [11, 1, 0, 'A_ReFire', 67, 'S_SAW3'], // 73
  [12, 0, 1, 'A_WeaponReady', 74, 'S_PLASMA'], // 74
  [12, 0, 1, 'A_Lower', 75, 'S_PLASMADOWN'], // 75
  [12, 0, 1, 'A_Raise', 76, 'S_PLASMAUP'], // 76
  [12, 0, 3, 'A_FirePlasma', 78, 'S_PLASMA1'], // 77
  [12, 1, 20, 'A_ReFire', 74, 'S_PLASMA2'], // 78
  [13, 32768, 4, 'A_Light1', 1, 'S_PLASMAFLASH1'], // 79
  [13, 32769, 4, 'A_Light1', 1, 'S_PLASMAFLASH2'], // 80
  [14, 0, 1, 'A_WeaponReady', 81, 'S_BFG'], // 81
  [14, 0, 1, 'A_Lower', 82, 'S_BFGDOWN'], // 82
  [14, 0, 1, 'A_Raise', 83, 'S_BFGUP'], // 83
  [14, 0, 20, 'A_BFGsound', 85, 'S_BFG1'], // 84
  [14, 1, 10, 'A_GunFlash', 86, 'S_BFG2'], // 85
  [14, 1, 10, 'A_FireBFG', 87, 'S_BFG3'], // 86
  [14, 1, 20, 'A_ReFire', 81, 'S_BFG4'], // 87
  [15, 32768, 11, 'A_Light1', 89, 'S_BFGFLASH1'], // 88
  [15, 32769, 6, 'A_Light2', 1, 'S_BFGFLASH2'], // 89
  [16, 2, 8, '', 91, 'S_BLOOD1'], // 90
  [16, 1, 8, '', 92, 'S_BLOOD2'], // 91
  [16, 0, 8, '', 0, 'S_BLOOD3'], // 92
  [17, 32768, 4, '', 94, 'S_PUFF1'], // 93
  [17, 1, 4, '', 95, 'S_PUFF2'], // 94
  [17, 2, 4, '', 96, 'S_PUFF3'], // 95
  [17, 3, 4, '', 0, 'S_PUFF4'], // 96
  [18, 32768, 4, '', 98, 'S_TBALL1'], // 97
  [18, 32769, 4, '', 97, 'S_TBALL2'], // 98
  [18, 32770, 6, '', 100, 'S_TBALLX1'], // 99
  [18, 32771, 6, '', 101, 'S_TBALLX2'], // 100
  [18, 32772, 6, '', 0, 'S_TBALLX3'], // 101
  [19, 32768, 4, '', 103, 'S_RBALL1'], // 102
  [19, 32769, 4, '', 102, 'S_RBALL2'], // 103
  [19, 32770, 6, '', 105, 'S_RBALLX1'], // 104
  [19, 32771, 6, '', 106, 'S_RBALLX2'], // 105
  [19, 32772, 6, '', 0, 'S_RBALLX3'], // 106
  [20, 32768, 6, '', 108, 'S_PLASBALL'], // 107
  [20, 32769, 6, '', 107, 'S_PLASBALL2'], // 108
  [21, 32768, 4, '', 110, 'S_PLASEXP'], // 109
  [21, 32769, 4, '', 111, 'S_PLASEXP2'], // 110
  [21, 32770, 4, '', 112, 'S_PLASEXP3'], // 111
  [21, 32771, 4, '', 113, 'S_PLASEXP4'], // 112
  [21, 32772, 4, '', 0, 'S_PLASEXP5'], // 113
  [22, 32768, 1, '', 114, 'S_ROCKET'], // 114
  [23, 32768, 4, '', 116, 'S_BFGSHOT'], // 115
  [23, 32769, 4, '', 115, 'S_BFGSHOT2'], // 116
  [24, 32768, 8, '', 118, 'S_BFGLAND'], // 117
  [24, 32769, 8, '', 119, 'S_BFGLAND2'], // 118
  [24, 32770, 8, 'A_BFGSpray', 120, 'S_BFGLAND3'], // 119
  [24, 32771, 8, '', 121, 'S_BFGLAND4'], // 120
  [24, 32772, 8, '', 122, 'S_BFGLAND5'], // 121
  [24, 32773, 8, '', 0, 'S_BFGLAND6'], // 122
  [25, 32768, 8, '', 124, 'S_BFGEXP'], // 123
  [25, 32769, 8, '', 125, 'S_BFGEXP2'], // 124
  [25, 32770, 8, '', 126, 'S_BFGEXP3'], // 125
  [25, 32771, 8, '', 0, 'S_BFGEXP4'], // 126
  [22, 32769, 8, 'A_Explode', 128, 'S_EXPLODE1'], // 127
  [22, 32770, 6, '', 129, 'S_EXPLODE2'], // 128
  [22, 32771, 4, '', 0, 'S_EXPLODE3'], // 129
  [26, 32768, 6, '', 131, 'S_TFOG'], // 130
  [26, 32769, 6, '', 132, 'S_TFOG01'], // 131
  [26, 32768, 6, '', 133, 'S_TFOG02'], // 132
  [26, 32769, 6, '', 134, 'S_TFOG2'], // 133
  [26, 32770, 6, '', 135, 'S_TFOG3'], // 134
  [26, 32771, 6, '', 136, 'S_TFOG4'], // 135
  [26, 32772, 6, '', 137, 'S_TFOG5'], // 136
  [26, 32773, 6, '', 138, 'S_TFOG6'], // 137
  [26, 32774, 6, '', 139, 'S_TFOG7'], // 138
  [26, 32775, 6, '', 140, 'S_TFOG8'], // 139
  [26, 32776, 6, '', 141, 'S_TFOG9'], // 140
  [26, 32777, 6, '', 0, 'S_TFOG10'], // 141
  [27, 32768, 6, '', 143, 'S_IFOG'], // 142
  [27, 32769, 6, '', 144, 'S_IFOG01'], // 143
  [27, 32768, 6, '', 145, 'S_IFOG02'], // 144
  [27, 32769, 6, '', 146, 'S_IFOG2'], // 145
  [27, 32770, 6, '', 147, 'S_IFOG3'], // 146
  [27, 32771, 6, '', 148, 'S_IFOG4'], // 147
  [27, 32772, 6, '', 0, 'S_IFOG5'], // 148
  [28, 0, -1, '', 0, 'S_PLAY'], // 149
  [28, 0, 4, '', 151, 'S_PLAY_RUN1'], // 150
  [28, 1, 4, '', 152, 'S_PLAY_RUN2'], // 151
  [28, 2, 4, '', 153, 'S_PLAY_RUN3'], // 152
  [28, 3, 4, '', 150, 'S_PLAY_RUN4'], // 153
  [28, 4, 12, '', 149, 'S_PLAY_ATK1'], // 154
  [28, 32773, 6, '', 154, 'S_PLAY_ATK2'], // 155
  [28, 6, 4, '', 157, 'S_PLAY_PAIN'], // 156
  [28, 6, 4, 'A_Pain', 149, 'S_PLAY_PAIN2'], // 157
  [28, 7, 10, '', 159, 'S_PLAY_DIE1'], // 158
  [28, 8, 10, 'A_PlayerScream', 160, 'S_PLAY_DIE2'], // 159
  [28, 9, 10, 'A_Fall', 161, 'S_PLAY_DIE3'], // 160
  [28, 10, 10, '', 162, 'S_PLAY_DIE4'], // 161
  [28, 11, 10, '', 163, 'S_PLAY_DIE5'], // 162
  [28, 12, 10, '', 164, 'S_PLAY_DIE6'], // 163
  [28, 13, -1, '', 0, 'S_PLAY_DIE7'], // 164
  [28, 14, 5, '', 166, 'S_PLAY_XDIE1'], // 165
  [28, 15, 5, 'A_XScream', 167, 'S_PLAY_XDIE2'], // 166
  [28, 16, 5, 'A_Fall', 168, 'S_PLAY_XDIE3'], // 167
  [28, 17, 5, '', 169, 'S_PLAY_XDIE4'], // 168
  [28, 18, 5, '', 170, 'S_PLAY_XDIE5'], // 169
  [28, 19, 5, '', 171, 'S_PLAY_XDIE6'], // 170
  [28, 20, 5, '', 172, 'S_PLAY_XDIE7'], // 171
  [28, 21, 5, '', 173, 'S_PLAY_XDIE8'], // 172
  [28, 22, -1, '', 0, 'S_PLAY_XDIE9'], // 173
  [29, 0, 10, 'A_Look', 175, 'S_POSS_STND'], // 174
  [29, 1, 10, 'A_Look', 174, 'S_POSS_STND2'], // 175
  [29, 0, 4, 'A_Chase', 177, 'S_POSS_RUN1'], // 176
  [29, 0, 4, 'A_Chase', 178, 'S_POSS_RUN2'], // 177
  [29, 1, 4, 'A_Chase', 179, 'S_POSS_RUN3'], // 178
  [29, 1, 4, 'A_Chase', 180, 'S_POSS_RUN4'], // 179
  [29, 2, 4, 'A_Chase', 181, 'S_POSS_RUN5'], // 180
  [29, 2, 4, 'A_Chase', 182, 'S_POSS_RUN6'], // 181
  [29, 3, 4, 'A_Chase', 183, 'S_POSS_RUN7'], // 182
  [29, 3, 4, 'A_Chase', 176, 'S_POSS_RUN8'], // 183
  [29, 4, 10, 'A_FaceTarget', 185, 'S_POSS_ATK1'], // 184
  [29, 5, 8, 'A_PosAttack', 186, 'S_POSS_ATK2'], // 185
  [29, 4, 8, '', 176, 'S_POSS_ATK3'], // 186
  [29, 6, 3, '', 188, 'S_POSS_PAIN'], // 187
  [29, 6, 3, 'A_Pain', 176, 'S_POSS_PAIN2'], // 188
  [29, 7, 5, '', 190, 'S_POSS_DIE1'], // 189
  [29, 8, 5, 'A_Scream', 191, 'S_POSS_DIE2'], // 190
  [29, 9, 5, 'A_Fall', 192, 'S_POSS_DIE3'], // 191
  [29, 10, 5, '', 193, 'S_POSS_DIE4'], // 192
  [29, 11, -1, '', 0, 'S_POSS_DIE5'], // 193
  [29, 12, 5, '', 195, 'S_POSS_XDIE1'], // 194
  [29, 13, 5, 'A_XScream', 196, 'S_POSS_XDIE2'], // 195
  [29, 14, 5, 'A_Fall', 197, 'S_POSS_XDIE3'], // 196
  [29, 15, 5, '', 198, 'S_POSS_XDIE4'], // 197
  [29, 16, 5, '', 199, 'S_POSS_XDIE5'], // 198
  [29, 17, 5, '', 200, 'S_POSS_XDIE6'], // 199
  [29, 18, 5, '', 201, 'S_POSS_XDIE7'], // 200
  [29, 19, 5, '', 202, 'S_POSS_XDIE8'], // 201
  [29, 20, -1, '', 0, 'S_POSS_XDIE9'], // 202
  [29, 10, 5, '', 204, 'S_POSS_RAISE1'], // 203
  [29, 9, 5, '', 205, 'S_POSS_RAISE2'], // 204
  [29, 8, 5, '', 206, 'S_POSS_RAISE3'], // 205
  [29, 7, 5, '', 176, 'S_POSS_RAISE4'], // 206
  [30, 0, 10, 'A_Look', 208, 'S_SPOS_STND'], // 207
  [30, 1, 10, 'A_Look', 207, 'S_SPOS_STND2'], // 208
  [30, 0, 3, 'A_Chase', 210, 'S_SPOS_RUN1'], // 209
  [30, 0, 3, 'A_Chase', 211, 'S_SPOS_RUN2'], // 210
  [30, 1, 3, 'A_Chase', 212, 'S_SPOS_RUN3'], // 211
  [30, 1, 3, 'A_Chase', 213, 'S_SPOS_RUN4'], // 212
  [30, 2, 3, 'A_Chase', 214, 'S_SPOS_RUN5'], // 213
  [30, 2, 3, 'A_Chase', 215, 'S_SPOS_RUN6'], // 214
  [30, 3, 3, 'A_Chase', 216, 'S_SPOS_RUN7'], // 215
  [30, 3, 3, 'A_Chase', 209, 'S_SPOS_RUN8'], // 216
  [30, 4, 10, 'A_FaceTarget', 218, 'S_SPOS_ATK1'], // 217
  [30, 32773, 10, 'A_SPosAttack', 219, 'S_SPOS_ATK2'], // 218
  [30, 4, 10, '', 209, 'S_SPOS_ATK3'], // 219
  [30, 6, 3, '', 221, 'S_SPOS_PAIN'], // 220
  [30, 6, 3, 'A_Pain', 209, 'S_SPOS_PAIN2'], // 221
  [30, 7, 5, '', 223, 'S_SPOS_DIE1'], // 222
  [30, 8, 5, 'A_Scream', 224, 'S_SPOS_DIE2'], // 223
  [30, 9, 5, 'A_Fall', 225, 'S_SPOS_DIE3'], // 224
  [30, 10, 5, '', 226, 'S_SPOS_DIE4'], // 225
  [30, 11, -1, '', 0, 'S_SPOS_DIE5'], // 226
  [30, 12, 5, '', 228, 'S_SPOS_XDIE1'], // 227
  [30, 13, 5, 'A_XScream', 229, 'S_SPOS_XDIE2'], // 228
  [30, 14, 5, 'A_Fall', 230, 'S_SPOS_XDIE3'], // 229
  [30, 15, 5, '', 231, 'S_SPOS_XDIE4'], // 230
  [30, 16, 5, '', 232, 'S_SPOS_XDIE5'], // 231
  [30, 17, 5, '', 233, 'S_SPOS_XDIE6'], // 232
  [30, 18, 5, '', 234, 'S_SPOS_XDIE7'], // 233
  [30, 19, 5, '', 235, 'S_SPOS_XDIE8'], // 234
  [30, 20, -1, '', 0, 'S_SPOS_XDIE9'], // 235
  [30, 11, 5, '', 237, 'S_SPOS_RAISE1'], // 236
  [30, 10, 5, '', 238, 'S_SPOS_RAISE2'], // 237
  [30, 9, 5, '', 239, 'S_SPOS_RAISE3'], // 238
  [30, 8, 5, '', 240, 'S_SPOS_RAISE4'], // 239
  [30, 7, 5, '', 209, 'S_SPOS_RAISE5'], // 240
  [31, 0, 10, 'A_Look', 242, 'S_VILE_STND'], // 241
  [31, 1, 10, 'A_Look', 241, 'S_VILE_STND2'], // 242
  [31, 0, 2, 'A_VileChase', 244, 'S_VILE_RUN1'], // 243
  [31, 0, 2, 'A_VileChase', 245, 'S_VILE_RUN2'], // 244
  [31, 1, 2, 'A_VileChase', 246, 'S_VILE_RUN3'], // 245
  [31, 1, 2, 'A_VileChase', 247, 'S_VILE_RUN4'], // 246
  [31, 2, 2, 'A_VileChase', 248, 'S_VILE_RUN5'], // 247
  [31, 2, 2, 'A_VileChase', 249, 'S_VILE_RUN6'], // 248
  [31, 3, 2, 'A_VileChase', 250, 'S_VILE_RUN7'], // 249
  [31, 3, 2, 'A_VileChase', 251, 'S_VILE_RUN8'], // 250
  [31, 4, 2, 'A_VileChase', 252, 'S_VILE_RUN9'], // 251
  [31, 4, 2, 'A_VileChase', 253, 'S_VILE_RUN10'], // 252
  [31, 5, 2, 'A_VileChase', 254, 'S_VILE_RUN11'], // 253
  [31, 5, 2, 'A_VileChase', 243, 'S_VILE_RUN12'], // 254
  [31, 32774, 0, 'A_VileStart', 256, 'S_VILE_ATK1'], // 255
  [31, 32774, 10, 'A_FaceTarget', 257, 'S_VILE_ATK2'], // 256
  [31, 32775, 8, 'A_VileTarget', 258, 'S_VILE_ATK3'], // 257
  [31, 32776, 8, 'A_FaceTarget', 259, 'S_VILE_ATK4'], // 258
  [31, 32777, 8, 'A_FaceTarget', 260, 'S_VILE_ATK5'], // 259
  [31, 32778, 8, 'A_FaceTarget', 261, 'S_VILE_ATK6'], // 260
  [31, 32779, 8, 'A_FaceTarget', 262, 'S_VILE_ATK7'], // 261
  [31, 32780, 8, 'A_FaceTarget', 263, 'S_VILE_ATK8'], // 262
  [31, 32781, 8, 'A_FaceTarget', 264, 'S_VILE_ATK9'], // 263
  [31, 32782, 8, 'A_VileAttack', 265, 'S_VILE_ATK10'], // 264
  [31, 32783, 20, '', 243, 'S_VILE_ATK11'], // 265
  [31, 32794, 10, '', 267, 'S_VILE_HEAL1'], // 266
  [31, 32795, 10, '', 268, 'S_VILE_HEAL2'], // 267
  [31, 32796, 10, '', 243, 'S_VILE_HEAL3'], // 268
  [31, 16, 5, '', 270, 'S_VILE_PAIN'], // 269
  [31, 16, 5, 'A_Pain', 243, 'S_VILE_PAIN2'], // 270
  [31, 16, 7, '', 272, 'S_VILE_DIE1'], // 271
  [31, 17, 7, 'A_Scream', 273, 'S_VILE_DIE2'], // 272
  [31, 18, 7, 'A_Fall', 274, 'S_VILE_DIE3'], // 273
  [31, 19, 7, '', 275, 'S_VILE_DIE4'], // 274
  [31, 20, 7, '', 276, 'S_VILE_DIE5'], // 275
  [31, 21, 7, '', 277, 'S_VILE_DIE6'], // 276
  [31, 22, 7, '', 278, 'S_VILE_DIE7'], // 277
  [31, 23, 5, '', 279, 'S_VILE_DIE8'], // 278
  [31, 24, 5, '', 280, 'S_VILE_DIE9'], // 279
  [31, 25, -1, '', 0, 'S_VILE_DIE10'], // 280
  [32, 32768, 2, 'A_StartFire', 282, 'S_FIRE1'], // 281
  [32, 32769, 2, 'A_Fire', 283, 'S_FIRE2'], // 282
  [32, 32768, 2, 'A_Fire', 284, 'S_FIRE3'], // 283
  [32, 32769, 2, 'A_Fire', 285, 'S_FIRE4'], // 284
  [32, 32770, 2, 'A_FireCrackle', 286, 'S_FIRE5'], // 285
  [32, 32769, 2, 'A_Fire', 287, 'S_FIRE6'], // 286
  [32, 32770, 2, 'A_Fire', 288, 'S_FIRE7'], // 287
  [32, 32769, 2, 'A_Fire', 289, 'S_FIRE8'], // 288
  [32, 32770, 2, 'A_Fire', 290, 'S_FIRE9'], // 289
  [32, 32771, 2, 'A_Fire', 291, 'S_FIRE10'], // 290
  [32, 32770, 2, 'A_Fire', 292, 'S_FIRE11'], // 291
  [32, 32771, 2, 'A_Fire', 293, 'S_FIRE12'], // 292
  [32, 32770, 2, 'A_Fire', 294, 'S_FIRE13'], // 293
  [32, 32771, 2, 'A_Fire', 295, 'S_FIRE14'], // 294
  [32, 32772, 2, 'A_Fire', 296, 'S_FIRE15'], // 295
  [32, 32771, 2, 'A_Fire', 297, 'S_FIRE16'], // 296
  [32, 32772, 2, 'A_Fire', 298, 'S_FIRE17'], // 297
  [32, 32771, 2, 'A_Fire', 299, 'S_FIRE18'], // 298
  [32, 32772, 2, 'A_FireCrackle', 300, 'S_FIRE19'], // 299
  [32, 32773, 2, 'A_Fire', 301, 'S_FIRE20'], // 300
  [32, 32772, 2, 'A_Fire', 302, 'S_FIRE21'], // 301
  [32, 32773, 2, 'A_Fire', 303, 'S_FIRE22'], // 302
  [32, 32772, 2, 'A_Fire', 304, 'S_FIRE23'], // 303
  [32, 32773, 2, 'A_Fire', 305, 'S_FIRE24'], // 304
  [32, 32774, 2, 'A_Fire', 306, 'S_FIRE25'], // 305
  [32, 32775, 2, 'A_Fire', 307, 'S_FIRE26'], // 306
  [32, 32774, 2, 'A_Fire', 308, 'S_FIRE27'], // 307
  [32, 32775, 2, 'A_Fire', 309, 'S_FIRE28'], // 308
  [32, 32774, 2, 'A_Fire', 310, 'S_FIRE29'], // 309
  [32, 32775, 2, 'A_Fire', 0, 'S_FIRE30'], // 310
  [17, 1, 4, '', 312, 'S_SMOKE1'], // 311
  [17, 2, 4, '', 313, 'S_SMOKE2'], // 312
  [17, 1, 4, '', 314, 'S_SMOKE3'], // 313
  [17, 2, 4, '', 315, 'S_SMOKE4'], // 314
  [17, 3, 4, '', 0, 'S_SMOKE5'], // 315
  [33, 32768, 2, 'A_Tracer', 317, 'S_TRACER'], // 316
  [33, 32769, 2, 'A_Tracer', 316, 'S_TRACER2'], // 317
  [34, 32768, 8, '', 319, 'S_TRACEEXP1'], // 318
  [34, 32769, 6, '', 320, 'S_TRACEEXP2'], // 319
  [34, 32770, 4, '', 0, 'S_TRACEEXP3'], // 320
  [35, 0, 10, 'A_Look', 322, 'S_SKEL_STND'], // 321
  [35, 1, 10, 'A_Look', 321, 'S_SKEL_STND2'], // 322
  [35, 0, 2, 'A_Chase', 324, 'S_SKEL_RUN1'], // 323
  [35, 0, 2, 'A_Chase', 325, 'S_SKEL_RUN2'], // 324
  [35, 1, 2, 'A_Chase', 326, 'S_SKEL_RUN3'], // 325
  [35, 1, 2, 'A_Chase', 327, 'S_SKEL_RUN4'], // 326
  [35, 2, 2, 'A_Chase', 328, 'S_SKEL_RUN5'], // 327
  [35, 2, 2, 'A_Chase', 329, 'S_SKEL_RUN6'], // 328
  [35, 3, 2, 'A_Chase', 330, 'S_SKEL_RUN7'], // 329
  [35, 3, 2, 'A_Chase', 331, 'S_SKEL_RUN8'], // 330
  [35, 4, 2, 'A_Chase', 332, 'S_SKEL_RUN9'], // 331
  [35, 4, 2, 'A_Chase', 333, 'S_SKEL_RUN10'], // 332
  [35, 5, 2, 'A_Chase', 334, 'S_SKEL_RUN11'], // 333
  [35, 5, 2, 'A_Chase', 323, 'S_SKEL_RUN12'], // 334
  [35, 6, 0, 'A_FaceTarget', 336, 'S_SKEL_FIST1'], // 335
  [35, 6, 6, 'A_SkelWhoosh', 337, 'S_SKEL_FIST2'], // 336
  [35, 7, 6, 'A_FaceTarget', 338, 'S_SKEL_FIST3'], // 337
  [35, 8, 6, 'A_SkelFist', 323, 'S_SKEL_FIST4'], // 338
  [35, 32777, 0, 'A_FaceTarget', 340, 'S_SKEL_MISS1'], // 339
  [35, 32777, 10, 'A_FaceTarget', 341, 'S_SKEL_MISS2'], // 340
  [35, 10, 10, 'A_SkelMissile', 342, 'S_SKEL_MISS3'], // 341
  [35, 10, 10, 'A_FaceTarget', 323, 'S_SKEL_MISS4'], // 342
  [35, 11, 5, '', 344, 'S_SKEL_PAIN'], // 343
  [35, 11, 5, 'A_Pain', 323, 'S_SKEL_PAIN2'], // 344
  [35, 11, 7, '', 346, 'S_SKEL_DIE1'], // 345
  [35, 12, 7, '', 347, 'S_SKEL_DIE2'], // 346
  [35, 13, 7, 'A_Scream', 348, 'S_SKEL_DIE3'], // 347
  [35, 14, 7, 'A_Fall', 349, 'S_SKEL_DIE4'], // 348
  [35, 15, 7, '', 350, 'S_SKEL_DIE5'], // 349
  [35, 16, -1, '', 0, 'S_SKEL_DIE6'], // 350
  [35, 16, 5, '', 352, 'S_SKEL_RAISE1'], // 351
  [35, 15, 5, '', 353, 'S_SKEL_RAISE2'], // 352
  [35, 14, 5, '', 354, 'S_SKEL_RAISE3'], // 353
  [35, 13, 5, '', 355, 'S_SKEL_RAISE4'], // 354
  [35, 12, 5, '', 356, 'S_SKEL_RAISE5'], // 355
  [35, 11, 5, '', 323, 'S_SKEL_RAISE6'], // 356
  [36, 32768, 4, '', 358, 'S_FATSHOT1'], // 357
  [36, 32769, 4, '', 357, 'S_FATSHOT2'], // 358
  [22, 32769, 8, '', 360, 'S_FATSHOTX1'], // 359
  [22, 32770, 6, '', 361, 'S_FATSHOTX2'], // 360
  [22, 32771, 4, '', 0, 'S_FATSHOTX3'], // 361
  [37, 0, 15, 'A_Look', 363, 'S_FATT_STND'], // 362
  [37, 1, 15, 'A_Look', 362, 'S_FATT_STND2'], // 363
  [37, 0, 4, 'A_Chase', 365, 'S_FATT_RUN1'], // 364
  [37, 0, 4, 'A_Chase', 366, 'S_FATT_RUN2'], // 365
  [37, 1, 4, 'A_Chase', 367, 'S_FATT_RUN3'], // 366
  [37, 1, 4, 'A_Chase', 368, 'S_FATT_RUN4'], // 367
  [37, 2, 4, 'A_Chase', 369, 'S_FATT_RUN5'], // 368
  [37, 2, 4, 'A_Chase', 370, 'S_FATT_RUN6'], // 369
  [37, 3, 4, 'A_Chase', 371, 'S_FATT_RUN7'], // 370
  [37, 3, 4, 'A_Chase', 372, 'S_FATT_RUN8'], // 371
  [37, 4, 4, 'A_Chase', 373, 'S_FATT_RUN9'], // 372
  [37, 4, 4, 'A_Chase', 374, 'S_FATT_RUN10'], // 373
  [37, 5, 4, 'A_Chase', 375, 'S_FATT_RUN11'], // 374
  [37, 5, 4, 'A_Chase', 364, 'S_FATT_RUN12'], // 375
  [37, 6, 20, 'A_FatRaise', 377, 'S_FATT_ATK1'], // 376
  [37, 32775, 10, 'A_FatAttack1', 378, 'S_FATT_ATK2'], // 377
  [37, 8, 5, 'A_FaceTarget', 379, 'S_FATT_ATK3'], // 378
  [37, 6, 5, 'A_FaceTarget', 380, 'S_FATT_ATK4'], // 379
  [37, 32775, 10, 'A_FatAttack2', 381, 'S_FATT_ATK5'], // 380
  [37, 8, 5, 'A_FaceTarget', 382, 'S_FATT_ATK6'], // 381
  [37, 6, 5, 'A_FaceTarget', 383, 'S_FATT_ATK7'], // 382
  [37, 32775, 10, 'A_FatAttack3', 384, 'S_FATT_ATK8'], // 383
  [37, 8, 5, 'A_FaceTarget', 385, 'S_FATT_ATK9'], // 384
  [37, 6, 5, 'A_FaceTarget', 364, 'S_FATT_ATK10'], // 385
  [37, 9, 3, '', 387, 'S_FATT_PAIN'], // 386
  [37, 9, 3, 'A_Pain', 364, 'S_FATT_PAIN2'], // 387
  [37, 10, 6, '', 389, 'S_FATT_DIE1'], // 388
  [37, 11, 6, 'A_Scream', 390, 'S_FATT_DIE2'], // 389
  [37, 12, 6, 'A_Fall', 391, 'S_FATT_DIE3'], // 390
  [37, 13, 6, '', 392, 'S_FATT_DIE4'], // 391
  [37, 14, 6, '', 393, 'S_FATT_DIE5'], // 392
  [37, 15, 6, '', 394, 'S_FATT_DIE6'], // 393
  [37, 16, 6, '', 395, 'S_FATT_DIE7'], // 394
  [37, 17, 6, '', 396, 'S_FATT_DIE8'], // 395
  [37, 18, 6, '', 397, 'S_FATT_DIE9'], // 396
  [37, 19, -1, 'A_BossDeath', 0, 'S_FATT_DIE10'], // 397
  [37, 17, 5, '', 399, 'S_FATT_RAISE1'], // 398
  [37, 16, 5, '', 400, 'S_FATT_RAISE2'], // 399
  [37, 15, 5, '', 401, 'S_FATT_RAISE3'], // 400
  [37, 14, 5, '', 402, 'S_FATT_RAISE4'], // 401
  [37, 13, 5, '', 403, 'S_FATT_RAISE5'], // 402
  [37, 12, 5, '', 404, 'S_FATT_RAISE6'], // 403
  [37, 11, 5, '', 405, 'S_FATT_RAISE7'], // 404
  [37, 10, 5, '', 364, 'S_FATT_RAISE8'], // 405
  [38, 0, 10, 'A_Look', 407, 'S_CPOS_STND'], // 406
  [38, 1, 10, 'A_Look', 406, 'S_CPOS_STND2'], // 407
  [38, 0, 3, 'A_Chase', 409, 'S_CPOS_RUN1'], // 408
  [38, 0, 3, 'A_Chase', 410, 'S_CPOS_RUN2'], // 409
  [38, 1, 3, 'A_Chase', 411, 'S_CPOS_RUN3'], // 410
  [38, 1, 3, 'A_Chase', 412, 'S_CPOS_RUN4'], // 411
  [38, 2, 3, 'A_Chase', 413, 'S_CPOS_RUN5'], // 412
  [38, 2, 3, 'A_Chase', 414, 'S_CPOS_RUN6'], // 413
  [38, 3, 3, 'A_Chase', 415, 'S_CPOS_RUN7'], // 414
  [38, 3, 3, 'A_Chase', 408, 'S_CPOS_RUN8'], // 415
  [38, 4, 10, 'A_FaceTarget', 417, 'S_CPOS_ATK1'], // 416
  [38, 32773, 4, 'A_CPosAttack', 418, 'S_CPOS_ATK2'], // 417
  [38, 32772, 4, 'A_CPosAttack', 419, 'S_CPOS_ATK3'], // 418
  [38, 5, 1, 'A_CPosRefire', 417, 'S_CPOS_ATK4'], // 419
  [38, 6, 3, '', 421, 'S_CPOS_PAIN'], // 420
  [38, 6, 3, 'A_Pain', 408, 'S_CPOS_PAIN2'], // 421
  [38, 7, 5, '', 423, 'S_CPOS_DIE1'], // 422
  [38, 8, 5, 'A_Scream', 424, 'S_CPOS_DIE2'], // 423
  [38, 9, 5, 'A_Fall', 425, 'S_CPOS_DIE3'], // 424
  [38, 10, 5, '', 426, 'S_CPOS_DIE4'], // 425
  [38, 11, 5, '', 427, 'S_CPOS_DIE5'], // 426
  [38, 12, 5, '', 428, 'S_CPOS_DIE6'], // 427
  [38, 13, -1, '', 0, 'S_CPOS_DIE7'], // 428
  [38, 14, 5, '', 430, 'S_CPOS_XDIE1'], // 429
  [38, 15, 5, 'A_XScream', 431, 'S_CPOS_XDIE2'], // 430
  [38, 16, 5, 'A_Fall', 432, 'S_CPOS_XDIE3'], // 431
  [38, 17, 5, '', 433, 'S_CPOS_XDIE4'], // 432
  [38, 18, 5, '', 434, 'S_CPOS_XDIE5'], // 433
  [38, 19, -1, '', 0, 'S_CPOS_XDIE6'], // 434
  [38, 13, 5, '', 436, 'S_CPOS_RAISE1'], // 435
  [38, 12, 5, '', 437, 'S_CPOS_RAISE2'], // 436
  [38, 11, 5, '', 438, 'S_CPOS_RAISE3'], // 437
  [38, 10, 5, '', 439, 'S_CPOS_RAISE4'], // 438
  [38, 9, 5, '', 440, 'S_CPOS_RAISE5'], // 439
  [38, 8, 5, '', 441, 'S_CPOS_RAISE6'], // 440
  [38, 7, 5, '', 408, 'S_CPOS_RAISE7'], // 441
  [0, 0, 10, 'A_Look', 443, 'S_TROO_STND'], // 442
  [0, 1, 10, 'A_Look', 442, 'S_TROO_STND2'], // 443
  [0, 0, 3, 'A_Chase', 445, 'S_TROO_RUN1'], // 444
  [0, 0, 3, 'A_Chase', 446, 'S_TROO_RUN2'], // 445
  [0, 1, 3, 'A_Chase', 447, 'S_TROO_RUN3'], // 446
  [0, 1, 3, 'A_Chase', 448, 'S_TROO_RUN4'], // 447
  [0, 2, 3, 'A_Chase', 449, 'S_TROO_RUN5'], // 448
  [0, 2, 3, 'A_Chase', 450, 'S_TROO_RUN6'], // 449
  [0, 3, 3, 'A_Chase', 451, 'S_TROO_RUN7'], // 450
  [0, 3, 3, 'A_Chase', 444, 'S_TROO_RUN8'], // 451
  [0, 4, 8, 'A_FaceTarget', 453, 'S_TROO_ATK1'], // 452
  [0, 5, 8, 'A_FaceTarget', 454, 'S_TROO_ATK2'], // 453
  [0, 6, 6, 'A_TroopAttack', 444, 'S_TROO_ATK3'], // 454
  [0, 7, 2, '', 456, 'S_TROO_PAIN'], // 455
  [0, 7, 2, 'A_Pain', 444, 'S_TROO_PAIN2'], // 456
  [0, 8, 8, '', 458, 'S_TROO_DIE1'], // 457
  [0, 9, 8, 'A_Scream', 459, 'S_TROO_DIE2'], // 458
  [0, 10, 6, '', 460, 'S_TROO_DIE3'], // 459
  [0, 11, 6, 'A_Fall', 461, 'S_TROO_DIE4'], // 460
  [0, 12, -1, '', 0, 'S_TROO_DIE5'], // 461
  [0, 13, 5, '', 463, 'S_TROO_XDIE1'], // 462
  [0, 14, 5, 'A_XScream', 464, 'S_TROO_XDIE2'], // 463
  [0, 15, 5, '', 465, 'S_TROO_XDIE3'], // 464
  [0, 16, 5, 'A_Fall', 466, 'S_TROO_XDIE4'], // 465
  [0, 17, 5, '', 467, 'S_TROO_XDIE5'], // 466
  [0, 18, 5, '', 468, 'S_TROO_XDIE6'], // 467
  [0, 19, 5, '', 469, 'S_TROO_XDIE7'], // 468
  [0, 20, -1, '', 0, 'S_TROO_XDIE8'], // 469
  [0, 12, 8, '', 471, 'S_TROO_RAISE1'], // 470
  [0, 11, 8, '', 472, 'S_TROO_RAISE2'], // 471
  [0, 10, 6, '', 473, 'S_TROO_RAISE3'], // 472
  [0, 9, 6, '', 474, 'S_TROO_RAISE4'], // 473
  [0, 8, 6, '', 444, 'S_TROO_RAISE5'], // 474
  [39, 0, 10, 'A_Look', 476, 'S_SARG_STND'], // 475
  [39, 1, 10, 'A_Look', 475, 'S_SARG_STND2'], // 476
  [39, 0, 2, 'A_Chase', 478, 'S_SARG_RUN1'], // 477
  [39, 0, 2, 'A_Chase', 479, 'S_SARG_RUN2'], // 478
  [39, 1, 2, 'A_Chase', 480, 'S_SARG_RUN3'], // 479
  [39, 1, 2, 'A_Chase', 481, 'S_SARG_RUN4'], // 480
  [39, 2, 2, 'A_Chase', 482, 'S_SARG_RUN5'], // 481
  [39, 2, 2, 'A_Chase', 483, 'S_SARG_RUN6'], // 482
  [39, 3, 2, 'A_Chase', 484, 'S_SARG_RUN7'], // 483
  [39, 3, 2, 'A_Chase', 477, 'S_SARG_RUN8'], // 484
  [39, 4, 8, 'A_FaceTarget', 486, 'S_SARG_ATK1'], // 485
  [39, 5, 8, 'A_FaceTarget', 487, 'S_SARG_ATK2'], // 486
  [39, 6, 8, 'A_SargAttack', 477, 'S_SARG_ATK3'], // 487
  [39, 7, 2, '', 489, 'S_SARG_PAIN'], // 488
  [39, 7, 2, 'A_Pain', 477, 'S_SARG_PAIN2'], // 489
  [39, 8, 8, '', 491, 'S_SARG_DIE1'], // 490
  [39, 9, 8, 'A_Scream', 492, 'S_SARG_DIE2'], // 491
  [39, 10, 4, '', 493, 'S_SARG_DIE3'], // 492
  [39, 11, 4, 'A_Fall', 494, 'S_SARG_DIE4'], // 493
  [39, 12, 4, '', 495, 'S_SARG_DIE5'], // 494
  [39, 13, -1, '', 0, 'S_SARG_DIE6'], // 495
  [39, 13, 5, '', 497, 'S_SARG_RAISE1'], // 496
  [39, 12, 5, '', 498, 'S_SARG_RAISE2'], // 497
  [39, 11, 5, '', 499, 'S_SARG_RAISE3'], // 498
  [39, 10, 5, '', 500, 'S_SARG_RAISE4'], // 499
  [39, 9, 5, '', 501, 'S_SARG_RAISE5'], // 500
  [39, 8, 5, '', 477, 'S_SARG_RAISE6'], // 501
  [40, 0, 10, 'A_Look', 502, 'S_HEAD_STND'], // 502
  [40, 0, 3, 'A_Chase', 503, 'S_HEAD_RUN1'], // 503
  [40, 1, 5, 'A_FaceTarget', 505, 'S_HEAD_ATK1'], // 504
  [40, 2, 5, 'A_FaceTarget', 506, 'S_HEAD_ATK2'], // 505
  [40, 32771, 5, 'A_HeadAttack', 503, 'S_HEAD_ATK3'], // 506
  [40, 4, 3, '', 508, 'S_HEAD_PAIN'], // 507
  [40, 4, 3, 'A_Pain', 509, 'S_HEAD_PAIN2'], // 508
  [40, 5, 6, '', 503, 'S_HEAD_PAIN3'], // 509
  [40, 6, 8, '', 511, 'S_HEAD_DIE1'], // 510
  [40, 7, 8, 'A_Scream', 512, 'S_HEAD_DIE2'], // 511
  [40, 8, 8, '', 513, 'S_HEAD_DIE3'], // 512
  [40, 9, 8, '', 514, 'S_HEAD_DIE4'], // 513
  [40, 10, 8, 'A_Fall', 515, 'S_HEAD_DIE5'], // 514
  [40, 11, -1, '', 0, 'S_HEAD_DIE6'], // 515
  [40, 11, 8, '', 517, 'S_HEAD_RAISE1'], // 516
  [40, 10, 8, '', 518, 'S_HEAD_RAISE2'], // 517
  [40, 9, 8, '', 519, 'S_HEAD_RAISE3'], // 518
  [40, 8, 8, '', 520, 'S_HEAD_RAISE4'], // 519
  [40, 7, 8, '', 521, 'S_HEAD_RAISE5'], // 520
  [40, 6, 8, '', 503, 'S_HEAD_RAISE6'], // 521
  [41, 32768, 4, '', 523, 'S_BRBALL1'], // 522
  [41, 32769, 4, '', 522, 'S_BRBALL2'], // 523
  [41, 32770, 6, '', 525, 'S_BRBALLX1'], // 524
  [41, 32771, 6, '', 526, 'S_BRBALLX2'], // 525
  [41, 32772, 6, '', 0, 'S_BRBALLX3'], // 526
  [42, 0, 10, 'A_Look', 528, 'S_BOSS_STND'], // 527
  [42, 1, 10, 'A_Look', 527, 'S_BOSS_STND2'], // 528
  [42, 0, 3, 'A_Chase', 530, 'S_BOSS_RUN1'], // 529
  [42, 0, 3, 'A_Chase', 531, 'S_BOSS_RUN2'], // 530
  [42, 1, 3, 'A_Chase', 532, 'S_BOSS_RUN3'], // 531
  [42, 1, 3, 'A_Chase', 533, 'S_BOSS_RUN4'], // 532
  [42, 2, 3, 'A_Chase', 534, 'S_BOSS_RUN5'], // 533
  [42, 2, 3, 'A_Chase', 535, 'S_BOSS_RUN6'], // 534
  [42, 3, 3, 'A_Chase', 536, 'S_BOSS_RUN7'], // 535
  [42, 3, 3, 'A_Chase', 529, 'S_BOSS_RUN8'], // 536
  [42, 4, 8, 'A_FaceTarget', 538, 'S_BOSS_ATK1'], // 537
  [42, 5, 8, 'A_FaceTarget', 539, 'S_BOSS_ATK2'], // 538
  [42, 6, 8, 'A_BruisAttack', 529, 'S_BOSS_ATK3'], // 539
  [42, 7, 2, '', 541, 'S_BOSS_PAIN'], // 540
  [42, 7, 2, 'A_Pain', 529, 'S_BOSS_PAIN2'], // 541
  [42, 8, 8, '', 543, 'S_BOSS_DIE1'], // 542
  [42, 9, 8, 'A_Scream', 544, 'S_BOSS_DIE2'], // 543
  [42, 10, 8, '', 545, 'S_BOSS_DIE3'], // 544
  [42, 11, 8, 'A_Fall', 546, 'S_BOSS_DIE4'], // 545
  [42, 12, 8, '', 547, 'S_BOSS_DIE5'], // 546
  [42, 13, 8, '', 548, 'S_BOSS_DIE6'], // 547
  [42, 14, -1, 'A_BossDeath', 0, 'S_BOSS_DIE7'], // 548
  [42, 14, 8, '', 550, 'S_BOSS_RAISE1'], // 549
  [42, 13, 8, '', 551, 'S_BOSS_RAISE2'], // 550
  [42, 12, 8, '', 552, 'S_BOSS_RAISE3'], // 551
  [42, 11, 8, '', 553, 'S_BOSS_RAISE4'], // 552
  [42, 10, 8, '', 554, 'S_BOSS_RAISE5'], // 553
  [42, 9, 8, '', 555, 'S_BOSS_RAISE6'], // 554
  [42, 8, 8, '', 529, 'S_BOSS_RAISE7'], // 555
  [43, 0, 10, 'A_Look', 557, 'S_BOS2_STND'], // 556
  [43, 1, 10, 'A_Look', 556, 'S_BOS2_STND2'], // 557
  [43, 0, 3, 'A_Chase', 559, 'S_BOS2_RUN1'], // 558
  [43, 0, 3, 'A_Chase', 560, 'S_BOS2_RUN2'], // 559
  [43, 1, 3, 'A_Chase', 561, 'S_BOS2_RUN3'], // 560
  [43, 1, 3, 'A_Chase', 562, 'S_BOS2_RUN4'], // 561
  [43, 2, 3, 'A_Chase', 563, 'S_BOS2_RUN5'], // 562
  [43, 2, 3, 'A_Chase', 564, 'S_BOS2_RUN6'], // 563
  [43, 3, 3, 'A_Chase', 565, 'S_BOS2_RUN7'], // 564
  [43, 3, 3, 'A_Chase', 558, 'S_BOS2_RUN8'], // 565
  [43, 4, 8, 'A_FaceTarget', 567, 'S_BOS2_ATK1'], // 566
  [43, 5, 8, 'A_FaceTarget', 568, 'S_BOS2_ATK2'], // 567
  [43, 6, 8, 'A_BruisAttack', 558, 'S_BOS2_ATK3'], // 568
  [43, 7, 2, '', 570, 'S_BOS2_PAIN'], // 569
  [43, 7, 2, 'A_Pain', 558, 'S_BOS2_PAIN2'], // 570
  [43, 8, 8, '', 572, 'S_BOS2_DIE1'], // 571
  [43, 9, 8, 'A_Scream', 573, 'S_BOS2_DIE2'], // 572
  [43, 10, 8, '', 574, 'S_BOS2_DIE3'], // 573
  [43, 11, 8, 'A_Fall', 575, 'S_BOS2_DIE4'], // 574
  [43, 12, 8, '', 576, 'S_BOS2_DIE5'], // 575
  [43, 13, 8, '', 577, 'S_BOS2_DIE6'], // 576
  [43, 14, -1, '', 0, 'S_BOS2_DIE7'], // 577
  [43, 14, 8, '', 579, 'S_BOS2_RAISE1'], // 578
  [43, 13, 8, '', 580, 'S_BOS2_RAISE2'], // 579
  [43, 12, 8, '', 581, 'S_BOS2_RAISE3'], // 580
  [43, 11, 8, '', 582, 'S_BOS2_RAISE4'], // 581
  [43, 10, 8, '', 583, 'S_BOS2_RAISE5'], // 582
  [43, 9, 8, '', 584, 'S_BOS2_RAISE6'], // 583
  [43, 8, 8, '', 558, 'S_BOS2_RAISE7'], // 584
  [44, 32768, 10, 'A_Look', 586, 'S_SKULL_STND'], // 585
  [44, 32769, 10, 'A_Look', 585, 'S_SKULL_STND2'], // 586
  [44, 32768, 6, 'A_Chase', 588, 'S_SKULL_RUN1'], // 587
  [44, 32769, 6, 'A_Chase', 587, 'S_SKULL_RUN2'], // 588
  [44, 32770, 10, 'A_FaceTarget', 590, 'S_SKULL_ATK1'], // 589
  [44, 32771, 4, 'A_SkullAttack', 591, 'S_SKULL_ATK2'], // 590
  [44, 32770, 4, '', 592, 'S_SKULL_ATK3'], // 591
  [44, 32771, 4, '', 591, 'S_SKULL_ATK4'], // 592
  [44, 32772, 3, '', 594, 'S_SKULL_PAIN'], // 593
  [44, 32772, 3, 'A_Pain', 587, 'S_SKULL_PAIN2'], // 594
  [44, 32773, 6, '', 596, 'S_SKULL_DIE1'], // 595
  [44, 32774, 6, 'A_Scream', 597, 'S_SKULL_DIE2'], // 596
  [44, 32775, 6, '', 598, 'S_SKULL_DIE3'], // 597
  [44, 32776, 6, 'A_Fall', 599, 'S_SKULL_DIE4'], // 598
  [44, 9, 6, '', 600, 'S_SKULL_DIE5'], // 599
  [44, 10, 6, '', 0, 'S_SKULL_DIE6'], // 600
  [45, 0, 10, 'A_Look', 602, 'S_SPID_STND'], // 601
  [45, 1, 10, 'A_Look', 601, 'S_SPID_STND2'], // 602
  [45, 0, 3, 'A_Metal', 604, 'S_SPID_RUN1'], // 603
  [45, 0, 3, 'A_Chase', 605, 'S_SPID_RUN2'], // 604
  [45, 1, 3, 'A_Chase', 606, 'S_SPID_RUN3'], // 605
  [45, 1, 3, 'A_Chase', 607, 'S_SPID_RUN4'], // 606
  [45, 2, 3, 'A_Metal', 608, 'S_SPID_RUN5'], // 607
  [45, 2, 3, 'A_Chase', 609, 'S_SPID_RUN6'], // 608
  [45, 3, 3, 'A_Chase', 610, 'S_SPID_RUN7'], // 609
  [45, 3, 3, 'A_Chase', 611, 'S_SPID_RUN8'], // 610
  [45, 4, 3, 'A_Metal', 612, 'S_SPID_RUN9'], // 611
  [45, 4, 3, 'A_Chase', 613, 'S_SPID_RUN10'], // 612
  [45, 5, 3, 'A_Chase', 614, 'S_SPID_RUN11'], // 613
  [45, 5, 3, 'A_Chase', 603, 'S_SPID_RUN12'], // 614
  [45, 32768, 20, 'A_FaceTarget', 616, 'S_SPID_ATK1'], // 615
  [45, 32774, 4, 'A_SPosAttack', 617, 'S_SPID_ATK2'], // 616
  [45, 32775, 4, 'A_SPosAttack', 618, 'S_SPID_ATK3'], // 617
  [45, 32775, 1, 'A_SpidRefire', 616, 'S_SPID_ATK4'], // 618
  [45, 8, 3, '', 620, 'S_SPID_PAIN'], // 619
  [45, 8, 3, 'A_Pain', 603, 'S_SPID_PAIN2'], // 620
  [45, 9, 20, 'A_Scream', 622, 'S_SPID_DIE1'], // 621
  [45, 10, 10, 'A_Fall', 623, 'S_SPID_DIE2'], // 622
  [45, 11, 10, '', 624, 'S_SPID_DIE3'], // 623
  [45, 12, 10, '', 625, 'S_SPID_DIE4'], // 624
  [45, 13, 10, '', 626, 'S_SPID_DIE5'], // 625
  [45, 14, 10, '', 627, 'S_SPID_DIE6'], // 626
  [45, 15, 10, '', 628, 'S_SPID_DIE7'], // 627
  [45, 16, 10, '', 629, 'S_SPID_DIE8'], // 628
  [45, 17, 10, '', 630, 'S_SPID_DIE9'], // 629
  [45, 18, 30, '', 631, 'S_SPID_DIE10'], // 630
  [45, 18, -1, 'A_BossDeath', 0, 'S_SPID_DIE11'], // 631
  [46, 0, 10, 'A_Look', 633, 'S_BSPI_STND'], // 632
  [46, 1, 10, 'A_Look', 632, 'S_BSPI_STND2'], // 633
  [46, 0, 20, '', 635, 'S_BSPI_SIGHT'], // 634
  [46, 0, 3, 'A_BabyMetal', 636, 'S_BSPI_RUN1'], // 635
  [46, 0, 3, 'A_Chase', 637, 'S_BSPI_RUN2'], // 636
  [46, 1, 3, 'A_Chase', 638, 'S_BSPI_RUN3'], // 637
  [46, 1, 3, 'A_Chase', 639, 'S_BSPI_RUN4'], // 638
  [46, 2, 3, 'A_Chase', 640, 'S_BSPI_RUN5'], // 639
  [46, 2, 3, 'A_Chase', 641, 'S_BSPI_RUN6'], // 640
  [46, 3, 3, 'A_BabyMetal', 642, 'S_BSPI_RUN7'], // 641
  [46, 3, 3, 'A_Chase', 643, 'S_BSPI_RUN8'], // 642
  [46, 4, 3, 'A_Chase', 644, 'S_BSPI_RUN9'], // 643
  [46, 4, 3, 'A_Chase', 645, 'S_BSPI_RUN10'], // 644
  [46, 5, 3, 'A_Chase', 646, 'S_BSPI_RUN11'], // 645
  [46, 5, 3, 'A_Chase', 635, 'S_BSPI_RUN12'], // 646
  [46, 32768, 20, 'A_FaceTarget', 648, 'S_BSPI_ATK1'], // 647
  [46, 32774, 4, 'A_BspiAttack', 649, 'S_BSPI_ATK2'], // 648
  [46, 32775, 4, '', 650, 'S_BSPI_ATK3'], // 649
  [46, 32775, 1, 'A_SpidRefire', 648, 'S_BSPI_ATK4'], // 650
  [46, 8, 3, '', 652, 'S_BSPI_PAIN'], // 651
  [46, 8, 3, 'A_Pain', 635, 'S_BSPI_PAIN2'], // 652
  [46, 9, 20, 'A_Scream', 654, 'S_BSPI_DIE1'], // 653
  [46, 10, 7, 'A_Fall', 655, 'S_BSPI_DIE2'], // 654
  [46, 11, 7, '', 656, 'S_BSPI_DIE3'], // 655
  [46, 12, 7, '', 657, 'S_BSPI_DIE4'], // 656
  [46, 13, 7, '', 658, 'S_BSPI_DIE5'], // 657
  [46, 14, 7, '', 659, 'S_BSPI_DIE6'], // 658
  [46, 15, -1, 'A_BossDeath', 0, 'S_BSPI_DIE7'], // 659
  [46, 15, 5, '', 661, 'S_BSPI_RAISE1'], // 660
  [46, 14, 5, '', 662, 'S_BSPI_RAISE2'], // 661
  [46, 13, 5, '', 663, 'S_BSPI_RAISE3'], // 662
  [46, 12, 5, '', 664, 'S_BSPI_RAISE4'], // 663
  [46, 11, 5, '', 665, 'S_BSPI_RAISE5'], // 664
  [46, 10, 5, '', 666, 'S_BSPI_RAISE6'], // 665
  [46, 9, 5, '', 635, 'S_BSPI_RAISE7'], // 666
  [47, 32768, 5, '', 668, 'S_ARACH_PLAZ'], // 667
  [47, 32769, 5, '', 667, 'S_ARACH_PLAZ2'], // 668
  [48, 32768, 5, '', 670, 'S_ARACH_PLEX'], // 669
  [48, 32769, 5, '', 671, 'S_ARACH_PLEX2'], // 670
  [48, 32770, 5, '', 672, 'S_ARACH_PLEX3'], // 671
  [48, 32771, 5, '', 673, 'S_ARACH_PLEX4'], // 672
  [48, 32772, 5, '', 0, 'S_ARACH_PLEX5'], // 673
  [49, 0, 10, 'A_Look', 675, 'S_CYBER_STND'], // 674
  [49, 1, 10, 'A_Look', 674, 'S_CYBER_STND2'], // 675
  [49, 0, 3, 'A_Hoof', 677, 'S_CYBER_RUN1'], // 676
  [49, 0, 3, 'A_Chase', 678, 'S_CYBER_RUN2'], // 677
  [49, 1, 3, 'A_Chase', 679, 'S_CYBER_RUN3'], // 678
  [49, 1, 3, 'A_Chase', 680, 'S_CYBER_RUN4'], // 679
  [49, 2, 3, 'A_Chase', 681, 'S_CYBER_RUN5'], // 680
  [49, 2, 3, 'A_Chase', 682, 'S_CYBER_RUN6'], // 681
  [49, 3, 3, 'A_Metal', 683, 'S_CYBER_RUN7'], // 682
  [49, 3, 3, 'A_Chase', 676, 'S_CYBER_RUN8'], // 683
  [49, 4, 6, 'A_FaceTarget', 685, 'S_CYBER_ATK1'], // 684
  [49, 5, 12, 'A_CyberAttack', 686, 'S_CYBER_ATK2'], // 685
  [49, 4, 12, 'A_FaceTarget', 687, 'S_CYBER_ATK3'], // 686
  [49, 5, 12, 'A_CyberAttack', 688, 'S_CYBER_ATK4'], // 687
  [49, 4, 12, 'A_FaceTarget', 689, 'S_CYBER_ATK5'], // 688
  [49, 5, 12, 'A_CyberAttack', 676, 'S_CYBER_ATK6'], // 689
  [49, 6, 10, 'A_Pain', 676, 'S_CYBER_PAIN'], // 690
  [49, 7, 10, '', 692, 'S_CYBER_DIE1'], // 691
  [49, 8, 10, 'A_Scream', 693, 'S_CYBER_DIE2'], // 692
  [49, 9, 10, '', 694, 'S_CYBER_DIE3'], // 693
  [49, 10, 10, '', 695, 'S_CYBER_DIE4'], // 694
  [49, 11, 10, '', 696, 'S_CYBER_DIE5'], // 695
  [49, 12, 10, 'A_Fall', 697, 'S_CYBER_DIE6'], // 696
  [49, 13, 10, '', 698, 'S_CYBER_DIE7'], // 697
  [49, 14, 10, '', 699, 'S_CYBER_DIE8'], // 698
  [49, 15, 30, '', 700, 'S_CYBER_DIE9'], // 699
  [49, 15, -1, 'A_BossDeath', 0, 'S_CYBER_DIE10'], // 700
  [50, 0, 10, 'A_Look', 701, 'S_PAIN_STND'], // 701
  [50, 0, 3, 'A_Chase', 703, 'S_PAIN_RUN1'], // 702
  [50, 0, 3, 'A_Chase', 704, 'S_PAIN_RUN2'], // 703
  [50, 1, 3, 'A_Chase', 705, 'S_PAIN_RUN3'], // 704
  [50, 1, 3, 'A_Chase', 706, 'S_PAIN_RUN4'], // 705
  [50, 2, 3, 'A_Chase', 707, 'S_PAIN_RUN5'], // 706
  [50, 2, 3, 'A_Chase', 702, 'S_PAIN_RUN6'], // 707
  [50, 3, 5, 'A_FaceTarget', 709, 'S_PAIN_ATK1'], // 708
  [50, 4, 5, 'A_FaceTarget', 710, 'S_PAIN_ATK2'], // 709
  [50, 32773, 5, 'A_FaceTarget', 711, 'S_PAIN_ATK3'], // 710
  [50, 32773, 0, 'A_PainAttack', 702, 'S_PAIN_ATK4'], // 711
  [50, 6, 6, '', 713, 'S_PAIN_PAIN'], // 712
  [50, 6, 6, 'A_Pain', 702, 'S_PAIN_PAIN2'], // 713
  [50, 32775, 8, '', 715, 'S_PAIN_DIE1'], // 714
  [50, 32776, 8, 'A_Scream', 716, 'S_PAIN_DIE2'], // 715
  [50, 32777, 8, '', 717, 'S_PAIN_DIE3'], // 716
  [50, 32778, 8, '', 718, 'S_PAIN_DIE4'], // 717
  [50, 32779, 8, 'A_PainDie', 719, 'S_PAIN_DIE5'], // 718
  [50, 32780, 8, '', 0, 'S_PAIN_DIE6'], // 719
  [50, 12, 8, '', 721, 'S_PAIN_RAISE1'], // 720
  [50, 11, 8, '', 722, 'S_PAIN_RAISE2'], // 721
  [50, 10, 8, '', 723, 'S_PAIN_RAISE3'], // 722
  [50, 9, 8, '', 724, 'S_PAIN_RAISE4'], // 723
  [50, 8, 8, '', 725, 'S_PAIN_RAISE5'], // 724
  [50, 7, 8, '', 702, 'S_PAIN_RAISE6'], // 725
  [51, 0, 10, 'A_Look', 727, 'S_SSWV_STND'], // 726
  [51, 1, 10, 'A_Look', 726, 'S_SSWV_STND2'], // 727
  [51, 0, 3, 'A_Chase', 729, 'S_SSWV_RUN1'], // 728
  [51, 0, 3, 'A_Chase', 730, 'S_SSWV_RUN2'], // 729
  [51, 1, 3, 'A_Chase', 731, 'S_SSWV_RUN3'], // 730
  [51, 1, 3, 'A_Chase', 732, 'S_SSWV_RUN4'], // 731
  [51, 2, 3, 'A_Chase', 733, 'S_SSWV_RUN5'], // 732
  [51, 2, 3, 'A_Chase', 734, 'S_SSWV_RUN6'], // 733
  [51, 3, 3, 'A_Chase', 735, 'S_SSWV_RUN7'], // 734
  [51, 3, 3, 'A_Chase', 728, 'S_SSWV_RUN8'], // 735
  [51, 4, 10, 'A_FaceTarget', 737, 'S_SSWV_ATK1'], // 736
  [51, 5, 10, 'A_FaceTarget', 738, 'S_SSWV_ATK2'], // 737
  [51, 32774, 4, 'A_CPosAttack', 739, 'S_SSWV_ATK3'], // 738
  [51, 5, 6, 'A_FaceTarget', 740, 'S_SSWV_ATK4'], // 739
  [51, 32774, 4, 'A_CPosAttack', 741, 'S_SSWV_ATK5'], // 740
  [51, 5, 1, 'A_CPosRefire', 737, 'S_SSWV_ATK6'], // 741
  [51, 7, 3, '', 743, 'S_SSWV_PAIN'], // 742
  [51, 7, 3, 'A_Pain', 728, 'S_SSWV_PAIN2'], // 743
  [51, 8, 5, '', 745, 'S_SSWV_DIE1'], // 744
  [51, 9, 5, 'A_Scream', 746, 'S_SSWV_DIE2'], // 745
  [51, 10, 5, 'A_Fall', 747, 'S_SSWV_DIE3'], // 746
  [51, 11, 5, '', 748, 'S_SSWV_DIE4'], // 747
  [51, 12, -1, '', 0, 'S_SSWV_DIE5'], // 748
  [51, 13, 5, '', 750, 'S_SSWV_XDIE1'], // 749
  [51, 14, 5, 'A_XScream', 751, 'S_SSWV_XDIE2'], // 750
  [51, 15, 5, 'A_Fall', 752, 'S_SSWV_XDIE3'], // 751
  [51, 16, 5, '', 753, 'S_SSWV_XDIE4'], // 752
  [51, 17, 5, '', 754, 'S_SSWV_XDIE5'], // 753
  [51, 18, 5, '', 755, 'S_SSWV_XDIE6'], // 754
  [51, 19, 5, '', 756, 'S_SSWV_XDIE7'], // 755
  [51, 20, 5, '', 757, 'S_SSWV_XDIE8'], // 756
  [51, 21, -1, '', 0, 'S_SSWV_XDIE9'], // 757
  [51, 12, 5, '', 759, 'S_SSWV_RAISE1'], // 758
  [51, 11, 5, '', 760, 'S_SSWV_RAISE2'], // 759
  [51, 10, 5, '', 761, 'S_SSWV_RAISE3'], // 760
  [51, 9, 5, '', 762, 'S_SSWV_RAISE4'], // 761
  [51, 8, 5, '', 728, 'S_SSWV_RAISE5'], // 762
  [52, 0, -1, '', 763, 'S_KEENSTND'], // 763
  [52, 0, 6, '', 765, 'S_COMMKEEN'], // 764
  [52, 1, 6, '', 766, 'S_COMMKEEN2'], // 765
  [52, 2, 6, 'A_Scream', 767, 'S_COMMKEEN3'], // 766
  [52, 3, 6, '', 768, 'S_COMMKEEN4'], // 767
  [52, 4, 6, '', 769, 'S_COMMKEEN5'], // 768
  [52, 5, 6, '', 770, 'S_COMMKEEN6'], // 769
  [52, 6, 6, '', 771, 'S_COMMKEEN7'], // 770
  [52, 7, 6, '', 772, 'S_COMMKEEN8'], // 771
  [52, 8, 6, '', 773, 'S_COMMKEEN9'], // 772
  [52, 9, 6, '', 774, 'S_COMMKEEN10'], // 773
  [52, 10, 6, 'A_KeenDie', 775, 'S_COMMKEEN11'], // 774
  [52, 11, -1, '', 0, 'S_COMMKEEN12'], // 775
  [52, 12, 4, '', 777, 'S_KEENPAIN'], // 776
  [52, 12, 8, 'A_Pain', 763, 'S_KEENPAIN2'], // 777
  [53, 0, -1, '', 0, 'S_BRAIN'], // 778
  [53, 1, 36, 'A_BrainPain', 778, 'S_BRAIN_PAIN'], // 779
  [53, 0, 100, 'A_BrainScream', 781, 'S_BRAIN_DIE1'], // 780
  [53, 0, 10, '', 782, 'S_BRAIN_DIE2'], // 781
  [53, 0, 10, '', 783, 'S_BRAIN_DIE3'], // 782
  [53, 0, -1, 'A_BrainDie', 0, 'S_BRAIN_DIE4'], // 783
  [51, 0, 10, 'A_Look', 784, 'S_BRAINEYE'], // 784
  [51, 0, 181, 'A_BrainAwake', 786, 'S_BRAINEYESEE'], // 785
  [51, 0, 150, 'A_BrainSpit', 786, 'S_BRAINEYE1'], // 786
  [54, 32768, 3, 'A_SpawnSound', 788, 'S_SPAWN1'], // 787
  [54, 32769, 3, 'A_SpawnFly', 789, 'S_SPAWN2'], // 788
  [54, 32770, 3, 'A_SpawnFly', 790, 'S_SPAWN3'], // 789
  [54, 32771, 3, 'A_SpawnFly', 787, 'S_SPAWN4'], // 790
  [32, 32768, 4, 'A_Fire', 792, 'S_SPAWNFIRE1'], // 791
  [32, 32769, 4, 'A_Fire', 793, 'S_SPAWNFIRE2'], // 792
  [32, 32770, 4, 'A_Fire', 794, 'S_SPAWNFIRE3'], // 793
  [32, 32771, 4, 'A_Fire', 795, 'S_SPAWNFIRE4'], // 794
  [32, 32772, 4, 'A_Fire', 796, 'S_SPAWNFIRE5'], // 795
  [32, 32773, 4, 'A_Fire', 797, 'S_SPAWNFIRE6'], // 796
  [32, 32774, 4, 'A_Fire', 798, 'S_SPAWNFIRE7'], // 797
  [32, 32775, 4, 'A_Fire', 0, 'S_SPAWNFIRE8'], // 798
  [22, 32769, 10, '', 800, 'S_BRAINEXPLODE1'], // 799
  [22, 32770, 10, '', 801, 'S_BRAINEXPLODE2'], // 800
  [22, 32771, 10, 'A_BrainExplode', 0, 'S_BRAINEXPLODE3'], // 801
  [55, 0, 6, '', 803, 'S_ARM1'], // 802
  [55, 32769, 7, '', 802, 'S_ARM1A'], // 803
  [56, 0, 6, '', 805, 'S_ARM2'], // 804
  [56, 32769, 6, '', 804, 'S_ARM2A'], // 805
  [57, 0, 6, '', 807, 'S_BAR1'], // 806
  [57, 1, 6, '', 806, 'S_BAR2'], // 807
  [58, 32768, 5, '', 809, 'S_BEXP'], // 808
  [58, 32769, 5, 'A_Scream', 810, 'S_BEXP2'], // 809
  [58, 32770, 5, '', 811, 'S_BEXP3'], // 810
  [58, 32771, 10, 'A_Explode', 812, 'S_BEXP4'], // 811
  [58, 32772, 10, '', 0, 'S_BEXP5'], // 812
  [59, 32768, 4, '', 814, 'S_BBAR1'], // 813
  [59, 32769, 4, '', 815, 'S_BBAR2'], // 814
  [59, 32770, 4, '', 813, 'S_BBAR3'], // 815
  [60, 0, 6, '', 817, 'S_BON1'], // 816
  [60, 1, 6, '', 818, 'S_BON1A'], // 817
  [60, 2, 6, '', 819, 'S_BON1B'], // 818
  [60, 3, 6, '', 820, 'S_BON1C'], // 819
  [60, 2, 6, '', 821, 'S_BON1D'], // 820
  [60, 1, 6, '', 816, 'S_BON1E'], // 821
  [61, 0, 6, '', 823, 'S_BON2'], // 822
  [61, 1, 6, '', 824, 'S_BON2A'], // 823
  [61, 2, 6, '', 825, 'S_BON2B'], // 824
  [61, 3, 6, '', 826, 'S_BON2C'], // 825
  [61, 2, 6, '', 827, 'S_BON2D'], // 826
  [61, 1, 6, '', 822, 'S_BON2E'], // 827
  [62, 0, 10, '', 829, 'S_BKEY'], // 828
  [62, 32769, 10, '', 828, 'S_BKEY2'], // 829
  [63, 0, 10, '', 831, 'S_RKEY'], // 830
  [63, 32769, 10, '', 830, 'S_RKEY2'], // 831
  [64, 0, 10, '', 833, 'S_YKEY'], // 832
  [64, 32769, 10, '', 832, 'S_YKEY2'], // 833
  [65, 0, 10, '', 835, 'S_BSKULL'], // 834
  [65, 32769, 10, '', 834, 'S_BSKULL2'], // 835
  [66, 0, 10, '', 837, 'S_RSKULL'], // 836
  [66, 32769, 10, '', 836, 'S_RSKULL2'], // 837
  [67, 0, 10, '', 839, 'S_YSKULL'], // 838
  [67, 32769, 10, '', 838, 'S_YSKULL2'], // 839
  [68, 0, -1, '', 0, 'S_STIM'], // 840
  [69, 0, -1, '', 0, 'S_MEDI'], // 841
  [70, 32768, 6, '', 843, 'S_SOUL'], // 842
  [70, 32769, 6, '', 844, 'S_SOUL2'], // 843
  [70, 32770, 6, '', 845, 'S_SOUL3'], // 844
  [70, 32771, 6, '', 846, 'S_SOUL4'], // 845
  [70, 32770, 6, '', 847, 'S_SOUL5'], // 846
  [70, 32769, 6, '', 842, 'S_SOUL6'], // 847
  [71, 32768, 6, '', 849, 'S_PINV'], // 848
  [71, 32769, 6, '', 850, 'S_PINV2'], // 849
  [71, 32770, 6, '', 851, 'S_PINV3'], // 850
  [71, 32771, 6, '', 848, 'S_PINV4'], // 851
  [72, 32768, -1, '', 0, 'S_PSTR'], // 852
  [73, 32768, 6, '', 854, 'S_PINS'], // 853
  [73, 32769, 6, '', 855, 'S_PINS2'], // 854
  [73, 32770, 6, '', 856, 'S_PINS3'], // 855
  [73, 32771, 6, '', 853, 'S_PINS4'], // 856
  [74, 32768, 6, '', 858, 'S_MEGA'], // 857
  [74, 32769, 6, '', 859, 'S_MEGA2'], // 858
  [74, 32770, 6, '', 860, 'S_MEGA3'], // 859
  [74, 32771, 6, '', 857, 'S_MEGA4'], // 860
  [75, 32768, -1, '', 0, 'S_SUIT'], // 861
  [76, 32768, 6, '', 863, 'S_PMAP'], // 862
  [76, 32769, 6, '', 864, 'S_PMAP2'], // 863
  [76, 32770, 6, '', 865, 'S_PMAP3'], // 864
  [76, 32771, 6, '', 866, 'S_PMAP4'], // 865
  [76, 32770, 6, '', 867, 'S_PMAP5'], // 866
  [76, 32769, 6, '', 862, 'S_PMAP6'], // 867
  [77, 32768, 6, '', 869, 'S_PVIS'], // 868
  [77, 1, 6, '', 868, 'S_PVIS2'], // 869
  [78, 0, -1, '', 0, 'S_CLIP'], // 870
  [79, 0, -1, '', 0, 'S_AMMO'], // 871
  [80, 0, -1, '', 0, 'S_ROCK'], // 872
  [81, 0, -1, '', 0, 'S_BROK'], // 873
  [82, 0, -1, '', 0, 'S_CELL'], // 874
  [83, 0, -1, '', 0, 'S_CELP'], // 875
  [84, 0, -1, '', 0, 'S_SHEL'], // 876
  [85, 0, -1, '', 0, 'S_SBOX'], // 877
  [86, 0, -1, '', 0, 'S_BPAK'], // 878
  [87, 0, -1, '', 0, 'S_BFUG'], // 879
  [88, 0, -1, '', 0, 'S_MGUN'], // 880
  [89, 0, -1, '', 0, 'S_CSAW'], // 881
  [90, 0, -1, '', 0, 'S_LAUN'], // 882
  [91, 0, -1, '', 0, 'S_PLAS'], // 883
  [92, 0, -1, '', 0, 'S_SHOT'], // 884
  [93, 0, -1, '', 0, 'S_SHOT2'], // 885
  [94, 32768, -1, '', 0, 'S_COLU'], // 886
  [95, 0, -1, '', 0, 'S_STALAG'], // 887
  [96, 0, 10, '', 889, 'S_BLOODYTWITCH'], // 888
  [96, 1, 15, '', 890, 'S_BLOODYTWITCH2'], // 889
  [96, 2, 8, '', 891, 'S_BLOODYTWITCH3'], // 890
  [96, 1, 6, '', 888, 'S_BLOODYTWITCH4'], // 891
  [28, 13, -1, '', 0, 'S_DEADTORSO'], // 892
  [28, 18, -1, '', 0, 'S_DEADBOTTOM'], // 893
  [97, 0, -1, '', 0, 'S_HEADSONSTICK'], // 894
  [98, 0, -1, '', 0, 'S_GIBS'], // 895
  [99, 0, -1, '', 0, 'S_HEADONASTICK'], // 896
  [100, 32768, 6, '', 898, 'S_HEADCANDLES'], // 897
  [100, 32769, 6, '', 897, 'S_HEADCANDLES2'], // 898
  [101, 0, -1, '', 0, 'S_DEADSTICK'], // 899
  [102, 0, 6, '', 901, 'S_LIVESTICK'], // 900
  [102, 1, 8, '', 900, 'S_LIVESTICK2'], // 901
  [103, 0, -1, '', 0, 'S_MEAT2'], // 902
  [104, 0, -1, '', 0, 'S_MEAT3'], // 903
  [105, 0, -1, '', 0, 'S_MEAT4'], // 904
  [106, 0, -1, '', 0, 'S_MEAT5'], // 905
  [107, 0, -1, '', 0, 'S_STALAGTITE'], // 906
  [108, 0, -1, '', 0, 'S_TALLGRNCOL'], // 907
  [109, 0, -1, '', 0, 'S_SHRTGRNCOL'], // 908
  [110, 0, -1, '', 0, 'S_TALLREDCOL'], // 909
  [111, 0, -1, '', 0, 'S_SHRTREDCOL'], // 910
  [112, 32768, -1, '', 0, 'S_CANDLESTIK'], // 911
  [113, 32768, -1, '', 0, 'S_CANDELABRA'], // 912
  [114, 0, -1, '', 0, 'S_SKULLCOL'], // 913
  [115, 0, -1, '', 0, 'S_TORCHTREE'], // 914
  [116, 0, -1, '', 0, 'S_BIGTREE'], // 915
  [117, 0, -1, '', 0, 'S_TECHPILLAR'], // 916
  [118, 32768, 6, '', 918, 'S_EVILEYE'], // 917
  [118, 32769, 6, '', 919, 'S_EVILEYE2'], // 918
  [118, 32770, 6, '', 920, 'S_EVILEYE3'], // 919
  [118, 32769, 6, '', 917, 'S_EVILEYE4'], // 920
  [119, 32768, 6, '', 922, 'S_FLOATSKULL'], // 921
  [119, 32769, 6, '', 923, 'S_FLOATSKULL2'], // 922
  [119, 32770, 6, '', 921, 'S_FLOATSKULL3'], // 923
  [120, 0, 14, '', 925, 'S_HEARTCOL'], // 924
  [120, 1, 14, '', 924, 'S_HEARTCOL2'], // 925
  [121, 32768, 4, '', 927, 'S_BLUETORCH'], // 926
  [121, 32769, 4, '', 928, 'S_BLUETORCH2'], // 927
  [121, 32770, 4, '', 929, 'S_BLUETORCH3'], // 928
  [121, 32771, 4, '', 926, 'S_BLUETORCH4'], // 929
  [122, 32768, 4, '', 931, 'S_GREENTORCH'], // 930
  [122, 32769, 4, '', 932, 'S_GREENTORCH2'], // 931
  [122, 32770, 4, '', 933, 'S_GREENTORCH3'], // 932
  [122, 32771, 4, '', 930, 'S_GREENTORCH4'], // 933
  [123, 32768, 4, '', 935, 'S_REDTORCH'], // 934
  [123, 32769, 4, '', 936, 'S_REDTORCH2'], // 935
  [123, 32770, 4, '', 937, 'S_REDTORCH3'], // 936
  [123, 32771, 4, '', 934, 'S_REDTORCH4'], // 937
  [124, 32768, 4, '', 939, 'S_BTORCHSHRT'], // 938
  [124, 32769, 4, '', 940, 'S_BTORCHSHRT2'], // 939
  [124, 32770, 4, '', 941, 'S_BTORCHSHRT3'], // 940
  [124, 32771, 4, '', 938, 'S_BTORCHSHRT4'], // 941
  [125, 32768, 4, '', 943, 'S_GTORCHSHRT'], // 942
  [125, 32769, 4, '', 944, 'S_GTORCHSHRT2'], // 943
  [125, 32770, 4, '', 945, 'S_GTORCHSHRT3'], // 944
  [125, 32771, 4, '', 942, 'S_GTORCHSHRT4'], // 945
  [126, 32768, 4, '', 947, 'S_RTORCHSHRT'], // 946
  [126, 32769, 4, '', 948, 'S_RTORCHSHRT2'], // 947
  [126, 32770, 4, '', 949, 'S_RTORCHSHRT3'], // 948
  [126, 32771, 4, '', 946, 'S_RTORCHSHRT4'], // 949
  [127, 0, -1, '', 0, 'S_HANGNOGUTS'], // 950
  [128, 0, -1, '', 0, 'S_HANGBNOBRAIN'], // 951
  [129, 0, -1, '', 0, 'S_HANGTLOOKDN'], // 952
  [130, 0, -1, '', 0, 'S_HANGTSKULL'], // 953
  [131, 0, -1, '', 0, 'S_HANGTLOOKUP'], // 954
  [132, 0, -1, '', 0, 'S_HANGTNOBRAIN'], // 955
  [133, 0, -1, '', 0, 'S_COLONGIBS'], // 956
  [134, 0, -1, '', 0, 'S_SMALLPOOL'], // 957
  [135, 0, -1, '', 0, 'S_BRAINSTEM'], // 958
  [136, 32768, 4, '', 960, 'S_TECHLAMP'], // 959
  [136, 32769, 4, '', 961, 'S_TECHLAMP2'], // 960
  [136, 32770, 4, '', 962, 'S_TECHLAMP3'], // 961
  [136, 32771, 4, '', 959, 'S_TECHLAMP4'], // 962
  [137, 32768, 4, '', 964, 'S_TECH2LAMP'], // 963
  [137, 32769, 4, '', 965, 'S_TECH2LAMP2'], // 964
  [137, 32770, 4, '', 966, 'S_TECH2LAMP3'], // 965
  [137, 32771, 4, '', 963, 'S_TECH2LAMP4'], // 966
];

/**
 * The eight `states[]` entry points one `mobjinfo` row carries, each 0 (`S_NULL`) where the type
 * has none.
 */
export interface MobjStates {
  spawn: number;
  see: number;
  pain: number;
  melee: number;
  missile: number;
  death: number;
  xdeath: number;
  raise: number;
}

/**
 * Every `mobjinfo[]` row's state pointers, index-aligned with `dehacked/tables.ts`'s `MOBJ_INFO`
 * (so `Thing N` is `MOBJ_STATES[N - 1]`). Kept as a separate table rather than widening `MobjRow`
 * because that one is hand-shaped around the stat sinks and this one is generated.
 */
export const MOBJ_STATES: readonly MobjStates[] = [
  { spawn: 149, see: 150, pain: 156, melee: 0, missile: 154, death: 158, xdeath: 165, raise: 0 }, // 1 MT_PLAYER
  { spawn: 174, see: 176, pain: 187, melee: 0, missile: 184, death: 189, xdeath: 194, raise: 203 }, // 2 MT_POSSESSED
  { spawn: 207, see: 209, pain: 220, melee: 0, missile: 217, death: 222, xdeath: 227, raise: 236 }, // 3 MT_SHOTGUY
  { spawn: 241, see: 243, pain: 269, melee: 0, missile: 255, death: 271, xdeath: 0, raise: 0 }, // 4 MT_VILE
  { spawn: 281, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 5 MT_FIRE
  { spawn: 321, see: 323, pain: 343, melee: 335, missile: 339, death: 345, xdeath: 0, raise: 351 }, // 6 MT_UNDEAD
  { spawn: 316, see: 0, pain: 0, melee: 0, missile: 0, death: 318, xdeath: 0, raise: 0 }, // 7 MT_TRACER
  { spawn: 311, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 8 MT_SMOKE
  { spawn: 362, see: 364, pain: 386, melee: 0, missile: 376, death: 388, xdeath: 0, raise: 398 }, // 9 MT_FATSO
  { spawn: 357, see: 0, pain: 0, melee: 0, missile: 0, death: 359, xdeath: 0, raise: 0 }, // 10 MT_FATSHOT
  { spawn: 406, see: 408, pain: 420, melee: 0, missile: 416, death: 422, xdeath: 429, raise: 435 }, // 11 MT_CHAINGUY
  { spawn: 442, see: 444, pain: 455, melee: 452, missile: 452, death: 457, xdeath: 462, raise: 470 }, // 12 MT_TROOP
  { spawn: 475, see: 477, pain: 488, melee: 485, missile: 0, death: 490, xdeath: 0, raise: 496 }, // 13 MT_SERGEANT
  { spawn: 475, see: 477, pain: 488, melee: 485, missile: 0, death: 490, xdeath: 0, raise: 496 }, // 14 MT_SHADOWS
  { spawn: 502, see: 503, pain: 507, melee: 0, missile: 504, death: 510, xdeath: 0, raise: 516 }, // 15 MT_HEAD
  { spawn: 527, see: 529, pain: 540, melee: 537, missile: 537, death: 542, xdeath: 0, raise: 549 }, // 16 MT_BRUISER
  { spawn: 522, see: 0, pain: 0, melee: 0, missile: 0, death: 524, xdeath: 0, raise: 0 }, // 17 MT_BRUISERSHOT
  { spawn: 556, see: 558, pain: 569, melee: 566, missile: 566, death: 571, xdeath: 0, raise: 578 }, // 18 MT_KNIGHT
  { spawn: 585, see: 587, pain: 593, melee: 0, missile: 589, death: 595, xdeath: 0, raise: 0 }, // 19 MT_SKULL
  { spawn: 601, see: 603, pain: 619, melee: 0, missile: 615, death: 621, xdeath: 0, raise: 0 }, // 20 MT_SPIDER
  { spawn: 632, see: 634, pain: 651, melee: 0, missile: 647, death: 653, xdeath: 0, raise: 660 }, // 21 MT_BABY
  { spawn: 674, see: 676, pain: 690, melee: 0, missile: 684, death: 691, xdeath: 0, raise: 0 }, // 22 MT_CYBORG
  { spawn: 701, see: 702, pain: 712, melee: 0, missile: 708, death: 714, xdeath: 0, raise: 720 }, // 23 MT_PAIN
  { spawn: 726, see: 728, pain: 742, melee: 0, missile: 736, death: 744, xdeath: 749, raise: 758 }, // 24 MT_WOLFSS
  { spawn: 763, see: 0, pain: 776, melee: 0, missile: 0, death: 764, xdeath: 0, raise: 0 }, // 25 MT_KEEN
  { spawn: 778, see: 0, pain: 779, melee: 0, missile: 0, death: 780, xdeath: 0, raise: 0 }, // 26 MT_BOSSBRAIN
  { spawn: 784, see: 785, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 27 MT_BOSSSPIT
  { spawn: 0, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 28 MT_BOSSTARGET
  { spawn: 787, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 29 MT_SPAWNSHOT
  { spawn: 791, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 30 MT_SPAWNFIRE
  { spawn: 806, see: 0, pain: 0, melee: 0, missile: 0, death: 808, xdeath: 0, raise: 0 }, // 31 MT_BARREL
  { spawn: 97, see: 0, pain: 0, melee: 0, missile: 0, death: 99, xdeath: 0, raise: 0 }, // 32 MT_TROOPSHOT
  { spawn: 102, see: 0, pain: 0, melee: 0, missile: 0, death: 104, xdeath: 0, raise: 0 }, // 33 MT_HEADSHOT
  { spawn: 114, see: 0, pain: 0, melee: 0, missile: 0, death: 127, xdeath: 0, raise: 0 }, // 34 MT_ROCKET
  { spawn: 107, see: 0, pain: 0, melee: 0, missile: 0, death: 109, xdeath: 0, raise: 0 }, // 35 MT_PLASMA
  { spawn: 115, see: 0, pain: 0, melee: 0, missile: 0, death: 117, xdeath: 0, raise: 0 }, // 36 MT_BFG
  { spawn: 667, see: 0, pain: 0, melee: 0, missile: 0, death: 669, xdeath: 0, raise: 0 }, // 37 MT_ARACHPLAZ
  { spawn: 93, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 38 MT_PUFF
  { spawn: 90, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 39 MT_BLOOD
  { spawn: 130, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 40 MT_TFOG
  { spawn: 142, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 41 MT_IFOG
  { spawn: 0, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 42 MT_TELEPORTMAN
  { spawn: 123, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 43 MT_EXTRABFG
  { spawn: 802, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 44 MT_MISC0
  { spawn: 804, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 45 MT_MISC1
  { spawn: 816, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 46 MT_MISC2
  { spawn: 822, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 47 MT_MISC3
  { spawn: 828, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 48 MT_MISC4
  { spawn: 830, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 49 MT_MISC5
  { spawn: 832, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 50 MT_MISC6
  { spawn: 838, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 51 MT_MISC7
  { spawn: 836, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 52 MT_MISC8
  { spawn: 834, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 53 MT_MISC9
  { spawn: 840, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 54 MT_MISC10
  { spawn: 841, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 55 MT_MISC11
  { spawn: 842, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 56 MT_MISC12
  { spawn: 848, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 57 MT_INV
  { spawn: 852, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 58 MT_MISC13
  { spawn: 853, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 59 MT_INS
  { spawn: 861, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 60 MT_MISC14
  { spawn: 862, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 61 MT_MISC15
  { spawn: 868, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 62 MT_MISC16
  { spawn: 857, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 63 MT_MEGA
  { spawn: 870, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 64 MT_CLIP
  { spawn: 871, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 65 MT_MISC17
  { spawn: 872, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 66 MT_MISC18
  { spawn: 873, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 67 MT_MISC19
  { spawn: 874, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 68 MT_MISC20
  { spawn: 875, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 69 MT_MISC21
  { spawn: 876, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 70 MT_MISC22
  { spawn: 877, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 71 MT_MISC23
  { spawn: 878, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 72 MT_MISC24
  { spawn: 879, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 73 MT_MISC25
  { spawn: 880, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 74 MT_CHAINGUN
  { spawn: 881, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 75 MT_MISC26
  { spawn: 882, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 76 MT_MISC27
  { spawn: 883, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 77 MT_MISC28
  { spawn: 884, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 78 MT_SHOTGUN
  { spawn: 885, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 79 MT_SUPERSHOTGUN
  { spawn: 959, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 80 MT_MISC29
  { spawn: 963, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 81 MT_MISC30
  { spawn: 886, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 82 MT_MISC31
  { spawn: 907, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 83 MT_MISC32
  { spawn: 908, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 84 MT_MISC33
  { spawn: 909, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 85 MT_MISC34
  { spawn: 910, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 86 MT_MISC35
  { spawn: 913, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 87 MT_MISC36
  { spawn: 924, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 88 MT_MISC37
  { spawn: 917, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 89 MT_MISC38
  { spawn: 921, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 90 MT_MISC39
  { spawn: 914, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 91 MT_MISC40
  { spawn: 926, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 92 MT_MISC41
  { spawn: 930, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 93 MT_MISC42
  { spawn: 934, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 94 MT_MISC43
  { spawn: 938, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 95 MT_MISC44
  { spawn: 942, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 96 MT_MISC45
  { spawn: 946, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 97 MT_MISC46
  { spawn: 906, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 98 MT_MISC47
  { spawn: 916, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 99 MT_MISC48
  { spawn: 911, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 100 MT_MISC49
  { spawn: 912, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 101 MT_MISC50
  { spawn: 888, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 102 MT_MISC51
  { spawn: 902, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 103 MT_MISC52
  { spawn: 903, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 104 MT_MISC53
  { spawn: 904, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 105 MT_MISC54
  { spawn: 905, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 106 MT_MISC55
  { spawn: 902, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 107 MT_MISC56
  { spawn: 904, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 108 MT_MISC57
  { spawn: 903, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 109 MT_MISC58
  { spawn: 905, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 110 MT_MISC59
  { spawn: 888, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 111 MT_MISC60
  { spawn: 515, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 112 MT_MISC61
  { spawn: 164, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 113 MT_MISC62
  { spawn: 193, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 114 MT_MISC63
  { spawn: 495, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 115 MT_MISC64
  { spawn: 600, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 116 MT_MISC65
  { spawn: 461, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 117 MT_MISC66
  { spawn: 226, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 118 MT_MISC67
  { spawn: 173, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 119 MT_MISC68
  { spawn: 173, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 120 MT_MISC69
  { spawn: 894, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 121 MT_MISC70
  { spawn: 895, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 122 MT_MISC71
  { spawn: 896, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 123 MT_MISC72
  { spawn: 897, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 124 MT_MISC73
  { spawn: 899, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 125 MT_MISC74
  { spawn: 900, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 126 MT_MISC75
  { spawn: 915, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 127 MT_MISC76
  { spawn: 813, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 128 MT_MISC77
  { spawn: 950, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 129 MT_MISC78
  { spawn: 951, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 130 MT_MISC79
  { spawn: 952, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 131 MT_MISC80
  { spawn: 953, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 132 MT_MISC81
  { spawn: 954, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 133 MT_MISC82
  { spawn: 955, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 134 MT_MISC83
  { spawn: 956, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 135 MT_MISC84
  { spawn: 957, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 136 MT_MISC85
  { spawn: 958, see: 0, pain: 0, melee: 0, missile: 0, death: 0, xdeath: 0, raise: 0 }, // 137 MT_MISC86
];

/** Sprite letter a `state_t.frame` names, the fullbright bit stripped: 0 is `A`. */
export function frameLetter(frame: number): string {
  return String.fromCharCode(65 + (frame & ~FF_FULLBRIGHT));
}

/** The five `states[]` entry points one `weaponinfo[]` row carries — `d_items.c`'s weapon table. */
export interface WeaponStates {
  /** `upstate`, the raise chain. A DEH `Weapon` record spells this **`Deselect frame`**. */
  up: number;
  /** `downstate`, the lower chain. A DEH `Weapon` record spells this **`Select frame`**. */
  down: number;
  /** `readystate`, the idle bob — `Bobbing frame`. */
  ready: number;
  /**
   * `atkstate`, the fire chain a trigger pull enters — `Shooting frame`. The one the rate is walked
   * from.
   */
  atk: number;
  /**
   * `flashstate`, the muzzle-flash layer — `Firing frame`. 0 for the fist and chainsaw, which have
   * none.
   */
  flash: number;
}

/**
 * Every `weaponinfo[]` row's state pointers, in `p_pspr.h`'s `weapontype_t` order — the order a DEH
 * `Weapon N` record indexes 0-based, which `dehacked/tables.ts`'s `WEAPON_ORDER` maps onto
 * `WeaponId`. The ammo type each row also carries lives in `WEAPONS` itself, so only the states are
 * here.
 *
 * The `up`/`down` naming is `d_items.c`'s, not the patch format's: `d_deh.c`'s `deh_weapon[]` calls
 * `upstate` "Deselect frame" and `downstate` "Select frame", the two the wrong way round. The
 * labels are what a patch writes, so the bridge keeps them and this table keeps the struct's.
 */
export const WEAPON_STATES: readonly WeaponStates[] = [
  { up: 4, down: 3, ready: 2, atk: 5, flash: 0 }, // 0 fist
  { up: 12, down: 11, ready: 10, atk: 13, flash: 17 }, // 1 pistol
  { up: 20, down: 19, ready: 18, atk: 21, flash: 30 }, // 2 shotgun
  { up: 51, down: 50, ready: 49, atk: 52, flash: 55 }, // 3 chaingun
  { up: 59, down: 58, ready: 57, atk: 60, flash: 63 }, // 4 rocket launcher
  { up: 76, down: 75, ready: 74, atk: 77, flash: 79 }, // 5 plasma rifle
  { up: 83, down: 82, ready: 81, atk: 84, flash: 88 }, // 6 BFG
  { up: 70, down: 69, ready: 67, atk: 71, flash: 0 }, // 7 chainsaw
  { up: 34, down: 33, ready: 32, atk: 35, flash: 47 }, // 8 super shotgun
];

/**
 * The states one weapon's fire chain occupies: from `atkstate` along `next`, up to and
 * **including** the `A_ReFire` state that closes it — with the trigger held, `A_ReFire` re-enters
 * `atkstate` the moment it is reached (`p_pspr.c`), so the chain never runs past it. Bounded by the
 * visited set, so a patched chain that loops back without one still terminates.
 *
 * Lives beside the data rather than in `dehacked/frames.ts` because two readers need the same span
 * and must not disagree about it: the walker sums its tics for the fire rate (docs/weapons.md
 * § Fire rates), and `dehacked/tables.ts` classifies a `Frame` record by whether it names one.
 */
export function fireChainStates(states: readonly StateRow[], atk: number): number[] {
  const span: number[] = [];
  const seen = new Set<number>();
  let cur = atk;
  while (cur !== 0 && states[cur] !== undefined && !seen.has(cur)) {
    seen.add(cur);
    span.push(cur);
    if (states[cur][3] === 'A_ReFire' || states[cur][2] === -1) break;
    cur = states[cur][4];
  }
  return span;
}

/**
 * Whether a state belongs to a weapon's first-person chain — `S_LIGHTDONE` through `S_BFGFLASH2`,
 * the states `p_pspr.c` steps rather than `P_MobjThinker`. Decided by sprite:
 * `SPR_SHTG`..`SPR_BFGF` (indices 1-15) are the gun and flash lumps, and nothing in the world draws
 * them. This engine has no first-person weapon, so a `Frame` record on one of these has no sink
 * here.
 */
export function isPspriteState(index: number): boolean {
  const row = STATES[index];
  return row !== undefined && row[0] >= 1 && row[0] <= 15;
}

/**
 * Whether a psprite state is a muzzle flash — the `S_*FLASH*` states and `S_LIGHTDONE`, which
 * `P_SetPsprite` runs on the flash layer. Named by `statenum_t` rather than by sprite because the
 * super shotgun's flash (`S_DSGUNFLASH1`-`2`) draws the gun's own `SHT2` lump.
 */
export function isFlashState(index: number): boolean {
  const name = STATES[index]?.[5];
  return name !== undefined && (name.includes('FLASH') || name === 'S_LIGHTDONE');
}
