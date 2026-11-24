/*
 * マナーカメラ
 *
 * ・シャッター音なし
 *   撮影APIは使わず、カメラ映像の「今の1コマ」を canvas に描いて JPEG にするだけ。
 *   OS のシャッター処理を通らないので、撮影音は鳴らない。
 *
 * ・YouTube や音楽を止めない
 *   1) getUserMedia は { audio: false } … マイクを使わない（使うと他アプリの再生が止まる）
 *   2) このページは音を一切再生しない（<audio> も AudioContext も使わない）
 *   3) プレビューの <video> は muted … 音声フォーカスを奪わない
 *   4) Safari では Audio Session を "ambient"（他の音と混ぜる）に設定
 */

// ── 音まわり：最初に「他のアプリの音を止めない」設定にしておく ──
try {
  if (navigator.audioSession) navigator.audioSession.type = 'ambient';
} catch (_) { /* 非対応ブラウザでは何もしない */ }

const $ = (id) => document.getElementById(id);

const ua = navigator.userAgent;
const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isMobile = isIOS || isAndroid;
const isInAppBrowser = /\bLine\/|Instagram|FBAN|FBAV|MicroMessenger|TikTok/i.test(ua);
const canVibrate = typeof navigator.vibrate === 'function';
const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

const ASPECT = { '4:3': 4 / 3, '16:9': 16 / 9, '1:1': 1 };
// カメラに要求する解像度（できるだけ高画質で。対応していなければブラウザが近いものを選ぶ）
const REQUEST = { '4:3': [4032, 3024], '16:9': [3840, 2160], '1:1': [4032, 3024] };
const TIMERS = [0, 3, 10];
const JPEG_QUALITY = 0.92;
const MAX_CANVAS_PIXELS = 16_000_000; // iOS の canvas 上限（約1670万画素）より少し下

// ───────── 設定 ─────────

const SETTINGS_KEY = 'mannerCamera.settings';
const DEFAULTS = {
  aspect: '4:3',
  grid: false,
  timer: 0,
  mirrorSave: true,
  haptics: true,
  autoSave: false,
  facing: 'environment',
};

const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) {}
  const s = { ...DEFAULTS, ...saved };
  if (!(s.aspect in ASPECT)) s.aspect = DEFAULTS.aspect;
  if (!TIMERS.includes(s.timer)) s.timer = 0;
  if (s.facing !== 'user') s.facing = 'environment';
  return s;
})();

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// ───────── 要素 ─────────

const el = {
  stage: $('stage'), frame: $('frame'), video: $('video'), gridLines: $('gridLines'),
  countdown: $('countdown'), blink: $('blink'), zoomChip: $('zoomChip'),
  notice: $('notice'), noticeTitle: $('noticeTitle'), noticeText: $('noticeText'), noticeBtn: $('noticeBtn'),
  btnTorch: $('btnTorch'), btnTimer: $('btnTimer'), timerLabel: $('timerLabel'), silentPill: $('silentPill'),
  btnGrid: $('btnGrid'), btnSettings: $('btnSettings'),
  btnGallery: $('btnGallery'), thumbImg: $('thumbImg'), btnShutter: $('btnShutter'), btnSwitch: $('btnSwitch'),
  gallery: $('gallery'), galleryBack: $('galleryBack'), galleryCount: $('galleryCount'), gallerySelect: $('gallerySelect'),
  galleryHint: $('galleryHint'), galleryGrid: $('galleryGrid'), galleryEmpty: $('galleryEmpty'),
  footNormal: $('footNormal'), footSelect: $('footSelect'), saveAll: $('saveAll'),
  selectAll: $('selectAll'), saveSel: $('saveSel'), delSel: $('delSel'),
  viewer: $('viewer'), viewerStage: $('viewerStage'), viewerImg: $('viewerImg'), viewerBack: $('viewerBack'),
  viewerDate: $('viewerDate'), viewerIndex: $('viewerIndex'),
  viewerDelete: $('viewerDelete'), viewerShare: $('viewerShare'), viewerSave: $('viewerSave'),
  settings: $('settings'), aspectSeg: $('aspectSeg'), optGrid: $('optGrid'), optMirror: $('optMirror'),
  optHaptics: $('optHaptics'), optAuto: $('optAuto'), rowHaptics: $('rowHaptics'), rowAuto: $('rowAuto'),
  toast: $('toast'),
};

