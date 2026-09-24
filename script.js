// ============================================================================
// Señas y Sonidos — Ejercicio 03 (DPPI 2026)
//
// Una misma cámara alimenta dos sistemas de interpretación independientes:
//
//   SISTEMA A (seña → sonido): MediaPipe HandLandmarker.
//     Pregunta: ¿qué gesto está haciendo la mano?
//     Representación: constelación orgánica de la mano, coloreada según
//     la seña reconocida. Cuando la seña se estabiliza, emite un sonido
//     sintetizado con Web Audio API.
//
//   SISTEMA B (palabra → color): campo semántico visual.
//     Pregunta: ¿qué intención lleva la palabra que nombra ese gesto?
//     Representación: matriz de puntos que traduce el brillo del video
//     al color de la intención semántica. Sin gesto: escena desaturada.
//     Con gesto: campo de color vibrante.
//
// La seña no es el sonido. El color no es la palabra.
// Cada sistema encuentra algo distinto en el mismo instante.
// ============================================================================

// ---------------------------------------------------------------------------
// CDN — MediaPipe Tasks Vision
// ---------------------------------------------------------------------------

const VISION_BUNDLE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ---------------------------------------------------------------------------
// Mapeo de gestos: seña → palabra → intención → color → hue
// ---------------------------------------------------------------------------

const GESTURES = {
  open:     { word: "Apertura",   intention: "calma",          color: "#5ce1ff", hue: 193 },
  fist:     { word: "Tensión",    intention: "fuerza",         color: "#ff3a3a", hue: 0   },
  v:        { word: "Dualidad",   intention: "equilibrio",     color: "#4ade80", hue: 142 },
  point:    { word: "Nombrar",    intention: "foco",           color: "#ffd166", hue: 47  },
  thumbsup: { word: "Afirmación", intention: "positividad",    color: "#ff8a5c", hue: 18  },
  pinch:    { word: "Retener",    intention: "concentración",  color: "#a78bfa", hue: 263 },
};

// Conexiones del esqueleto de la mano (21 landmarks MediaPipe Hands)
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // pulgar
  [0, 5], [5, 6], [6, 7], [7, 8],           // índice
  [5, 9], [9, 10], [10, 11], [11, 12],      // medio
  [9, 13], [13, 14], [14, 15], [15, 16],    // anular
  [13, 17], [17, 18], [18, 19], [19, 20],   // meñique
  [0, 17], [5, 13],                          // base de la palma
];

// Color por dedo cuando no hay gesto reconocido
const FINGER_COLORS = ["#ffd166", "#ff8a5c", "#ff5c8a", "#a78bfa", "#5ce1ff"];

// ---------------------------------------------------------------------------
// Configuración Sistema B
// ---------------------------------------------------------------------------

const DOT_COLS = 40;
const DOT_ROWS = 30;

// ---------------------------------------------------------------------------
// Referencias DOM
// ---------------------------------------------------------------------------

const video        = document.getElementById("video");
const canvasA      = document.getElementById("canvasA");
const ctxA         = canvasA.getContext("2d");
const canvasB      = document.getElementById("canvasB");
const ctxB         = canvasB.getContext("2d");
const offCanvas    = document.getElementById("hiddenSample");
const offCtx       = offCanvas.getContext("2d", { willReadFrequently: true });

// El switch del HTML es un checkbox con id="toggle" (antes se buscaban ids
// que no existían, y el script moría al cargar con un TypeError).
const toggle            = document.getElementById("toggle");
const statusMsg         = document.getElementById("statusMsg");
const idleHintA         = document.getElementById("idleHintA");
const idleHintB         = document.getElementById("idleHintB");
const statA             = document.getElementById("statA");
const statB             = document.getElementById("statB");

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------

let handLandmarker  = null;
let audioCtx        = null;
let reverbNode      = null;
let running         = false;
let lastVideoTime   = -1;
let stream          = null;     // MediaStream activo, para poder apagar la cámara
let rafId           = null;     // id del requestAnimationFrame, para no duplicar loops

