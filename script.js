/**
 * CIRCLENS – Echtzeit Kreiserkennung via Kamera
 * Algorithmus: Sobel-Kantendetektion + Hough-Kreis-Transformation
 * Optimiert für Mobilgeräte durch skaliertes Processing-Canvas
 */

'use strict';

// ─── DOM ─────────────────────────────────────────────────────
const video       = document.getElementById('camera');
const overlay     = document.getElementById('overlay');
const ctx         = overlay.getContext('2d');
const noCamera    = document.getElementById('no-camera');
const retryBtn    = document.getElementById('retry-btn');
const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');
const hudFps      = document.getElementById('hud-fps');
const hudRadius   = document.getElementById('hud-radius');
const hudConf     = document.getElementById('hud-conf');

// Controls
const rminInput   = document.getElementById('rmin');
const rmaxInput   = document.getElementById('rmax');
const edgeInput   = document.getElementById('edge-thresh');
const accInput    = document.getElementById('acc-thresh');
const resSelect   = document.getElementById('res-select');
const showEdges   = document.getElementById('show-edges');
const showMask    = document.getElementById('show-mask');

// Value displays
const valRmin = document.getElementById('val-rmin');
const valRmax = document.getElementById('val-rmax');
const valEdge = document.getElementById('val-edge');
const valAcc  = document.getElementById('val-acc');

// ─── State ───────────────────────────────────────────────────
let params = {
  rMin:       20,
  rMax:       180,
  edgeThresh: 45,
  accThresh:  55,   // % der Kreislinie muss abstimmen
  procWidth:  320,
};

let procCanvas, procCtx;
let procW = 320, procH = 240;
let lastCircle   = null;
let smoothCircle = null;
let rafId        = null;
let running      = false;

// FPS-Messung
let fpsFrames = 0, fpsLast = performance.now(), fpsVal = 0;

// ─── Processing Canvas Setup ──────────────────────────────────
function createProcCanvas(w, h) {
  procCanvas = document.createElement('canvas');
  procCanvas.width  = w;
  procCanvas.height = h;
  procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
  procW = w; procH = h;
}

// ─── Kamera starten ───────────────────────────────────────────
async function startCamera() {
  setStatus('Kamera wird gestartet…', 'pending');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise(res => { video.onloadedmetadata = res; });
    await video.play();
    noCamera.classList.add('hidden');
    setStatus('Läuft', 'active');
    running = true;
    resizeOverlay();
    startLoop();
  } catch (err) {
    console.error('Kamerafehler:', err);
    noCamera.classList.remove('hidden');
    setStatus('Kein Zugriff', 'error');
  }
}

function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = '';
  if (state) statusDot.classList.add(state);
}

// ─── Overlay-Canvas Größe anpassen ────────────────────────────
function resizeOverlay() {
  const vw = video.offsetWidth  || window.innerWidth;
  const vh = video.offsetHeight || window.innerHeight;
  overlay.width  = vw;
  overlay.height = vh;
}

window.addEventListener('resize', resizeOverlay);

// ─── Haupt-Render-Loop ────────────────────────────────────────
function startLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  loop();
}

function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  if (video.readyState < 2) return;

  // FPS messen
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 500) {
    fpsVal = Math.round(fpsFrames / ((now - fpsLast) / 1000));
    fpsFrames = 0;
    fpsLast = now;
    hudFps.textContent = fpsVal + ' FPS';
  }

  // Verarbeitungs-Canvas befüllen
  const aspect = video.videoWidth / video.videoHeight || 4/3;
  const ph = Math.round(procW / aspect);
  if (procCanvas.width !== procW || procCanvas.height !== ph) {
    procCanvas.width  = procW;
    procCanvas.height = ph;
    procH = ph;
  }
  procCtx.drawImage(video, 0, 0, procW, procH);

  const imageData = procCtx.getImageData(0, 0, procW, procH);

  const circle = detectCircle(imageData, procW, procH);
  lastCircle = circle;

  drawFrame(circle);
  updateHUD(circle);
}

