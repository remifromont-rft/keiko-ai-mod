/**
 * pull — Pull graph.json or sprints.json from Cosmotracer (Supabase).
 */
import { mkdirSync } from "fs";
import { dirname } from "path";
import { supabaseQuery } from "./supabase.ts";
import type { ProjectConfig } from "./resolve.ts";

function requireProjectId(project: ProjectConfig): string {
  if (!project.projectId) {
    console.error("No project_id in tracer.yml. Required for pulling from Cosmotracer.");
    process.exit(1);
  }
  return project.projectId;
}

export async function pullGraph(project: ProjectConfig): Promise<void> {
  const projectId = requireProjectId(project);

  console.log("Pulling graph from cosmotracer...");

  const nodeRows = await supabaseQuery("graph_nodes", `project_id=eq.${projectId}`);
  const edgeRows = await supabaseQuery("graph_edges", `project_id=eq.${projectId}`);

  const nodes: Record<string, any> = {};
  for (const row of nodeRows) {
    const entry: any = { deps: [], exploration: row.exploration || "analyzed" };
    if (row.line_start != null && row.line_end != null) {
      entry.loc = row.line_end - row.line_start + 1;
      entry.lineStart = row.line_start;
      entry.lineEnd = row.line_end;
    }
    if (row.e || row.r || row.w || row.x) {
      entry.E = row.e; entry.R = row.r; entry.W = row.w; entry.X = row.x;
    }
    nodes[row.node_id] = entry;
  }

  for (const { src, dst } of edgeRows) {
    if (nodes[src]) nodes[src].deps.push(dst);
    if (!nodes[dst]) nodes[dst] = { deps: [] };
  }

  const graph = { nodes };
  mkdirSync(dirname(project.graphJsonPath), { recursive: true });
  Bun.write(project.graphJsonPath, JSON.stringify(graph, null, 2));

  let edgeCount = 0;
  for (const n of Object.values(nodes) as any[]) edgeCount += n.deps.length;
  console.log(`Pulled ${Object.keys(nodes).length} nodes, ${edgeCount} edges → ${project.graphJsonPath}`);
}

export async function pullSprints(project: ProjectConfig): Promise<void> {
  const projectId = requireProjectId(project);

  console.log("Pulling sprints from cosmotracer...");

  const sprintRows = await supabaseQuery("sprints", `project_id=eq.${projectId}&order=position`);
  const unassignedRows = await supabaseQuery("unassigned_touchpoints", `project_id=eq.${projectId}&order=position`);
  const statusRows = await supabaseQuery("touchpoint_status", `project_id=eq.${projectId}`);

  const sprints: any[] = [];
  for (const s of sprintRows) {
    const epRows = await supabaseQuery("sprint_touchpoints", `sprint_id=eq.${s.id}&order=position`);
    const sprint: any = {
      name: s.name,
      position: s.position,
    };
    if (s.date) sprint.date = s.date;
    if (s.budget) sprint.budget = s.budget;
    if (s.standard) sprint.standard = s.standard;
    if (epRows.length) sprint.endpoints = epRows.map((r: any) => r.touchpoint_id);
    sprints.push(sprint);
  }

  const unassigned = unassignedRows.map((r: any) => r.touchpoint_id);
  const done: Record<string, boolean> = {};
  for (const r of statusRows) {
    if (r.done) done[r.touchpoint_id] = true;
  }

  const state = { sprints, unassigned, done };
  mkdirSync(dirname(project.sprintsJsonPath), { recursive: true });
  Bun.write(project.sprintsJsonPath, JSON.stringify(state, null, 2));

  console.log(`Pulled ${sprints.length} sprints, ${unassigned.length} unassigned, ${Object.keys(done).length} done → ${project.sprintsJsonPath}`);
}