// Detección estable de gestos
let gestureBuffer    = [];
const STABLE_FRAMES  = 20;      // frames consecutivos para confirmar un gesto
let currentGesture   = null;    // gesto activo y confirmado
let lastPlayedGesture = null;
let soundCooldown    = 0;       // frames restantes antes de permitir repetir sonido

// Sistema B — hue y saturación suavizados para transición fluida entre gestos
let displayedHue = null;
let displayedSat = 0;

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

// El checkbox cambia de estado al hacer clic: checked = encender, unchecked = apagar
toggle.addEventListener("change", () => {
  if (toggle.checked) start();
  else stop();
});

async function start() {
  // Mientras se pide permiso/carga el modelo, bloqueamos el switch para evitar doble clic
  toggle.disabled = true;

  // AudioContext debe crearse dentro de un handler de usuario.
  // Se crea una sola vez y se reutiliza al reencender.
  if (!audioCtx) {
    audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    reverbNode = buildReverb(audioCtx);
    reverbNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();

  setStatus("Solicitando acceso a la cámara…");
  try {
    await initCamera();
  } catch (err) {
    console.error(err);
    setStatus("No se pudo acceder a la cámara: " + (err?.message ?? "revisa los permisos e intentá de nuevo."));
    // Si falló, el switch vuelve a "apagado" para que refleje la realidad
    toggle.checked  = false;
    toggle.disabled = false;
    return;
  }

  // Ambos sistemas arrancan apenas hay cámara.
  // Si el modelo de MediaPipe demora, el Sistema B sigue funcionando.
  running = true;
  toggle.disabled = false; // ya se puede apagar
  rafId = requestAnimationFrame(renderLoop);

  // El modelo se descarga una sola vez; al reencender se reutiliza
  if (handLandmarker) {
    setStatus("Listo. Mostrá una seña frente a la cámara.");
    return;
  }

  setStatus("Cámara activa. Cargando modelo de manos…");
  try {
    await initHands();
    setStatus("Listo. Mostrá una seña frente a la cámara.");
  } catch (err) {
    console.error(err);
    setStatus("Sistema B activo. El Sistema A no pudo cargar el modelo (verificá tu conexión).");
    idleHintA.textContent = "modelo no disponible";
  }
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  // Soltar la cámara de verdad (si no, la luz del navegador queda prendida)
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;

  // Reiniciar estado de detección para que al reencender no quede un gesto "fantasma"
  gestureBuffer     = [];
  currentGesture    = null;
  lastPlayedGesture = null;
  soundCooldown     = 0;
  lastVideoTime     = -1;
  displayedHue      = null;
  displayedSat      = 0;

  // Limpiar los canvas y volver a los textos iniciales
  [ctxA, ctxB].forEach((ctx) => ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height));
  idleHintA.style.opacity = "1";
  idleHintB.style.opacity = "1";
  statA.textContent = "sin datos";
  statB.textContent = "sin datos";
  setStatus("La cámara aún no está activa.");
}

function setStatus(text) {
  statusMsg.textContent = text;
}

async function initCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;

  // Esperamos a tener metadata (videoWidth/Height) antes de reproducir,
  // porque los canvas se dimensionan con esas medidas
  await new Promise((resolve) => {
    if (video.readyState >= 1) return resolve();
    video.onloadedmetadata = () => resolve();
  });
  await video.play();

  const w = video.videoWidth  || 640;
  const h = video.videoHeight || 480;
  canvasA.width  = w;  canvasA.height  = h;
  canvasB.width  = w;  canvasB.height  = h;
  offCanvas.width = DOT_COLS;  offCanvas.height = DOT_ROWS;
}

async function initHands() {
  const { HandLandmarker, FilesetResolver } = await import(VISION_BUNDLE_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

  const baseOpts = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
  };

  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, baseOpts);
  } catch {
    // GPU delegate no disponible en algunos navegadores: reintentamos con CPU
    console.warn("GPU delegate falló, reintentando con CPU…");
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      ...baseOpts,
      baseOptions: { ...baseOpts.baseOptions, delegate: "CPU" },
    });
  }
}

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

