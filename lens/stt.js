// ===================================================================
// 鏡頭即時翻譯 — 語音轉文字（stt.js）
//
// Claude 的線上頁面不能直接用麥克風，所以改用這個方法：
//   1. 用手機「錄影」或選一段錄音檔（錄影會同時錄到聲音）
//   2. 在手機上把影片裡的聲音取出來，轉成 16kHz 單聲道
//   3. 用語音辨識模型 Whisper（base 版）在手機上把聲音轉成文字
//      ─ 模型檔案放在這個頁面一起，第一次會下載約 100MB，之後存在手機裡不再下載
//   4. 文字交給 Claude 翻譯、整理對方的意思（在主程式裡）
//
// 用法：await LensSTT.transcribe(檔案, { language: "ja", onProgress })
//   → { text: "辨識出的文字", language: "ja", seconds: 錄音長度 }
// ===================================================================
(function () {
"use strict";
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js";
const BASE = new URL("w/", location.href).href;     // 模型檔案的位置（和這個頁面放在一起）
const CACHE = "lens-stt-v1";                         // 存在手機裡的名稱，之後不用重新下載

let pipePromise = null;
const joined = {};   // 同一個檔案只接一次

// ---------- 下載一個被切成好幾段的大檔案，接回成一個檔案（下載過就從手機裡拿） ----------
function getJoined(key, parts, size, onProgress, label) {
  if (!joined[key]) { joined[key] = getJoined0(key, parts, size, onProgress, label); joined[key].catch(() => { delete joined[key]; }); }
  return joined[key];
}
async function getJoined0(key, parts, size, onProgress, label) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(BASE + key); if (hit) { onProgress && onProgress(label, 1); return await hit.arrayBuffer(); } } catch (e) { cache = null; }
  const out = new Uint8Array(size); let pos = 0;
  for (const p of parts) {
    const r = await fetch(BASE + p);
    if (!r.ok) throw new Error("模型檔案下載失敗（" + p + "）");
    // 一邊下載一邊回報進度
    const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.set(value, pos); pos += value.length; onProgress && onProgress(label, pos / size); }
  }
  try { if (cache) await cache.put(BASE + key, new Response(out)); } catch (e) {}
  return out.buffer;
}

// ---------- 準備好語音辨識模型（只做一次） ----------
async function load(onProgress) {
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    const man = await (await fetch(BASE + "manifest.json")).json();
    const T = await import(TF_URL);
    const env = T.env;
    // 執行引擎（wasm）：用這個頁面自己帶的檔案，不從其他網站下載
    const wasm = await getJoined("ort.wasm", man.ort.parts, man.ort.size, onProgress, "語音引擎");
    env.backends.onnx.wasm.wasmBinary = wasm;
    env.backends.onnx.wasm.numThreads = 1;
    // 模型檔案：全部從這個頁面拿（大檔案自動接回）
    const big = { "onnx/encoder_model_quantized.onnx": "enc", "onnx/decoder_model_merged_quantized.onnx": "dec" };
    env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = BASE;
    env.useBrowserCache = false; env.useCustomCache = true;
    env.customCache = {
      async match(req) {
        const u = typeof req === "string" ? req : req.url;
        const m = /whisper-base\/(.+)$/.exec(u); if (!m) return undefined;
        const f = m[1];
        if (big[f]) { const k = big[f], buf = await getJoined(k + ".onnx", man[k].parts, man[k].size, onProgress, k === "enc" ? "辨識模型（1/2）" : "辨識模型（2/2）"); return new Response(buf); }
        const r = await fetch(BASE + f.replace(/^.*\//, "")); return r.ok ? r : undefined;
      },
      async put() {}
    };
    return await T.pipeline("automatic-speech-recognition", "Xenova/whisper-base", { dtype: "q8", device: "wasm" });
  })();
  pipePromise.catch(() => { pipePromise = null; });
  return pipePromise;
}

const AC = window.AudioContext || window.webkitAudioContext;
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
function ext(file) { const m = /\.([a-z0-9]+)$/i.exec(file.name || ""); return m ? "." + m[1].toLowerCase() : (file.type || "未知格式"); }

// ---------- 方法一：直接解開檔案（快，但 iPhone 錄影檔 .mov、部分 Android 錄音格式會失敗） ----------
async function decodeFast(file) {
  const ac = new AC();
  try {
    const data = await file.arrayBuffer();
    // 舊版 iPhone 只支援「回呼」寫法，兩種都試
    return await new Promise((ok, bad) => { const p = ac.decodeAudioData(data, ok, bad); if (p && p.then) p.then(ok, bad); });
  } finally { try { ac.close(); } catch (e) {} }
}

