// Cloudflare Worker: forwards requests from the Framing Lab page to Anthropic.
// Deploy: https://dash.cloudflare.com > Workers & Pages > Create > paste this file.
// Then add a secret named ANTHROPIC_API_KEY under Settings > Variables and Secrets.
// Optional: restrict ALLOWED_ORIGIN to your GitHub Pages URL.

const ALLOWED_ORIGIN = "https://unnatinarang.github.io";

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    const body = await request.json();
    // Guardrails so the key can only be used for this tool.
    body.model = "claude-sonnet-4-6";
    body.max_tokens = Math.min(body.max_tokens || 1000, 2000);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