function renderLoop(tsMs) {
  if (!running) return;

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const result    = handLandmarker?.detectForVideo(video, tsMs) ?? null;
    const landmarks = result?.landmarks?.[0] ?? null;
    const rawGesture = landmarks ? classifyGesture(landmarks) : null;

    // Acumular en buffer de estabilidad
    const stableGesture = updateGestureStability(rawGesture);

    if (stableGesture && stableGesture !== currentGesture) {
      currentGesture = stableGesture;
      if (soundCooldown <= 0 || stableGesture !== lastPlayedGesture) {
        playGestureSound(stableGesture);
        lastPlayedGesture = stableGesture;
        soundCooldown = 60; // ~2 s a ~30 fps antes de repetir la misma seña
      }
    }

    if (!landmarks) currentGesture = null;
    if (soundCooldown > 0) soundCooldown--;

    drawSystemA(landmarks, rawGesture, tsMs / 1000);
    drawSystemB();
  }

  rafId = requestAnimationFrame(renderLoop);
}

// ---------------------------------------------------------------------------
// CLASIFICACIÓN DE GESTOS
// ---------------------------------------------------------------------------

/**
 * Un dedo está extendido si su punta está claramente por encima del PIP
 * (en coordenadas imagen: y menor = más arriba).
 */
function isFingerExtended(lm, mcp, pip, dip, tip) {
  return lm[tip].y < lm[pip].y - 0.025;
}

/**
 * El pulgar es un caso especial: se mueve lateralmente.
 * Está extendido si la punta (4) está lejos del MCP del índice (5).
 */
function isThumbExtended(lm) {
  const d    = Math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y);
  const hand = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  return d > hand * 0.45;
}

function classifyGesture(lm) {
  const thumb  = isThumbExtended(lm);
  const index  = isFingerExtended(lm, 5,  6,  7,  8);
  const middle = isFingerExtended(lm, 9,  10, 11, 12);
  const ring   = isFingerExtended(lm, 13, 14, 15, 16);
  const pinky  = isFingerExtended(lm, 17, 18, 19, 20);

  // Pellizco: punta pulgar (4) muy cerca de punta índice (8)
  const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
  const handSize  = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  if (pinchDist < handSize * 0.28 && !middle && !ring && !pinky) return "pinch";

  // Palma abierta: todos los dedos extendidos
  if (thumb && index && middle && ring && pinky) return "open";

  // Puño: ningún dedo extendido
  if (!index && !middle && !ring && !pinky) return "fist";

  // V / paz: índice y medio extendidos; anular y meñique cerrados
  if (index && middle && !ring && !pinky) return "v";

  // Índice apuntando: solo índice extendido
  if (index && !middle && !ring && !pinky) return "point";

  // Pulgar arriba: pulgar extendido, resto cerrado
  if (thumb && !index && !middle && !ring && !pinky) return "thumbsup";

  return null; // gesto no clasificado
}

/**
 * Acumula frames en el buffer y devuelve el gesto solo cuando
 * STABLE_FRAMES consecutivos coinciden. Evita destellos.
 */
