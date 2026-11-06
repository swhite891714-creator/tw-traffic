// ===================================================================
// 鏡頭即時翻譯 — 語音翻譯對話（talk.js）
//
// 流程：
//   對方說話 → 按「錄下對方說話」用手機錄影（會同時錄到聲音）→ 手機上轉成文字（stt.js）
//   → Claude 翻成中文，並整理「對方的意思」和「可以怎麼回」
//   你要回話 → 打字或錄下你說的中文 → Claude 翻成對方的語言 → 大字顯示、可以唸出來給對方聽
// ===================================================================
(function () {
"use strict";
const $ = id => document.getElementById(id);
const store = { get(k, d) { try { const v = localStorage.getItem("lens." + k); return v === null ? d : v; } catch (e) { return d; } },
                set(k, v) { try { localStorage.setItem("lens." + k, v); } catch (e) {} } };

// 對方可能說的語言：辨識代碼、Claude 用的名稱、唸出來用的代碼、顯示名稱
const LANGS = [
  ["ja", "Japanese", "ja-JP", "日文"], ["ko", "Korean", "ko-KR", "韓文"], ["en", "English", "en-US", "英文"],
  ["th", "Thai", "th-TH", "泰文"], ["vi", "Vietnamese", "vi-VN", "越南文"], ["id", "Indonesian", "id-ID", "印尼文"],
  ["ms", "Malay", "ms-MY", "馬來文"], ["zh", "Mandarin Chinese (Simplified)", "zh-CN", "普通話"], ["fr", "French", "fr-FR", "法文"],
  ["de", "German", "de-DE", "德文"], ["es", "Spanish", "es-ES", "西班牙文"], ["it", "Italian", "it-IT", "義大利文"], ["", "", "", "自動判斷"]
];
const sel = $("tLang");
LANGS.forEach(l => sel.add(new Option(l[3], l[0])));
sel.value = store.get("tlang", "ja");
const them = () => LANGS.find(l => l[0] === sel.value) || LANGS[0];
function labels() { const n = them()[3]; $("tThemBtn").textContent = "● 錄下對方說話" + (sel.value ? `（${n}）` : ""); $("tReplyTitle").textContent = sel.value ? `我要回話（翻成${n}）` : "我要回話"; }
sel.addEventListener("change", () => { store.set("tlang", sel.value); labels(); });
labels();

let sample = null;
if (window.claude && claude.use) claude.use("sample").then(s => { sample = s; }).catch(() => {});

// 打開語音翻譯：先把拍照畫面藏起來，語音畫面放在同一頁（不蓋在最上層，手機上才不會跑版）
const mainWrap = document.querySelector(".wrap");
$("talkBtn").addEventListener("click", () => { mainWrap.hidden = true; $("talk").hidden = false; window.scrollTo(0, 0); });
$("tClose").addEventListener("click", () => { $("talk").hidden = true; $("tBig").hidden = true; mainWrap.hidden = false; window.scrollTo(0, 0); });
$("tClear").addEventListener("click", () => { $("tLog").innerHTML = ""; history = []; });

function status(t, err) { const s = $("tStatus"); s.textContent = t || ""; s.className = "tstatus" + (err ? " err" : ""); }
function bar(p) { const b = $("tBar"); b.hidden = p == null; if (p != null) b.firstElementChild.style.width = Math.round(p * 100) + "%"; }

// ---------- 對話紀錄 ----------
let history = [];   // 最近幾句，讓 Claude 了解上下文
// 新的一句放在最上面（緊接在操作區下方），不用往下捲就看得到
function bubble(cls) { const b = document.createElement("div"); b.className = "tb " + cls; $("tLog").prepend(b); return b; }
function el(tag, cls, text) { const e = document.createElement(tag); e.className = cls; e.textContent = text || ""; return e; }

// ---------- 唸出來（要由你按按鈕觸發，手機才允許發出聲音） ----------
function speak(text, lang) {
  if (!window.speechSynthesis) { status("這支手機不支援朗讀，請用「放大」給對方看。", true); return; }
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = .95; speechSynthesis.speak(u); } catch (e) {}
}
// 放大給對方看：在語音畫面最上方顯示白色大字卡，點一下收起
function showBig(t) { $("tBigText").textContent = t; $("tBig").hidden = false; $("tBig").scrollIntoView({ behavior: "smooth", block: "start" }); }
$("tBig").addEventListener("click", () => { $("tBig").hidden = true; });

// ---------- 錄音 → 文字 ----------
async function toText(file, lang, direct) {
  bar(0); status("準備語音辨識…");
  const r = await LensSTT.transcribe(file, {
    language: lang, direct,
    onProgress: (label, p) => {
      if (label === "辨識中") { bar(null); status("把聲音轉成文字中…（約需錄音長度的 1～2 倍時間）"); }
      else if (label === "讀取聲音") { bar(p); status(`讀取錄音中 ${Math.round(p * 100)}%（需要和錄音一樣長的時間）`); }
      else { bar(p); status(`第一次使用：下載${label} ${Math.round(p * 100)}%（約 100MB，之後不用再下載）`); }
    }
  });
  bar(null);
  return r;
}

// ---------- 對方說話：錄影 / 錄音檔 ----------
// iPhone 規定要你按一下才能讀取影片聲音：顯示按鈕，按了再繼續
function askTap(b, run) {
  status("請點一下下方按鈕，開始讀取錄音", true); bar(null);
  const t = el("button", "tchip", "▶ 開始讀取聲音"); t.type = "button";
  t.onclick = () => { t.remove(); run(); };
  b.append(t);
}
function onThemFile(e) {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  const b = bubble("them");
  b.append(el("div", "to", "辨識中…"));
  handleThem(f, b, false);
}
async function handleThem(f, b, direct) {
  const L = them();
  b.firstChild.textContent = "辨識中…";
  try {
    const { text, seconds } = await toText(f, L[0], direct);
    if (!text) { b.firstChild.textContent = "沒有聽到說話聲，請靠近一點再錄一次。"; status(""); return; }
    b.firstChild.textContent = text;
    status("Claude 翻譯中…");
    if (!sample) throw new Error("翻譯需要在 claude.ai 開啟這個頁面");
    const ctx = history.slice(-6).map(h => `${h.who}: ${h.text}`).join("\n");
    const res = await sample.json(
`You are an interpreter helping a traveler from Taiwan. Someone just spoke to them${L[1] ? " in " + L[1] : ""}. Below is a speech-recognition transcript, which may contain recognition mistakes; use context to infer what was most likely said.
Recent conversation (may be empty):
${ctx || "(none)"}

Transcript: """${text}"""

Reply with ONLY a JSON object:
{"lang":"<language they spoke, in Traditional Chinese, e.g. 日文>",
 "fixed":"<the transcript with obvious recognition errors corrected, in the original language>",
 "translation":"<natural Traditional Chinese (Taiwan) translation of everything they said>",
 "gist":"<one short Traditional Chinese sentence: what they want or are telling you, and anything you need to do>",
 "replies":[{"zh":"<a short natural reply the traveler might give, in Traditional Chinese>","say":"<that reply in the speaker's language>","read":"<how to pronounce it, in simple Chinese-friendly romanization or zhuyin-style hints>"}]}
Give 2 or 3 replies that fit the situation.`, { modelTier: "default", effort: "low", cache: false });
    b.innerHTML = "";
    b.append(el("div", "to", res.fixed || text), el("div", "tt", res.translation || ""));
    if (res.gist) b.append(el("div", "tg", "重點：" + res.gist));
    const acts = el("div", "ta"); const big = el("button", "tbtn", "放大"); big.type = "button"; big.onclick = () => showBig(res.translation || ""); acts.append(big); b.append(acts);
    history.push({ who: "對方", text: res.fixed || text });
    // 建議回覆：點一下直接當作你的回答（翻好了、可以唸給對方聽）
    if (Array.isArray(res.replies) && res.replies.length) {
      const box = el("div", "tsug"); box.append(el("div", "tsl", "可以這樣回："));
      res.replies.slice(0, 3).forEach(r => { const c = el("button", "tchip", r.zh); c.type = "button"; c.onclick = () => showMine(r.zh, r.say, r.read); box.append(c); });
      b.append(box);
    }
    status(`完成（錄音 ${seconds.toFixed(0)} 秒）`);
  } catch (err) {
    if (err.code === "needTap") { b.firstChild.textContent = "錄音已收到"; askTap(b, () => handleThem(f, b, true)); return; }
    b.firstChild ? (b.firstChild.textContent = "失敗：" + (err.message || err.code || err)) : 0;
    status(err.code === "not_granted" ? "需要允許這個頁面使用 Claude 才能翻譯。" : (err.message || "翻譯失敗"), true); bar(null);
  }
}
$("tThem").addEventListener("change", onThemFile);
$("tThemFile").addEventListener("change", onThemFile);

// ---------- 你要回話：打字或錄音 → 翻成對方的語言 ----------
function showMine(zh, say, read) {
  const L = them(), b = bubble("me");
  b.append(el("div", "to", zh), el("div", "tt", say || ""));
  if (read) b.append(el("div", "tg", "讀音：" + read));
  const acts = el("div", "ta");
  const sp = el("button", "tbtn", "🔊 唸給對方聽"); sp.type = "button"; sp.onclick = () => speak(say, L[2] || "ja-JP");
  const big = el("button", "tbtn", "放大給對方看"); big.type = "button"; big.onclick = () => showBig(say);
  acts.append(sp, big); b.append(acts);
  history.push({ who: "我", text: zh });
}
async function reply(zh) {
  zh = (zh || "").trim(); if (!zh) return;
  const L = them();
  if (!L[0]) { status("回話前請先選「對方說的語言」。", true); return; }
  if (!sample) { status("翻譯需要在 claude.ai 開啟這個頁面", true); return; }
  status("Claude 翻譯中…");
  try {
    const ctx = history.slice(-6).map(h => `${h.who}: ${h.text}`).join("\n");
    const r = await sample.json(
`Translate what a traveler from Taiwan wants to say into natural, polite spoken ${L[1]} suitable for talking to a local (shop staff, station staff, restaurant). Fix any speech-recognition mistakes in the Chinese first.
Recent conversation: ${ctx || "(none)"}
Traveler says (Traditional Chinese): """${zh}"""
Reply with ONLY: {"zh":"<the Chinese, corrected>","say":"<in ${L[1]}>","read":"<simple pronunciation hints for a Chinese speaker>"}`, { modelTier: "quick", cache: false });
    showMine(r.zh || zh, r.say || "", r.read || "");
    status("");
  } catch (e) { status(e.code === "not_granted" ? "需要允許這個頁面使用 Claude 才能翻譯。" : "翻譯失敗，請再試一次", true); }
}
// ---------- 打字輸入框：自動長高、好收起鍵盤 ----------
const inp = $("tInput");
function grow() { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight + 2, window.innerHeight * .4) + "px"; }
function hideKbd() { inp.blur(); }
inp.addEventListener("input", grow);
// 打字時才顯示「收起鍵盤」按鈕
inp.addEventListener("focus", () => { $("tKbd").hidden = false; });
inp.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== inp) $("tKbd").hidden = true; }, 150); });
// 按「收起鍵盤」：pointerdown 時就處理，避免按鈕被鍵盤擋住點不到
$("tKbd").addEventListener("pointerdown", e => { e.preventDefault(); hideKbd(); });
$("tKbd").addEventListener("click", hideKbd);
// 點一下或滑動上面的對話區，也會收起鍵盤
$("tLog").addEventListener("touchstart", hideKbd, { passive: true });
$("tLog").addEventListener("mousedown", hideKbd);
// 按「翻譯給對方」：送出後自動收起鍵盤，譯文才看得到
$("tSend").addEventListener("click", () => { const v = inp.value; inp.value = ""; grow(); hideKbd(); reply(v); });
// 鍵盤上的「傳送」鍵直接送出；要換行請用 Shift+Enter（實體鍵盤）
inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("tSend").click(); } });
async function handleMe(f, direct) {
  try { const { text } = await toText(f, "zh", direct); if (!text) { status("沒有聽到說話聲，請再錄一次。", true); return; } await reply(text); }
  catch (err) {
    if (err.code === "needTap") { const b = bubble("me"); b.append(el("div", "to", "你的錄音已收到")); askTap(b, () => { b.remove(); handleMe(f, true); }); return; }
    status(err.message || "辨識失敗", true); bar(null);
  }
}
$("tMe").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
  handleMe(f, false);
});

// 按鍵盤 Enter / 空白鍵也能打開選檔
document.querySelectorAll('#talk label[role="button"]').forEach(l => l.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $(l.htmlFor).click(); } }));
})();
