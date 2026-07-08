/**
 * validate — Node ID and line-range validation against source files.
 */
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

export function splitFuncId(rest: string): { filePath: string; funcName: string } {
  const parts = rest.split(":");
  let pathEnd = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes("/")) pathEnd = i;
  }
  if (pathEnd === -1) return { filePath: "", funcName: rest };
  if (pathEnd === parts.length - 1) return { filePath: rest, funcName: "" };
  return {
    filePath: parts.slice(0, pathEnd + 1).join(":"),
    funcName: parts.slice(pathEnd + 1).join(":"),
  };
}

function die(msg: string): never {
  throw new Error(msg);
}

const VALID_PREFIXES = ["func:", "endpoint:", "subprocess:", "page:", "command:", "listener:", "database:", "table:"];

export function validateNodeId(codePath: string, id: string, language?: string): void {
  if (!VALID_PREFIXES.some(p => id.startsWith(p))) {
    die(`invalid node ID "${id}": must start with one of ${VALID_PREFIXES.join(", ")}. Run 'bin/tracer help' for usage.`);
  }
  if (!id.startsWith("func:")) return;
  const rest = id.slice(5);
  const { filePath, funcName } = splitFuncId(rest);

  if (!filePath) die(`cannot extract file path from node ID: ${id}`);
  const fullPath = resolve(codePath, filePath);
  if (!existsSync(fullPath)) die(`file not found: ${fullPath} (node: ${id})`);
  if (!funcName) return;
  const withoutVariant = funcName.split(":")[0];

  if (withoutVariant.includes(".")) {
    const className = withoutVariant.split(".")[0];
    if (className.includes("\\") || className.includes("/")) {
      die(`class name "${className}" must not contain / or \\ (use bare class name, no namespace) in node: ${id}`);
    }
  }
}

export function validateLines(
  codePath: string,
  nodeId: string,
  lineStart: number,
  lineEnd: number,
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!nodeId.startsWith("func:")) return { valid: true, warnings };
  if (lineStart > lineEnd) {
    warnings.push(`start (${lineStart}) > end (${lineEnd})`);
    return { valid: false, warnings };
  }
  const rest = nodeId.slice(5);
  const { filePath, funcName } = splitFuncId(rest);
  if (!filePath) return { valid: true, warnings };

  const fullPath = resolve(codePath, filePath);
  let fileLines: string[];
  try {
    fileLines = readFileSync(fullPath, "utf-8").split("\n");
  } catch {
    warnings.push(`cannot read file: ${fullPath}`);
    return { valid: false, warnings };
  }
  if (lineEnd > fileLines.length) {
    warnings.push(`end line (${lineEnd}) > file length (${fileLines.length})`);
    return { valid: false, warnings };
  }
  if (funcName) {
    const withoutVariant = funcName.split(":")[0];
    const bareName = withoutVariant.split(".").pop() ?? withoutVariant;
    const rangeLines = fileLines.slice(lineStart - 1, lineEnd);
    const found = rangeLines.some(line => line.includes(bareName));
    if (!found) {
      warnings.push(`function "${bareName}" not found in lines ${lineStart}-${lineEnd}`);
      return { valid: false, warnings };
    }
  }
  return { valid: true, warnings };
}
