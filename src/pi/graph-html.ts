/**
 * graph-html.ts — 把记忆图谱渲染成自包含交互式 HTML。
 *
 * 为什么不用 web 面板:pi 是 TUI/RPC 运行时,没有 dsh 的 webServer 注入点,
 * 因此把 src/client/index.tsx 的 canvas 图谱逻辑(环形布局 / 滚轮缩放 / 拖拽平移与拖节点 /
 * 悬停详情 / 搜索命中脉冲 + BFS 神经传导)平移为无依赖的独立页面,
 * 由 /memory-graph 命令生成到临时目录并用系统浏览器打开。
 *
 * 输出不依赖任何 CDN 或构建产物,单文件可离线打开、可分享。
 */
import type { GraphData } from '../server/graph.js'

/** 类型配色(与 dsh client 保持一致) */
const TYPE_COLORS: Record<string, string> = {
  Fact: '#2f7bff', Preference: '#ffd400', Decision: '#ff2d55', Method: '#00e66e',
  Insight: '#c04dff', Idea: '#ff7a00', Lesson: '#c8d1dd', TechChoice: '#00e5ff', Other: '#9aa7b8',
}

/** JSON 内联进 <script> 时的转义(防 `</script>` 提前闭合) */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (m) => (m === '\u2028' ? '\\u2028' : '\\u2029'))
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/**
 * 生成图谱 HTML。
 * @param g buildGraph() 的输出
 */
