/**
 * graph — Read-only graph queries. Works from SQLite db or graph.json fallback.
 */
import { existsSync, readFileSync } from "fs";
import { openDb, getGraph, getStats as dbGetStats, getRemaining as dbGetRemaining, getNodeExploration, type GraphNode } from "./db.ts";
import { formatLabel, cosmicAnnotation, formatCosmic } from "./format.ts";
import type { ProjectConfig } from "./resolve.ts";

type Graph = { nodes: Record<string, GraphNode> };

function loadGraph(project: ProjectConfig): Graph {
  if (existsSync(project.dbPath)) {
    const db = openDb(project.dbPath);
    const g = getGraph(db);
    db.close();
    return g;
  }
  if (existsSync(project.graphJsonPath)) {
    return JSON.parse(readFileSync(project.graphJsonPath, "utf-8"));
  }
  console.error("No database or graph.json found");
  process.exit(1);
}

function printTree(nodes: Record<string, GraphNode>, rootId: string): string {
  if (!nodes[rootId]) return `unknown node: ${rootId}`;

  const visited = new Set<string>();
  const tables = new Set<string>();
  let funcCount = 0;
  let totalLoc = 0;
  let totalE = 0, totalR = 0, totalW = 0, totalX = 0;
  const lines: string[] = [];

  function walk(nodeId: string, prefix: string, isLast: boolean, isRoot: boolean) {
    const node = nodes[nodeId];
    const label = formatLabel(nodeId, node);
    const isTable = nodeId.startsWith("table:");
    const isFunc = nodeId.startsWith("func:");
    const seen = visited.has(nodeId);

    if (isTable) tables.add(nodeId.slice(6));
    if (isFunc && !seen) {
      funcCount++;
      if (node?.loc) totalLoc += node.loc;
      if (node) { totalE += node.E ?? 0; totalR += node.R ?? 0; totalW += node.W ?? 0; totalX += node.X ?? 0; }
    }

    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const refStr = seen && !isTable ? " (already seen)" : "";
    const annotation = cosmicAnnotation(node);
    lines.push(`${prefix}${connector}${label}${annotation}${refStr}`);

    if (seen || !node) return;
    visited.add(nodeId);

    const deps = node.deps;
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    for (let i = 0; i < deps.length; i++) {
      walk(deps[i], childPrefix, i === deps.length - 1, false);
    }
  }

  walk(rootId, "", true, true);

  lines.push("");
  if (tables.size) lines.push(`${tables.size} tables: ${[...tables].sort().join(", ")}`);
  const totalCFP = totalE + totalR + totalW + totalX;
  lines.push(`${funcCount} functions, ${totalLoc} loc, ${totalCFP} CFP (E:${totalE} R:${totalR} W:${totalW} X:${totalX})`);
  return lines.join("\n");
}

function subtreeStats(nodes: Record<string, GraphNode>, rootId: string) {
  const visited = new Set<string>();
  let funcs = 0, loc = 0, E = 0, R = 0, W = 0, X = 0;

  function walk(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const n = nodes[id];
    if (id.startsWith("func:")) {
      funcs++;
      if (n?.loc) loc += n.loc;
      E += n?.E ?? 0; R += n?.R ?? 0; W += n?.W ?? 0; X += n?.X ?? 0;
    }
    if (n) for (const dep of n.deps) walk(dep);
  }

  walk(rootId);
  return { funcs, loc, E, R, W, X };
}

// ── Exported command handlers ─────────────────────────────────────