// ───────── カメラ ─────────

const cam = {
  stream: null,
  track: null,
  gen: 0,            // 起動のたびに増える。古い起動処理の結果を捨てるため
  ready: false,
  facing: settings.facing,
  isFront: false,
  deviceId: null,    // PC で複数カメラを切り替えるとき用
  devices: [],
  caps: {},
  torch: false,
  torchSupported: false,
};

async function openStream() {
  const [w, h] = REQUEST[settings.aspect];
  const video = { width: { ideal: w }, height: { ideal: h }, aspectRatio: { ideal: w / h } };
  if (cam.deviceId) video.deviceId = { exact: cam.deviceId };
  else video.facingMode = { ideal: settings.facing };
  if (isAndroid) video.zoom = true; // Chrome にズーム機能を公開してもらう

  // ★ audio: false … マイクを使わない。これが「YouTube を止めない」いちばんのポイント
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
    // 高解像度で起動できない端末向けに、条件をゆるめて再挑戦
    const loose = cam.deviceId ? { deviceId: { exact: cam.deviceId } } : { facingMode: settings.facing };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: loose, audio: false });
    } catch (err2) {
      if (err2 && (err2.name === 'NotAllowedError' || err2.name === 'SecurityError')) throw err2;
      cam.deviceId = null;
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }
}

async function startCamera() {
  const gen = ++cam.gen;
  stopCamera();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!window.isSecureContext) {
      showNotice('HTTPS で開いてください', 'カメラは安全な接続（https://）のページでしか使えません。');
    } else {
      showNotice('このブラウザではカメラを使えません', isInAppBrowser
        ? 'LINE などのアプリ内ブラウザでは動かないことがあります。\nSafari または Chrome で開き直してください。'
        : 'Safari または Chrome の最新版でお試しください。');
    }
    return;
  }

  const loading = setTimeout(() => {
    if (gen === cam.gen && !cam.ready) showNotice('カメラを起動中…', '', { button: false, spinner: true });
  }, 400);

  let stream;
  try {
    stream = await openStream();
  } catch (err) {
    clearTimeout(loading);
    if (gen !== cam.gen) return;
    const [title, text] = describeError(err);
    showNotice(title, text + (isInAppBrowser ? '\n\nアプリ内ブラウザの場合は Safari / Chrome で開き直してください。' : ''));
    return;
  }
  clearTimeout(loading);

  if (gen !== cam.gen || document.hidden) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  cam.stream = stream;
  cam.track = stream.getVideoTracks()[0];
  const s = safeSettings(cam.track);
  cam.facing = s.facingMode || (isMobile ? settings.facing : 'user');
  cam.isFront = cam.facing === 'user';

  const track = cam.track;
  track.addEventListener('ended', () => {
    if (track !== cam.track) return;
    cam.ready = false;
    updateCameraUI();
    showNotice('カメラが止まりました', '他のアプリがカメラを使い始めた可能性があります。');
  });

  const v = el.video;
  v.muted = true; // 念のため。ミュート再生は音声フォーカスを取らない
  v.srcObject = stream;
  try { await v.play(); } catch (_) {}
  if (!v.videoWidth) await waitForEvent(v, 'loadedmetadata', 3000);
  if (gen !== cam.gen) return;

  hideNotice();
  setupCapabilities();
  setupZoom();
  layoutFrame();
  cam.ready = true;
  updateCameraUI();
  refreshDevices();
}

function stopCamera() {
  cam.ready = false;
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.track = null;
  cam.torch = false;
  cam.torchSupported = false;
  el.video.srcObject = null;
  updateCameraUI();
}

function safeSettings(track) {
  try { return (track && track.getSettings && track.getSettings()) || {}; } catch (_) { return {}; }
}

function waitForEvent(target, type, timeout) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); target.removeEventListener(type, done); resolve(); };
    const timer = setTimeout(done, timeout);
    target.addEventListener(type, done, { once: true });
  });
}

