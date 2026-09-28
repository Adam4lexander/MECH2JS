/**
 * One NetMech station - one MW2.EXE - in its own process, for
 * test/sim/netplay.test.ts. The port keeps a program's state in module
 * globals, so two stations need two processes; the test is the network,
 * carrying each packet from one station's outbox to the other's inbox, and
 * drives both in lockstep so a run is deterministic.
 *
 * argv: <station> <stationCount> <mission>. Commands arrive over IPC and
 * each is answered with { id, ...result }.
 */
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { bootMissionStartSteps } from '../../src/mission/load.ts';
import { mainLoopFrame, mainLoopRunning } from '../../src/mission/mainLoop.ts';
import { missionEnd } from '../../src/mission/end.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { clock } from '../../src/engine/clock.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { loadoutSections } from '../../src/sim/mech/loadout.ts';
import { mechDestroySection } from '../../src/sim/mech/damage.ts';
import { messages } from '../../src/sim/cockpit/messages.ts';
import { ui } from '../../src/sim/ui/uiContext.ts';
import { things } from '../../src/sim/things/gameThings.ts';
import { gamethingDestroy } from '../../src/sim/things/gameThingDamage.ts';
import { videoText } from '../../src/sim/display/videoText.ts';
import { weaponGlobals } from '../../src/sim/weapons/weapons.ts';
import { net, type NetBlocking } from '../../src/sim/net/netplay.ts';
import { netplayBuildState, netplayFrameExchange } from '../../src/sim/net/netSession.ts';
import { netDriver, setNetTransport } from '../../src/sim/net/transport.ts';
import { QueueTransport } from '../../src/sim/net/memoryTransport.ts';
import { gameSource, installFiles } from '../support/env.ts';

const station = Number(process.argv[2]);
const count = Number(process.argv[3]);
const mission = process.argv[4]!;

interface Sent {
  to: number;
  bytes: number[];
}
let outbox: Sent[] = [];
let received: { from: number; bytes: number[] }[] = [];

const transport = new QueueTransport(station, count, (to, bytes) => {
  outbox.push({ to, bytes: Array.from(bytes) });
  return true;
});
// what the frame takes off the driver, for the test to compare with what was sent
const take = transport.receive.bind(transport);
transport.receive = () => {
  const p = take();
  if (p) received.push({ from: p.from, bytes: Array.from(p.bytes) });
  return p;
};

const src = gameSource();
const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
const prj = new ProjectFile(await src.read('MW2.PRJ'));
setNetTransport(transport);
let boot: NetBlocking<boolean> | false = bootMissionStartSteps({ exe, prj, looseFiles: installFiles(), argv: ['MW2', '-n', '-g=NETWAIT', mission] });

function mechState(i: number) {
  const e = mechs.mechTable[i]!;
  const l = e.loadout!;
  return {
    index: e.index,
    flags: e.flags,
    pos: [e.posX, e.posY, e.posZ],
    angles: [e.pitch, e.heading, e.roll],
    status: l.status,
    ramps: l.ramps.map((r) => [r.current, r.target]),
    sections: loadoutSections(l).map((s) => [s.armorFront, s.armorRear, s.internal, s.flags]),
  };
}

function state() {
  return {
    station,
    simTick: clock.simTick,
    simClockLast: clock.simClockLast,
    simClockMode: clock.simClockMode,
    netRole: net.netRole,
    netSessionState: net.netSessionState,
    netMasterStation: net.netMasterStation,
    netMyStation: net.netMyStation,
    netActiveStations: net.netActiveStations,
    netStationFlags: Array.from(net.netStationFlags),
    netOpponentAnnounced: Array.from(net.netOpponentAnnounced),
    playerMechIndex: mechs.playerMechIndex,
    mechs: [0, 1].map(mechState),
    messages: messages.messageSlots.filter((s) => s.inUse !== 0).map((s) => s.text),
    videoText: videoText.shown?.text ?? null,
    thingsDestroyed: things.gameThings.map((g, i) => ((g.flags & 4) !== 0 ? i : -1)).filter((i) => i >= 0),
    running: mainLoopRunning(),
  };
}

