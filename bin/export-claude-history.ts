#!/usr/bin/env tsx
// export-claude-history v1.3

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return process.cwd();
  }
}

const projectRoot = getProjectRoot();
const claudeProjectPath = `${process.env["HOME"]}/.claude/projects/${projectRoot.replace(/\//g, "-")}`;
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fullExport = process.argv.includes("--full");
const targetDirArg = args[0];

if (!targetDirArg) {
  console.error("Usage: export-claude-history <target-dir> [--full]");
  process.exit(1);
}

const targetDir = path.isAbsolute(targetDirArg)
  ? targetDirArg
  : path.join(projectRoot, targetDirArg);

// --- Types ---

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
  tool_use_id?: string;
}

interface JsonlLine {
  type?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  timestamp?: string;
  gitBranch?: string;
  toolUseResult?: unknown;
}

// --- Helpers ---

const SKIP_TYPES = new Set([
  "progress",
  "system",
  "queue-operation",
  "file-history-snapshot",
]);

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  php: "php",
};

function langFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANG_MAP[ext] || ext;
}

function formatToolInput(name: string, input: unknown): string {
  const obj = typeof input === "object" && input !== null ? input : null;
  if (!obj) return JSON.stringify(input);

  const { file_path, content, old_string, new_string, command, description, pattern } =
    obj as Record<string, string | undefined>;

  switch (name) {
    case "Write": {
      const lang = langFor(file_path || "");
      const body = truncate(content || "");
      if (lang === "markdown") {
        return `\`${file_path}\`\n\n    ${body.split("\n").join("\n    ")}`;
      }
      return `\`${file_path}\`\n\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case "Edit":
      return `\`${file_path}\`\n\`\`\`diff\n- ${truncate(old_string || "").split("\n").join("\n- ")}\n+ ${truncate(new_string || "").split("\n").join("\n+ ")}\n\`\`\``;
    case "Bash":
      return `${description ? description + "\n" : ""}\`\`\`bash\n${command}\n\`\`\``;
    case "Read": {
      const { offset, limit } = obj as Record<string, number | undefined>;
      const range = offset || limit ? ` (${offset ? `offset:${offset}` : ""}${offset && limit ? " " : ""}${limit ? `limit:${limit}` : ""})` : "";
      return `\`${file_path}\`${range}`;
    }
    case "Glob":
      return `\`${pattern}\``;
    case "Grep": {
      const { path: grepPath } = obj as Record<string, string | undefined>;
      return grepPath ? `\`${pattern}\` in \`${grepPath}\`` : `\`${pattern}\``;
    }
    case "Agent": {
      const { prompt, ...rest } = obj as Record<string, unknown>;
      const fields = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const promptBlock = prompt
        ? `\n\n    ${String(prompt).split("\n").join("\n    ")}\n\n`
        : "";
      return fields + promptBlock;
    }
    default: {
      return truncate(JSON.stringify(input), 500);
    }
  }
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m?.[1]?.trim() ?? "";
}

function formatTaskNotification(raw: string): string {
  const summary = extractXmlTag(raw, "summary");
  const result = extractXmlTag(raw, "result");
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (result) parts.push(result);
  return parts.join("\n\n") || raw;
}

// Inter-agent messages arrive as a user turn prefixed with this sentinel and
// wrap a <teammate-message teammate_id="..." color="..." summary="..."> envelope.
// We keep only the inner payload — the sentinel prefix and the boilerplate
// security caveat that trails the closing tag are dropped.
interface Teammate {
  id: string;
  color: string;
  summary: string;
  body: string;
}

function parseTeammateMessage(content: string): Teammate | null {
  if (!content.trimStart().startsWith("Another Claude session sent a message:")) return null;
  const attrs = content.match(/<teammate-message([^>]*)>/)?.[1] ?? "";
  const inner = content.match(/<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/)?.[1];
  return {
    id: attrs.match(/teammate_id="([^"]*)"/)?.[1] || "unknown",
    color: attrs.match(/\bcolor="([^"]*)"/)?.[1] || "",
    summary: attrs.match(/\bsummary="([^"]*)"/)?.[1] || "",
    body: (inner ?? content.replace(/^[^\n]*\n?/, "")).trim(),
  };
}

