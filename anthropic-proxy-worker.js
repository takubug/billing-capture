/**
 * Cloudflare Worker — Anthropic API Proxy for BillingCapture
 *
 * Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
 * Then add your API key as a secret:
 *   Settings → Variables → Add variable (type: Secret)
 *   Name: ANTHROPIC_API_KEY  Value: sk-ant-...
 *
 * Set ALLOWED_ORIGIN below to your GitHub Pages URL to lock it down.
 */

const ALLOWED_ORIGIN = "https://takubug.github.io";  // ← your GitHub Pages origin

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Only accept requests from your GitHub Pages site
    if (!origin.startsWith(ALLOWED_ORIGIN)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const body = await request.json();

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const data = await anthropicRes.json();

      return new Response(JSON.stringify(data), {
        status: anthropicRes.status,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin),
        },
      });
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