function updateGestureStability(gesture) {
  gestureBuffer.push(gesture);
  if (gestureBuffer.length > STABLE_FRAMES) gestureBuffer.shift();

  if (
    gestureBuffer.length === STABLE_FRAMES &&
    gesture !== null &&
    gestureBuffer.every((g) => g === gesture)
  ) {
    return gesture;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SISTEMA A — Seña → Sonido (MediaPipe Hands)
// ---------------------------------------------------------------------------

function drawSystemA(landmarks, rawGesture, t) {
  const w = canvasA.width;
  const h = canvasA.height;

  ctxA.fillStyle = "#07060c";
  ctxA.fillRect(0, 0, w, h);

  if (!landmarks) {
    idleHintA.style.opacity = "1";
    statA.textContent = "sin mano detectada";
    drawIdlePulse(ctxA, w, h, t, "#a78bfa");
    return;
  }

  idleHintA.style.opacity = "0";

  const info      = currentGesture ? GESTURES[currentGesture] : null;
  const baseColor = info?.color ?? "#f1ecf7";

  // Estado textual
  statA.textContent = info
    ? `"${info.word}" — ${currentGesture}`
    : rawGesture
      ? `detectando: ${rawGesture}…`
      : "gesto no clasificado";

  // Halo radial suave centrado en la palma (nodo 9)
  const palm = landmarks[9];
  if (palm && info) {
    const pulse = 0.8 + 0.2 * Math.sin(t * 2.4);
    const gx = palm.x * w, gy = palm.y * h;
    const grad = ctxA.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.32 * pulse);
    grad.addColorStop(0, hexAlpha(baseColor, 0.20));
    grad.addColorStop(1, hexAlpha(baseColor, 0));
    ctxA.fillStyle = grad;
    ctxA.fillRect(0, 0, w, h);
  }

  // Conexiones con curvas orgánicas (leve oscilación para sensación de tejido vivo)
  HAND_CONNECTIONS.forEach(([ia, ib], idx) => {
    const a = landmarks[ia], b = landmarks[ib];
    if (!a || !b) return;

    const ax = a.x * w, ay = a.y * h;
    const bx = b.x * w, by = b.y * h;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const wobble = Math.sin(t * 1.9 + idx * 0.6) * Math.min(5, len * 0.09);

    const strokeColor = info ? baseColor : (FINGER_COLORS[getFingerIndex(ia)] ?? "#f1ecf7");

    ctxA.strokeStyle = strokeColor;
    ctxA.globalAlpha = 0.78;
    ctxA.lineWidth   = 2;
    ctxA.lineCap     = "round";
    ctxA.shadowColor = strokeColor;
    ctxA.shadowBlur  = 10;
    ctxA.beginPath();
    ctxA.moveTo(ax, ay);
    ctxA.quadraticCurveTo(mx + nx * wobble, my + ny * wobble, bx, by);
    ctxA.stroke();
  });

  ctxA.globalAlpha = 1;
  ctxA.shadowBlur  = 0;

  // Nodos: puntos brillantes en cada landmark
  landmarks.forEach((p, i) => {
    const nodeColor = info ? baseColor : (FINGER_COLORS[getFingerIndex(i)] ?? "#f1ecf7");
    // Nodos de articulación principales un poco más grandes
    const r = [0, 5, 9, 13, 17].includes(i) ? 5 : 3;

    ctxA.beginPath();
    ctxA.fillStyle   = nodeColor;
    ctxA.shadowColor = nodeColor;
    ctxA.shadowBlur  = 14;
    ctxA.globalAlpha = 0.92;
    ctxA.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    ctxA.fill();
  });

  ctxA.globalAlpha = 1;
  ctxA.shadowBlur  = 0;

  // Palabra superpuesta en el canvas cuando hay gesto estable
  if (info) {
    ctxA.font        = `bold ${Math.round(w * 0.068)}px "Helvetica Neue", Arial, sans-serif`;
    ctxA.textAlign   = "center";
    ctxA.fillStyle   = baseColor;
    ctxA.shadowColor = baseColor;
    ctxA.shadowBlur  = 28;
    ctxA.globalAlpha = 0.92;
    ctxA.fillText(info.word, w / 2, h * 0.11);
    ctxA.shadowBlur  = 0;
    ctxA.globalAlpha = 1;
  }
}

/** Devuelve el índice de dedo (0-4) dado el índice de landmark. */
function getFingerIndex(i) {
  if (i <= 4)  return 0; // pulgar
  if (i <= 8)  return 1; // índice
  if (i <= 12) return 2; // medio
  if (i <= 16) return 3; // anular
  return 4;              // meñique
}

/** Anillos pulsantes cuando no hay mano en cuadro. */
function drawIdlePulse(ctx, w, h, t, color) {
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < 3; i++) {
    const phase = t * 0.85 + i * 0.8;
    const r     = 15 + ((phase * 38) % 125);
    const alpha = clamp(1 - r / 140, 0, 0.45);
    ctx.beginPath();
    ctx.strokeStyle = hexAlpha(color, alpha);
    ctx.lineWidth   = 1.5;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// SISTEMA B — Palabra → Color (campo semántico)
//
// La escena se muestrea en baja resolución (DOT_COLS × DOT_ROWS celdas).
// Cada celda se dibuja como un círculo cuyo tamaño depende de la luminancia
// y cuyo color depende de la intención semántica del gesto activo.
// Sin gesto: imagen desaturada. Con gesto: campo de color vibrante.
// ---------------------------------------------------------------------------

function drawSystemB() {
  const w = canvasB.width;
  const h = canvasB.height;

  // Muestrear video en la resolución de la grilla
  offCtx.drawImage(video, 0, 0, DOT_COLS, DOT_ROWS);
  const frame = offCtx.getImageData(0, 0, DOT_COLS, DOT_ROWS).data;

  ctxB.fillStyle = "#050409";
  ctxB.fillRect(0, 0, w, h);

  const info      = currentGesture ? GESTURES[currentGesture] : null;
  const targetHue = info?.hue ?? null;
  const targetSat = info ? 78 : 0;

  // Interpolación suave de hue y saturación para transiciones fluidas
  if (targetHue !== null) {
    displayedHue = displayedHue === null ? targetHue : lerpAngle(displayedHue, targetHue, 0.07);
    displayedSat = lerp(displayedSat, targetSat, 0.07);
  } else {
    displayedSat = lerp(displayedSat, 0, 0.04);
  }

  const cellW  = w / DOT_COLS;
  const cellH  = h / DOT_ROWS;
  const maxR   = Math.min(cellW, cellH) * 0.52;

  for (let row = 0; row < DOT_ROWS; row++) {
    for (let col = 0; col < DOT_COLS; col++) {
      const pi   = (row * DOT_COLS + col) * 4;
      const r    = frame[pi], g = frame[pi + 1], b = frame[pi + 2];
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

      const dotR = luma * maxR;
      if (dotR < 0.5) continue;

      const cx_ = (col + 0.5) * cellW;
      const cy_ = (row + 0.5) * cellH;

      const hue   = Math.round(displayedHue ?? 260);
      const sat   = Math.round(displayedSat);
      const light = Math.round(12 + luma * 68);

      ctxB.beginPath();
      ctxB.fillStyle  = `hsl(${hue}, ${sat}%, ${light}%)`;
      ctxB.shadowBlur = luma > 0.72 ? 8 : 0;
      ctxB.shadowColor = `hsl(${hue}, ${sat}%, ${Math.min(100, light + 22)}%)`;
      ctxB.arc(cx_, cy_, dotR, 0, Math.PI * 2);
      ctxB.fill();
    }
  }

  ctxB.shadowBlur = 0;

  // Idle hint y estado textual
  if (info) {
    idleHintB.style.opacity = "0";
    statB.textContent = `"${info.word}" → intención: ${info.intention}`;
  } else {
    idleHintB.style.opacity = displayedSat < 5 ? "1" : "0";
    statB.textContent = "esperando seña…";
  }
}

// ---------------------------------------------------------------------------
// AUDIO — Web Audio API (síntesis en código, sin samples externos)
// ---------------------------------------------------------------------------

/**
 * Construye un nodo de reverb simple por convolución con ruido exponencial.
 * Se conecta al destination y recibe las señales wet de cada sonido.
 */
function buildReverb(ctx) {
  const conv   = ctx.createConvolver();
  const length = Math.floor(ctx.sampleRate * 1.8);
  const buf    = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
    }
  }
  conv.buffer = buf;
  return conv;
}