function teammateHeading(t: Teammate): string {
  return t.color ? `🤝 Teammate: ${t.id} (${t.color})` : `🤝 Teammate: ${t.id}`;
}

function teammateBody(t: Teammate): string {
  const summary = t.summary ? `**Summary:** ${t.summary}\n\n` : "";
  return `${summary}${t.body}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Slash commands and local-command output arrive as user turns wrapped in
// <command-name>/<command-args>/<local-command-stdout> tags. Returns the
// cleaned, tag-free body, or null when the content is not a command turn.
function formatLocalCommand(content: string): string | null {
  const s = content.trimStart();
  if (s.startsWith("<command-name>") || s.startsWith("<command-message>")) {
    const name = extractXmlTag(content, "command-name") || extractXmlTag(content, "command-message");
    const args = extractXmlTag(content, "command-args");
    return `\`${(name + (args ? " " + args : "")).trim()}\``;
  }
  if (s.startsWith("<local-command-stdout>")) {
    const out = stripAnsi(extractXmlTag(content, "local-command-stdout")).trim();
    return out ? `↳ ${out}` : "↳ _(no output)_";
  }
  return null;
}

function truncate(s: string, max = 2000): string {
  if (fullExport || s.length <= max) return s;
  const kept = s.slice(0, max);
  const truncatedLines = s.slice(max).split("\n").length;
  return kept + `\n...(${truncatedLines} lines truncated)`;
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", "-").replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

function formatDuration(startIso: string, endIso: string): string {
  const mins = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000,
  );
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
}

function getGitUsername(): string {
  try {
    return execSync("git config user.email", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("@")[0] || os.userInfo().username;
  } catch {
    return os.userInfo().username;
  }
}

// --- Parsing ---

function getLastTimestamp(lines: string[]): string {
  let last = "";
  for (const line of lines) {
    const m = line.match(/"timestamp":"([^"]+)"/);
    if (m) last = m[1] ?? "";
  }
  return last;
}

