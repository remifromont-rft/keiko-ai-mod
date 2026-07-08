/**
 * serve — Local graph viewer that polls analysis/data/graph.db and renders a live D3 force graph.
 */
import { existsSync } from "fs";
import { openDb, getGraph, getStats } from "./db.ts";
import type { ProjectConfig } from "./resolve.ts";

const D3_CDN = "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js";

function graphJson(project: ProjectConfig): string {
  if (!existsSync(project.dbPath)) return JSON.stringify({ nodes: {} });
  if (!_db) _db = openDb(project.dbPath);
  const graph = getGraph(_db);
  const stats = getStats(_db);
  return JSON.stringify({ ...graph, stats });
}

let _db: ReturnType<typeof openDb> | null = null;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tracer — live graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fafafa; color: #333; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; overflow: hidden; }
  #graph { width: 100vw; height: 100vh; }
  #tooltip {
    display: none; position: fixed; z-index: 20;
    padding: 5px 10px; font-size: 11px; border-radius: 4px;
    border: 1px solid rgba(0,0,0,0.1); background: #fff; color: #333;
    pointer-events: none; white-space: nowrap;
  }
  #stats {
    position: absolute; top: 12px; right: 12px; z-index: 10;
    min-width: 160px; padding: 12px; border-radius: 6px;
    border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.9);
    backdrop-filter: blur(8px); font-size: 12px;
  }
  #stats h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #999; margin-bottom: 8px; }
  .stat { display: flex; justify-content: space-between; padding: 2px 0; }
  .stat-label { color: #888; }
  .stat-value { font-variant-numeric: tabular-nums; color: #333; }
  .divider { border-top: 1px solid rgba(0,0,0,0.08); margin: 4px 0; }
  #legend {
    position: absolute; bottom: 12px; left: 12px; z-index: 10;
    display: flex; gap: 14px; font-size: 11px; color: #666; align-items: center;
  }
  .legend-item { display: flex; align-items: center; gap: 5px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .legend-sep { width: 1px; height: 16px; background: rgba(0,0,0,0.15); margin: 0 4px; }
  #controls {
    position: absolute; top: 44px; left: 12px; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 6px;
    border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.9);
    backdrop-filter: blur(8px); font-size: 12px; color: #555;
  }
  #filter-input {
    width: 220px; padding: 6px 8px; font-size: 12px;
    border: 1px solid rgba(0,0,0,0.15); border-radius: 4px; outline: none;
  }
  #controls label { display: flex; align-items: center; gap: 6px; user-select: none; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="graph"></div>
<div id="tooltip"></div>
<div id="stats"></div>
<div id="legend">
  <span class="legend-item"><span class="legend-dot" style="background:#9595b8"></span>pending</span>
  <span class="legend-item"><span class="legend-dot" style="background:#e0c040"></span>exploring</span>
  <span class="legend-item"><span class="legend-dot" style="background:#40e080"></span>analyzed</span>
</div>
<div id="controls">
  <input id="filter-input" type="text" placeholder="Filter nodes… (id or label)" />
  <label><input type="checkbox" id="toggle-children" /> Show full dependency tree</label>
  <span id="filter-count" style="margin-left:6px; color:#888; font-size:11px;"></span>
  </div>

<script src="${D3_CDN}"></script>
<script>
const STATUS_FILL = { pending: "#9595b8", exploring: "#e0c040", analyzed: "#40e080" };
const BASE_RADIUS = { page: 8, endpoint: 8, command: 8, listener: 8, database: 8, subprocess: 7, func: 5, table: 7 };

function nodeType(id) { return id.split(":")[0]; }
function nodeRadius(id, loc) {
  const base = BASE_RADIUS[nodeType(id)] || 5;
  if (!loc) return base;
  return Math.min(base + Math.sqrt(loc) * 0.8, 24);
}
function labelText(id) {
  const t = nodeType(id), rest = id.slice(t.length + 1);
  if (t === "endpoint") return rest.replace(":", " ");
  if (["page", "command", "listener", "database"].includes(t)) return rest;
  if (t === "subprocess") { const p = rest.split(":"); const sub = p.pop(); return p[0] + " ../" + p.slice(1).join(":").split("/").pop() + " [" + sub + "]"; }
  if (t === "table") return rest;
  const p = rest.split(":"); return p[p.length - 1] || p[p.length - 2] || rest;
}

