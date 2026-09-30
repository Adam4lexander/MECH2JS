/**
 * The page's start when the dev server has no install (MW2_ROOT unset) or
 * there is no dev server: the player drops the MechWarrior 2 folder on the
 * page, or picks it (app/droppedInstall.ts). A folder the browser kept from
 * before opens straight away, or - when the browser wants the player's leave
 * again - is one click away.
 *
 * @portOnly the host's setup
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { canPickDirectory, type DroppedInstall, installFromDrop, installFromFiles, installFromPicker, rememberedInstall, reopenInstall } from './droppedInstall.ts';

export function InstallDrop({ onInstall, error }: { onInstall: (install: DroppedInstall) => void; error: string | null }) {
  const [checking, setChecking] = useState(true);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(error);
  const [remembered, setRemembered] = useState<FileSystemDirectoryHandle | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    (p: Promise<DroppedInstall | null>) => {
      setBusy(true);
      setFailed(null);
      p.then((install) => {
        setBusy(false);
        if (install) onInstall(install);
      }).catch((e: unknown) => {
        setBusy(false);
        setFailed(e instanceof Error ? e.message : String(e));
      });
    },
    [onInstall],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const dir = await rememberedInstall();
      // after a failed load the player chooses, rather than the same folder failing again
      const install = dir && !error ? await reopenInstall(dir, false).catch(() => null) : null;
      if (!live) return;
      if (install) return onInstall(install);
      setRemembered(dir);
      setChecking(false);
    })();
    return () => {
      live = false;
    };
  }, [error, onInstall]);

  if (checking) return <div className="boot">starting…</div>;
  return (
    <div
      className={over ? 'install over' : 'install'}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!busy) take(installFromDrop(e.dataTransfer));
      }}
    >
      <div className="install-box">
        <h1>MechWarrior 2</h1>
        <div className="install-target">{busy ? 'Reading the folder…' : 'Drop your MechWarrior 2 folder here'}</div>
        <div className="hint">
          The install directory, with MW2.PRJ, MW2.EXE, MW2SHELL.EXE and the .MW2 archives - and the game CD's image (.CUE / .BIN) beside them for the movies and the music.
          The files stay where they are: the game reads them from your disk as it goes.
        </div>
        <div className="install-actions">
          <button disabled={busy} onClick={() => (canPickDirectory() ? take(installFromPicker()) : input.current?.click())}>
            Choose folder…
          </button>
          {remembered && (
            <button disabled={busy} onClick={() => take(reopenInstall(remembered, true))}>
              Open {remembered.name} again
            </button>
          )}
        </div>
        {failed && <div className="install-error">{failed}</div>}
        <div className="hint">Or set MW2_ROOT in .env.local to the install and restart the dev server.</div>
        <input
          ref={input}
          type="file"
          hidden
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) take(installFromFiles(files));
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
