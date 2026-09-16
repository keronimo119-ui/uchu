// 実機のChromeで __U.* を叩く道具（Chrome DevTools Protocol）。2026-09-16 作成。
// 準備: adb -s <端末> forward tcp:9222 localabstract:chrome_devtools_remote
//       curl -s http://127.0.0.1:9222/json で対象ページの webSocketDebuggerUrl を取る
// 使い方: node tools/cdp.mjs <wsUrl> "<JS式>" [スクショ保存先.jpg]
// 注意: Git Bash で MSYS_NO_PATHCONV=1 を付けているときは、このファイルのパスを C:/... 形式で書く
import fs from 'fs';
const [,, ws, expr, shot] = process.argv;
const s = new WebSocket(ws); let id = 0; const pend = new Map();
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); s.send(JSON.stringify({ id: i, method, params })); });
s.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); } };
s.onopen = async () => {
  try {
    if (expr) { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value ?? r)); }
    if (shot) { const r = await call('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.writeFileSync(shot, Buffer.from(r.data, 'base64')); console.log('shot saved'); }
  } catch (e) { console.error('ERR', JSON.stringify(e)); }
  s.close(); process.exit(0);
};
s.onerror = e => { console.error('ws error', e.message, e.error && e.error.message); process.exit(1); };
setTimeout(() => { console.error('timeout'); process.exit(2); }, 40000);