function describeError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return ['カメラが許可されていません', isIOS
      ? 'アドレスバーの「ぁあ」→「Webサイトの設定」→「カメラ」を「許可」にしてから、もう一度お試しください。'
      : 'アドレスバーの鍵アイコン（サイトの設定）からカメラを許可して、もう一度お試しください。'];
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return ['カメラが見つかりません', 'カメラが使える端末か確認してください。'];
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return ['カメラを起動できません', '他のアプリがカメラを使っているかもしれません。\nそのアプリを閉じてから、もう一度お試しください。'];
  }
  return ['カメラを起動できません', String((err && err.message) || err || '')];
}

async function refreshDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    cam.devices = list.filter((d) => d.kind === 'videoinput');
  } catch (_) {
    cam.devices = [];
  }
  updateCameraUI();
}

function switchCamera() {
  cancelCountdown();
  const s = safeSettings(cam.track);
  if (isMobile || s.facingMode) {
    settings.facing = cam.facing === 'user' ? 'environment' : 'user';
    cam.deviceId = null;
    saveSettings();
  } else if (cam.devices.length > 1) {
    const i = cam.devices.findIndex((d) => d.deviceId === s.deviceId);
    cam.deviceId = cam.devices[(i + 1) % cam.devices.length].deviceId;
  } else {
    return;
  }
  startCamera();
}

function setupCapabilities() {
  let caps = {};
  try { caps = (cam.track.getCapabilities && cam.track.getCapabilities()) || {}; } catch (_) {}
  cam.caps = caps;
  const t = caps.torch;
  cam.torchSupported = Array.isArray(t) ? t.includes(true) : t === true;
  cam.torch = false;
}

async function toggleTorch() {
  if (!cam.track || !cam.torchSupported) return;
  const next = !cam.torch;
  try {
    await cam.track.applyConstraints({ advanced: [{ torch: next }] });
    cam.torch = next;
  } catch (_) {
    toast('ライトを切り替えられませんでした');
  }
  updateCameraUI();
}

function updateCameraUI() {
  el.btnShutter.disabled = !cam.ready && !countdownTimer;
  el.zoomChip.hidden = !cam.ready;

  el.btnTorch.classList.toggle('is-off', !cam.torchSupported);
  el.btnTorch.classList.toggle('active', cam.torch);
  el.btnTorch.setAttribute('aria-pressed', String(cam.torch));
  el.btnTorch.querySelector('use').setAttribute('href', cam.torch ? '#i-bolt' : '#i-bolt-off');

  const switchable = isMobile || cam.devices.length > 1;
  el.btnSwitch.classList.toggle('is-off', !switchable);

  applyVideoTransform();
}

// ───────── プレビューの枠（見たまま撮れるように、写真と同じ比率にする） ─────────

function frameRatio(vw, vh) {
  const a = ASPECT[settings.aspect];
  return vw >= vh ? a : 1 / a;
}

function layoutFrame() {
  const v = el.video;
  const rect = el.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const r = v.videoWidth && v.videoHeight
    ? frameRatio(v.videoWidth, v.videoHeight)
    : frameRatio(rect.width, rect.height);
  let w = rect.width;
  let h = w / r;
  if (h > rect.height) { h = rect.height; w = h * r; }
  el.frame.style.width = `${Math.floor(w)}px`;
  el.frame.style.height = `${Math.floor(h)}px`;
}

// ───────── ズーム（端末のズーム機能があれば使い、なければデジタルズーム） ─────────

const zoom = { hw: false, value: 1, min: 1, max: 4, base: 1, busy: false, dirty: false };

function setupZoom() {
  const c = cam.caps && cam.caps.zoom;
  if (c && typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min) {
    zoom.hw = true;
    zoom.min = c.min;
    zoom.base = c.min >= 1.5 ? c.min : 1; // 「1×」と表示する基準
    zoom.max = Math.min(c.max, zoom.base * 10);
    const cur = safeSettings(cam.track).zoom;
    zoom.value = typeof cur === 'number' ? cur : Math.min(zoom.max, Math.max(zoom.min, zoom.base));
  } else {
    zoom.hw = false;
    zoom.min = 1;
    zoom.max = 4;
    zoom.base = 1;
    zoom.value = 1;
  }
  updateZoomChip();
}

function setZoom(z) {
  z = Math.min(zoom.max, Math.max(zoom.min, z));
  if (Math.abs(z - zoom.value) < 0.001) return;
  zoom.value = z;
  if (zoom.hw) pushHardwareZoom();
  applyVideoTransform();
  updateZoomChip();
}

