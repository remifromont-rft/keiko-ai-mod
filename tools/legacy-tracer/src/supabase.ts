/**
 * Shared Supabase client for pushing data to cosmotracer.
 * Uses user session (from `bin/tracer login`) with RLS.
 *
 * URL and anon key are public values (same as the web app's client-side config).
 * Security is enforced by RLS, not by hiding these.
 */
import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

const ROOT = resolve(dirname(import.meta.path), "..");
const SESSION_FILE = resolve(ROOT, ".session");

const URL = "https://odsnywvvltevmtusiciz.supabase.co";
const ANON_KEY = "sb_publishable_SBFjHLT-ldsRFNcmqEm7dA_B0te6uY5";

async function getAccessToken(): Promise<string> {
  if (!existsSync(SESSION_FILE)) {
    console.error("Not logged in. Run: bin/tracer login");
    process.exit(1);
  }

  const session = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  const now = Math.floor(Date.now() / 1000);

  // If token expires in less than 60 seconds, refresh it
  if (session.expires_at - now < 60) {
    const resp = await fetch(`${URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!resp.ok) {
      console.error("Session expired. Run: bin/tracer login");
      process.exit(1);
    }

    const newSession = await resp.json();
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({
        access_token: newSession.access_token,
        refresh_token: newSession.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + newSession.expires_in,
      }, null, 2)
    );
    return newSession.access_token;
  }

  return session.access_token;
}

function headers(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function supabasePost(path: string, body: unknown) {
  const token = await getAccessToken();
  const resp = await fetch(`${URL}/rest/v1/rpc/${path}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase RPC ${path} failed (${resp.status}): ${text}`);
  }
  return resp;
}

export async function supabaseQuery(table: string, params: string) {
  const token = await getAccessToken();
  const allRows: any[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const h = headers(token);
    h["Range"] = `${offset}-${offset + pageSize - 1}`;
    h["Prefer"] = "count=exact";
    const resp = await fetch(`${URL}/rest/v1/${table}?${params}`, { headers: h });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Supabase query ${table} failed (${resp.status}): ${text}`);
    }
    const rows = await resp.json();
    allRows.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return allRows;
}

export async function supabaseUpsert(table: string, body: unknown, onConflict?: string) {
  const token = await getAccessToken();
  const h = headers(token);
  h["Prefer"] = "resolution=merge-duplicates,return=representation";
  const queryStr = onConflict ? `?on_conflict=${onConflict}` : "";
  const resp = await fetch(`${URL}/rest/v1/${table}${queryStr}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase upsert ${table} failed (${resp.status}): ${text}`);
  }
  return resp;
}

export async function supabaseInsertIgnore(table: string, body: unknown, onConflict?: string) {
  const token = await getAccessToken();
  const h = headers(token);
  h["Prefer"] = "resolution=ignore-duplicates";
  const queryStr = onConflict ? `?on_conflict=${onConflict}` : "";
  const resp = await fetch(`${URL}/rest/v1/${table}${queryStr}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase insert-ignore ${table} failed (${resp.status}): ${text}`);
  }
  return resp;
}

export async function supabasePatch(table: string, params: string, body: unknown) {
  const token = await getAccessToken();
  const resp = await fetch(`${URL}/rest/v1/${table}?${params}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase patch ${table} failed (${resp.status}): ${text}`);
  }
  return resp;
}

export async function supabaseInsert(table: string, body: unknown) {
  const token = await getAccessToken();
  const resp = await fetch(`${URL}/rest/v1/${table}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase insert ${table} failed (${resp.status}): ${text}`);
  }
  return resp;
}

export async function supabaseDelete(table: string, params: string) {
  const token = await getAccessToken();
  const resp = await fetch(`${URL}/rest/v1/${table}?${params}`, {
    method: "DELETE",
    headers: headers(token),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase delete ${table} failed (${resp.status}): ${text}`);
  }
  return resp;
}
