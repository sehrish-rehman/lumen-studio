// Supabase Edge Function: "ai"
// Powers Lumen Studio's AI features (layout, text, palette, image).
// Secrets used (set in Supabase → Project Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  -> required for: generate-layout, write-text, palette
//   OPENAI_API_KEY     -> required for: generate-image
// Deploy with JWT verification ON so only signed-in users can call it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

async function claude(system: string, user: string, maxTokens = 1500): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()).slice(0, 300));
  const data = await r.json();
  return (data.content?.[0]?.text ?? "").trim();
}

function extractJson(s: string): any {
  // tolerate code fences / prose around the JSON
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : s;
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

const LAYOUT_SYSTEM = `You are a senior UI/graphic designer that outputs design layouts as STRICT JSON for a vector canvas.
Return ONLY a JSON object: {"shapes":[ ... ]} with 5-14 shapes. No prose, no markdown.
Coordinate system: origin top-left, units = pixels, within the given canvas width/height. Keep all shapes inside the canvas with sensible margins.
Each shape is one of:
  {"type":"rect","x":,"y":,"w":,"h":,"fill":"#RRGGBB","radius":0}
  {"type":"ellipse","x":,"y":,"w":,"h":,"fill":"#RRGGBB"}
  {"type":"line","x":,"y":,"x2":,"y2":,"stroke":"#RRGGBB","strokeWidth":2}
  {"type":"text","x":,"y":,"w":,"text":"...","fontSize":,"weight":400-800,"align":"left|center|right","fill":"#RRGGBB"}
Design tastefully: a background or banner rect, clear visual hierarchy, readable contrast, a cohesive palette, and real copy (not lorem ipsum). Use large headings and smaller body text. Prefer a few strong shapes over clutter.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Require a real signed-in user (role "authenticated"), not just the public anon/apikey,
  // so the embedded publishable key can't be used by strangers to burn your API credits.
  const authz = req.headers.get("authorization") || "";
  const jwt = authz.replace(/^Bearer\s+/i, "");
  let role: string | null = null;
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    role = payload.role ?? null;
  } catch { role = null; }
  if (role !== "authenticated") return json({ error: "Sign in required to use AI." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = body.action as string;
  const prompt = (body.prompt ?? "").toString().slice(0, 2000);
  const w = Math.max(200, Math.min(4000, Number(body.w) || 1280));
  const h = Math.max(200, Math.min(4000, Number(body.h) || 720));

  try {
    if (action === "generate-layout") {
      if (!ANTHROPIC_KEY) return json({ error: "AI not configured: set the ANTHROPIC_API_KEY secret." });
      const user = `Canvas size: ${w}x${h} px.\nDesign brief: ${prompt}\nReturn the JSON now.`;
      const out = await claude(LAYOUT_SYSTEM, user, 2000);
      const parsed = extractJson(out);
      const shapes = Array.isArray(parsed.shapes) ? parsed.shapes.slice(0, 24) : [];
      return json({ shapes });
    }
    if (action === "write-text") {
      if (!ANTHROPIC_KEY) return json({ error: "AI not configured: set the ANTHROPIC_API_KEY secret." });
      const sys = "You are a concise copywriter. Return ONLY the requested text, no quotes, no preamble. Keep it tight and high-quality.";
      const out = await claude(sys, prompt, 500);
      return json({ text: out.replace(/^["']|["']$/g, "") });
    }
    if (action === "palette") {
      if (!ANTHROPIC_KEY) return json({ error: "AI not configured: set the ANTHROPIC_API_KEY secret." });
      const sys = `Return ONLY JSON {"palette":["#RRGGBB", ... 5 colors]} for the described mood/brand. Cohesive, usable, good contrast. No prose.`;
      const out = await claude(sys, prompt || "a modern, friendly brand palette", 300);
      const parsed = extractJson(out);
      const palette = (parsed.palette || []).filter((c: string) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8);
      return json({ palette });
    }
    if (action === "generate-image") {
      if (!OPENAI_KEY) return json({ error: "Image generation not configured: set the OPENAI_API_KEY secret." });
      const r = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OPENAI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1", prompt: prompt.slice(0, 1000), size: "1024x1024", n: 1 }),
      });
      if (!r.ok) return json({ error: "OpenAI " + r.status + ": " + (await r.text()).slice(0, 200) });
      const data = await r.json();
      const b64 = data.data?.[0]?.b64_json;
      const url = data.data?.[0]?.url;
      return json({ imageDataUrl: b64 ? "data:image/png;base64," + b64 : null, imageUrl: url ?? null });
    }
    return json({ error: "Unknown action: " + action }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "AI request failed" }, 200);
  }
});
