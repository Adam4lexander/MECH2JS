/**
 * Remote weapon fire. A DA packet carries one bit per weapon a mech fired
 * since its owner's last packet (bits 5..14 of the word at +3, by
 * MechWeapon.originalIndex); netplay_apply_state sets netplayWeaponFired from
 * them and netplay_weapons_start_burst starts those bursts locally, so a
 * remote mech's shots fly - and hit - on every machine.
 */
import { unestablished } from '../../core/provenance.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import type { MechLoadout } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32s } from '../../engine/image.ts';
import { weaponTypes } from '../mech/config.ts';
import { loadoutWeapons } from '../mech/loadout.ts';

export const netWeapons = registerGlobals(
  'netWeapons',
  {
    /**
     * 0x159418: ten dwords, one per weapon slot - 1 when a received DA packet
     * said that weapon fired. netplay_weapons_start_burst clears each as it
     * starts the burst; mech_weapons_cancel_bursts clears them all.
     */
    netplayWeaponFired: new Int32Array(10),
  },
  () => {
    netWeapons.netplayWeaponFired = Int32Array.from(imageI32s(LABEL.netplayWeaponFired, 10, new Array<number>(10).fill(0)));
  },
);

/**
 * Starts a burst on each of a remote mech's weapons flagged in
 * netplayWeaponFired, clearing the flag: the writes the local trigger makes
 * in mech_weapons_tick (fireState 2, stateTick 0, shotsLeft = the type's
 * shots, the lock from targetHandle for a guided type when the loadout is
 * locked, else none) - but from any state except -1 (out of ammo), and
 * without weapon_fire_alert_target.
 *
 * @mw2 netplay_weapons_start_burst 0x00052cb0
 * @fidelity exact
 */
export function netplayWeaponsStartBurst(l: MechLoadout): void {
  const fired = netWeapons.netplayWeaponFired;
  const weapons = loadoutWeapons(l);
  const types = weaponTypes();
  for (let i = 0; i < 10; i++) {
    if (fired[i] === 0) continue;
    fired[i] = 0;
    const w = weapons[i]!;
    if (w.fireState === -1) continue;
    w.fireState = 2;
    const wt = types[w.type];
    w.stateTick = 0;
    if (!wt) {
      // an empty slot (type < 0) indexes weaponTypes out of its table in the original
      unestablished(`netplay_weapons_start_burst: slot ${i} has no weapon type (${w.type}); shots and guidance taken as 0`, 'netplay_weapons_start_burst');
      w.shotsLeft = 0;
      w.lockType = 0;
      w.lockIndex = 0;
      continue;
    }
    w.shotsLeft = wt.shots;
    if (wt.guided === 0 || (l.flags & 0x80) === 0) {
      w.lockType = 0;
      w.lockIndex = w.lockType;
    } else {
      w.lockIndex = l.entity!.targetHandle & 0xff;
      w.lockType = l.entity!.targetHandle & 0xf00;
    }
  }
}
