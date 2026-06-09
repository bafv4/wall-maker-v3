/**
 * Phase 2 検証 UI（最小）。
 * デフォルト WallState を保持し、buildPack → JSZip → ダウンロードまで通すだけ。
 * 本格的な UI 移植は Phase 4。Web アダプタの正式実装は Phase 6。
 */
import { useState } from 'react';
import JSZip from 'jszip';
import { buildPack } from './core/buildPack';
import { createDefaultWallState, type WallState } from './core/state';

function App() {
  const [state, setState] = useState<WallState>(() => createDefaultWallState());
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const append = (line: string) =>
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  async function handleExport() {
    setBusy(true);
    try {
      const pack = await buildPack(state);
      const zip = new JSZip();
      for (const [path, value] of pack) {
        zip.file(path, value);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = state.packInfo.name.trim() || 'seedqueue-pack';
      a.href = url;
      a.download = `${name}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      append(`exported "${name}.zip" — ${pack.size} files`);
    } catch (e) {
      append(`error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>
        SeedQueue Wall Maker — Phase 2 dev harness
      </h1>

      <fieldset style={{ marginBottom: 16, padding: 12 }}>
        <legend>Pack info</legend>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Name:&nbsp;
          <input
            value={state.packInfo.name}
            onChange={(e) =>
              setState({
                ...state,
                packInfo: { ...state.packInfo, name: e.target.value },
              })
            }
          />
        </label>
        <label style={{ display: 'block' }}>
          Description:&nbsp;
          <input
            value={state.packInfo.description}
            onChange={(e) =>
              setState({
                ...state,
                packInfo: { ...state.packInfo, description: e.target.value },
              })
            }
            style={{ width: 360 }}
          />
        </label>
      </fieldset>

      <fieldset style={{ marginBottom: 16, padding: 12 }}>
        <legend>Resolution</legend>
        <label>
          W:&nbsp;
          <input
            type="number"
            min={1}
            value={state.resolution.width}
            onChange={(e) =>
              setState({
                ...state,
                resolution: {
                  ...state.resolution,
                  width: Math.max(1, Math.floor(Number(e.target.value) || 0)),
                },
              })
            }
            style={{ width: 80 }}
          />
        </label>
        &nbsp;&nbsp;
        <label>
          H:&nbsp;
          <input
            type="number"
            min={1}
            value={state.resolution.height}
            onChange={(e) =>
              setState({
                ...state,
                resolution: {
                  ...state.resolution,
                  height: Math.max(1, Math.floor(Number(e.target.value) || 0)),
                },
              })
            }
            style={{ width: 80 }}
          />
        </label>
      </fieldset>

      <fieldset style={{ marginBottom: 16, padding: 12 }}>
        <legend>Main grid</legend>
        <label>
          rows:&nbsp;
          <input
            type="number"
            min={1}
            value={state.layout.main.rows}
            onChange={(e) =>
              setState({
                ...state,
                layout: {
                  ...state.layout,
                  main: {
                    ...state.layout.main,
                    rows: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  },
                },
              })
            }
            style={{ width: 60 }}
          />
        </label>
        &nbsp;&nbsp;
        <label>
          columns:&nbsp;
          <input
            type="number"
            min={1}
            value={state.layout.main.columns}
            onChange={(e) =>
              setState({
                ...state,
                layout: {
                  ...state.layout,
                  main: {
                    ...state.layout.main,
                    columns: Math.max(
                      1,
                      Math.floor(Number(e.target.value) || 1),
                    ),
                  },
                },
              })
            }
            style={{ width: 60 }}
          />
        </label>
      </fieldset>

      <button
        onClick={handleExport}
        disabled={busy}
        style={{ padding: '8px 16px', fontSize: 14 }}
      >
        {busy ? 'Building…' : 'Export Pack (.zip)'}
      </button>

      <pre
        style={{
          marginTop: 16,
          padding: 12,
          background: '#f5f5f5',
          minHeight: 80,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
        }}
      >
        {log.length === 0 ? '(no actions yet)' : log.join('\n')}
      </pre>
    </main>
  );
}

export default App;
