/**
 * The screen shown when the app cannot start (src/main.jsx): the error, a
 * Reload button and the hard-reload hint - after a redeploy the browser's
 * cached copy of the page can be the cause (src/utils/chunkReload.js
 * reloads once by itself first).
 */
import BrandMark, { BrandWordmark } from '../brand/BrandMark';

export default function StartupError({ error, staleChunk = false }) {
  const message = String(error?.message || error || 'Unknown error');
  const hardReload = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '') ? 'Cmd+Shift+R' : 'Ctrl+Shift+R (Ctrl+F5)';
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 640, color: 'var(--os-text-primary, #151515)' }} data-testid="startup-error" data-stale-chunk={staleChunk ? 'true' : 'false'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}><BrandMark size={36} /><BrandWordmark size={22} /></div>
      <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>Jacarium could not start</h1>
      <p style={{ margin: '0 0 12px', fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-word' }}>{message}</p>
      {staleChunk && (
        <p style={{ margin: '0 0 12px', fontSize: 14 }}>
          The server was updated and this browser still had an older copy of the page. A reload fetches the current one.
        </p>
      )}
      <button type="button" onClick={() => window.location.reload()} style={{ padding: '8px 14px', fontSize: 14, borderRadius: 'var(--radius-sm, 8px)', border: '1px solid #0066cc', background: '#0066cc', color: '#fff', cursor: 'pointer' }} data-testid="startup-reload">
        Reload
      </button>
      <p style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>
        If it keeps failing, hard-reload the page ({hardReload}) to bypass the browser&apos;s cache.
      </p>
    </div>
  );
}
