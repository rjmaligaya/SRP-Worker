// Cloudflare Worker: accept POSTed CSV/JSON/multipart and store in R2
// Binding required in wrangler.toml: [vars] / [[r2_buckets]] binding = "DATA_BUCKET"

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method Not Allowed" }, 405, origin);
    }

    try {
      const ct = (request.headers.get("content-type") || "").toLowerCase();

      let filename = "";
      let data = "";
      let contentType = "text/csv";

      if (ct.includes("application/json")) {
        const body = await request.json();
        filename = String(body?.filename || `upload_${Date.now()}.csv`);
        contentType = String(body?.contentType || "text/csv");
        const raw = body?.data;
        if (raw === undefined || raw === null) {
          data = "";
        } else if (typeof raw === "string") {
          data = raw;
        } else {
          // If data is an object/array, store its JSON representation
          data = JSON.stringify(raw);
          if (!contentType) contentType = "application/json";
        }
      } else if (ct.includes("text/plain") || ct.includes("text/csv")) {
        const text = await request.text();
        filename = `upload_${Date.now()}.csv`;
        data = text;
        contentType = ct.includes("text/csv") ? "text/csv" : "text/plain";
      } else if (ct.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        const suppliedName = form.get("filename");
        if (suppliedName && typeof suppliedName === "string") {
          filename = suppliedName;
        }
        if (file && typeof file === "object" && "text" in file) {
          // @ts-ignore - File from runtime implements .text() and .type
          data = await file.text();
          // @ts-ignore
          contentType = file.type || "text/csv";
          // @ts-ignore
          if (!filename && typeof file.name === "string") filename = file.name;
        } else {
          // Allow plain field 'data' in multipart as a fallback
          const fallback = form.get("data");
          if (fallback != null) data = String(fallback);
          filename ||= `upload_${Date.now()}.csv`;
        }
      } else {
        return json({ ok: false, error: "Unsupported Content-Type" }, 415, origin);
      }

      if (!filename || data === "") {
        return json({ ok: false, error: "Missing filename or data" }, 400, origin);
      }

      // Normalize and sanitize the key a bit
      const key = String(filename)
        .replace(/[\r\n]/g, " ")
        .replace(/[\/\\]+/g, "_")
        .trim();

      // Store to R2. Strings are accepted directly by put().
      await env.DATA_BUCKET.put(key, data, {
        httpMetadata: { contentType: contentType || "text/csv" },
      });

      return json({ ok: true, key }, 200, origin);
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500, request.headers.get("Origin") || "*");
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(origin),
    },
  });
}
