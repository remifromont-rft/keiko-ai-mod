#!/usr/bin/env bun
import { resolve, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolveProject } from "./src/resolve.ts";
import { openDb, claimNode, unclaimNode, unclaimAll, doneNode, seedNodes, deleteNode, renameNode, mergeNodes, reparentNode, resetDb, getNodeCosmic, addEdge, getNodeStatuses, getNodeDeps, claimRandomPending } from "./src/db.ts";
import { validateNodeId, validateLines } from "./src/validate.ts";
import * as graph from "./src/graph.ts";
import { exportGraph } from "./src/export.ts";
import { importGraph } from "./src/import.ts";
import { pushGraph, pushSprints } from "./src/push.ts";
import { pullGraph, pullSprints } from "./src/pull.ts";

const ROOT = dirname(import.meta.path);
const [cmd, ...args] = process.argv.slice(2);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function rejectSpaces(id: string, context: string): void {
  if (id.includes(" ")) {
    die(`${context}: node ID must not contain spaces (use _ instead): "${id}"`);
  }
}

function usage(): never {
  console.log(`tracer — COSMIC call-graph CLI

Usage: tracer <command> [args...]

Setup:
  login                           Authenticate with Cosmotracer

Graph mutation (requires analysis/data/graph.db):
  seed <node_id> [...]            Create nodes as pending (skip if exist)
  claim <node_id>                 Claim a node for processing
  claim-random-pending            Atomically claim a random pending node
  done <node_id> [opts] [deps]    Mark node as analyzed
    --lines START:END               Line range in source file
    --cosmic E:n,R:n,W:n,X:n       COSMIC data movement counts
    --force                         Skip line validation errors
  unclaim <node_id>               Release a claimed node
  unclaim-all                     Release all exploring nodes
  rename <old> <new>              Rename a node, updating edges
  delete <node_id>                Delete a node and its edges
  merge <from> <into>             Merge from into into
  reparent <node> <old> <new>     Move node between parents
  add-edge <src> <dst>            Add a dependency edge from src to dst
  reset                           Delete all nodes and edges

Read-only queries (analysis/data/graph.db or graph.json):
  stats                           Node/edge counts and exploration breakdown
  status <node_id>                Print exploration state
  statuses <node_id> [...]        Print exploration state of multiple nodes
  deps <node_id>                  List direct dependencies with status
  remaining [--type TYPE]         List pending/exploring nodes
  tree <pattern>                  Tree view of dependency graph
  subprocess-tree <pattern>       Tree view of a subprocess
  touchpoints                     List all touchpoints with COSMIC
  functions [exploration]         List func: nodes
  dump                            Full graph as JSON

Export & sync:
  db-to-json                      Export graph.db → graph.json
  json-to-db                      Import graph.json → graph.db (resets DB)
  push graph                      Push graph.json to Cosmotracer
  push sprints                    Push sprints.json to Cosmotracer
  pull graph                      Pull graph.json from Cosmotracer
  pull sprints                    Pull sprints.json from Cosmotracer

Other:
  serve [--port PORT]             Live graph viewer (default: 3000)
  help                            Show this help`);
  process.exit(0);
}

// Commands that don't need a project context
if (cmd === "help" || cmd === "--help" || !cmd) usage();


if (cmd === "login") {
  await import("./src/login.ts");
  process.exit(0);
}



// All remaining commands need project context
let project: ReturnType<typeof resolveProject>;
try {
  project = resolveProject();
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}