export function renderGraphHtml(g: GraphData): string {
  const canvasData = { nodes: g.nodes, edges: g.edges.map((e) => ({ source: e.source, target: e.target })) }

  // 顶部统计(服务端渲染,便于无 JS 时也能读)
  const byType = new Map<string, number>()
  for (const n of g.nodes) byType.set(n.type, (byType.get(n.type) || 0) + 1)
  const typeRows = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<span class="chip"><i style="background:${TYPE_COLORS[t] || TYPE_COLORS.Other}"></i>${escapeHtml(t)} <b>${c}</b></span>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OKF 记忆图谱 · ${g.meta.totalConcepts} 节点</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0d1725; color: #dbe7f3;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
  header { padding: 14px 18px 10px; border-bottom: 1px solid rgba(120,160,200,.14); }
  h1 { margin: 0 0 8px; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
  h1 small { font-weight: 400; color: #7d97b0; margin-left: 8px; font-size: 12px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: #8aa4bd; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
    border-radius: 20px; background: rgba(255,255,255,.05); }
  .chip i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .chip b { color: #dbe7f3; font-weight: 600; }
  .bar { display: flex; gap: 10px; align-items: center; padding: 10px 18px; }
  #q { flex: 1; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(120,160,200,.3);
    background: rgba(20,32,46,.8); color: #dbe7f3; font-size: 13px; outline: none; }
  #q:focus { border-color: rgba(126,195,255,.55); }
  #hint { font-size: 11px; color: #6f8ba5; white-space: nowrap; }
  .stage { position: relative; padding: 0 18px 18px; }
  canvas { width: 100%; height: calc(100vh - 190px); display: block; border-radius: 10px; cursor: crosshair; }
  #tip { position: absolute; top: 10px; right: 30px; max-width: 340px; padding: 10px 13px;
    border-radius: 9px; background: rgba(10,18,28,.97); font-size: 12px; line-height: 1.5;
    box-shadow: 0 8px 26px rgba(0,0,0,.55); display: none; }
  #tip .t { font-weight: 600; font-size: 13px; }
  #tip .ty { font-size: 10px; padding: 1px 7px; border-radius: 8px; margin-left: 6px; color: #fff; }
  #tip .dim { color: #8aa4bd; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>OKF 记忆图谱<small>${escapeHtml(g.meta.root)}</small></h1>
  <div class="meta">
    <span class="chip">节点 <b>${g.nodes.length}</b></span>
    <span class="chip">边 <b>${g.edges.length}</b></span>
    <span class="chip">生成于 <b>${escapeHtml(String(g.meta.generatedAt).slice(0, 19).replace('T', ' '))}</b></span>
    ${typeRows}
  </div>
</header>
<div class="bar">
  <input id="q" placeholder="🔍 命中记忆(搜标题 / 类型 / 标签)…" autocomplete="off">
  <span id="hint">滚轮缩放 · 拖拽平移 · 拖节点 · 悬停详情</span>
</div>
<div class="stage">
  <canvas id="c"></canvas>
  <div id="tip"></div>
</div>
<script>
const GRAPH = ${inlineJson(canvasData)};
const TYPE_COLORS = ${inlineJson(TYPE_COLORS)};

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const tip = document.getElementById('tip');
const qInput = document.getElementById('q');

const view = { zoom: 1, panX: 0, panY: 0 };
let drag = { id: null, offX: 0, offY: 0, panning: false, lastX: 0, lastY: 0 };
let hoverId = null;
let query = '';

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function hexToRgba(hex, a) {
  const c = hex.replace('#', '');
  return 'rgba(' + parseInt(c.slice(0,2),16) + ',' + parseInt(c.slice(2,4),16) + ',' + parseInt(c.slice(4,6),16) + ',' + a + ')';
}

// ── 环形初始布局(与 dsh client 一致;拖拽后不再自动回弹) ──
const maxW = Math.max(...GRAPH.nodes.map(n => n.weight), 1);
const N = GRAPH.nodes.length || 1;
const R = Math.max(120, Math.min(300, 60 + N * 30));
const layout = GRAPH.nodes.map((node, i) => {
  const h = hash(node.id);
  const ang = (i / N) * Math.PI * 2;
  const r = R * (0.6 + ((h % 100) / 100) * 0.5);
  return Object.assign({}, node, {
    x: Math.cos(ang) * r, y: Math.sin(ang) * r,
    r: 8 + Math.sqrt(node.weight / maxW) * 20,
  });
});
const byId = new Map(layout.map(n => [n.id, n]));

function matches(n, q) {
  const t = q.trim().toLowerCase();
  if (!t) return false;
  return (n.title + ' ' + n.type + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(t);
}
// BFS 神经传导:命中节点的关联节点逐级激活
function activateHits(hits) {
  const act = new Set(hits);
  const adj = new Map();
  GRAPH.edges.forEach(e => {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  });
  const queue = [...hits];
  while (queue.length) {
    const cur = queue.shift();
    (adj.get(cur) || []).forEach(nb => { if (!act.has(nb)) { act.add(nb); queue.push(nb); } });
  }
  return act;
}
function hitTest(px, py, cw, ch) {
  const wx = (px - cw / 2 - view.panX) / view.zoom;
  const wy = (py - ch / 2 - view.panY) / view.zoom;
  for (let i = layout.length - 1; i >= 0; i--) {
    const n = layout[i];
    const dx = n.x - wx, dy = n.y - wy;
    if (dx * dx + dy * dy < (n.r + 6) * (n.r + 6)) return n;
  }
  return null;
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 800, H = canvas.clientHeight || 500;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const tx = x => W / 2 + x * view.zoom + view.panX;
  const ty = y => H / 2 + y * view.zoom + view.panY;

  ctx.fillStyle = '#13233a'; ctx.fillRect(0, 0, W, H);

  const hits = new Set();
  if (query.trim()) GRAPH.nodes.forEach(n => { if (matches(n, query)) hits.add(n.id); });
  const active = activateHits(hits);

  // 边
  GRAPH.edges.forEach(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) return;
    const isActive = active.has(e.source) || active.has(e.target);
    ctx.beginPath(); ctx.moveTo(tx(a.x), ty(a.y)); ctx.lineTo(tx(b.x), ty(b.y));
    ctx.strokeStyle = isActive ? 'rgba(126,195,255,.5)' : 'rgba(120,160,200,.18)';
    ctx.lineWidth = 1 / view.zoom; ctx.stroke();
  });

  const t = performance.now() / 700;
  layout.forEach(n => {
    const c = TYPE_COLORS[n.type] || TYPE_COLORS.Other;
    const isHit = hits.has(n.id), isActive = active.has(n.id);
    const rr = n.r * view.zoom;
    const x = tx(n.x), y = ty(n.y);

    // 命中脉冲光环
    if (isHit) {
      const tp = (t + (hash(n.id) % 10) / 10) % 1;
      ctx.beginPath(); ctx.arc(x, y, rr * (1.5 + tp * 1.8), 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(c, 0.8 * (1 - tp)); ctx.lineWidth = 2.5 / view.zoom; ctx.stroke();
    }
    // 激活辉光
    if (isHit || isActive) {
      const rad = rr * (isHit ? 2.9 : 2.1);
      const rg = ctx.createRadialGradient(x, y, rr * 0.2, x, y, rad);
      rg.addColorStop(0, hexToRgba(c, isHit ? 0.8 : 0.45));
      rg.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = rg; ctx.fill();
    }
    // 节点本体
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? (isHit ? '#fff' : c) : '#13233a';
    ctx.globalAlpha = isActive ? 0.95 : 1; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = isHit ? '#fff' : (isActive ? c : '#33506a');
    ctx.lineWidth = (isHit ? 3.2 : 1.2) / view.zoom; ctx.stroke();

    // archived 虚线描边(状态可见)
    if (n.state === 'inactive') {
      ctx.setLineDash([3 / view.zoom, 3 / view.zoom]);
      ctx.beginPath(); ctx.arc(x, y, rr + 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200,209,221,.5)'; ctx.lineWidth = 1 / view.zoom; ctx.stroke();
      ctx.setLineDash([]);
    }

    // 标签
    ctx.fillStyle = isActive ? '#fff' : '#5f7d97';
    ctx.font = (11 * Math.min(1.4, Math.max(0.8, view.zoom))) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(n.title).slice(0, 10), x, y + rr + 12);
    if (isHit) {
      ctx.fillStyle = '#fff';
      ctx.font = '700 ' + (11 * Math.max(0.8, view.zoom)) + 'px sans-serif';
      ctx.fillText('⚡命中', x, y - rr - 9);
    }
  });

  if (query.trim()) {
    document.getElementById('hint').textContent =
      '命中 ' + hits.size + ' · 传导激活 ' + active.size + ' / ' + layout.length;
  } else {
    document.getElementById('hint').textContent = '滚轮缩放 · 拖拽平移 · 拖节点 · 悬停详情';
  }
}

function renderTip(n) {
  if (!n) { tip.style.display = 'none'; return; }
  const c = TYPE_COLORS[n.type] || TYPE_COLORS.Other;
  tip.style.display = 'block';
  tip.style.border = '1px solid ' + c;
  tip.innerHTML =
    '<div><span class="t">' + n.title + '</span>' +
    '<span class="ty" style="background:' + c + '66">' + n.type + '</span></div>' +
    '<div class="dim">权重 ' + n.weight + ' · ' + n.state +
    (n.lastAccessed ? ' · 最近 ' + String(n.lastAccessed).slice(0, 10) : '') + '</div>' +
    (n.description ? '<div class="dim">' + n.description + '</div>' : '') +
    ((n.tags && n.tags.length) ? '<div class="dim">' + n.tags.map(x => '#' + x).join(' ') + '</div>' : '');
}

// ── 交互 ──
qInput.addEventListener('input', e => { query = e.target.value; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  view.zoom = Math.min(4, Math.max(0.3, view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
}, { passive: false });
canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const cw = canvas.clientWidth || rect.width, ch = canvas.clientHeight || rect.height;
  const hit = hitTest(px, py, cw, ch);
  if (hit) drag = { id: hit.id, offX: hit.x - px, offY: hit.y - py, panning: false, lastX: px, lastY: py };
  else drag = { id: null, offX: 0, offY: 0, panning: true, lastX: px, lastY: py };
});
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const cw = canvas.clientWidth || rect.width, ch = canvas.clientHeight || rect.height;
  if (drag.id) {
    const n = byId.get(drag.id);
    if (n) {
      n.x = (px - cw / 2 - view.panX) / view.zoom + drag.offX;
      n.y = (py - ch / 2 - view.panY) / view.zoom + drag.offY;
    }
  } else if (drag.panning) {
    view.panX += px - drag.lastX; view.panY += py - drag.lastY;
    drag.lastX = px; drag.lastY = py;
  }
  const h = hitTest(px, py, cw, ch);
  const id = h ? h.id : null;
  if (id !== hoverId) { hoverId = id; renderTip(h); canvas.style.cursor = h ? 'grab' : 'crosshair'; }
});
window.addEventListener('mouseup', () => { drag = { id: null, offX: 0, offY: 0, panning: false, lastX: 0, lastY: 0 }; });
canvas.addEventListener('mouseleave', () => { hoverId = null; renderTip(null); });
window.addEventListener('resize', () => { view.zoom = 1; view.panX = 0; view.panY = 0; });

(function loop() { draw(); requestAnimationFrame(loop); })();
</script>
</body>
</html>`
}