function parseConversation(lines: string[], uuid: string) {
  const messages: string[] = [];
  let firstTimestamp = "";
  let lastTimestamp = "";
  const branchCounts: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const pendingTools = new Map<string, { name: string; input: unknown }>();

  const count = (key: string) => {
    categories[key] = (categories[key] || 0) + 1;
  };

  for (const line of lines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
    if (obj.gitBranch) {
      branchCounts[obj.gitBranch] = (branchCounts[obj.gitBranch] || 0) + 1;
    }
    if (SKIP_TYPES.has(obj.type || "")) continue;

    const msg = obj.message;
    if (!msg?.role) continue;

    // String content = user message or task notification
    if (typeof msg.content === "string") {
      if (msg.content.trim()) {
        const teammate = parseTeammateMessage(msg.content);
        const command = formatLocalCommand(msg.content);
        if (teammate) {
          count("teammate");
          messages.push(`\n## ${teammateHeading(teammate)}\n${teammateBody(teammate)}`);
        } else if (msg.content.trimStart().startsWith("<local-command-caveat>")) {
          // Boilerplate caveat that precedes local-command output — drop it.
        } else if (command) {
          count("command");
          messages.push(`\n## ⌨️ Command\n${command}`);
        } else if (msg.content.trimStart().startsWith("<task-notification>")) {
          count("task_notification");
          messages.push(`\n## 🔔 Task Notification\n${formatTaskNotification(msg.content)}`);
        } else if (msg.content.trimStart().startsWith("Base directory for this skill:")) {
          count("skill_prompt");
          messages.push(`\n## 📜 Skill Prompt\n${msg.content}`);
        } else {
          count("user");
          messages.push(`\n## 🧑 User\n${msg.content}`);
        }
      }
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    for (const b of msg.content) {
      switch (b.type) {
        case "thinking":
          if (b.thinking) {
            count("thinking");
            messages.push(`\n## 🧠 Thinking\n${b.thinking}`);
          }
          break;

        case "text":
          if (b.text?.trim()) {
            const teammate = msg.role === "user" ? parseTeammateMessage(b.text) : null;
            if (msg.role === "assistant") {
              count("assistant");
              messages.push(`\n## 🤖 Assistant\n${b.text}`);
            } else if (teammate) {
              count("teammate");
              messages.push(`\n## ${teammateHeading(teammate)}\n${teammateBody(teammate)}`);
            } else if (b.text.trimStart().startsWith("Base directory for this skill:")) {
              count("skill_prompt");
              messages.push(`\n## 📜 Skill Prompt\n${b.text}`);
            } else {
              count("user");
              messages.push(`\n## 🧑 User\n${b.text}`);
            }
          }
          break;

        case "tool_use":
          count(`tool_call:${b.name}`);
          if (b.id) pendingTools.set(b.id, { name: b.name!, input: b.input });
          messages.push(
            `\n## ⚪️ Tool Call: ${b.name}\n${formatToolInput(b.name!, b.input)}`,
          );
          break;

        case "tool_result": {
          const pending = b.tool_use_id ? pendingTools.get(b.tool_use_id) : null;
          if (b.tool_use_id) pendingTools.delete(b.tool_use_id);

          const toolName = pending?.name || "unknown";
          const isRejected = obj.toolUseResult === "User rejected tool use";
          const isError = b.is_error === true && !isRejected;

          const raw =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: { text?: string }) => c.text || "").join("\n")
                : "";
          const body = toolName === "Grep" || toolName === "Read" || toolName === "Bash"
            ? "    " + truncate(raw).split("\n").join("\n    ")
            : truncate(raw);

          if (isRejected) {
            count("tool_rejected");
            messages.push(`\n## ❌ Tool Rejected: ${toolName}\n${body}`);
          } else if (isError) {
            count("tool_error");
            messages.push(`\n## 🔴 Tool Error: ${toolName}\n${body}`);
          } else if (body.trim()) {
            count("tool_result");
            messages.push(`\n## 🟢 Tool Result: ${toolName}\n${body}`);
          }
          break;
        }
      }
    }
  }

  const branch =
    Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  return { messages, firstTimestamp, lastTimestamp, branch, categories, uuid };
}

// --- Formatting ---

const MSG_DEFS = [
  { key: "user", emoji: "🧑", label: "User" },
  { key: "teammate", emoji: "🤝", label: "Teammate" },
  { key: "command", emoji: "⌨️", label: "Command" },
  { key: "skill_call", emoji: "🧑", label: "Skill Call" },
  { key: "skill_prompt", emoji: "📜", label: "Skill Prompt" },
  { key: "assistant", emoji: "🤖", label: "Assistant" },
  { key: "thinking", emoji: "🧠", label: "Thinking" },
  { key: "tool_result", emoji: "🟢", label: "Tool Result" },
  { key: "task_notification", emoji: "🔔", label: "Task Notification" },
  { key: "tool_error", emoji: "🔴", label: "Tool Error" },
  { key: "tool_rejected", emoji: "❌", label: "Tool Rejected" },
];

function formatHeader(stats: ReturnType<typeof parseConversation>): string {
  const msgLine = MSG_DEFS.filter((d) => stats.categories[d.key])
    .map((d) => `${stats.categories[d.key]} ${d.emoji} ${d.label}`)
    .join(", ");

  const toolLine = Object.entries(stats.categories)
    .filter(([k]) => k.startsWith("tool_call:"))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k.replace("tool_call:", "")}`)
    .join(", ");

  return `---
