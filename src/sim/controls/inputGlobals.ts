/**
 * Input state outside ControlState's named channels.
 */
import { registerGlobals } from '../../engine/globals.ts';

export const inputGlobals = registerGlobals(
  'input',
  {
    /**
     * playerControls +0x14 (a short): the keystroke waiting this frame. It is
     * not one of the game's control channels, so ControlState has no field
     * for it; the name rests on its consumers (menu_poll_key and
     * key_command_update read it as a key code and zero it to consume it).
     */
    controlKey: 0,
  },
  () => {
    inputGlobals.controlKey = 0;
  },
);
