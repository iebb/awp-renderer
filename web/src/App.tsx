import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { PassRenderer, type PassRenderState, type NativeRenderFace } from '../../src/react/index';
import { isPassAssetName, passRenderInputFromArchive, type PassAssets } from '../../src/core/input';
import membership from '../../examples/membership.json';
import boarding from '../../examples/boarding.json';
import event from '../../examples/event.json';
import coupon from '../../examples/coupon.json';
import store from '../../examples/store-card.json';
import poster from '../../examples/poster.json';

const samples = {
  Membership: membership,
  Boarding: boarding,
  Event: event,
  Coupon: coupon,
  Rewards: store,
  Poster: poster,
};
const initialState: PassRenderState = { status: 'loading', result: null, error: '' };
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
function download(name: string, data: Blob | string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function App() {
  const [json, setJson] = useState(pretty(membership));
  const [selected, setSelected] = useState('Membership');
  const [assets, setAssets] = useState<PassAssets>({});
  const [face, setFace] = useState<NativeRenderFace>('front');
  const [width, setWidth] = useState(343);
  const [rendered, setRendered] = useState(initialState);
  const [endpoint, setEndpoint] = useState('/render');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const assetsRef = useRef<HTMLInputElement>(null);
  const headers = useMemo(
    () => (token ? { Authorization: `Bearer ${token}` } : undefined),
    [token],
  );
  const onRender = useCallback((next: PassRenderState) => setRendered(next), []);
  const result = rendered.result;
  const ready = rendered.status === 'ready' && !!result;
  function choose(name: keyof typeof samples) {
    setSelected(name);
    setJson(pretty(samples[name]));
    setAssets({});
    setNotice('');
  }
  async function importPass(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('The file exceeds the 16 MiB limit.');
      if (/\.json$/i.test(file.name)) {
        if (file.size > 256 * 1024) throw new Error('Pass JSON exceeds the 256 KiB limit.');
        const text = await file.text();
        JSON.parse(text);
        setJson(text);
        setAssets({});
      } else {
        const input = await passRenderInputFromArchive(file);
        setJson(typeof input.pass === 'string' ? input.pass : pretty(input.pass));
        setAssets(input.assets || {});
      }
      setSelected('Custom');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import this file.');
    }
  }
  async function addAssets(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    try {
      const additions: Record<string, File> = {};
      for (const file of files) {
        if (!isPassAssetName(file.name))
          throw new Error(`Use a pass resource name such as logo@2x.png: ${file.name}`);
        additions[file.name] = file;
      }
      setAssets((previous) => ({ ...previous, ...additions }));
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add artwork.');
    }
  }
  function stress(value: string) {
    try {
      const pass = JSON.parse(json);
      const style = [
        'generic',
        'posterGeneric',
        'boardingPass',
        'eventTicket',
        'coupon',
        'storeCard',
      ].find((key) => pass[key]);
      if (!style) throw new Error('Choose a pass with fields first.');
      const field = ['primaryFields', 'secondaryFields', 'headerFields'].flatMap(
        (group) => pass[style][group] || [],
      )[0];
      if (!field) throw new Error('This pass has no front fields.');
      field.value = value;
      delete field.numberStyle;
      delete field.dateStyle;
      delete field.timeStyle;
      delete field.currencyCode;
      setJson(pretty(pass));
      setSelected('Custom');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Fix the JSON first.');
    }
  }
  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="#">
          <span className="mark" aria-hidden="true">
            a<span>↗</span>
          </span>{' '}
          awp<span className="wordmark-light">renderer</span>
        </a>
        <nav aria-label="Project">
          <span className="local-tag">
            <i /> LOCAL WORKSPACE
          </span>
          <a href="https://github.com/iebb/awp-renderer" target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </nav>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">APPLE WALLET · NATIVE RENDERING</p>
            <h1>
              Your JSON.
              <br />
              <em>Wallet’s pixels.</em>
            </h1>
            <p className="intro-copy">
              Build pass previews with Apple’s own renderer.
              <br />
              One component, a simple API, and this little workspace.
            </p>
          </div>
          <div className="intro-note">
            <span className="note-number">01 — 03</span>
            <p>
              Edit the JSON.
              <br />
              See the native result.
              <br />
              Ship with confidence.
            </p>
            <code>&lt;PassRenderer pass={'{json}'} /&gt;</code>
          </div>
        </section>
        <section className="workbench" aria-label="Pass rendering workspace">
          <div className="workspace-toolbar">
            <div className="sample-tabs" aria-label="Example passes">
              {Object.keys(samples).map((name) => (
                <button
                  key={name}
                  className={selected === name ? 'active' : ''}
                  onClick={() => choose(name as keyof typeof samples)}
                >
                  {name}
                </button>
              ))}
            </div>
            <button className="import-button" onClick={() => fileRef.current?.click()}>
              ↥ Import pass
            </button>
            <input
              hidden
              ref={fileRef}
              type="file"
              accept=".json,.pkpass,.pkpasstemplate,.zip"
              onChange={importPass}
            />
          </div>
          <div className="workspace-grid">
            <section className="editor-pane">
              <div className="pane-heading">
                <span>
                  <i className="file-dot" /> pass.json
                </span>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(json);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      setNotice('Clipboard is unavailable in this browser.');
                    }
                  }}
                >
                  {copied ? 'Copied ✓' : 'Copy JSON'}
                </button>
              </div>
              <label className="sr-only" htmlFor="pass-json">
                Pass JSON
              </label>
              <textarea
                id="pass-json"
                value={json}
                onChange={(event) => {
                  setJson(event.target.value);
                  setSelected('Custom');
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <div className="editor-footer">
                <span>UTF-8 · {new TextEncoder().encode(json).length.toLocaleString()} bytes</span>
                <button
                  onClick={() => {
                    try {
                      setJson(pretty(JSON.parse(json)));
                      setNotice('');
                    } catch {
                      setNotice('Fix the JSON syntax before formatting.');
                    }
                  }}
                >
                  Format JSON
                </button>
              </div>
            </section>
            <section className="preview-pane" aria-label="Native preview">
              <div className="preview-toolbar">
                <div className="face-tabs" aria-label="Preview face">
                  {(['front', 'semantic', 'watch'] as const).map((value) => (
                    <button
                      key={value}
                      onClick={() => setFace(value)}
                      className={face === value ? 'active' : ''}
                    >
                      {value === 'front' ? 'iPhone' : value === 'watch' ? 'Watch' : 'Semantic'}
                    </button>
                  ))}
                </div>
                <span className={`status ${ready ? 'ready' : ''}`}>
                  <i />
                  {ready
                    ? 'Native pixels'
                    : rendered.status === 'loading'
                      ? 'Rendering…'
                      : 'Needs attention'}
                </span>
              </div>
              <div className="preview-stage">
                <PassRenderer
                  pass={json}
                  assets={assets}
                  face={face}
                  width={width}
                  endpoint={endpoint}
                  headers={headers}
                  onRender={onRender}
                  loading={
                    <div className="preview-message">
                      <span className="spinner" />
                      <strong>Asking Apple’s renderer…</strong>
                      <p>The first render may compile the local bridge.</p>
                    </div>
                  }
                  renderError={(message) => (
                    <div className="preview-message error">
                      <strong>Let’s get this rendering.</strong>
                      <p>{message}</p>
                      <code>awp-renderer doctor</code>
                    </div>
                  )}
                />
              </div>
              <div className="preview-footer">
                <label>
                  Display width{' '}
                  <input
                    aria-label="Display width"
                    type="range"
                    min="200"
                    max="440"
                    value={width}
                    onChange={(event) => setWidth(Number(event.target.value))}
                  />
                  <span>{width}px</span>
                </label>
                <span>
                  {ready
                    ? `${Math.round(result.width * result.scale)} × ${Math.round(result.height * result.scale)} PNG`
                    : '4× · System language'}
                </span>
              </div>
            </section>
          </div>
          <div className="workspace-bottom">
            <span>Pixels and text fitting are handled by the installed Apple renderer.</span>
            <div>
              <button
                disabled={!ready}
                onClick={() =>
                  result &&
                  download(
                    'pass-layout.json',
                    new Blob([pretty({ ...result, png: undefined })], { type: 'application/json' }),
                  )
                }
              >
                Layout JSON ↧
              </button>
              <button
                className="primary-button"
                disabled={!ready}
                onClick={() =>
                  result && download(`pass-${face}.png`, `data:image/png;base64,${result.png}`)
                }
              >
                Download PNG ↧
              </button>
            </div>
          </div>
        </section>
        {notice && (
          <p className="notice" role="alert">
            {notice}
            <button onClick={() => setNotice('')} aria-label="Dismiss message">
              ×
            </button>
          </p>
        )}
        <section className="utilities" aria-label="Pass resources and rendering settings">
          <div>
            <p className="eyebrow">ARTWORK</p>
            <h2>Bring your own assets.</h2>
            <p>PNG resources keep their original bytes and resolution.</p>
            <button className="outline-button" onClick={() => assetsRef.current?.click()}>
              ＋ Add PNG files
            </button>
            <input
              hidden
              type="file"
              ref={assetsRef}
              multiple
              accept="image/png"
              onChange={addAssets}
            />
            <ul className="asset-list">
              {Object.keys(assets).map((name) => (
                <li key={name}>
                  <code>{name}</code>
                  <button
                    aria-label={`Remove ${name}`}
                    onClick={() =>
                      setAssets((previous) =>
                        Object.fromEntries(
                          Object.entries(previous).filter(([key]) => key !== name),
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow">TEXT FITTING</p>
            <h2>Give the layout a workout.</h2>
            <p>Try a long value and inspect Apple’s own fitting decisions.</p>
            <div className="stress-buttons">
              <button
                onClick={() =>
                  stress('Alexandria Montgomery-Wellington von Hohenlohe-Schillingsfürst')
                }
              >
                Long name ↗
              </button>
              <button onClick={() => stress('天地玄黃 宇宙洪荒 — مرحباً بالعالم — Sofia 👩🏽‍🚀')}>
                CJK · RTL · Emoji ↗
              </button>
              <button onClick={() => stress('W'.repeat(200000))}>200,000 characters ↗</button>
            </div>
          </div>
          <div>
            <p className="eyebrow">CONNECTION</p>
            <h2>A Mac behind the pixels.</h2>
            <p>Use this local service or an authenticated endpoint.</p>
            <details>
              <summary>Connection settings</summary>
              <label>
                API endpoint
                <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
              </label>
              <label>
                Bearer token
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Only if required"
                />
              </label>
            </details>
          </div>
        </section>
        <section className="integration">
          <div>
            <p className="eyebrow">BUILT TO FIT YOUR STACK</p>
            <h2>
              From this workspace
              <br />
              to your product.
            </h2>
            <p>
              React component. Typed JavaScript API. A CLI for exports.
              <br />
              No editor store or stylesheet required.
            </p>
          </div>
          <pre>
            <span>import</span> {'{ PassRenderer }'} <span>from</span> <em>"awp-renderer/react"</em>
            ;{'\n\n'}
            <span>export function</span> Preview(){' '}
            {
              '{\n  return <PassRenderer\n    pass={json}\n    assets={assets}\n    endpoint="/render"\n  />;\n}'
            }
          </pre>
        </section>
      </main>
      <footer>
        <span>AWP Renderer · MIT · Independent open source</span>
        <a
          href="https://github.com/iebb/awp-renderer#native-requirements"
          target="_blank"
          rel="noreferrer"
        >
          Native setup & parity limits ↗
        </a>
      </footer>
    </div>
  );
}
