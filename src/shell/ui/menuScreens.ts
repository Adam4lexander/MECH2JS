/**
 * The screens shell_menu opens: 1 COMBAT VARIABLES (the options panel), 2
 * COCKPIT CONTROLS (controls_screen), 3 HALL OF HONOR, 4 THE KESHIK
 * (credits_screen). Each registers here when its module is ported, so the
 * menu does not import screens that import the menu.
 *
 * @portOnly the menu's dispatch to its sub-screens
 */
import type { Blocking } from '../host/blocking.ts';

type SubScreen = () => Blocking<void>;

const screens = new Map<number, SubScreen>();

export const menuScreens = {
  register(item: number, fn: SubScreen): void {
    screens.set(item, fn);
  },
  *run(item: number): Blocking<void> {
    const fn = screens.get(item);
    if (fn) yield* fn();
  },
};