function pushHardwareZoom() {
  const track = cam.track;
  if (!track) return;
  if (zoom.busy) { zoom.dirty = true; return; }
  zoom.busy = true;
  track.applyConstraints({ advanced: [{ zoom: zoom.value }] })
    .catch(() => {})
    .finally(() => {
      zoom.busy = false;
      if (zoom.dirty && track === cam.track) { zoom.dirty = false; pushHardwareZoom(); }
    });
}

function digitalZoom() {
  return zoom.hw ? 1 : zoom.value;
}

function applyVideoTransform() {
  const mirror = cam.isFront ? 'scaleX(-1) ' : '';
  el.video.style.transform = `${mirror}scale(${digitalZoom()})`;
}

function updateZoomChip() {
  const r = Math.round((zoom.value / zoom.base) * 10) / 10;
  el.zoomChip.textContent = `${String(r).replace(/\.0$/, '')}×`;
}

function toggleZoomPreset() {
  const rel = zoom.value / zoom.base;
  setZoom(rel < 1.95 ? Math.min(zoom.max, zoom.base * 2) : zoom.base);
}

// ピンチでズーム
const pointers = new Map();
let pinch = null;

function pointerDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

el.stage.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) pinch = { d: pointerDistance(), z: zoom.value };
});
el.stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2 && pinch.d > 0 && cam.ready) {
    setZoom(pinch.z * (pointerDistance() / pinch.d));
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
};
el.stage.addEventListener('pointerup', endPointer);
el.stage.addEventListener('pointercancel', endPointer);
el.stage.addEventListener('wheel', (e) => {
  if (!cam.ready) return;
  e.preventDefault();
  setZoom(zoom.value * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
}, { passive: false });

// ───────── 撮影 ─────────

let countdownTimer = null;

function onShutter() {
  if (countdownTimer) { cancelCountdown(); return; }
  if (!cam.ready) return;
  if (settings.timer > 0) startCountdown(settings.timer);
  else takePhoto();
}

function startCountdown(sec) {
  let n = sec;
  const show = () => {
    el.countdown.textContent = String(n);
    el.countdown.classList.remove('tick');
    void el.countdown.offsetWidth;
    el.countdown.classList.add('tick');
  };
  el.countdown.classList.add('show');
  el.btnShutter.classList.add('counting');
  el.btnShutter.setAttribute('aria-label', 'タイマーを中止');
  show();
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      cancelCountdown();
      takePhoto();
    } else {
      show();
    }
  }, 1000);
}

function cancelCountdown() {
  if (!countdownTimer) return;
  clearInterval(countdownTimer);
  countdownTimer = null;
  el.countdown.classList.remove('show', 'tick');
  el.countdown.textContent = '';
  el.btnShutter.classList.remove('counting');
  el.btnShutter.setAttribute('aria-label', '撮影');
  updateCameraUI();
}

/** プレビューに映っている範囲そのままを canvas に描く（無音） */
function grabFrame() {
  const v = el.video;
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const r = frameRatio(vw, vh);

  // 縦横比に合わせて中央を切り抜く
  let sw = vw;
  let sh = vh;
  if (vw / vh > r) sw = vh * r;
  else sh = vw / r;
  // デジタルズーム分をさらに切り抜く
  const dz = digitalZoom();
  sw /= dz;
  sh /= dz;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;

  let cw = Math.round(sw);
  let ch = Math.round(sh);
  const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (cw * ch)));
  cw = Math.max(1, Math.floor(cw * scale));
  ch = Math.max(1, Math.floor(ch * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (cam.isFront && settings.mirrorSave) {
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch);
  return canvas;
}

function makeThumbCanvas(src) {
  const s = Math.min(1, 360 / Math.max(src.width, src.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(src.width * s));
  t.height = Math.max(1, Math.round(src.height * s));
  const ctx = t.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, t.width, t.height);
  return t;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => {
    try { canvas.toBlob(resolve, 'image/jpeg', quality); } catch (_) { resolve(null); }
  });
}

let storeWarned = false;