/**
 * Reproduce un oscilador con envolvente AHDSR y mezcla dry/wet.
 * @param {string}  type     - tipo de oscilador: sine, square, triangle, sawtooth
 * @param {number}  freq     - frecuencia en Hz
 * @param {number}  vol      - volumen pico (0-1)
 * @param {number}  attack   - tiempo de ataque (s)
 * @param {number}  hold     - tiempo de sustain (s)
 * @param {number}  release  - tiempo de caída (s)
 * @param {number}  [startOffset=0] - retraso antes de iniciar (s), para arpegios
 */
function playNote(type, freq, vol, attack, hold, release, startOffset = 0) {
  const now = audioCtx.currentTime + startOffset;

  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  const dryGain = audioCtx.createGain();
  const wetGain = audioCtx.createGain();
  dryGain.gain.setValueAtTime(0, now);
  wetGain.gain.setValueAtTime(0, now);

  osc.connect(dryGain);  dryGain.connect(audioCtx.destination);
  osc.connect(wetGain);  wetGain.connect(reverbNode);

  const end = now + attack + hold + release;

  dryGain.gain.linearRampToValueAtTime(vol * 0.70, now + attack);
  dryGain.gain.setValueAtTime(vol * 0.70,          now + attack + hold);
  dryGain.gain.linearRampToValueAtTime(0,           end);

  wetGain.gain.linearRampToValueAtTime(vol * 0.32, now + attack);
  wetGain.gain.setValueAtTime(vol * 0.32,          now + attack + hold);
  wetGain.gain.linearRampToValueAtTime(0,          end);

  osc.start(now);
  osc.stop(end + 0.05);
}

