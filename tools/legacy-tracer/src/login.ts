#!/usr/bin/env bun
/**
 * login — Authenticate with Cosmotracer using email/password.
 *
 * Usage: bin/tracer login
 *
 * Prompts for email and password, authenticates against Supabase,
 * and saves the session to .session (gitignored).
 */
import { resolve, dirname } from "path";
import { writeFileSync } from "fs";

const ROOT = resolve(dirname(import.meta.path), "..");
const SESSION_FILE = resolve(ROOT, ".session");

const URL = "https://odsnywvvltevmtusiciz.supabase.co";
const ANON_KEY = "sb_publishable_SBFjHLT-ldsRFNcmqEm7dA_B0te6uY5";

// Prompt for credentials
console.log("Enter your Cosmotracer credentials (cosmotracer.vercel.app)\n");
process.stdout.write("Email: ");
const email = (await new Promise<string>((resolve) => {
  process.stdin.once("data", (data) => resolve(data.toString().trim()));
}));

process.stdout.write("Password: ");
process.stdin.setRawMode(true);
let pwBuf = "";
const password = await new Promise<string>((resolve) => {
  process.stdin.on("data", (data) => {
    const ch = data.toString();
    if (ch === "\r" || ch === "\n") {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners("data");
      process.stdout.write("\n");
      resolve(pwBuf);
    } else if (ch === "\x7f" || ch === "\b") {
      pwBuf = pwBuf.slice(0, -1);
    } else if (ch === "\x03") {
      process.exit(1);
    } else {
      pwBuf += ch;
    }
  });
});

// Authenticate
const resp = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
  },
  body: JSON.stringify({ email, password }),
});

if (!resp.ok) {
  const err = await resp.json();
  console.error(`Login failed: ${err.error_description || err.msg || resp.statusText}`);
  process.exit(1);
}

const session = await resp.json();

writeFileSync(
  SESSION_FILE,
  JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
  }, null, 2)
);

console.log(`Logged in as ${session.user.email}. Session saved to ${SESSION_FILE}`);
process.exit(0);