async function takePhoto() {
  const v = el.video;
  if (!cam.ready || !v.videoWidth || !v.videoHeight) return;
  const createdAt = Date.now();

  let canvas;
  let thumbCanvas;
  try {
    canvas = grabFrame();
    thumbCanvas = makeThumbCanvas(canvas);
  } catch (_) {
    toast('撮影に失敗しました');
    return;
  }
  blink();
  haptic();

  const [blob, thumb] = await Promise.all([
    canvasToBlob(canvas, JPEG_QUALITY),
    canvasToBlob(thumbCanvas, 0.8),
  ]);
  const width = canvas.width;
  const height = canvas.height;
  // iOS は canvas のメモリ上限が厳しいので、すぐ解放する
  canvas.width = canvas.height = 0;
  thumbCanvas.width = thumbCanvas.height = 0;

  if (!blob) { toast('撮影に失敗しました'); return; }

  const photo = {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    blob,
    thumb: thumb || null,
    width,
    height,
    saved: false,
  };
  photos.unshift(photo);
  updateThumb(true);
  if (!el.gallery.hidden) renderGallery();

  store.put(photo).catch(() => {
    if (storeWarned) return;
    storeWarned = true;
    toast('アルバムに記録できませんでした。早めに保存してください', 3200);
  });
  requestPersistentStorage();

  if (settings.autoSave && !isIOS) {
    downloadFiles([toFile(photo)]);
    markSaved([photo]);
  }
}

function blink() {
  el.blink.classList.remove('on');
  void el.blink.offsetWidth;
  el.blink.classList.add('on');
}

function haptic() {
  if (!settings.haptics || !canVibrate) return;
  try { navigator.vibrate(12); } catch (_) {}
}

let persistAsked = false;
function requestPersistentStorage() {
  if (persistAsked) return;
  persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (_) {}
}

// ───────── アルバムの保管（IndexedDB） ─────────

const store = (() => {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
        const req = indexedDB.open('manner-camera', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      dbPromise.catch(() => {});
    }
    return dbPromise;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    all: () => run('readonly', (st) => st.getAll()),
    put: (photo) => run('readwrite', (st) => st.put(photo)),
    del: (ids) => run('readwrite', (st) => { ids.forEach((id) => st.delete(id)); }),
  };
})();

let photos = [];
const thumbUrls = new Map();

function thumbURL(p) {
  let url = thumbUrls.get(p.id);
  if (!url) {
    url = URL.createObjectURL(p.thumb || p.blob);
    thumbUrls.set(p.id, url);
  }
  return url;
}

async function loadPhotos() {
  try {
    const list = await store.all();
    const have = new Set(photos.map((p) => p.id));
    photos = photos.concat(list.filter((p) => p && p.blob && !have.has(p.id)));
    photos.sort((a, b) => b.createdAt - a.createdAt);
    updateThumb(false);
    if (!el.gallery.hidden) renderGallery();
  } catch (_) { /* 保管できない環境でも撮影はできる */ }
}

async function deletePhotos(ids) {
  const set = new Set(ids);
  photos = photos.filter((p) => !set.has(p.id));
  ids.forEach((id) => {
    const url = thumbUrls.get(id);
    if (url) { URL.revokeObjectURL(url); thumbUrls.delete(id); }
    selected.delete(id);
  });
  updateThumb(false);
  try { await store.del(ids); } catch (_) {}
}

function updateThumb(pop) {
  const p = photos[0];
  if (p) {
    el.thumbImg.src = thumbURL(p);
    el.thumbImg.hidden = false;
  } else {
    el.thumbImg.hidden = true;
    el.thumbImg.removeAttribute('src');
  }
  if (pop) {
    el.btnGallery.classList.remove('pop');
    void el.btnGallery.offsetWidth;
    el.btnGallery.classList.add('pop');
  }
}

