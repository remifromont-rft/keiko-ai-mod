/**
 * resolve — Find tracer.yml by walking up from cwd, derive all project paths.
 */
import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";

export type ProjectConfig = {
  root: string;
  language: string;
  projectId: string | null;
  codePath: string;
  dbPath: string;
  graphJsonPath: string;
  touchpointsPath: string;
  stateJsonPath: string;
  sprintsJsonPath: string;
};

export function parseYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

export function resolveProject(): ProjectConfig {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, "tracer.yml");
    if (existsSync(candidate)) {
      const yml = parseYaml(readFileSync(candidate, "utf-8"));
      const root = dir;
      const codePath = yml.code_path
        ? resolve(root, yml.code_path)
        : resolve(root, "code");
      return {
        root,
        language: yml.language ?? "unknown",
        projectId: yml.project_id ?? null,
        codePath,
        dbPath: resolve(root, "analysis", "data", "graph.db"),
        graphJsonPath: resolve(root, "analysis", "graph.json"),
        touchpointsPath: resolve(root, "analysis", "touchpoints.txt"),
        stateJsonPath: resolve(root, "analysis", "state.json"),
        sprintsJsonPath: resolve(root, "analysis", "sprints.json"),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      console.error("tracer.yml not found (searched from cwd to /)");
      process.exit(1);
    }
    dir = parent;
  }
}
