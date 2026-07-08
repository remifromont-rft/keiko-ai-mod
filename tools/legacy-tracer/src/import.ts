/**
 * import — Import graph.json into analysis/data/graph.db.
 */
import { existsSync, readFileSync } from "fs";
import { openDb, resetDb, type GraphNode } from "./db.ts";
import type { ProjectConfig } from "./resolve.ts";

export function importGraph(project: ProjectConfig): void {
  if (!existsSync(project.graphJsonPath)) {
    console.error(`graph.json not found: ${project.graphJsonPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(project.graphJsonPath, "utf-8"));
  const nodes: Record<string, GraphNode> = raw.nodes;

  const db = openDb(project.dbPath);
  resetDb(db);

  const insertNode = db.prepare(
    `INSERT INTO nodes (node_id, exploration, line_start, line_end, e, r, w, x)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (src, dst) VALUES (?, ?)`
  );

  db.transaction(() => {
    for (const [id, node] of Object.entries(nodes)) {
      insertNode.run(
        id,
        node.exploration ?? "pending",
        node.lineStart ?? null,
        node.lineEnd ?? null,
        node.E ?? 0,
        node.R ?? 0,
        node.W ?? 0,
        node.X ?? 0,
      );
    }
    for (const [id, node] of Object.entries(nodes)) {
      for (const dep of node.deps) {
        insertEdge.run(id, dep);
      }
    }
  })();

  db.close();

  const nodeCount = Object.keys(nodes).length;
  let edgeCount = 0;
  for (const n of Object.values(nodes)) edgeCount += n.deps.length;
  console.log(`imported ${nodeCount} nodes, ${edgeCount} edges ← ${project.graphJsonPath}`);
}
