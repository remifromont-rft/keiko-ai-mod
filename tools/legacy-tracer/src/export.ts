/**
 * export — Export analysis/data/graph.db to graph.json.
 */
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { openDb, getGraph } from "./db.ts";
import type { ProjectConfig } from "./resolve.ts";

export function exportGraph(project: ProjectConfig): void {
  if (!existsSync(project.dbPath)) {
    console.error(`database not found: ${project.dbPath}`);
    process.exit(1);
  }
  const db = openDb(project.dbPath);
  const graph = getGraph(db);
  db.close();

  mkdirSync(dirname(project.graphJsonPath), { recursive: true });
  Bun.write(project.graphJsonPath, JSON.stringify(graph, null, 2) + "\n");

  const nodeCount = Object.keys(graph.nodes).length;
  let edgeCount = 0;
  for (const n of Object.values(graph.nodes)) edgeCount += n.deps.length;
  console.log(`exported ${nodeCount} nodes, ${edgeCount} edges → ${project.graphJsonPath}`);
}
