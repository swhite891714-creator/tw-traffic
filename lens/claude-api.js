// ===================================================================
// 鏡頭即時翻譯 — 線上版（GitHub）連接 Claude 的程式（claude-api.js）
//
// 在 claude.ai 裡，頁面是透過 Claude App 呼叫 Claude；
// 放在 GitHub 上時沒有 Claude App，所以改成「用你自己的 Claude API 金鑰」直接連到 Claude。
//   - 金鑰只存在這支手機（瀏覽器）裡，不會傳到其他地方，只會送到 Claude 官方的網址 api.anthropic.com
//   - 第一次按翻譯時會跳出視窗請你貼上金鑰；之後可以按右上角「金鑰」更換或刪除
//
// 這個檔案模擬 claude.ai 提供的兩個功能，主程式不用改：
//   claude.use("sample")    → 把文字和照片送給 Claude，拿回 JSON 結果
//   claude.use("downloads") → 把翻譯好的圖片存到手機
// ===================================================================
(function () {
"use strict";
if (window.claude && window.claude.use) return;   // 在 claude.ai 裡開啟時，用原本的功能

const KEY_NAME = "lens.anthropicKey";
const API = "https://api.anthropic.com/v1/messages";
// 一般辨識、潤飾用 Sonnet；快速的小翻譯用 Haiku
const MODELS = { default: "claude-sonnet-5-5", quick: "claude-haiku-5-5" };

const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch (e) { return ""; } };
const setKey = v => { try { v ? localStorage.setItem(KEY_NAME, v) : localStorage.removeItem(KEY_NAME); } catch (e) {} };

// 畫面樣式（金鑰視窗、金鑰按鈕）只加一次
let cssDone=false;
function ensureCss(){
  if(cssDone)return;cssDone=true;
    const css = document.createElement("style");
  css.textContent = `
    #keyDlg{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
    #keyDlg[hidden]{display:none}
    #keyDlg .kd-box{width:100%;max-width:440px;background:#1b1d22;color:#eee;border:1px solid #333;border-radius:16px;padding:18px;font:15px/1.6 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif}
    #keyDlg h2{margin:0 0 8px;font-size:18px}
    #keyDlg p{margin:0 0 10px}
    #keyDlg .kd-small{font-size:13px;color:#aaa}
    #keyDlg .kd-why{color:#f0c050}
    #keyDlg .kd-why:empty{display:none}
    #keyDlg input{width:100%;box-sizing:border-box;font:16px monospace;padding:10px;border-radius:10px;border:1px solid #444;background:#111;color:#fff;margin:4px 0 12px}
    #keyDlg .kd-row{display:flex;gap:8px;align-items:center}
    #keyDlg button{font:inherit;border-radius:99px;padding:8px 16px;cursor:pointer}
    #keyDlg .kd-ghost{background:transparent;color:#ddd;border:1px solid #444}
    #keyDlg .kd-main{background:#f0c050;color:#111;border:0;font-weight:700}
    #keyDlg .kd-msg{margin:10px 0 0;font-size:13px;color:#f88;min-height:1em}
    .kd-open.kd-inline{position:static;margin-left:8px;flex:0 0 auto}
    .kd-open{position:fixed;top:max(10px,env(safe-area-inset-top));right:12px;z-index:30;font:13px system-ui,sans-serif;background:rgba(30,32,38,.85);color:#ddd;border:1px solid #444;border-radius:99px;padding:6px 12px;cursor:pointer}`;
  document.head.appendChild(css);
}
// ---------- 金鑰設定視窗 ----------
let waiting = null;   // 正在等你輸入金鑰的翻譯工作
function keyDialog(reason) {
  let dlg = document.getElementById("keyDlg");
  if (!dlg) {
    dlg = document.createElement("div");
    dlg.id = "keyDlg";
    dlg.innerHTML = `
      <div class="kd-box" role="dialog" aria-modal="true" aria-labelledby="kdTitle">
        <h2 id="kdTitle">設定 Claude API 金鑰</h2>
        <p class="kd-why" id="kdWhy"></p>
        <p>線上版需要你自己的 Claude API 金鑰才能辨識與翻譯（依使用量向你的帳號計費）。
           金鑰只存在這支手機的瀏覽器裡，只會傳送到 Claude 官方網址。</p>
        <p class="kd-small">取得方式：用電腦開 <b>console.anthropic.com</b> → 登入 → 「API Keys」→「Create Key」，複製 sk-ant- 開頭的整串。</p>
        <input id="kdInput" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-...">
        <div class="kd-row">
          <button type="button" id="kdDel" class="kd-ghost">刪除金鑰</button>
          <span style="flex:1"></span>
          <button type="button" id="kdCancel" class="kd-ghost">取消</button>
          <button type="button" id="kdSave" class="kd-main">儲存</button>
        </div>
        <p class="kd-msg" id="kdMsg"></p>
      </div>`;
    ensureCss();
    document.body.appendChild(dlg);
    const close = ok => { dlg.hidden = true; if (waiting) { const w = waiting; waiting = null; ok ? w.resolve() : w.reject(Object.assign(new Error("需要 Claude API 金鑰才能翻譯"), { code: "no_key" })); } };
    dlg.querySelector("#kdSave").onclick = () => {
      const v = dlg.querySelector("#kdInput").value.trim();
      if (!/^sk-ant-/.test(v)) { dlg.querySelector("#kdMsg").textContent = "金鑰應該是 sk-ant- 開頭，請整串貼上。"; return; }
      setKey(v); dlg.querySelector("#kdInput").value = ""; hideSetupCard(); close(true);
    };
    dlg.querySelector("#kdCancel").onclick = () => close(false);
    dlg.querySelector("#kdDel").onclick = () => { setKey(""); dlg.querySelector("#kdMsg").textContent = "已刪除這支手機上的金鑰。"; };
  }
  dlg.querySelector("#kdWhy").textContent = reason || "";
  dlg.querySelector("#kdMsg").textContent = getKey() ? "目前已有金鑰；貼上新的會取代舊的。" : "";
  dlg.hidden = false;
  setTimeout(() => dlg.querySelector("#kdInput").focus(), 50);
}
// 第一次用、或金鑰錯了：跳出視窗，等你存好金鑰再繼續
function needKey(reason) {
  if (!waiting) { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); waiting = { promise: p, resolve: res, reject: rej }; }
  keyDialog(reason);
  return waiting.promise;
}

