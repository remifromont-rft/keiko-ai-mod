/**
 * db — SQLite backend for the COSMIC call-graph store.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  exploration TEXT NOT NULL DEFAULT 'pending',
  line_start INTEGER,
  line_end INTEGER,
  e INTEGER NOT NULL DEFAULT 0,
  r INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  x INTEGER NOT NULL DEFAULT 0,
  verification TEXT,
  warnings TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  UNIQUE(src, dst)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`;

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);
  return db;
}

export function claimNode(db: Database, nodeId: string): boolean {
  const stmt = db.prepare(
    "UPDATE nodes SET exploration = 'exploring' WHERE node_id = ? AND exploration = 'pending'"
  );
  const result = stmt.run(nodeId);
  return result.changes === 1;
}

export function unclaimNode(db: Database, nodeId: string): void {
  db.run("UPDATE nodes SET exploration = 'pending' WHERE node_id = ? AND exploration IN ('exploring', 'analyzed')", [nodeId]);
}

export function unclaimAll(db: Database): number {
  const result = db.run("UPDATE nodes SET exploration = 'pending' WHERE exploration = 'exploring'");
  return result.changes;
}

export type DoneOpts = {
  lineStart?: number | null;
  lineEnd?: number | null;
  e?: number;
  r?: number;
  w?: number;
  x?: number;
  verification?: string | null;
  warnings?: string | null;
};

export function doneNode(db: Database, nodeId: string, opts: DoneOpts, deps: string[]): { node_id: string; exploration: string }[] {
  return db.transaction(() => {
    db.run(
      `INSERT INTO nodes (node_id, exploration, line_start, line_end, e, r, w, x, verification, warnings)
       VALUES (?, 'analyzed', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         exploration = 'analyzed',
         line_start = excluded.line_start,
         line_end = excluded.line_end,
         e = excluded.e,
         r = excluded.r,
         w = excluded.w,
         x = excluded.x,
         verification = excluded.verification,
         warnings = excluded.warnings`,
      [
        nodeId,
        opts.lineStart ?? null,
        opts.lineEnd ?? null,
        opts.e ?? 0,
        opts.r ?? 0,
        opts.w ?? 0,
        opts.x ?? 0,
        opts.verification ?? null,
        opts.warnings ?? null,
      ]
    );
    for (const dep of deps) {
      db.run("INSERT OR IGNORE INTO nodes (node_id) VALUES (?)", [dep]);
      db.run("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)", [nodeId, dep]);
    }
    // Return exploration status of all deps
    if (deps.length === 0) return [];
    const placeholders = deps.map(() => "?").join(",");
    return db.query(
      `SELECT node_id, exploration FROM nodes WHERE node_id IN (${placeholders}) ORDER BY node_id`
    ).all(...deps) as { node_id: string; exploration: string }[];
  })();
}

export function addEdge(db: Database, src: string, dst: string): void {
  const srcExists = db.query("SELECT 1 FROM nodes WHERE node_id = ?").get(src);
  if (!srcExists) throw new Error(`source node not found: ${src}`);
  const dstExists = db.query("SELECT 1 FROM nodes WHERE node_id = ?").get(dst);
  if (!dstExists) throw new Error(`destination node not found: ${dst}`);
  db.run("INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)", [src, dst]);
}

export function seedNodes(db: Database, nodes: { node_id: string; exploration?: string }[]): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO nodes (node_id, exploration) VALUES (?, ?)");
  db.transaction(() => {
    for (const n of nodes) {
      stmt.run(n.node_id, n.exploration ?? "pending");
    }
  })();
}

export function getStats(db: Database): {
  nodeCount: number;
  edgeCount: number;
  exploration: Record<string, number>;
  verification: Record<string, number>;
  cfp: { E: number; R: number; W: number; X: number; total: number };
} {
  const nodeCount = (db.query("SELECT count(*) as c FROM nodes").get() as any).c;
  const edgeCount = (db.query("SELECT count(*) as c FROM edges").get() as any).c;
  const exploration: Record<string, number> = {};
  for (const row of db.query("SELECT exploration, count(*) as c FROM nodes GROUP BY exploration").all() as any[]) {
    exploration[row.exploration] = row.c;
  }
  const cfpRow = db.query("SELECT COALESCE(SUM(e),0) as E, COALESCE(SUM(r),0) as R, COALESCE(SUM(w),0) as W, COALESCE(SUM(x),0) as X FROM nodes").get() as any;
  const cfp = { E: cfpRow.E, R: cfpRow.R, W: cfpRow.W, X: cfpRow.X, total: cfpRow.E + cfpRow.R + cfpRow.W + cfpRow.X };
  const verification: Record<string, number> = {};
  for (const row of db.query("SELECT verification, count(*) as c FROM nodes WHERE verification IS NOT NULL GROUP BY verification").all() as any[]) {
    verification[row.verification] = row.c;
  }
  return { nodeCount, edgeCount, exploration, verification, cfp };
}

export type GraphNode = {
  deps: string[];
  exploration?: string;
  loc?: number;
  lineStart?: number;
  lineEnd?: number;
  E?: number;
  R?: number;
  W?: number;
  X?: number;
};

export function getGraph(db: Database): { nodes: Record<string, GraphNode> } {
  const out: Record<string, GraphNode> = {};
  for (const row of db.query("SELECT * FROM nodes ORDER BY node_id").all() as any[]) {
    const entry: GraphNode = { deps: [], exploration: row.exploration };
    if (row.line_start != null && row.line_end != null) {
      entry.loc = row.line_end - row.line_start + 1;
      entry.lineStart = row.line_start;
      entry.lineEnd = row.line_end;
    }
    if (row.e || row.r || row.w || row.x) {
      entry.E = row.e; entry.R = row.r; entry.W = row.w; entry.X = row.x;
    }
    out[row.node_id] = entry;
  }
  for (const { src, dst } of db.query("SELECT src, dst FROM edges ORDER BY src").all() as any[]) {
    (out[src] ??= { deps: [] }).deps.push(dst);
    out[dst] ??= { deps: [] };
  }
  return { nodes: out };
}

export function getRemaining(db: Database, type?: string): { node_id: string; exploration: string }[] {
  let sql = "SELECT node_id, exploration FROM nodes WHERE exploration IN ('pending', 'exploring') ORDER BY exploration, node_id";
  const params: any[] = [];
  if (type) {
    sql = "SELECT node_id, exploration FROM nodes WHERE exploration IN ('pending', 'exploring') AND node_id LIKE ? ORDER BY exploration, node_id";
    params.push(type + ":%");
  }
  return db.query(sql).all(...params) as any[];
}

export function getNodeExploration(db: Database, nodeId: string): string {
  const row = db.query("SELECT exploration FROM nodes WHERE node_id = ?").get(nodeId) as any;
  return row ? row.exploration : "unknown";
}

export function getNodeDeps(db: Database, nodeId: string): { node_id: string; exploration: string }[] {
  return db.query(
    `SELECT n.node_id, n.exploration FROM edges e JOIN nodes n ON n.node_id = e.dst WHERE e.src = ? ORDER BY n.node_id`
  ).all(nodeId) as { node_id: string; exploration: string }[];
}

export function getNodeStatuses(db: Database, nodeIds: string[]): { node_id: string; exploration: string }[] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db.query(
    `SELECT node_id, exploration FROM nodes WHERE node_id IN (${placeholders}) ORDER BY node_id`
  ).all(...nodeIds) as { node_id: string; exploration: string }[];
}

export function claimRandomPending(db: Database): string | null {
  return db.transaction(() => {
    const row = db.query(
      "SELECT node_id FROM nodes WHERE exploration = 'pending' ORDER BY RANDOM() LIMIT 1"
    ).get() as { node_id: string } | null;
    if (!row) return null;
    db.run(
      "UPDATE nodes SET exploration = 'exploring' WHERE node_id = ? AND exploration = 'pending'",
      [row.node_id]
    );
    return row.node_id;
  })();
}

export function getNodeCosmic(db: Database, nodeId: string): { e: number; r: number; w: number; x: number; exploration: string } | null {
  const row = db.query("SELECT e, r, w, x, exploration FROM nodes WHERE node_id = ?").get(nodeId) as any;
  return row ?? null;
}

export function deleteNode(db: Database, nodeId: string): { deleted: boolean; orphans: string[] } {
  const row = db.query("SELECT node_id FROM nodes WHERE node_id = ?").get(nodeId);
  if (!row) return { deleted: false, orphans: [] };

  const children = db.query("SELECT dst FROM edges WHERE src = ?").all(nodeId) as any[];

  db.transaction(() => {
    db.run("DELETE FROM edges WHERE src = ? OR dst = ?", [nodeId, nodeId]);
    db.run("DELETE FROM nodes WHERE node_id = ?", [nodeId]);
  })();

  const orphans: string[] = [];
  for (const { dst } of children) {
    const remaining = db.query("SELECT 1 FROM edges WHERE dst = ? LIMIT 1").get(dst);
    if (!remaining) orphans.push(dst);
  }
  return { deleted: true, orphans };
}

export function renameNode(db: Database, oldId: string, newId: string): boolean {
  const old = db.query("SELECT * FROM nodes WHERE node_id = ?").get(oldId) as any;
  if (!old) return false;
  const existing = db.query("SELECT 1 FROM nodes WHERE node_id = ?").get(newId);
  if (existing) throw new Error(`target already exists: ${newId} (use merge instead)`);

  db.transaction(() => {
    db.run(
      `INSERT INTO nodes (node_id, exploration, line_start, line_end, e, r, w, x, verification, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, old.exploration, old.line_start, old.line_end, old.e, old.r, old.w, old.x, old.verification, old.warnings]
    );
    db.run("UPDATE edges SET src = ? WHERE src = ?", [newId, oldId]);
    db.run("UPDATE edges SET dst = ? WHERE dst = ?", [newId, oldId]);
    db.run("DELETE FROM nodes WHERE node_id = ?", [oldId]);
  })();
  return true;
}

export function mergeNodes(db: Database, fromId: string, intoId: string): boolean {
  if (fromId === intoId) throw new Error("cannot merge a node into itself");
  const from = db.query("SELECT * FROM nodes WHERE node_id = ?").get(fromId) as any;
  const into = db.query("SELECT * FROM nodes WHERE node_id = ?").get(intoId) as any;
  if (!from) throw new Error(`node not found: ${fromId}`);
  if (!into) throw new Error(`target not found: ${intoId}`);

  db.transaction(() => {
    // Carry over COSMIC if into has none and from does
    if ((from.e || from.r || from.w || from.x) && !(into.e || into.r || into.w || into.x)) {
      db.run(
        "UPDATE nodes SET e = ?, r = ?, w = ?, x = ?, line_start = ?, line_end = ?, exploration = ?, verification = ? WHERE node_id = ?",
        [from.e, from.r, from.w, from.x, from.line_start, from.line_end, from.exploration, from.verification, intoId]
      );
    }

    // Delete edges that would become duplicates or self-loops after remapping
    db.run(`DELETE FROM edges WHERE src = ? AND dst IN (SELECT dst FROM edges WHERE src = ?)`, [fromId, intoId]);
    db.run(`DELETE FROM edges WHERE dst = ? AND src IN (SELECT src FROM edges WHERE dst = ?)`, [fromId, intoId]);
    db.run(`DELETE FROM edges WHERE (src = ? AND dst = ?) OR (src = ? AND dst = ?)`, [fromId, intoId, intoId, fromId]);

    db.run("UPDATE edges SET src = ? WHERE src = ?", [intoId, fromId]);
    db.run("UPDATE edges SET dst = ? WHERE dst = ?", [intoId, fromId]);

    // Remove any remaining self-loops
    db.run("DELETE FROM edges WHERE src = dst");

    db.run("DELETE FROM nodes WHERE node_id = ?", [fromId]);
  })();
  return true;
}

export function reparentNode(db: Database, nodeId: string, oldParent: string, newParent: string): void {
  const edge = db.query("SELECT id FROM edges WHERE src = ? AND dst = ?").get(oldParent, nodeId) as any;
  if (!edge) throw new Error(`edge not found: ${oldParent} → ${nodeId}`);
  const parentExists = db.query("SELECT 1 FROM nodes WHERE node_id = ?").get(newParent);
  if (!parentExists) throw new Error(`new parent not found: ${newParent}`);

  const newEdgeExists = db.query("SELECT 1 FROM edges WHERE src = ? AND dst = ?").get(newParent, nodeId);
  if (newEdgeExists) {
    db.run("DELETE FROM edges WHERE id = ?", [edge.id]);
  } else {
    db.run("UPDATE edges SET src = ? WHERE id = ?", [newParent, edge.id]);
  }
}

export function resetDb(db: Database): void {
  db.transaction(() => {
    db.run("DELETE FROM edges");
    db.run("DELETE FROM nodes");
  })();
}