// ─── Zeichnen ─────────────────────────────────────────────────
function drawFrame(circle) {
  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);

  const sx = W / procW;
  const sy = H / procH;

  if (showEdges.checked && lastEdgeData) {
    drawEdges(sx, sy, W, H);
  }

  if (!circle) {
    smoothCircle = null;
    return;
  }

  // Exponentielles Smoothing für flüssige Bewegung
  const alpha = 0.5;
  if (!smoothCircle) {
    smoothCircle = { ...circle };
  } else {
    smoothCircle.x = smoothCircle.x * (1 - alpha) + circle.x * alpha;
    smoothCircle.y = smoothCircle.y * (1 - alpha) + circle.y * alpha;
    smoothCircle.r = smoothCircle.r * (1 - alpha) + circle.r * alpha;
  }

  const cx = smoothCircle.x * sx;
  const cy = smoothCircle.y * sy;
  const cr = smoothCircle.r * ((sx + sy) / 2);

  // Hintergrundmaske außerhalb des Kreises
  if (showMask.checked) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, cr, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();
  }

  const conf = circle.score;
  const green = `rgba(0, 255, 136, ${0.85 + 0.15 * conf})`;

  // Äußerer Glow-Ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, cr + 6, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(0,255,136, ${0.15 * conf})`;
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.restore();

  // Haupt-Kreis grüner Umriss
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.strokeStyle = green;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(0,255,136,0.6)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();

  // Mittelpunkt-Fadenkreuz
  ctx.save();
  const cross = 10;
  ctx.strokeStyle = green;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,255,136,0.5)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(cx - cross, cy); ctx.lineTo(cx + cross, cy);
  ctx.moveTo(cx, cy - cross); ctx.lineTo(cx, cy + cross);
  ctx.stroke();
  ctx.restore();

  // Konfidenz-Bogen
  ctx.save();
  const arcLen = conf * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(cx, cy, cr - 4, -Math.PI / 2, -Math.PI / 2 + arcLen);
  ctx.strokeStyle = `rgba(0,255,136, 0.4)`;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Label mit Radius und Konfidenz
  ctx.save();
  const label = `r=${Math.round(smoothCircle.r)}px  ${Math.round(conf * 100)}%`;
  const lx = cx;
  const ly = cy - cr - 12;
  ctx.font = '600 11px DM Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(lx - 52, ly - 13, 104, 18);
  ctx.fillStyle = green;
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

// ─── Edge Debug Draw ──────────────────────────────────────────
let lastEdgeData = null;

function drawEdges(sx, sy, W, H) {
  if (!lastEdgeData) return;
  const tmp = document.createElement('canvas');
  tmp.width = procW; tmp.height = procH;
  const tc = tmp.getContext('2d');
  const id = tc.createImageData(procW, procH);
  for (let i = 0; i < lastEdgeData.length; i++) {
    const v = lastEdgeData[i];
    id.data[i * 4 + 0] = 0;
    id.data[i * 4 + 1] = v > 0 ? 200 : 0;
    id.data[i * 4 + 2] = 0;
    id.data[i * 4 + 3] = v > 0 ? 160 : 0;
  }
  tc.putImageData(id, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.drawImage(tmp, 0, 0, W, H);
  ctx.restore();
}

// ─── HUD Update ───────────────────────────────────────────────
function updateHUD(circle) {
  if (circle) {
    hudRadius.textContent = `R: ${Math.round(circle.r)}px`;
    hudConf.textContent   = `${Math.round(circle.score * 100)}% Konfidenz`;
    setStatus('Kreis erkannt', 'found');
  } else {
    hudRadius.textContent = 'R: —';
    hudConf.textContent   = 'Konfidenz: —';
    setStatus('Suche…', 'active');
  }
}

// ═══════════════════════════════════════════════════════════════
//  KREIS-ERKENNUNGS-ALGORITHMUS
//  1. Graustufen
//  2. Gaußsche Glättung 3×3
//  3. Sobel-Kantendetektion
//  4. Hough-Kreis-Transformation (Gradient-Methode)
//  5. Peak-Suche im Akkumulator
// ═══════════════════════════════════════════════════════════════

function detectCircle(imageData, W, H) {
  const { edgeThresh, rMin, rMax, accThresh } = params;
  const pixels = imageData.data;

  // ── 1. Graustufen ──────────────────────────────────────────
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    gray[i] = (pixels[o] * 77 + pixels[o+1] * 150 + pixels[o+2] * 29) >> 8;
  }

  // ── 2. Gaußsche Glättung 3×3 ──────────────────────────────
  const blurred = gaussBlur3x3(gray, W, H);

  // ── 3. Sobel-Kantendetektion ───────────────────────────────
  const { magnitude, gx, gy } = sobelEdge(blurred, W, H);
  lastEdgeData = magnitude;

  // ── 4. Hough-Kreis-Transformation ─────────────────────────
  const rStep    = Math.max(1, Math.round((rMax - rMin) / 25));
  const numRadii = Math.floor((rMax - rMin) / rStep) + 1;
  const accArr   = new Int32Array(numRadii * H * W);

  // Kantenpunkte sammeln
  const edgePoints = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const m = magnitude[y * W + x];
      if (m >= edgeThresh) {
        edgePoints.push({
          x, y,
          dx: gx[y * W + x] / (m || 1),
          dy: gy[y * W + x] / (m || 1),
          m
        });
      }
    }
  }

  // Abstimmen entlang des Gradienten
  for (const pt of edgePoints) {
    for (let ri = 0; ri < numRadii; ri++) {
      const r = rMin + ri * rStep;
      for (const sign of [-1, 1]) {
        const cx = Math.round(pt.x + sign * r * pt.dx);
        const cy = Math.round(pt.y + sign * r * pt.dy);
        if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
        accArr[ri * H * W + cy * W + cx]++;
      }
    }
  }

  // ── 5. Peak-Suche ──────────────────────────────────────────
  let bestScore = -1, bestX = 0, bestY = 0, bestR = 0;
  const minVotes = accThresh / 100;

  for (let ri = 0; ri < numRadii; ri++) {
    const r = rMin + ri * rStep;
    const maxPossible = Math.ceil(2 * Math.PI * r);

    for (let y = r; y < H - r; y++) {
      for (let x = r; x < W - r; x++) {
        const v = accArr[ri * H * W + y * W + x];
        if (v <= 0) continue;
        const score = v / maxPossible;
        if (score >= minVotes && score > bestScore) {
          bestScore = score; bestX = x; bestY = y; bestR = r;
        }
      }
    }
  }

  if (bestScore < 0) return null;
  return { x: bestX, y: bestY, r: bestR, score: Math.min(1, bestScore) };
}

