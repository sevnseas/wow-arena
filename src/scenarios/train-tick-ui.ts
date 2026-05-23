/**
 * Browser UI for the in-browser tick-speed REINFORCE trainer. Hosts the
 * 2D env4 viz on the left and live metrics/charts on the right. Bridges
 * train-tick.ts (pure training) to DOM events.
 */
import { startTickTrainer, ACTION_NAMES, actionToUnitVec, isMovementAction, STAGES, AGENT } from './train-tick';
import { serializePolicy4 } from '../rl/policy4';
import type { Entity } from '../rl/types';

const params = new URLSearchParams(location.search);
const agentName = (params.get('a') ?? 'wolf') as keyof typeof AGENT;
for (const a of document.querySelectorAll('#picker a')) {
  if ((a as HTMLAnchorElement).dataset.a === agentName) a.classList.add('active');
}

// ---- Env canvas (2D top-down) ----
const canvas = document.getElementById('env-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
function fitCanvas() {
  const wrap = canvas.parentElement!;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

function renderEnv(state: { agent: Entity | null; enemies: Entity[]; bounds: number; chosenAction: number | null }) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#141622';
  ctx.fillRect(0, 0, W, H);

  // Auto-scale so the pen always fills ~70% of the smaller canvas dim.
  // Bounds is the half-width of the square arena → render side = 2*bounds.
  const margin = 30;
  const sidePx = Math.min(W, H) - margin * 2;
  const scale = sidePx / (state.bounds * 2);
  const cx = W / 2, cy = H / 2;
  const toPx = (x: number, z: number) => [cx + x * scale, cy - z * scale];

  // Pen
  ctx.strokeStyle = '#ffaa55';
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - state.bounds * scale, cy - state.bounds * scale, state.bounds * scale * 2, state.bounds * scale * 2);
  // Grid (1m squares — visible only when pen is small enough).
  ctx.strokeStyle = '#1a2230';
  ctx.lineWidth = 1;
  for (let g = -Math.ceil(state.bounds); g <= Math.ceil(state.bounds); g++) {
    const [x1, y1] = toPx(g, -state.bounds);
    const [x2, y2] = toPx(g, state.bounds);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const [xa, ya] = toPx(-state.bounds, g);
    const [xb, yb] = toPx(state.bounds, g);
    ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
  }

  // Enemies
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const [px, py] = toPx(e.x, e.z);
    ctx.fillStyle = '#ff6666';
    ctx.beginPath();
    ctx.arc(px, py, Math.max(4, e.size * scale), 0, Math.PI * 2);
    ctx.fill();
    // HP bar above
    const w = 30, h = 4;
    ctx.fillStyle = '#2a0808';
    ctx.fillRect(px - w / 2, py - 20, w, h);
    ctx.fillStyle = '#d04040';
    ctx.fillRect(px - w / 2, py - 20, w * (e.hp / e.maxHp), h);
  }

  // Agent
  if (state.agent && state.agent.alive) {
    const [px, py] = toPx(state.agent.x, state.agent.z);
    ctx.fillStyle = '#9af0c0';
    ctx.beginPath();
    ctx.arc(px, py, Math.max(5, state.agent.size * scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    // Action arrow
    if (state.chosenAction !== null) {
      if (isMovementAction(state.chosenAction)) {
        const v = actionToUnitVec(state.chosenAction);
        ctx.strokeStyle = '#66e0ff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + v.x * 40, py - v.z * 40);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = '#ffcc44';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 16 + (Date.now() / 80 % 8), 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }
}

// ---- Charts ----
const plotCanvas = document.getElementById('plot') as HTMLCanvasElement;
const plotCtx = plotCanvas.getContext('2d')!;
const recentMA: number[] = [];
function drawPlot() {
  const W = plotCanvas.width, H = plotCanvas.height;
  plotCtx.fillStyle = '#0a0d18';
  plotCtx.fillRect(0, 0, W, H);
  if (recentMA.length < 2) return;
  const min = Math.min(...recentMA), max = Math.max(...recentMA);
  const span = (max - min) || 1;
  plotCtx.strokeStyle = '#9af0c0';
  plotCtx.lineWidth = 1.5;
  plotCtx.beginPath();
  for (let i = 0; i < recentMA.length; i++) {
    const x = (i / Math.max(1, recentMA.length - 1)) * (W - 4) + 2;
    const y = H - 4 - ((recentMA[i] - min) / span) * (H - 8);
    if (i === 0) plotCtx.moveTo(x, y); else plotCtx.lineTo(x, y);
  }
  plotCtx.stroke();
  // Min/max labels.
  plotCtx.fillStyle = '#888';
  plotCtx.font = '10px monospace';
  plotCtx.fillText(max.toFixed(1), 4, 10);
  plotCtx.fillText(min.toFixed(1), 4, H - 4);
}

// ---- Stage list ----
const stageList = document.getElementById('stage-list')!;
function renderStages(activeIdx: number, killRates: Map<string, number>, stageEp: number) {
  stageList.innerHTML = '';
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const isActive = i === activeIdx;
    const isPast = i < activeIdx;
    const kr = killRates.get(s.label);
    const row = document.createElement('div');
    row.className = 'stage-row' + (isActive ? ' active' : '');
    const pct = isPast && kr !== undefined ? (kr * 100).toFixed(0) + '%' :
                isActive ? `${stageEp}/${s.episodes}` : '—';
    const fillPct = isPast && kr !== undefined ? kr * 100 :
                    isActive ? (stageEp / s.episodes) * 100 : 0;
    row.innerHTML = `
      <span class="name">${s.label}</span>
      <span class="bar"><span class="fill" style="width:${fillPct}%"></span></span>
      <span class="pct">${pct}</span>
    `;
    stageList.appendChild(row);
  }
}

// ---- Log ----
const log = document.getElementById('log')!;
function logLine(msg: string) {
  const line = document.createElement('div');
  line.textContent = msg;
  log.appendChild(line);
  while (log.childElementCount > 9) log.removeChild(log.firstChild!);
}

// ---- Metrics ----
const $ = (id: string) => document.getElementById(id)!;
let currentStageIdx = 0;
let currentStageEp = 0;
const killRates = new Map<string, number>();
let lastEpochTime = performance.now();
let epochCount = 0;
let epsPerSec = 0;

const handle = startTickTrainer({
  onRender(state) {
    renderEnv(state);
    const stage = STAGES[currentStageIdx];
    $('env-label').textContent = `tick env4 · agent=${agentName} · stage=${stage.label} (bounds≤${stage.maxBounds}m)`;
  },
  onEpisode(ep, ret, ma50, stageLabel, stageEp) {
    const idx = STAGES.findIndex(s => s.label === stageLabel);
    if (idx !== currentStageIdx || stageEp === 0) {
      currentStageIdx = idx;
      recentMA.length = 0;
    }
    currentStageEp = stageEp;
    recentMA.push(ma50);
    if (recentMA.length > 400) recentMA.shift();
    $('m-ep').textContent = String(ep);
    $('m-stage-ep').textContent = `${stageEp} / ${STAGES[idx].episodes}`;
    $('m-ret').textContent = ret.toFixed(2);
    $('m-ma').textContent = ma50.toFixed(2);
    epochCount++;
    const now = performance.now();
    if (now - lastEpochTime > 500) {
      epsPerSec = (epochCount * 1000) / (now - lastEpochTime);
      lastEpochTime = now;
      epochCount = 0;
      $('m-eps').textContent = epsPerSec.toFixed(1);
    }
    drawPlot();
    renderStages(currentStageIdx, killRates, currentStageEp);
  },
  onStageDone(stageLabel, killRate) {
    killRates.set(stageLabel, killRate);
    renderStages(currentStageIdx, killRates, currentStageEp);
  },
  onLog(msg) {
    logLine(msg);
  },
}, agentName);

// Throttle the latest-action label off the rendered state. We sniff it via
// a small hook on render() — simpler than threading another callback.
let lastActionShown = -1;
const origRenderEnv = renderEnv;
function patchedRender(s: Parameters<typeof origRenderEnv>[0]) {
  origRenderEnv(s);
  if (s.chosenAction !== null && s.chosenAction !== lastActionShown) {
    lastActionShown = s.chosenAction;
    $('m-act').textContent = ACTION_NAMES[s.chosenAction] ?? '?';
  }
}
(renderEnv as any) = patchedRender; // best-effort, harmless if it doesn't re-bind

// ---- Controls ----
$('btn-pause').addEventListener('click', () => {
  const btn = $('btn-pause');
  const paused = btn.classList.toggle('active');
  handle.setPaused(paused);
  btn.textContent = paused ? '▶ resume' : '⏸ pause';
});
function setSpeed(n: number, el: string) {
  handle.setEpsPerFrame(n);
  for (const id of ['btn-1x', 'btn-5x', 'btn-20x']) $(id).classList.remove('active');
  $(el).classList.add('active');
}
$('btn-1x').addEventListener('click', () => setSpeed(1, 'btn-1x'));
$('btn-5x').addEventListener('click', () => setSpeed(5, 'btn-5x'));
$('btn-20x').addEventListener('click', () => setSpeed(20, 'btn-20x'));
setSpeed(5, 'btn-5x');
$('btn-reset').addEventListener('click', () => { handle.stop(); location.reload(); });
$('btn-export').addEventListener('click', () => {
  const json = serializePolicy4(handle.policy);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${agentName}.json`;
  a.click();
  logLine(`exported ${agentName}.json (${(json.length / 1024).toFixed(1)} KB)`);
});

renderStages(0, killRates, 0);
logLine(`tick trainer started · agent=${agentName} · 5× ep/frame`);