// 右上角「金鑰」按鈕：隨時更換或刪除
function addKeyButton() {
  ensureCss();
  const b = document.createElement("button");
  b.type = "button"; b.className = "kd-open"; b.textContent = "金鑰";
  b.setAttribute("aria-label", "設定 Claude API 金鑰");
  b.onclick = () => keyDialog("");
  // 放在標題列裡（版本標示旁邊），沒有標題列才浮在右上角
  const h = document.querySelector(".wrap > header");
  if (h) { b.classList.add("kd-inline"); h.appendChild(b); } else document.body.appendChild(b);
}
// 第一次打開（還沒有金鑰）：在標題下面放一張說明卡，按一下就能設定，不用猜要做什麼
function addSetupCard() {
  if (getKey() || document.getElementById("kdCard")) return;
  const h = document.querySelector(".wrap > header"); if (!h) return;
  const c = document.createElement("section");
  c.id = "kdCard";
  c.innerHTML = `<b>第一次使用：先設定金鑰（約 3 分鐘）</b>
    <ol>
      <li>用電腦或手機打開 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> 並登入</li>
      <li>先在「Billing」儲值（翻譯依用量計費，一張照片約幾美分）</li>
      <li>「API Keys」→「Create Key」→ 複製 sk-ant- 開頭的整串</li>
    </ol>
    <button type="button" class="kd-main" id="kdCardBtn">貼上金鑰</button>
    <span class="kd-note">金鑰只存在這支手機裡。</span>`;
  const css = document.createElement("style");
  css.textContent = `#kdCard{background:#2a2410;border:1px solid #5a4a1a;border-radius:14px;padding:12px 14px;font-size:14px;line-height:1.6;color:#eee}
    #kdCard ol{margin:6px 0 10px;padding-left:20px}#kdCard a{color:#f0c050}
    #kdCard .kd-main{font:inherit;font-weight:700;background:#f0c050;color:#111;border:0;border-radius:99px;padding:8px 18px;cursor:pointer}
    #kdCard .kd-note{font-size:12px;color:#aaa;margin-left:8px}`;
  document.head.appendChild(css);
  h.after(c);
  c.querySelector("#kdCardBtn").onclick = () => keyDialog("");
}
function hideSetupCard() { const c = document.getElementById("kdCard"); if (c && getKey()) c.remove(); }
function boot() { addKeyButton(); addSetupCard(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

// ---------- 圖片轉成 Claude 看得懂的格式 ----------
async function toImageBlock(img) {
  const blob = img instanceof Blob ? img : (img && img.data instanceof Blob ? img.data : null);
  if (!blob) throw new Error("圖片格式不支援");
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const type = /^image\/(jpeg|png|gif|webp)$/.test(blob.type) ? blob.type : "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: type, data: btoa(s) } };
}

// ---------- 從 Claude 的回答裡取出 JSON ----------
function parseJSON(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  throw Object.assign(new Error("Claude 回傳的格式不正確，請再試一次"), { code: "bad_json" });
}

// ---------- 送出一次請求 ----------
async function call(prompt, opts) {
  opts = opts || {};
  let key = getKey();
  if (!key) { await needKey("第一次使用：請先設定金鑰。"); key = getKey(); }
  const imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
  const content = [];
  for (const im of imgs) content.push(await toImageBlock(im));
  content.push({ type: "text", text: prompt + "\n\nReply with the JSON object only, no other text." });
  const body = {
    model: MODELS[opts.modelTier] || MODELS.default,
    max_tokens: opts.effort === "medium" || opts.effort === "high" ? 12000 : 8000,
    messages: [{ role: "user", content }]
  };
  let r;
  try {
    r = await fetch(API, {
      method: "POST", signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"   // 允許從網頁直接連線（金鑰只在你自己的手機上）
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw Object.assign(new Error("已取消"), { code: "cancelled" });
    throw Object.assign(new Error("連不上 Claude，請檢查網路"), { code: "network" });
  }
  if (r.status === 401 || r.status === 403) {
    // 金鑰錯了：請你重新輸入，存好後自動重試一次
    setKey("");
    await needKey("金鑰不正確或已失效，請重新貼上。");
    return call(prompt, opts);
  }
  if (r.status === 429 || r.status === 529) throw Object.assign(new Error("Claude 目前太忙或用量達上限，請稍等一下再試"), { code: "busy" });
  if (r.status === 400) {
    let m = ""; try { m = (await r.json()).error.message || ""; } catch (e) {}
    if (/credit|billing|balance/i.test(m)) throw Object.assign(new Error("Claude 帳號額度不足，請到 console.anthropic.com 儲值"), { code: "billing" });
    throw Object.assign(new Error("請求被拒絕：" + m), { code: "bad_request" });
  }
  if (!r.ok) throw Object.assign(new Error("Claude 發生錯誤（" + r.status + "），請再試一次"), { code: "server" });
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return text;
}

const sample = {
  limits: async () => ({ images: { maxCount: 2 } }),          // 一次最多送兩張圖（照片＋格線版）
  json: async (prompt, opts) => parseJSON(await call(prompt, opts)),
  text: async (prompt, opts) => call(prompt, opts)
};

// 存圖片：手機會跳出「下載／分享」
const downloads = {
  save: async ({ filename, data }) => {
    const url = URL.createObjectURL(data);
    const a = document.createElement("a"); a.href = url; a.download = filename || "翻譯.jpg";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { ok: true };
  }
};

window.claude = { use: async name => name === "sample" ? sample : name === "downloads" ? downloads : null };
})();