/** This station's replica of mechTable[i] through the DA encoder, as its owner would send it. */
function reencode(i: number): number[] {
  const saved = {
    player: mechs.playerMechIndex,
    packet: net.netStatePacket!.slice(),
    local: weaponGlobals.netplayWeaponFiredLocal.slice(),
    queue: [netDriver.dat0009830c, netDriver.dat00098314],
    send: netDriver.sendBuffer.slice(),
  };
  mechs.playerMechIndex = i;
  weaponGlobals.netplayWeaponFiredLocal.fill(0);
  netDriver.dat0009830c = 1;
  netplayBuildState();
  const out = Array.from(net.netStatePacket!);
  mechs.playerMechIndex = saved.player;
  net.netStatePacket!.set(saved.packet);
  weaponGlobals.netplayWeaponFiredLocal.set(saved.local);
  [netDriver.dat0009830c, netDriver.dat00098314] = saved.queue as [number, number];
  netDriver.sendBuffer.set(saved.send);
  return out;
}

function flush() {
  const r = { outbox, received };
  outbox = [];
  received = [];
  return r;
}

type Command =
  | { id: number; cmd: 'deliver'; from: number; bytes: number[] }
  | { id: number; cmd: 'join'; ticks: number }
  | { id: number; cmd: 'frame'; ticks: number }
  | { id: number; cmd: 'exchange' }
  | { id: number; cmd: 'state' }
  | { id: number; cmd: 'reencode'; mech: number }
  | { id: number; cmd: 'destroySection'; location: number }
  | { id: number; cmd: 'destroyThing'; thing: number }
  | { id: number; cmd: 'quit'; ticks: number }
  | { id: number; cmd: 'exit' };

function handle(c: Command): object {
  switch (c.cmd) {
    case 'deliver':
      transport.deliver(c.from, Uint8Array.from(c.bytes));
      return {};
    case 'join': {
      if (!boot) return { done: true, ok: false, ...flush() };
      for (let i = 0; i < c.ticks; i++) ailTimerService();
      const r = boot.next();
      if (r.done) boot = false;
      return { done: r.done === true, ok: r.done ? r.value : null, ...flush(), state: state() };
    }
    case 'frame': {
      const before = state();
      for (let i = 0; i < c.ticks; i++) ailTimerService();
      mainLoopFrame();
      return { before, ...flush(), state: state() };
    }
    case 'exchange': {
      // main's first call alone: what arrived is applied, and nothing of the frame after it runs
      const before = state();
      netplayFrameExchange();
      return { before, ...flush(), state: state() };
    }
    case 'state':
      return { state: state() };
    case 'reencode':
      return { bytes: reencode(c.mech) };
    case 'destroySection': {
      const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
      mechDestroySection(l, c.location);
      return { state: state() };
    }
    case 'destroyThing':
      gamethingDestroy(c.thing);
      return { state: state() };
    case 'quit': {
      // the pilot quits (command 0x50, as the exit prompt's key does): main's loop runs out and main shuts down, netplay_shutdown signing off
      ui.quitCountdown = (ui.quitCountdown + 2) | 0;
      ui.quitRequested = 1;
      while (mainLoopRunning()) {
        for (let i = 0; i < c.ticks; i++) ailTimerService();
        mainLoopFrame();
      }
      missionEnd();
      return { ...flush(), state: state() };
    }
    case 'exit':
      setImmediate(() => process.exit(0));
      return {};
  }
}

process.on('message', (m: Command) => {
  try {
    process.send!({ id: m.id, ...handle(m) });
  } catch (e) {
    process.send!({ id: m.id, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
});
process.send!({ id: 0, ready: true });