// ─── Gaußsche Glättung 3×3 ────────────────────────────────────
function gaussBlur3x3(src, W, H) {
  const dst = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      dst[i] = (
        src[(y-1)*W+(x-1)] + 2*src[(y-1)*W+x] + src[(y-1)*W+(x+1)] +
        2*src[y*W+(x-1)]   + 4*src[y*W+x]     + 2*src[y*W+(x+1)]   +
        src[(y+1)*W+(x-1)] + 2*src[(y+1)*W+x] + src[(y+1)*W+(x+1)]
      ) >> 4;
    }
  }
  return dst;
}

// ─── Sobel Kantendetektion ────────────────────────────────────
function sobelEdge(src, W, H) {
  const mag = new Uint8Array(W * H);
  const gxA = new Float32Array(W * H);
  const gyA = new Float32Array(W * H);

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx =
        -src[(y-1)*W+(x-1)] + src[(y-1)*W+(x+1)]
        -2*src[y*W+(x-1)]   + 2*src[y*W+(x+1)]
        -src[(y+1)*W+(x-1)] + src[(y+1)*W+(x+1)];
      const gy =
        src[(y-1)*W+(x-1)] + 2*src[(y-1)*W+x] + src[(y-1)*W+(x+1)]
        -src[(y+1)*W+(x-1)] - 2*src[(y+1)*W+x] - src[(y+1)*W+(x+1)];

      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m > 255 ? 255 : m;
      gxA[i] = gx;
      gyA[i] = gy;
    }
  }
  return { magnitude: mag, gx: gxA, gy: gyA };
}

// ─── Controls Listener ───────────────────────────────────────
function bindControls() {
  rminInput.addEventListener('input', () => {
    params.rMin = parseInt(rminInput.value);
    valRmin.textContent = params.rMin;
  });
  rmaxInput.addEventListener('input', () => {
    params.rMax = parseInt(rmaxInput.value);
    valRmax.textContent = params.rMax;
  });
  edgeInput.addEventListener('input', () => {
    params.edgeThresh = parseInt(edgeInput.value);
    valEdge.textContent = params.edgeThresh;
  });
  accInput.addEventListener('input', () => {
    params.accThresh = parseInt(accInput.value);
    valAcc.textContent = params.accThresh;
  });
  resSelect.addEventListener('change', () => {
    params.procWidth = parseInt(resSelect.value);
    procW = params.procWidth;
    procCanvas.width  = procW;
    procCanvas.height = Math.round(procW / (video.videoWidth / video.videoHeight || 1.33));
    procH = procCanvas.height;
  });
}

retryBtn.addEventListener('click', startCamera);

// ─── Init ─────────────────────────────────────────────────────
(function init() {
  createProcCanvas(320, 240);
  bindControls();
  startCamera();

  window.addEventListener('orientationchange', () => {
    setTimeout(resizeOverlay, 300);
  });
})();