try {
switch (cmd) {
  // ── Graph mutation ────────────────────────────────────────────────

  case "seed": {
    if (args.length === 0) die("usage: tracer seed <node_id> [node_id...]");
    for (const id of args) rejectSpaces(id, "seed");
    const db = openDb(project.dbPath);
    seedNodes(db, args.map(id => ({ node_id: id })));
    db.close();
    console.log(`${args.length} nodes seeded`);
    break;
  }

  case "claim": {
    const [id] = args;
    if (!id) die("usage: tracer claim <node_id>");
    rejectSpaces(id, "claim");
    validateNodeId(project.codePath, id, project.language);
    const db = openDb(project.dbPath);
    const ok = claimNode(db, id);
    db.close();
    console.log(ok ? "ok" : "taken");
    break;
  }

  case "done": {
    const [id, ...rest] = args;
    if (!id) die("usage: tracer done <node_id> --lines START:END --cosmic E:n,R:n,W:n,X:n [--force] [deps...]");
    rejectSpaces(id, "done");
    validateNodeId(project.codePath, id, project.language);

    let lineStart: number | null = null;
    let lineEnd: number | null = null;
    let E = 0, R = 0, W = 0, X = 0;
    let force = false;
    let deps = [...rest];
    let hasCosmic = false;

    const forceIdx = deps.indexOf("--force");
    if (forceIdx !== -1) { force = true; deps.splice(forceIdx, 1); }

    const linesIdx = deps.indexOf("--lines");
    if (linesIdx !== -1) {
      const span = deps[linesIdx + 1];
      if (!span || !span.includes(":")) die("--lines requires START:END (e.g. --lines 14:28)");
      [lineStart, lineEnd] = span.split(":").map(Number);
      deps.splice(linesIdx, 2);
    }

    const cosmicIdx = deps.indexOf("--cosmic");
    if (cosmicIdx !== -1) {
      hasCosmic = true;
      const scores = deps[cosmicIdx + 1];
      if (!scores) die("--cosmic requires scores (e.g. --cosmic E:1,R:2,W:0,X:1)");
      for (const s of scores.split(",")) {
        const [key, val] = s.split(":");
        const n = parseInt(val, 10);
        if (isNaN(n)) die(`invalid cosmic score: ${s}`);
        if (key === "E") E = n;
        else if (key === "R") R = n;
        else if (key === "W") W = n;
        else if (key === "X") X = n;
      }
      deps.splice(cosmicIdx, 2);
    }

    const nonCosmicPrefixes = ["endpoint:", "subprocess:", "page:", "command:", "listener:", "database:"];
    if (hasCosmic && nonCosmicPrefixes.some(p => id.startsWith(p))) {
      die(`${id}: touchpoint/subprocess nodes must not carry COSMIC annotations (only func: nodes carry COSMIC)`);
    }

    // Strict validation: func: nodes require --lines and --cosmic unless --force is provided
    if (id.startsWith("func:") && !force) {
      if (lineStart === null || lineEnd === null) {
        die(`${id}: func: nodes require --lines START:END (use --force to override)`);
      }
      if (!hasCosmic) {
        die(`${id}: func: nodes require --cosmic E:n,R:n,W:n,X:n (use --force to override)`);
      }
    }

    if (lineStart !== null && lineEnd !== null && hasCosmic) {
      const loc = lineEnd - lineStart + 1;
      const cfp = E + R + W + X;
      if (loc <= 5 && cfp > 5) {
        console.error(`warning: ${id}: ${cfp} CFP in ${loc} LOC — are these data movements in this function or delegated to callees?`);
      }
    }

    // Check for COSMIC changes on already-analyzed nodes
    if (hasCosmic) {
      const db = openDb(project.dbPath);
      const existing = getNodeCosmic(db, id);
      if (existing && existing.exploration === "analyzed") {
        if (existing.e !== E || existing.r !== R || existing.w !== W || existing.x !== X) {
          console.error(`warning: ${id}: COSMIC changed from E:${existing.e},R:${existing.r},W:${existing.w},X:${existing.x} to E:${E},R:${R},W:${W},X:${X}`);
        }
      }
      db.close();
    }

    let verification: string | null = null;
    let warnings: string | null = null;
    if (id.startsWith("func:") && lineStart !== null && lineEnd !== null) {
      const result = validateLines(project.codePath, id, lineStart, lineEnd);
      if (!result.valid) {
        if (!force) {
          for (const w of result.warnings) console.error(`error: ${w}`);
          process.exit(1);
        }
        verification = "unverified";
        warnings = JSON.stringify(result.warnings);
      } else {
        verification = "verified";
      }
    }

    for (const dep of deps) {
      rejectSpaces(dep, "done (dep)");
      validateNodeId(project.codePath, dep, project.language);
    }

    const db = openDb(project.dbPath);
    const depStatuses = doneNode(db, id, {
      lineStart, lineEnd,
      e: E, r: R, w: W, x: X,
      verification, warnings,
    }, deps);
    db.close();
    console.log("ok");
    for (const { node_id, exploration } of depStatuses) {
      console.log(`${exploration}\t${node_id}`);
    }
    break;
  }

  case "unclaim": {
    const [id] = args;
    if (!id) die("usage: tracer unclaim <node_id>");
    rejectSpaces(id, "unclaim");
    const db = openDb(project.dbPath);
    unclaimNode(db, id);
    db.close();
    console.log("ok");
    break;
  }

  case "unclaim-all": {
    const db = openDb(project.dbPath);
    const count = unclaimAll(db);
    db.close();
    console.log(`${count} nodes unclaimed`);
    break;
  }

  case "rename": {
    const [oldId, newId] = args;
    if (!oldId || !newId) die("usage: tracer rename <old_id> <new_id>");
    rejectSpaces(newId, "rename");
    validateNodeId(project.codePath, newId, project.language);
    const db = openDb(project.dbPath);
    try {
      if (!renameNode(db, oldId, newId)) { db.close(); die(`node not found: ${oldId}`); }
    } catch (e: any) { db.close(); die(e.message); }
    db.close();
    console.log(`renamed: ${oldId} → ${newId}`);
    break;
  }

  case "delete": {
    const [id] = args;
    if (!id) die("usage: tracer delete <node_id>");
    rejectSpaces(id, "delete");
    const db = openDb(project.dbPath);
    const { deleted, orphans } = deleteNode(db, id);
    db.close();
    if (!deleted) die(`node not found: ${id}`);
    for (const o of orphans) console.error(`warning: ${o} is now an orphan`);
    console.log(`deleted: ${id}`);
    break;
  }

  case "merge": {
    const [fromId, intoId] = args;
    if (!fromId || !intoId) die("usage: tracer merge <from_id> <into_id>");
    const db = openDb(project.dbPath);
    try { mergeNodes(db, fromId, intoId); }
    catch (e: any) { db.close(); die(e.message); }
    db.close();
    console.log(`merged: ${fromId} → ${intoId}`);
    break;
  }

  case "reparent": {
    const [nodeId, oldParent, newParent] = args;
    if (!nodeId || !oldParent || !newParent) die("usage: tracer reparent <node_id> <old_parent> <new_parent>");
    const db = openDb(project.dbPath);
    try { reparentNode(db, nodeId, oldParent, newParent); }
    catch (e: any) { db.close(); die(e.message); }
    db.close();
    console.log(`reparented: ${nodeId} from ${oldParent} → ${newParent}`);
    break;
  }

  case "add-edge": {
    const [src, dst] = args;
    if (!src || !dst) die("usage: tracer add-edge <src> <dst>");
    rejectSpaces(src, "add-edge (src)");
    rejectSpaces(dst, "add-edge (dst)");
    validateNodeId(project.codePath, src, project.language);
    validateNodeId(project.codePath, dst, project.language);
    const db = openDb(project.dbPath);
    try { addEdge(db, src, dst); }
    catch (e: any) { db.close(); die(e.message); }
    db.close();
    console.log(`edge added: ${src} → ${dst}`);
    break;
  }

  case "claim-random-pending": {
    const db = openDb(project.dbPath);
    const claimed = claimRandomPending(db);
    db.close();
    console.log(claimed ? `${claimed} (claimed for you - process immediately)` : "none");
    break;
  }

  case "reset": {
    const db = openDb(project.dbPath);
    resetDb(db);
    db.close();
    console.log("graph reset");
    break;
  }

  // ── Read-only queries ─────────────────────────────────────────────

  case "stats":
    graph.stats(project);
    break;

  case "status": {
    const [id] = args;
    if (!id) die("usage: tracer status <node_id>");
    graph.status(project, id);
    break;
  }

  case "statuses": {
    if (args.length === 0) die("usage: tracer statuses <node_id> [node_id...]");
    const db = openDb(project.dbPath);
    const statuses = getNodeStatuses(db, args);
    db.close();
    for (const { node_id, exploration } of statuses) {
      console.log(`${exploration}\t${node_id}`);
    }
    break;
  }

  case "deps": {
    const [id] = args;
    if (!id) die("usage: tracer deps <node_id>");
    const db = openDb(project.dbPath);
    const deps = getNodeDeps(db, id);
    db.close();
    for (const { node_id, exploration } of deps) {
      console.log(`${exploration}\t${node_id}`);
    }
    break;
  }

  case "remaining": {
    let typeFilter: string | undefined;
    const typeIdx = args.indexOf("--type");
    if (typeIdx !== -1) {
      typeFilter = args[typeIdx + 1];
      if (!typeFilter) die("--type requires a value (func, endpoint, page, command, listener, database, table)");
    }
    graph.remaining(project, typeFilter);
    break;
  }

  case "tree": {
    const [pattern] = args;
    if (!pattern) die("usage: tracer tree <node-pattern>");
    graph.tree(project, pattern);
    break;
  }

  case "subprocess-tree": {
    const [pattern] = args;
    if (!pattern) die("usage: tracer subprocess-tree <subprocess-pattern>");
    graph.subprocessTree(project, pattern);
    break;
  }

  case "touchpoints":
  case "endpoints":
    graph.touchpoints(project);
    break;

  case "functions":
    graph.functions(project, args[0]);
    break;

  case "dump":
    graph.dump(project);
    break;

  // ── Export & push ─────────────────────────────────────────────────

  case "db-to-json":
  case "export":
    exportGraph(project);
    break;

  case "json-to-db":
  case "import":
    importGraph(project);
    break;

  case "push": {
    const [target] = args;
    if (target === "graph") await pushGraph(project);
    else if (target === "sprints") await pushSprints(project);
    else die("usage: tracer push <graph|sprints>");
    break;
  }

  case "pull": {
    const [target] = args;
    if (target === "graph") await pullGraph(project);
    else if (target === "sprints") await pullSprints(project);
    else die("usage: tracer pull <graph|sprints>");
    break;
  }

  case "serve": {
    const portIdx = args.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3000;
    const { serve } = await import("./src/serve.ts");
    serve(project, port);
    break;
  }

  default:
    die(`Unknown command: ${cmd}. Run 'tracer help' for usage.`);
}
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}