uuid: ${stats.uuid}
branch: ${stats.branch}
started: ${stats.firstTimestamp}
ended: ${stats.lastTimestamp}
duration: ${formatDuration(stats.firstTimestamp, stats.lastTimestamp)}
messages: ${msgLine}
tools: ${toolLine || "none"}
---
`;
}

// --- Export logic ---

function findExportedTimestamps(): Map<string, Set<string>> {
  const exported = new Map<string, Set<string>>();
  if (!fs.existsSync(targetDir)) return exported;

  // Build prefix → uuid[] from source files
  const prefixToUuids = new Map<string, string[]>();
  for (const f of fs.readdirSync(claudeProjectPath).filter((f) => f.endsWith(".jsonl"))) {
    const uuid = f.replace(".jsonl", "");
    const prefix = uuid.split("-")[0] ?? "";
    if (!prefixToUuids.has(prefix)) prefixToUuids.set(prefix, []);
    prefixToUuids.get(prefix)!.push(uuid);
  }

  // Scan target dir for existing exports
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(path.join(dir, entry.name));
        continue;
      }
      const m = entry.name.match(
        /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})-([a-f0-9]{8})\.(md|txt)$/,
      );
      if (!m) continue;
      for (const uuid of prefixToUuids.get(m[2] ?? "") || []) {
        if (!exported.has(uuid)) exported.set(uuid, new Set());
        exported.get(uuid)!.add(m[1] ?? "");
      }
    }
  }

  scan(targetDir);
  return exported;
}

function loadSkippedUuids(): Set<string> {
  const file = path.join(targetDir, ".skipped");
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()));
}

function saveSkippedUuid(uuid: string): void {
  const file = path.join(targetDir, ".skipped");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, uuid + "\n");
}

function exportFile(lines: string[], id: string, targetFile: string): boolean {
  const stats = parseConversation(lines, id);
  if (!stats.messages.join("").trim()) return false;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, formatHeader(stats) + stats.messages.join("\n"));
  return true;
}

// --- Main ---

function main() {
  console.log(`Export Claude History → ${targetDir}\n`);

  if (!fs.existsSync(claudeProjectPath)) {
    console.error(`Error: Claude project path not found: ${claudeProjectPath}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(claudeProjectPath).filter((f) => f.endsWith(".jsonl"));
  const exported = findExportedTimestamps();
  const skipped = loadSkippedUuids();

  // Find conversations needing export
  const toExport: Array<{ uuid: string; lines: string[] }> = [];
  for (const file of allFiles) {
    const uuid = file.replace(".jsonl", "");
    if (skipped.has(uuid)) continue;

    const lines = readLines(path.join(claudeProjectPath, file));
    const ts = formatTimestamp(getLastTimestamp(lines));
    const existing = exported.get(uuid);
    if (!existing || !existing.has(ts)) {
      toExport.push({ uuid, lines });
    }
  }

  console.log(`Found ${allFiles.length} conversations, ${toExport.length} to export\n`);
  if (toExport.length === 0) return;

  const username = getGitUsername();

  for (const { uuid, lines } of toExport) {
    const stats = parseConversation(lines, uuid);
    if (!stats.messages.join("").trim()) {
      saveSkippedUuid(uuid);
      continue;
    }

    const prefix = uuid.split("-")[0];
    const ts = formatTimestamp(stats.lastTimestamp);
    const branchDir = path.join(targetDir, username, sanitizeBranch(stats.branch));
    const fileName = `${ts}-${prefix}.md`;

    fs.mkdirSync(branchDir, { recursive: true });
    fs.writeFileSync(
      path.join(branchDir, fileName),
      formatHeader(stats) + stats.messages.join("\n"),
    );
    console.log(`  Exported: ${username}/${sanitizeBranch(stats.branch)}/${fileName}`);

    // Export subagents
    const subagentsDir = path.join(claudeProjectPath, uuid, "subagents");
    if (!fs.existsSync(subagentsDir)) continue;

    const agentFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"));
    if (agentFiles.length === 0) continue;

    const subTargetDir = path.join(branchDir, `${ts}-${prefix}-subagents`);
    for (const agentFile of agentFiles) {
      const agentId = agentFile.replace("agent-", "").replace(".jsonl", "");
      try {
        exportFile(
          readLines(path.join(subagentsDir, agentFile)),
          agentId,
          path.join(subTargetDir, `${agentId}.md`),
        );
      } catch (e) {
        console.error(`    Agent error (${agentId}): ${e}`);
      }
    }
    console.log(`    + ${agentFiles.length} subagent(s)`);
  }

  console.log("\nDone");
}

main();
