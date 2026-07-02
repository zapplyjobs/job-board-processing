// supabase/functions/publish-metrics/index.ts
//
// Receives the 8 pipeline metric blobs (POSTed by the GitHub workflow, which reads them via
// git checkout — NOT raw-GitHub) and upserts them to the pipeline_metrics table.
//
// WHY THIS EXISTS: so the sensitive SUPABASE_SERVICE_ROLE_KEY lives ONLY in Supabase's own
// secret store — GitHub Actions never sees it. GitHub holds just PUBLISH_SECRET (a lightweight
// shared secret for calling this function). Direction: projects/zjp/docs/dash/DASH_DIRECTION.md.
//
// Deploy (operator):  supabase functions deploy publish-metrics --project-ref xxmhgagpbxjflajoaahy
// Set its secrets:    supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<the key> PUBLISH_SECRET=<a random string> --project-ref xxmhgagpbxjflajoaahy
// GitHub then only needs: PUBLISH_SECRET (the same random string) as a repo secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PUBLISH_SECRET = Deno.env.get("PUBLISH_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://xxmhgagpbxjflajoaahy.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed (POST only)" }, 405);
  if (!PUBLISH_SECRET || !SERVICE_KEY) return json({ error: "function misconfigured (secrets missing)" }, 500);

  let body: { secret?: string; blobs?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (body?.secret !== PUBLISH_SECRET) return json({ error: "forbidden" }, 403);
  const blobs = body?.blobs;
  if (!blobs || typeof blobs !== "object") return json({ error: "missing blobs" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows = Object.entries(blobs).map(([key, data]) => ({ key, data }));
  const { error } = await sb.from("pipeline_metrics").upsert(rows, { onConflict: "key" });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, count: rows.length });
});