function playGestureSound(gesture) {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume();

  switch (gesture) {
    case "open":     playApertura();   break;
    case "fist":     playTension();    break;
    case "v":        playDualidad();   break;
    case "point":    playNombrar();    break;
    case "thumbsup": playAfirmacion(); break;
    case "pinch":    playRetener();    break;
  }
}

// 1. APERTURA — sinusoide suave en C4 (261 Hz), larga y abierta
function playApertura() {
  playNote("sine", 261.63, 0.28, 0.30, 0.85, 0.85);
}

// 2. TENSIÓN — pulso cuadrado grave en A2 (110 Hz), percusivo y corto
function playTension() {
  playNote("square", 110, 0.18, 0.01, 0.10, 0.07);
}

// 3. DUALIDAD — dos senos en tercera mayor: C4 + E4 (261 + 329 Hz)
function playDualidad() {
  playNote("sine", 261.63, 0.20, 0.15, 0.55, 0.55);
  playNote("sine", 329.63, 0.20, 0.15, 0.55, 0.55);
}

// 4. NOMBRAR — ping agudo en G5 (783 Hz), triángulo, muy breve y preciso
function playNombrar() {
  playNote("triangle", 783.99, 0.22, 0.005, 0.04, 0.38);
}

// 5. AFIRMACIÓN — arpeggio ascendente C4→E4→G4, notas escalonadas
function playAfirmacion() {
  const notas = [261.63, 329.63, 392.00];
  notas.forEach((freq, i) => playNote("sine", freq, 0.22, 0.07, 0.38, 0.45, i * 0.09));
}

// 6. RETENER — vibrato: A4 (440 Hz) modulada por LFO a 5 Hz
function playRetener() {
  const now    = audioCtx.currentTime;
  const osc    = audioCtx.createOscillator();
  const lfo    = audioCtx.createOscillator();
  const lfoAmt = audioCtx.createGain();
  const envGain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(440, now);
  lfo.frequency.setValueAtTime(5, now);
  lfoAmt.gain.setValueAtTime(13, now); // profundidad del vibrato (Hz)

  lfo.connect(lfoAmt);
  lfoAmt.connect(osc.frequency);
  osc.connect(envGain);
  envGain.connect(audioCtx.destination);
  envGain.connect(reverbNode);

  envGain.gain.setValueAtTime(0, now);
  envGain.gain.linearRampToValueAtTime(0.24, now + 0.18);
  envGain.gain.setValueAtTime(0.24,          now + 0.65);
  envGain.gain.linearRampToValueAtTime(0,    now + 1.05);

  lfo.start(now);  osc.start(now);
  lfo.stop(now + 1.1); osc.stop(now + 1.1);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t)      { return a + (b - a) * t; }

/** Interpola entre dos ángulos (hues 0-360) por el camino más corto. */
function lerpAngle(a, b, t) {
  let diff = b - a;
  if (diff >  180) diff -= 360;
  if (diff < -180) diff += 360;
  return a + diff * t;
}

/** Convierte un color hex a rgba con alpha dado. */
function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}