const container = document.getElementById("graph");
const tip = document.getElementById("tooltip");
const statsEl = document.getElementById("stats");
const controlsEl = document.getElementById("controls");
const filterInput = document.getElementById("filter-input");
const toggleChildren = document.getElementById("toggle-children");
const filterCount = document.getElementById("filter-count");

const svg = d3.select(container).append("svg").style("display","block").style("width","100%").style("height","100%");
const g = svg.append("g");

svg.call(d3.zoom().scaleExtent([0.1, 8]).on("zoom", e => g.attr("transform", e.transform)));
svg.append("defs").append("marker")
  .attr("id","arrow").attr("viewBox","0 0 10 10").attr("refX",20).attr("refY",5)
  .attr("markerWidth",6).attr("markerHeight",6).attr("orient","auto-start-reverse")
  .append("path").attr("d","M 0 0 L 10 5 L 0 10 z").attr("fill","#ccc");

const linkG = g.append("g"), nodeG = g.append("g"), spinnerG = g.append("g"), labelG = g.append("g");

const state = { nodesById: new Map(), edgeSet: new Set(), nodes: [], edges: [], simulation: null };

const filter = { q: "", children: false };

function debounce(fn, wait) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function buildAdjacency() {
  const adj = new Map();
  for (const e of state.edges) {
    const sid = e.source.id, tid = e.target.id;
    let arr = adj.get(sid);
    if (!arr) { arr = []; adj.set(sid, arr); }
    arr.push(tid);
  }
  return adj;
}

function expandDescendants(seedIds, adj) {
  const seen = new Set(seedIds);
  const stack = [...seedIds];
  while (stack.length) {
    const id = stack.pop();
    const outs = adj.get(id) || [];
    for (const to of outs) {
      if (!seen.has(to)) { seen.add(to); stack.push(to); }
    }
  }
  return seen;
}

function applyFilter() {
  const q = (filter.q || "").trim().toLowerCase();
  let visible = null;

  if (q) {
    const seeds = [];
    for (const n of state.nodes) {
      const idMatch = n.id.toLowerCase().includes(q);
      const labelMatch = labelText(n.id).toLowerCase().includes(q);
      if (idMatch || labelMatch) seeds.push(n.id);
    }
    if (filter.children && seeds.length) {
      const adj = buildAdjacency();
      visible = expandDescendants(seeds, adj);
    } else {
      visible = new Set(seeds);
    }
  }

  const showNode = d => !visible || visible.has(d.id);
  const showLink = d => !visible || (visible.has(d.source.id) && visible.has(d.target.id));

  nodeG.selectAll("circle").attr("display", d => showNode(d) ? null : "none");
  labelG.selectAll("text").attr("display", d => showNode(d) ? null : "none");
  spinnerG.selectAll("circle").attr("display", d => showNode(d) ? null : "none");
  linkG.selectAll("line").attr("display", d => showLink(d) ? null : "none");

  if (!visible) {
    filterCount.textContent = "";
  } else {
    filterCount.textContent = visible.size + " shown";
  }
}

if (filterInput) {
  filterInput.addEventListener("input", debounce(e => {
    filter.q = e.target.value;
    applyFilter();
  }, 150));
}
if (toggleChildren) {
  toggleChildren.addEventListener("change", () => {
    filter.children = toggleChildren.checked;
    applyFilter();
  });
}

function tick() {
  linkG.selectAll("line").attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
  nodeG.selectAll("circle").attr("cx",d=>d.x).attr("cy",d=>d.y);
  spinnerG.selectAll("circle").attr("cx",d=>d.x).attr("cy",d=>d.y).style("transform-origin",d=>d.x+"px "+d.y+"px");
  labelG.selectAll("text").attr("x",d=>d.x+10).attr("y",d=>d.y+3);
}