export function stats(project: ProjectConfig): void {
  if (existsSync(project.dbPath)) {
    const db = openDb(project.dbPath);
    const s = dbGetStats(db);
    db.close();
    const exp = Object.entries(s.exploration).sort().map(([k,v]) => `${k}:${v}`).join(" ");
    const ver = Object.entries(s.verification).sort().map(([k,v]) => `${k}:${v}`).join(" ");
    console.log(`nodes: ${s.nodeCount}, edges: ${s.edgeCount}`);
    console.log(`exploration: ${exp}` + (ver ? ` | verification: ${ver}` : ""));
    console.log(`cfp: ${s.cfp.total} (E:${s.cfp.E} R:${s.cfp.R} W:${s.cfp.W} X:${s.cfp.X})`);
    return;
  }

  // Fallback to graph.json with full stats
  const { nodes } = loadGraph(project);
  const ids = Object.keys(nodes);
  const types: Record<string, number> = {};
  const exploration: Record<string, number> = {};
  let totalEdges = 0, totalLoc = 0;
  let totalE = 0, totalR = 0, totalW = 0, totalX = 0;

  for (const [id, node] of Object.entries(nodes)) {
    types[id.split(":")[0]] = (types[id.split(":")[0]] ?? 0) + 1;
    const exp = node.exploration ?? "unknown";
    exploration[exp] = (exploration[exp] ?? 0) + 1;
    totalEdges += node.deps.length;
    if (node.loc) totalLoc += node.loc;
    totalE += node.E ?? 0; totalR += node.R ?? 0; totalW += node.W ?? 0; totalX += node.X ?? 0;
  }

  const totalCFP = totalE + totalR + totalW + totalX;
  console.log(`nodes: ${ids.length}, edges: ${totalEdges}`);
  console.log("types:");
  for (const [type, cnt] of Object.entries(types).sort()) console.log(`  ${type}: ${cnt}`);
  console.log("exploration:");
  for (const [exp, cnt] of Object.entries(exploration).sort()) console.log(`  ${exp}: ${cnt}`);
  console.log(`loc: ${totalLoc}`);
  console.log(`cosmic: ${totalCFP} CFP (E:${totalE} R:${totalR} W:${totalW} X:${totalX})`);
}

export function status(project: ProjectConfig, nodeId: string): void {
  if (existsSync(project.dbPath)) {
    const db = openDb(project.dbPath);
    console.log(getNodeExploration(db, nodeId));
    db.close();
    return;
  }
  const { nodes } = loadGraph(project);
  console.log(nodes[nodeId]?.exploration ?? "unknown");
}

export function remaining(project: ProjectConfig, type?: string): void {
  if (existsSync(project.dbPath)) {
    const db = openDb(project.dbPath);
    const rows = dbGetRemaining(db, type);
    db.close();
    for (const { node_id, exploration } of rows) console.log(`${exploration}\t${node_id}`);
    return;
  }
  console.error("remaining requires a database");
  process.exit(1);
}

export function tree(project: ProjectConfig, pattern: string): void {
  const { nodes } = loadGraph(project);
  const knownPrefixes = ["endpoint:", "subprocess:", "func:", "page:", "command:", "listener:", "database:", "table:"];
  const target = pattern.includes(":") && !knownPrefixes.some(p => pattern.includes(p))
    ? `endpoint:${pattern}` : pattern;
  const matches = Object.keys(nodes).filter(id => id === target || id === pattern);
  if (matches.length === 0) { console.error(`no node matching '${pattern}'`); process.exit(1); }
  for (const m of matches) {
    if (matches.length > 1) console.log("---");
    console.log(printTree(nodes, m));
  }
}

export function subprocessTree(project: ProjectConfig, pattern: string): void {
  const { nodes } = loadGraph(project);
  const target = pattern.includes("subprocess:") ? pattern : `subprocess:${pattern}`;
  const matches = Object.keys(nodes).filter(id => id.startsWith("subprocess:") && (id === target || id.includes(pattern)));
  if (matches.length === 0) { console.error(`no subprocess matching '${pattern}'`); process.exit(1); }
  for (const m of matches) {
    if (matches.length > 1) console.log("---");
    console.log(printTree(nodes, m));
  }
}

const TOUCHPOINT_PREFIXES = ["page:", "endpoint:", "command:", "listener:", "database:"];

export function touchpoints(project: ProjectConfig): void {
  const { nodes } = loadGraph(project);
  const tps = Object.keys(nodes).filter(id => TOUCHPOINT_PREFIXES.some(p => id.startsWith(p))).sort();
  for (const id of tps) {
    const s = subtreeStats(nodes, id);
    console.log(`${id}\t${s.funcs} functions, ${s.loc} loc, ${formatCosmic(s)}`);
  }
  console.log(`\n${tps.length} touchpoints`);
}

export function functions(project: ProjectConfig, explorationFilter?: string): void {
  const { nodes } = loadGraph(project);
  const seen = new Set<string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (!id.startsWith("func:")) continue;
    if (explorationFilter && node.exploration !== explorationFilter) continue;
    const canonical = id.replace(/:(GET|POST|PUT|DELETE|PATCH)(-\w+)?$/, "");
    if (!seen.has(canonical)) { seen.add(canonical); console.log(canonical); }
  }
}

export function dump(project: ProjectConfig): void {
  const graph = loadGraph(project);
  console.log(JSON.stringify(graph, null, 2));
}
