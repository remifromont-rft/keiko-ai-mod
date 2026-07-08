/**
 * format — Shared formatting utilities for graph display.
 */
import { splitFuncId } from "./validate.ts";

type NodeLike = {
  lineStart?: number;
  lineEnd?: number;
  E?: number;
  R?: number;
  W?: number;
  X?: number;
};

export function shortenPath(filePath: string): string {
  const markers = ["/code/private/", "/private/"];
  for (const m of markers) {
    const idx = filePath.indexOf(m);
    if (idx !== -1) return filePath.slice(idx + 1);
  }
  return filePath;
}

export function formatLabel(id: string, node?: NodeLike): string {
  const type = id.split(":")[0];
  const rest = id.slice(type.length + 1);
  if (type === "endpoint") {
    const method = rest.split(":")[0];
    const path = rest.slice(method.length + 1);
    return `${method} ${path}`;
  }
  if (type === "subprocess") {
    const parts = rest.split(":");
    const name = parts[parts.length - 1];
    const method = parts[0];
    const path = parts.slice(1, -1).join(":");
    return `${method} ${path} [${name}]`;
  }
  if (type === "table") return `table: ${rest}`;
  const { filePath, funcName } = splitFuncId(rest);
  const short = filePath ? shortenPath(filePath) : "";
  const lineRange = node?.lineStart != null && node?.lineEnd != null
    ? `:${node.lineStart}-${node.lineEnd}` : "";
  return short ? `${funcName}  ${short}${lineRange}` : funcName;
}

export function cosmicAnnotation(node?: NodeLike): string {
  if (!node) return "";
  const parts: string[] = [];
  if (node.E) parts.push(`E:${node.E}`);
  if (node.R) parts.push(`R:${node.R}`);
  if (node.W) parts.push(`W:${node.W}`);
  if (node.X) parts.push(`X:${node.X}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

export function formatCosmic(s: { E: number; R: number; W: number; X: number }): string {
  const total = s.E + s.R + s.W + s.X;
  const parts: string[] = [];
  if (s.E) parts.push(`E:${s.E}`);
  if (s.R) parts.push(`R:${s.R}`);
  if (s.W) parts.push(`W:${s.W}`);
  if (s.X) parts.push(`X:${s.X}`);
  return `${total} CFP${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
