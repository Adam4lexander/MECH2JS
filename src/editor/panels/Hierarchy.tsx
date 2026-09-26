/**
 * The hierarchy: the game's own organisation, not an invented one.
 *  - Gamepieces: mechTable (each with its scene tree)
 *  - World records: the mission's scenery, by record
 *  - Scene roots: every scene-node tree not reached from the above
 *  - Globals: every registered global group (the C globals, by subject)
 *
 * @portOnly
 */
import { useMemo, useState } from 'react';
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { globalGroups } from '../../engine/globals.ts';
import { objectsOnList, worldRootNode, altRootNode, auxRootNode } from '../../engine/scene/objectLists.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { world } from '../../sim/world/worldRecords.ts';
import { things } from '../../sim/things/gameThings.ts';
import { resources } from '../../engine/resources/cache.ts';
import { engineStore, editorStore, useRevision } from '../store/store.ts';
import { select, selected } from '../store/selection.ts';
import { structOf } from './Inspector.tsx';

interface Item {
  key: string;
  label: string;
  detail?: string;
  target?: object;
  children?: () => Item[];
}

function polyName(id: number): string {
  return resources.mainProject?.resourceName('POLY', id) ?? '';
}

function objLabel(o: WorldObject | null): string {
  if (!o) return '';
  return `type 0x${o.type.toString(16)} class ${o.objectClass}`;
}

function nodeItem(n: SceneNode, key: string, label?: string): Item {
  const kids: SceneNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) kids.push(c);
  return {
    key,
    label: label ?? (n.userData ? 'node' : 'node (empty)'),
    detail: objLabel(n.userData),
    target: n,
    children: kids.length ? () => kids.map((c, i) => nodeItem(c, `${key}/${i}`)) : undefined,
  };
}

function roots(): Item[] {
  const items: Item[] = [];
  items.push({
    key: 'mechs',
    label: `Gamepieces (${mechs.mechCount})`,
    target: mechs.mechTable,
    children: () =>
      mechs.mechTable.slice(0, mechs.mechCount).map((m, i) => ({
        key: `mech${i}`,
        label: `${i}: ${m?.name || '(unnamed)'}`,
        detail: m ? `class ${m.gamepieceClass}${i === mechs.playerMechIndex ? ' · player' : ''}` : '',
        target: m ?? undefined,
        children: m?.node ? () => [nodeItem(m.node!, `mech${i}/node`, 'scene node')] : undefined,
      })),
  });
  items.push({
    key: 'records',
    label: `World records (${world.worldObjectCount})`,
    target: world.worldRecords,
    children: () =>
      world.worldRecords.slice(0, world.worldObjectCount).map((r, i) => ({
        key: `rec${i}`,
        label: `${i}: ${polyName(r.polyId) || `POLY ${r.polyId}`}`,
        detail: `${r.parent === -2 ? 'static' : `parent ${r.parent}`}${r.gamething >= 0 ? ` · GT ${things.gameThings[r.gamething]?.name ?? r.gamething}` : ''}${r.flags & 0x800 ? ' · suppressed' : ''}`,
        target: r,
        children: r.node ? () => [nodeItem(r.node!, `rec${i}/node`, 'scene node')] : undefined,
      })),
  });
  const listItem = (key: string, label: string, sentinel: WorldObject): Item => ({
    key,
    label,
    target: sentinel,
    children: () => [...objectsOnList(sentinel)].map((o, i) => ({ key: `${key}${i}`, label: `object ${i}`, detail: objLabel(o), target: o })),
  });
  items.push(listItem('wl', 'Drawn objects (world list)', worldRootNode));
  items.push(listItem('al', 'Hidden objects (alt list)', altRootNode));
  items.push(listItem('xl', 'Set-aside objects (aux list)', auxRootNode));
  items.push({
    key: 'globals',
    label: 'Globals',
    children: () => globalGroups().map((g) => ({ key: `g:${g.name}`, label: g.name, target: g.state })),
  });
  return items;
}

function Row({ item, depth }: { item: Item; depth: number }) {
  const [open, setOpen] = useState(false);
  const sel = selected();
  const kids = useMemo(() => (open && item.children ? item.children() : []), [open, item]);
  return (
    <>
      <div
        className={`tree-row${sel?.target === item.target && item.target ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => item.target && select({ label: item.label, struct: structOf(item.target), target: item.target })}
      >
        <span
          className="tree-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {item.children ? (open ? '▾' : '▸') : ' '}
        </span>
        <span className="tree-label">{item.label}</span>
        {item.detail ? <span className="tree-detail">{item.detail}</span> : null}
      </div>
      {kids.map((k) => (
        <Row key={k.key} item={k} depth={depth + 1} />
      ))}
    </>
  );
}

export function Hierarchy() {
  const rev = useRevision(engineStore);
  useRevision(editorStore);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => roots(), [rev]);
  return (
    <div className="tree">
      {items.map((it) => (
        <Row key={it.key} item={it} depth={0} />
      ))}
    </div>
  );
}
