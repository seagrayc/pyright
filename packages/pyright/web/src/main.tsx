import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

function useQueryParam(name: string): [string | null, (value: string) => void] {
  const [value, setValue] = useState<string | null>(() => new URL(window.location.href).searchParams.get(name));
  const setter = (v: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(name, v);
    history.replaceState({}, '', url.toString());
    setValue(v);
  };
  return [value, setter];
}

function App() {
  const [clientId, setClientId] = useQueryParam('clientId');
  const [sessionId, setSessionId] = useQueryParam('sessionId');
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [payload, setPayload] = useState<string>('{}');
  const [repoPath, setRepoPath] = useState<string>('');
  const [pythonPath, setPythonPath] = useState<string>('');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!clientId) {
      const id = crypto.randomUUID();
      setClientId(id);
    }
  }, [clientId, setClientId]);

  useEffect(() => {
    if (!clientId || esRef.current) return;
    const es = new EventSource(`/sse?clientId=${encodeURIComponent(clientId)}`);
    esRef.current = es;
    es.onopen = () => {
      setConnected(true);
      setLog((l) => [
        ...l,
        `[sse] open for clientId=${clientId}`,
      ]);
    };
    es.onmessage = (ev) => {
      setLog((l) => [...l, `[sse] message: ${ev.data}`]);
    };
    es.onerror = (err) => {
      setConnected(false);
      setLog((l) => [...l, `[sse] error`] );
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [clientId]);

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    if (!clientId) throw new Error('No clientId');
    const r = await fetch(`/session?clientId=${encodeURIComponent(clientId)}`);
    if (!r.ok) throw new Error(`No session for clientId=${clientId}`);
    const j = await r.json();
    setSessionId(j.sessionId);
    return j.sessionId as string;
  }

  async function send() {
    try {
      const sid = await ensureSession();
      let body: unknown = {};
      try {
        body = JSON.parse(payload || '{}');
      } catch (e) {
        alert('Payload is not valid JSON');
        return;
      }
      const enriched = {
        ...body,
        // convenience fields for internal testing
        repoPath: repoPath || undefined,
        pythonPath: pythonPath || undefined,
      };
      const res = await fetch('/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sid,
        },
        body: JSON.stringify(enriched),
      });
      setLog((l) => [...l, `[post] status=${res.status}`]);
    } catch (e: any) {
      setLog((l) => [...l, `[post] error: ${e?.message ?? e}`]);
    }
  }

  return (
    <div>
      <h2>Pyright MCP Test UI</h2>
      <div className="row">
        <span className="badge" style={{ background: connected ? '#16a34a' : '#ef4444' }} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      <div style={{ marginTop: 12 }} className="row">
        <label>clientId</label>
        <input type="text" value={clientId ?? ''} onChange={(e) => setClientId(e.target.value)} />
        <label>sessionId</label>
        <input type="text" value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value)} />
      </div>

      <div style={{ marginTop: 12 }} className="row">
        <label>repoPath</label>
        <input type="text" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <label>pythonPath</label>
        <input type="text" value={pythonPath} onChange={(e) => setPythonPath(e.target.value)} />
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Payload (JSON)</label>
        <textarea value={payload} onChange={(e) => setPayload(e.target.value)} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={send}>Send</button>
        <button onClick={() => setLog([])}>Clear Log</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <div>Event Log</div>
        <div className="log">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById('root')!;
createRoot(container).render(<App />);