function renderStats(data) {
  if (!data.stats) return;
  const s = data.stats;
  let h = '<h3>Graph</h3>';
  h += stat("Nodes", s.nodeCount);
  h += stat("Edges", s.edgeCount);
  h += '<div class="divider"></div>';
  for (const [k,v] of Object.entries(s.exploration).sort()) h += stat(k, v, k==="analyzed"?"#4ce7a2":k==="exploring"?"#f0c040":null);
  if (Object.keys(s.verification).length) {
    h += '<div class="divider"></div>';
    for (const [k,v] of Object.entries(s.verification).sort()) h += stat(k, v);
  }
  if (s.cfp) {
    h += '<div class="divider"></div>';
    h += '<h3>COSMIC CFP</h3>';
    h += stat("Total", s.cfp.total, "#e080e0");
    h += stat("E", s.cfp.E);
    h += stat("R", s.cfp.R);
    h += stat("W", s.cfp.W);
    h += stat("X", s.cfp.X);
  }
  statsEl.innerHTML = h;
}
function stat(label, value, color) {
  const style = color ? ' style="color:'+color+'"' : '';
  return '<div class="stat"><span class="stat-label"'+style+'>'+label+'</span><span class="stat-value">'+value+'</span></div>';
}

function update(data) {
  const allNodes = data.nodes || {};
  if (Object.keys(allNodes).length === 0) return;

  const rect = container.getBoundingClientRect();
  const w = rect.width || 800, h = rect.height || 600;
  let newNodesCount = 0, changed = false;

  for (const id in allNodes) {
    const info = allNodes[id];
    const deps = info.deps || [];
    const allIds = [id, ...deps];
    for (const nid of allIds) {
      const m = allNodes[nid] || { loc: null, exploration: "pending", E: 0, R: 0, W: 0, X: 0 };
      if (!state.nodesById.has(nid)) {
        let x = w/2 + (Math.random()-0.5)*50, y = h/2 + (Math.random()-0.5)*50;
        const neighbor = state.nodesById.get(id);
        if (neighbor) { x = neighbor.x + (Math.random()-0.5)*40; y = neighbor.y + (Math.random()-0.5)*40; }
        const node = { id: nid, x, y, loc: m.loc||null, status: m.exploration||"pending",
          cfp: (m.E||0)+(m.R||0)+(m.W||0)+(m.X||0), E: m.E||0, R: m.R||0, W: m.W||0, X: m.X||0 };
        state.nodesById.set(nid, node);
        state.nodes.push(node);
        newNodesCount++; changed = true;
      } else {
        const ex = state.nodesById.get(nid);
        const st = m.exploration || "pending";
        if (ex.status !== st) { ex.status = st; changed = true; }
        const loc = m.loc || null;
        if (loc != null && ex.loc !== loc) { ex.loc = loc; changed = true; }
        const cfp = (m.E||0)+(m.R||0)+(m.W||0)+(m.X||0);
        if (ex.cfp !== cfp) { ex.cfp = cfp; ex.E = m.E||0; ex.R = m.R||0; ex.W = m.W||0; ex.X = m.X||0; changed = true; }
      }
    }
    for (const dst of (info.deps||[])) {
      const key = id + "\\0" + dst;
      if (!state.edgeSet.has(key) && state.nodesById.has(id) && state.nodesById.has(dst)) {
        state.edgeSet.add(key);
        state.edges.push({ source: state.nodesById.get(id), target: state.nodesById.get(dst) });
        changed = true;
      }
    }
  }
  if (!changed && state.simulation) return;

  linkG.selectAll("line").data(state.edges, d=>d.source.id+"\\0"+d.target.id)
    .join(enter => enter.append("line").attr("stroke","#ccc").attr("stroke-width",1).attr("marker-end","url(#arrow)")
      .attr("opacity",0).call(s=>s.transition().duration(400).attr("opacity",1)));

  nodeG.selectAll("circle").data(state.nodes, d=>d.id)
    .join(
      enter => enter.append("circle").attr("r",0)
        .attr("fill", d => STATUS_FILL[d.status]||STATUS_FILL.pending)
        .attr("stroke", d => ["page","endpoint","command","listener","database"].includes(nodeType(d.id)) ? "#e74c6f" : "none")
        .attr("stroke-width", d => ["page","endpoint","command","listener","database"].includes(nodeType(d.id)) ? 3 : 0)
        .style("cursor","grab")
        .on("mouseover", (e,d) => {
          tip.style.display = "block";
          const p = [d.id]; if (d.loc) p.push(d.loc+" LOC");
          if (d.cfp) p.push(["E","R","W","X"].filter(k=>d[k]).map(k=>k+":"+d[k]).join(" "));
          p.push(d.status); tip.textContent = p.join(" — ");
        })
        .on("mousemove", e => { tip.style.left = e.clientX+12+"px"; tip.style.top = e.clientY-12+"px"; })
        .on("mouseout", () => { tip.style.display = "none"; })
        .call(d3.drag()
          .on("start", (e,d) => { if (!e.active) state.simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
          .on("drag", (e,d) => { d.fx=e.x; d.fy=e.y; })
          .on("end", (e,d) => { if (!e.active) state.simulation.alphaTarget(0); d.fx=null; d.fy=null; }))
        .call(s => s.transition().duration(400).attr("r", d => nodeRadius(d.id, d.loc))),
      update => update.transition().duration(400)
        .attr("r", d => nodeRadius(d.id, d.loc))
        .attr("fill", d => STATUS_FILL[d.status]||STATUS_FILL.pending)
    );

  const exploring = state.nodes.filter(d => d.status === "exploring");
  spinnerG.selectAll("circle").data(exploring, d=>d.id)
    .join(
      enter => enter.append("circle").attr("r", d=>nodeRadius(d.id,d.loc)+5)
        .attr("fill","none").attr("stroke","#e0c040").attr("stroke-width",2)
        .attr("stroke-dasharray","6 4").attr("stroke-linecap","round").attr("opacity",0.8)
        .style("transform-origin","0 0").style("animation","spin 2s linear infinite").style("pointer-events","none"),
      update => update.attr("r", d=>nodeRadius(d.id,d.loc)+5),
      exit => exit.remove()
    );

  labelG.selectAll("text").data(state.nodes, d=>d.id)
    .join(enter => enter.append("text").attr("font-size",10).attr("fill","#888")
      .style("pointer-events","none").text(d=>labelText(d.id)).attr("opacity",0)
      .call(s=>s.transition().duration(400).attr("opacity",1)));

  if (!state.simulation) {
    state.simulation = d3.forceSimulation(state.nodes)
      .force("link", d3.forceLink(state.edges).id(d=>d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("x", d3.forceX(w/2).strength(0.02))
      .force("y", d3.forceY(h/2).strength(0.02))
      .force("collision", d3.forceCollide().radius(30))
      .on("tick", tick);
  } else {
    state.simulation.nodes(state.nodes);
    state.simulation.force("link").links(state.edges);
    const alpha = newNodesCount > 0 ? Math.min(0.1 + newNodesCount * 0.02, 0.3) : 0.05;
    state.simulation.alpha(alpha).restart();
  }
  applyFilter();
}

async function poll() {
  try {
    const res = await fetch("/api/graph");
    const data = await res.json();
    update(data);
    renderStats(data);
  } catch (e) {
    console.error("poll error:", e.message);
  }
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;

export function serve(project: ProjectConfig, port: number = 3000): void {
  try {
    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/graph") {
          return new Response(graphJson(project), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        return new Response(HTML, { headers: { "Content-Type": "text/html" } });
      },
    });
    console.log(`graph viewer at http://localhost:${server.port}`);
  } catch {
    console.error(`Failed to start server on port ${port}. Try: bin/tracer serve --port <other-port>`);
    process.exit(1);
  }
}
