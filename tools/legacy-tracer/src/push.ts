/**
 * push — Push graph.json or sprints.json to Cosmotracer (Supabase).
 */
import { existsSync, readFileSync } from "fs";
import { supabaseDelete, supabaseUpsert } from "./supabase.ts";
import type { ProjectConfig } from "./resolve.ts";

function requireProjectId(project: ProjectConfig): string {
  if (!project.projectId) {
    console.error("No project_id in tracer.yml. Required for pushing to Cosmotracer.");
    process.exit(1);
  }
  return project.projectId;
}

export async function pushGraph(project: ProjectConfig): Promise<void> {
  const projectId = requireProjectId(project);

  if (!existsSync(project.graphJsonPath)) {
    console.error(`Graph file not found: ${project.graphJsonPath}`);
    process.exit(1);
  }

  const graphData = JSON.parse(readFileSync(project.graphJsonPath, "utf-8"));
  const nodes: Record<string, any> = graphData.nodes || {};
  const nodeIds = Object.keys(nodes);

  console.log(`Pushing graph (${nodeIds.length} nodes) to cosmotracer...`);

  await supabaseDelete("graph_edges", `project_id=eq.${projectId}`);
  await supabaseDelete("graph_nodes", `project_id=eq.${projectId}`);

  const nodeRows = nodeIds.map(id => {
    const n = nodes[id];
    return {
      project_id: projectId,
      node_id: id,
      exploration: n.exploration || "analyzed",
      line_start: n.lineStart ?? null,
      line_end: n.lineEnd ?? null,
      e: n.E ?? 0,
      r: n.R ?? 0,
      w: n.W ?? 0,
      x: n.X ?? 0,
    };
  });

  const BATCH = 100;
  for (let i = 0; i < nodeRows.length; i += BATCH) {
    await supabaseUpsert("graph_nodes", nodeRows.slice(i, i + BATCH), "project_id,node_id");
  }
  console.log(`  ${nodeRows.length} nodes inserted`);

  const edgeRows: { project_id: string; src: string; dst: string }[] = [];
  for (const id of nodeIds) {
    for (const dep of nodes[id].deps || []) {
      edgeRows.push({ project_id: projectId, src: id, dst: dep });
    }
  }
  for (let i = 0; i < edgeRows.length; i += BATCH) {
    await supabaseUpsert("graph_edges", edgeRows.slice(i, i + BATCH), "project_id,src,dst");
  }
  console.log(`  ${edgeRows.length} edges inserted`);
  console.log("Done.");
}

export async function pushSprints(project: ProjectConfig): Promise<void> {
  const projectId = requireProjectId(project);

  if (!existsSync(project.sprintsJsonPath)) {
    console.error(`Sprints file not found: ${project.sprintsJsonPath}`);
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(project.sprintsJsonPath, "utf-8"));
  const sprints: any[] = state.sprints || [];
  const unassigned: string[] = state.unassigned || [];
  const done: Record<string, boolean> = state.done || {};

  console.log(`Pushing ${sprints.length} sprints to cosmotracer...`);

  await supabaseDelete("sprints", `project_id=eq.${projectId}`);
  await supabaseDelete("unassigned_touchpoints", `project_id=eq.${projectId}`);
  await supabaseDelete("touchpoint_status", `project_id=eq.${projectId}`);

  for (let i = 0; i < sprints.length; i++) {
    const s = sprints[i];
    const resp = await supabaseUpsert("sprints", [{
      project_id: projectId,
      name: s.name,
      position: i,
      date: s.date || null,
      budget: s.budget || 0,
      standard: s.standard || 0,
    }]);
    const created = await resp.json();
    const sprintId = created[0]?.id;
    if (!sprintId) { console.error(`Failed to create sprint "${s.name}"`); continue; }

    if (s.endpoints?.length) {
      const rows = s.endpoints.map((epId: string, j: number) => ({
        sprint_id: sprintId,
        touchpoint_id: epId,
        position: j,
      }));
      await supabaseUpsert("sprint_touchpoints", rows);
    }
    console.log(`  Sprint "${s.name}": ${(s.endpoints || []).length} endpoints`);
  }

  if (unassigned.length) {
    const rows = unassigned.map((epId, i) => ({ project_id: projectId, touchpoint_id: epId, position: i }));
    await supabaseUpsert("unassigned_touchpoints", rows);
    console.log(`  Unassigned: ${unassigned.length} endpoints`);
  }

  const doneEndpoints = Object.keys(done).filter(k => done[k]);
  if (doneEndpoints.length) {
    const rows = doneEndpoints.map(epId => ({ project_id: projectId, touchpoint_id: epId, done: true }));
    await supabaseUpsert("touchpoint_status", rows, "project_id,touchpoint_id");
    console.log(`  Done: ${doneEndpoints.length} endpoints`);
  }

  console.log("Done.");
}