// ───────── 端末への保存・共有 ─────────

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function fileName(p) {
  const d = new Date(p.createdAt);
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}.jpg`;
}

function toFile(p) {
  return new File([p.blob], fileName(p), { type: 'image/jpeg', lastModified: p.createdAt });
}

function canShareFiles(files) {
  if (!canShare) return false;
  try { return navigator.canShare({ files }); } catch (_) { return false; }
}

function downloadFiles(files) {
  files.forEach((file, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, i * 300);
  });
}

/**
 * 端末に保存。iPhone は共有シート（→「画像を保存」で写真アプリへ）、それ以外はダウンロード。
 * 共有シートはタップ直後にしか開けないので、この関数はタップの処理から同期的に呼ぶこと。
 */
function savePhotos(list) {
  if (!list.length) return;
  const files = list.map(toFile);
  if (isIOS && canShareFiles(files)) {
    navigator.share({ files }).then(
      () => markSaved(list),
      (err) => {
        if (err && err.name === 'AbortError') return;
        downloadFiles(files);
        markSaved(list);
      },
    );
    return;
  }
  downloadFiles(files);
  markSaved(list);
  toast(list.length > 1 ? `${list.length}枚をダウンロードしました` : 'ダウンロードしました');
}

function sharePhotos(list) {
  if (!list.length) return;
  const files = list.map(toFile);
  if (!canShareFiles(files)) { toast('この端末では共有できません'); return; }
  navigator.share({ files }).then(() => markSaved(list), () => {});
}

function markSaved(list) {
  list.forEach((p) => {
    if (p.saved) return;
    p.saved = true;
    store.put(p).catch(() => {});
  });
  if (!el.gallery.hidden) renderGallery();
  if (!el.viewer.hidden) updateViewerMeta();
}

// ───────── 画面の重なり（Android の「戻る」でも閉じられるように履歴を使う） ─────────

const overlays = [];

function openOverlay(close) {
  overlays.push(close);
  try { history.pushState({ mannerCamera: overlays.length }, ''); } catch (_) {}
}

function closeTopOverlay() {
  if (overlays.length) history.back();
}

window.addEventListener('popstate', () => {
  const close = overlays.pop();
  if (close) close();
});

// ───────── アルバム画面 ─────────

let selecting = false;
const selected = new Set();
const checkSvg = '<svg class="ic"><use href="#i-check"/></svg>';

function openGallery() {
  if (!el.gallery.hidden) return;
  cancelCountdown();
  selecting = false;
  selected.clear();
  el.galleryHint.textContent = isIOS
    ? 'アルバムはこのアプリ内の一時保管です（● は未保存）。「保存」→「画像を保存」で写真アプリに残せます。'
    : 'アルバムはこのアプリ内の一時保管です（● は未保存）。「保存」で端末にダウンロードされます。';
  renderGallery();
  el.gallery.hidden = false;
  el.galleryGrid.scrollTop = 0;
  openOverlay(() => {
    el.gallery.hidden = true;
    selecting = false;
    selected.clear();
  });
}

function renderGallery() {
  const grid = el.galleryGrid;
  const frag = document.createDocumentFragment();
  for (const p of photos) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'g-item';
    item.dataset.id = p.id;
    item.setAttribute('aria-label', `${formatDate(p.createdAt)}${p.saved ? '' : '（未保存）'}`);
    if (selected.has(p.id)) item.classList.add('selected');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = thumbURL(p);
    item.appendChild(img);
    if (!p.saved) {
      const dot = document.createElement('span');
      dot.className = 'g-dot';
      item.appendChild(dot);
    }
    const check = document.createElement('span');
    check.className = 'g-check';
    check.innerHTML = checkSvg;
    item.appendChild(check);
    frag.appendChild(item);
  }
  grid.replaceChildren(frag);
  grid.classList.toggle('selecting', selecting);

  const total = photos.length;
  const unsaved = photos.filter((p) => !p.saved).length;
  el.galleryCount.textContent = total ? `${total}枚${unsaved ? `・未保存 ${unsaved}` : ''}` : '';
  el.galleryEmpty.hidden = total > 0;
  grid.hidden = total === 0;

  el.gallerySelect.textContent = selecting ? 'キャンセル' : '選択';
  el.gallerySelect.disabled = total === 0;
  el.footNormal.hidden = selecting;
  el.footSelect.hidden = !selecting;
  el.saveAll.disabled = total === 0;

  const n = selected.size;
  el.selectAll.textContent = n === total && total > 0 ? '選択解除' : 'すべて選択';
  el.saveSel.disabled = n === 0;
  el.delSel.disabled = n === 0;
  el.saveSel.querySelector('span').textContent = n ? `保存（${n}）` : '保存';
  el.delSel.querySelector('span').textContent = n ? `削除（${n}）` : '削除';
}

el.galleryGrid.addEventListener('click', (e) => {
  const item = e.target.closest('.g-item');
  if (!item) return;
  const id = item.dataset.id;
  if (selecting) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    renderGallery();
    return;
  }
  const index = photos.findIndex((p) => p.id === id);
  if (index >= 0) openViewer(index);
});

el.gallerySelect.addEventListener('click', () => {
  selecting = !selecting;
  selected.clear();
  renderGallery();
});

el.selectAll.addEventListener('click', () => {
  if (selected.size === photos.length) selected.clear();
  else photos.forEach((p) => selected.add(p.id));
  renderGallery();
});

el.saveAll.addEventListener('click', () => savePhotos(photos.slice()));
el.saveSel.addEventListener('click', () => savePhotos(photos.filter((p) => selected.has(p.id))));

el.delSel.addEventListener('click', async () => {
  const list = photos.filter((p) => selected.has(p.id));
  if (!list.length) return;
  const unsaved = list.filter((p) => !p.saved).length;
  const msg = `${list.length}枚の写真を削除しますか？` + (unsaved ? `\n（うち ${unsaved}枚はまだ保存していません）` : '');
  if (!confirm(msg)) return;
  await deletePhotos(list.map((p) => p.id));
  selected.clear();
  if (!photos.length) selecting = false;
  renderGallery();
});

el.galleryBack.addEventListener('click', closeTopOverlay);

// ───────── 写真ビューア ─────────

let viewerIndex = 0;
let viewerUrl = null;

function openViewer(index) {
  viewerIndex = index;
  el.viewer.classList.remove('chrome-hidden');
  renderViewer();
  el.viewer.hidden = false;
  openOverlay(() => {
    el.viewer.hidden = true;
    el.viewerImg.removeAttribute('src');
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  });
}

function renderViewer() {
  const p = photos[viewerIndex];
  if (!p) return;
  const old = viewerUrl;
  viewerUrl = URL.createObjectURL(p.blob);
  el.viewerImg.src = viewerUrl;
  if (old) URL.revokeObjectURL(old);
  updateViewerMeta();
}

function updateViewerMeta() {
  const p = photos[viewerIndex];
  if (!p) return;
  el.viewerDate.textContent = formatDate(p.createdAt);
  el.viewerIndex.textContent = `${viewerIndex + 1} / ${photos.length}${p.saved ? '' : '・未保存'}`;
}

function stepViewer(delta) {
  const next = viewerIndex + delta;
  if (next < 0 || next >= photos.length) return;
  viewerIndex = next;
  renderViewer();
}

let swipe = null;
el.viewerStage.addEventListener('pointerdown', (e) => {
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
el.viewerStage.addEventListener('pointerup', (e) => {
  if (!swipe || swipe.id !== e.pointerId) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepViewer(dx < 0 ? 1 : -1);
  else if (dy > 90 && dy > Math.abs(dx)) closeTopOverlay();
  else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) el.viewer.classList.toggle('chrome-hidden');
});
el.viewerStage.addEventListener('pointercancel', () => { swipe = null; });

el.viewerBack.addEventListener('click', closeTopOverlay);
el.viewerSave.addEventListener('click', () => {
  const p = photos[viewerIndex];
  if (p) savePhotos([p]);
});
el.viewerShare.addEventListener('click', () => {
  const p = photos[viewerIndex];
  if (p) sharePhotos([p]);
});
el.viewerDelete.addEventListener('click', async () => {
  const p = photos[viewerIndex];
  if (!p) return;
  if (!confirm(p.saved ? 'この写真を削除しますか？' : 'この写真はまだ保存していません。削除しますか？')) return;
  await deletePhotos([p.id]);
  if (!el.gallery.hidden) renderGallery();
  if (!photos.length) { closeTopOverlay(); return; }
  viewerIndex = Math.min(viewerIndex, photos.length - 1);
  renderViewer();
});

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
});
function formatDate(t) { return dateFormat.format(new Date(t)); }

// ───────── 設定画面 ─────────

function openSettings() {
  cancelCountdown();
  syncSettingsUI();
  el.settings.hidden = false;
  openOverlay(() => { el.settings.hidden = true; });
}

function syncSettingsUI() {
  el.aspectSeg.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.v === settings.aspect));
  });
  el.optGrid.checked = settings.grid;
  el.optMirror.checked = settings.mirrorSave;
  el.optHaptics.checked = settings.haptics;
  el.optAuto.checked = settings.autoSave;
  el.rowHaptics.hidden = !canVibrate;
  el.rowAuto.hidden = isIOS;
}

function setAspect(aspect) {
  if (!(aspect in ASPECT) || aspect === settings.aspect) return;
  const needRestart = REQUEST[aspect].join() !== REQUEST[settings.aspect].join();
  settings.aspect = aspect;
  saveSettings();
  syncSettingsUI();
  if (needRestart) startCamera();
  else layoutFrame();
}

function applyGrid() {
  el.gridLines.hidden = !settings.grid;
  el.btnGrid.classList.toggle('active', settings.grid);
  el.btnGrid.setAttribute('aria-pressed', String(settings.grid));
  el.optGrid.checked = settings.grid;
}

function updateTimerButton() {
  el.timerLabel.textContent = settings.timer ? `${settings.timer}s` : '';
  el.btnTimer.classList.toggle('active', settings.timer > 0);
  el.btnTimer.setAttribute('aria-label', `セルフタイマー：${settings.timer ? `${settings.timer}秒` : 'オフ'}`);
}

el.settings.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeTopOverlay();
});
el.aspectSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (b) setAspect(b.dataset.v);
});
el.optGrid.addEventListener('change', () => { settings.grid = el.optGrid.checked; saveSettings(); applyGrid(); });
el.optMirror.addEventListener('change', () => { settings.mirrorSave = el.optMirror.checked; saveSettings(); });
el.optHaptics.addEventListener('change', () => { settings.haptics = el.optHaptics.checked; saveSettings(); });
el.optAuto.addEventListener('change', () => { settings.autoSave = el.optAuto.checked; saveSettings(); });

// ───────── カメラ画面のボタン ─────────

el.btnShutter.addEventListener('click', onShutter);
el.btnSwitch.addEventListener('click', switchCamera);
el.btnGallery.addEventListener('click', openGallery);
el.btnSettings.addEventListener('click', openSettings);
el.btnTorch.addEventListener('click', toggleTorch);
el.zoomChip.addEventListener('click', toggleZoomPreset);
el.noticeBtn.addEventListener('click', () => startCamera());

el.btnGrid.addEventListener('click', () => {
  settings.grid = !settings.grid;
  saveSettings();
  applyGrid();
});

el.btnTimer.addEventListener('click', () => {
  cancelCountdown();
  const i = TIMERS.indexOf(settings.timer);
  settings.timer = TIMERS[(i + 1) % TIMERS.length];
  saveSettings();
  updateTimerButton();
  toast(settings.timer ? `セルフタイマー ${settings.timer}秒` : 'セルフタイマー オフ');
});

el.silentPill.addEventListener('click', () => {
  toast('シャッター音なし・YouTube や音楽も止めません', 2600);
});

// キーボード（PC）：スペース / Enter で撮影
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (overlays.length) { e.preventDefault(); closeTopOverlay(); }
    return;
  }
  if (!el.viewer.hidden) {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
    return;
  }
  if (overlays.length) return;
  const onControl = e.target && e.target.closest && e.target.closest('button, input, select, textarea');
  if ((e.code === 'Space' || e.key === 'Enter') && !onControl) {
    e.preventDefault();
    onShutter();
  }
});

// iOS Safari のピンチでページ全体が拡大されるのを防ぐ
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ───────── 表示まわり ─────────

let toastTimer = null;
function toast(message, ms = 1800) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function showNotice(title, text, { button = true, spinner = false } = {}) {
  el.noticeTitle.textContent = title;
  el.noticeText.textContent = text;
  el.noticeBtn.hidden = !button;
  el.notice.classList.toggle('loading', spinner);
  el.notice.hidden = false;
}

function hideNotice() {
  el.notice.hidden = true;
}

if ('ResizeObserver' in window) new ResizeObserver(layoutFrame).observe(el.stage);
else window.addEventListener('resize', layoutFrame);
el.video.addEventListener('resize', layoutFrame); // 端末を回転したとき

// 画面を離れたらカメラを止め（バッテリー節約）、戻ったら再開
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelCountdown();
    cam.gen++;
    stopCamera();
  } else {
    startCamera();
  }
});
window.addEventListener('pageshow', (e) => { if (e.persisted) startCamera(); });

// ───────── 起動 ─────────

applyGrid();
updateTimerButton();
syncSettingsUI();
el.viewerShare.hidden = isIOS || !canShare;
layoutFrame();
updateCameraUI();
loadPhotos();
startCamera();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