// ---------- 方法二：用手機內建播放器把檔案「播一遍」，邊播邊收聲音 ----------
// 只要手機能播放的影片／錄音都能用；需要的時間等於錄音長度（播放時不會發出聲音）。
// iPhone 有時規定一定要你按一下才能播放，這時會丟出 code = "needTap"，畫面會請你點一下再繼續。
function decodeByPlaying(file, onProgress) {
  // 這裡的設定都要「立刻」做完（不能先等待），手機才會認定是你按下按鈕觸發的
  const url = URL.createObjectURL(file);
  const el = document.createElement((file.type || "").startsWith("audio") ? "audio" : "video");
  el.playsInline = true; el.setAttribute("playsinline", ""); el.preload = "auto"; el.src = url;
  const ac = new AC();
  try { ac.resume(); } catch (e) {}
  const src = ac.createMediaElementSource(el);
  const sp = ac.createScriptProcessor(4096, 2, 1);
  const mute = ac.createGain(); mute.gain.value = 0;        // 收聲音，但喇叭不出聲
  src.connect(sp); sp.connect(mute); mute.connect(ac.destination);
  const chunks = []; let total = 0;
  sp.onaudioprocess = e => {
    if (el.paused || el.ended) return;
    const ib = e.inputBuffer, n = ib.length, out = new Float32Array(n), ch = ib.numberOfChannels;
    for (let c = 0; c < ch; c++) { const d = ib.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
    chunks.push(out); total += n;
  };
  let closed = false;   // 只收尾一次
  const cleanup = () => { if (closed) return; closed = true; try { el.pause(); } catch (e) {} try { sp.disconnect(); src.disconnect(); } catch (e) {} try { Promise.resolve(ac.close()).catch(() => {}); } catch (e) {} URL.revokeObjectURL(url); };
  const playing = el.play();
  return new Promise((ok, bad) => {
    const fail = err => { cleanup(); bad(err); };
    el.addEventListener("error", () => fail(new Error(`手機無法讀取這個檔案（${ext(file)}）。請改按「錄下對方說話」直接錄影，或用手機內建錄音 App 的 .m4a 檔`)));
    el.addEventListener("loadedmetadata", () => { if (isFinite(el.duration) && el.duration > 125) fail(new Error("錄音太長了，請控制在 2 分鐘以內")); });
    el.addEventListener("timeupdate", () => { if (isFinite(el.duration) && el.duration > 0) onProgress && onProgress("讀取聲音", Math.min(1, el.currentTime / el.duration)); });
    el.addEventListener("ended", () => {
      // 等最後一小段聲音收完
      setTimeout(() => {
        const rate = ac.sampleRate, pcm = new Float32Array(total); let p = 0;
        for (const c of chunks) { pcm.set(c, p); p += c.length; }
        cleanup();
        if (!total) { bad(new Error("播放了但沒收到聲音，請再試一次")); return; }
        ok({ pcm, rate });
      }, 300);
    });
    Promise.resolve(playing).catch(e => {
      if (e && e.name === "NotAllowedError") { const x = new Error("請點一下「開始讀取聲音」"); x.code = "needTap"; fail(x); }
      else fail(new Error(`手機無法播放這個檔案（${ext(file)}）。請改按「錄下對方說話」直接錄影`));
    });
  });
}

// ---------- 把聲音轉成 16kHz 單聲道（辨識模型需要的格式） ----------
async function to16k(buf) {
  const len = Math.ceil(buf.duration * 16000);
  const off = new OAC(1, Math.max(1, len), 16000);
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  return await off.startRendering();
}

// ---------- 把影片／錄音檔裡的聲音取出來：先用方法一，不行就自動改用方法二 ----------
// direct = true：跳過方法一（你剛按了「開始讀取聲音」，要馬上播放）
async function decode(file, onProgress, direct) {
  let buf = null;
  // 錄影檔很大時（超過 60MB）直接用方法二，避免手機記憶體不夠
  if (!direct && file.size < 60e6) { try { buf = await decodeFast(file); } catch (e) { buf = null; } }
  if (!buf) {
    const { pcm, rate } = await decodeByPlaying(file, onProgress);
    const tmp = new OAC(1, pcm.length, rate);
    buf = tmp.createBuffer(1, pcm.length, rate);
    buf.getChannelData(0).set(pcm);
  }
  const r = await to16k(buf);
  // 前後各補 0.6 秒安靜，避免最後一個字被切掉
  const raw = r.getChannelData(0), padN = 9600, pcm = new Float32Array(raw.length + padN * 2); pcm.set(raw, padN);
  // 聲音太小時自動放大，讓辨識更準
  let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  if (peak > 0 && peak < .5) { const g = .9 / peak; for (let i = 0; i < pcm.length; i++) pcm[i] *= g; }
  return { pcm, seconds: buf.duration };
}

// ---------- 主要功能：檔案 → 文字 ----------
// language：對方的語言代碼（ja、ko、en、zh…），傳空字串讓模型自己判斷
// direct：剛按了「開始讀取聲音」時傳 true
async function transcribe(file, { language = "", onProgress, direct = false } = {}) {
  const [{ pcm, seconds }, asr] = await Promise.all([decode(file, onProgress, direct), load(onProgress)]);
  if (seconds > 120) throw new Error("錄音太長了，請控制在 2 分鐘以內");
  onProgress && onProgress("辨識中", 0);
  const opts = { task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
  if (language) opts.language = language;
  const out = await asr(pcm, opts);
  const text = (Array.isArray(out) ? out.map(o => o.text).join(" ") : out.text || "").trim();
  return { text, language, seconds };
}

window.LensSTT = { transcribe, load };
})();
