/**
 * The controls files on a first run. In the original the installer left
 * INPUT.MAP, GAMEKEY.MAP and the giddi\*.cpc files on the disk, and from
 * then on the COCKPIT CONTROLS screen rewrote INPUT.MAP and config00.cpc.
 * The port reads none of the install's copies: when its disk lacks them it
 * writes its own -
 *
 *   GAMEKEY.MAP             the port's table (sim/controls/gamekeyMap.ts)
 *   giddi\keyboard.cpc,     the port's default profiles (profiles.ts), in
 *   giddi\mouse.cpc         the .cpc layout RESET DEFAULTS reads
 *   INPUT.MAP,              what the device panel's ACCEPT writes with the
 *   giddi\config00.cpc      keyboard and the mouse chosen: the ported
 *                           controls_reset_defaults and controls_accept_config
 *
 * - each only when absent, so a player's configuration is never replaced.
 * An INPUT.MAP missing beside a config00.cpc is rewritten from it (the
 * screen's own load, then ACCEPT CONFIG AND EXIT).
 *
 * @portOnly the port's first run
 */
import { divergence } from '../../core/provenance.ts';
import type { ExeImage } from '../../data/exe/ExeImage.ts';
import { lxModuleLoad } from '../../data/exe/tables/menus.ts';
import { dosFileExists, dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { resetAllGlobals } from '../../engine/globals.ts';
import { setBootImage } from '../../engine/image.ts';
import { emptyRecord, giddiDriverFor } from '../../sim/controls/giddi.ts';
import { gamekeyMapBytes } from '../../sim/controls/gamekeyMap.ts';
import { configFileName, CONTROLS, controlsChooseDevice, controlsResetDefaults, controlsScreenSetup } from './config.ts';
import { inputDeviceGet, inputDeviceCount } from './devices.ts';
import { controlMapName, controlsAcceptConfigFiles } from './inputMap.ts';
import { DEVICE_PROFILES, profileToCpc } from './profiles.ts';
// the shell's memory must be registered before the process start resets it
import '../memory.ts';

/** What seedControlFiles wrote. */
export interface ControlSeedReport {
  written: string[];
}

/**
 * Writes the controls files the disk lacks. Needs MW2SHELL.EXE (its tables
 * and memory: the shell "process" is started for the call, as the screen
 * would run in it) and the GIDDI drivers on the disk's read-only layer.
 * Leaves the shell's globals as the call left them; a shell started later
 * resets them.
 */
export function seedControlFiles(shellExe: ExeImage): ControlSeedReport {
  const written: string[] = [];
  if (!dosFileExists('GAMEKEY.MAP')) {
    divergence('GAMEKEY.MAP: the port writes its own table; the install\'s is not read');
    dosFileWrite('GAMEKEY.MAP', gamekeyMapBytes());
    written.push('GAMEKEY.MAP');
  }
  const needProfiles = DEVICE_PROFILES.filter((p) => !dosFileExists(`giddi\\${p.device}.cpc`));
  const needConfig = !dosFileExists(configFileName(0)) || !dosFileExists('input.map');
  if (needProfiles.length === 0 && !needConfig) return { written };

  setBootImage(shellExe, 'mw2shell');
  resetAllGlobals('mw2shell');
  const controls = Array.from({ length: CONTROLS }, (_, i) => controlMapName(i));
  for (const p of needProfiles) {
    const dll = dosFileLoad(`giddi\\${p.device}.dll`);
    const module = dll ? lxModuleLoad(dll) : null;
    const driver = module ? giddiDriverFor(p.device, module) : null;
    if (!driver) continue;
    const record = emptyRecord();
    driver.init(record);
    const path = `giddi\\${p.device}.cpc`;
    dosFileWrite(path, profileToCpc(p, controls, record));
    written.push(path.toUpperCase());
  }
  if (!needConfig) return { written };

  // controls_screen's start: the devices, the keyboard chosen, config00 loaded if there is one
  if (controlsScreenSetup() < 0) return { written };
  if (!dosFileExists(configFileName(0))) {
    divergence('first run: the controls configuration is the device panel\'s ACCEPT with the keyboard and the mouse chosen, where the original started from the files its installer left');
    for (let i = 0; i < inputDeviceCount(); i++) if (inputDeviceGet(i)?.name === 'mouse') controlsChooseDevice(i);
    controlsResetDefaults();
  }
  if (controlsAcceptConfigFiles()) written.push('INPUT.MAP', configFileName(0).toUpperCase());
  return { written };
}
