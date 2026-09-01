const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;
const HETRIX_TOKEN = process.env.HETRIX_WEBHOOK_TOKEN;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function redis(command) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("Upstash environment variables are missing");
  }

  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`Upstash returned HTTP ${response.status}`);
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(result.error);
  }

  return result.result;
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function normalizeStatus(status) {
  return status === "online" ? "operational" : "major_outage";
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      ok: true,
      service: "hetrix-webhook",
      message: "Webhook endpoint is ready.",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!HETRIX_TOKEN) {
    return json(res, 500, {
      ok: false,
      error: "HETRIX_WEBHOOK_TOKEN is not configured",
    });
  }

  if (getBearerToken(req) !== HETRIX_TOKEN) {
    return json(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const payload = req.body || {};

    if (!payload.monitor_id || !payload.monitor_name || !payload.monitor_status) {
      return json(res, 400, {
        ok: false,
        error: "Invalid HetrixTools payload",
      });
    }

    if (!["online", "offline"].includes(payload.monitor_status)) {
      return json(res, 400, {
        ok: false,
        error: "Unsupported monitor status",
      });
    }

    const monitor = {
      monitor_id: String(payload.monitor_id),
      monitor_name: String(payload.monitor_name),
      monitor_target: payload.monitor_target ? String(payload.monitor_target) : "",
      monitor_type: payload.monitor_type ? String(payload.monitor_type) : "",
      monitor_category: payload.monitor_category ? String(payload.monitor_category) : "",
      monitor_status: payload.monitor_status,
      status: normalizeStatus(payload.monitor_status),
      timestamp: Number(payload.timestamp) || Math.floor(Date.now() / 1000),
      monitor_errors: payload.monitor_errors || {},
      updated_at: new Date().toISOString(),
    };

    const key = `hetrix:monitor:${monitor.monitor_id}`;

    await redis(["SET", key, JSON.stringify(monitor)]);
    await redis(["SADD", "hetrix:monitors", monitor.monitor_id]);

    if (monitor.monitor_status === "offline") {
      const incidentKey = `hetrix:incident:${monitor.monitor_id}`;
      const existingIncident = await redis(["GET", incidentKey]);

      if (!existingIncident) {
        await redis([
          "SET",
          incidentKey,
          JSON.stringify({
            monitor_id: monitor.monitor_id,
            monitor_name: monitor.monitor_name,
            started_at: monitor.timestamp,
            started_at_iso: new Date(monitor.timestamp * 1000).toISOString(),
          }),
        ]);
      }
    } else {
      await redis(["DEL", `hetrix:incident:${monitor.monitor_id}`]);
    }

    return json(res, 200, {
      ok: true,
      monitor_id: monitor.monitor_id,
      monitor_status: monitor.monitor_status,
    });
  } catch (error) {
    console.error("HetrixTools webhook error:", error);
    return json(res, 500, {
      ok: false,
      error: "Failed to process webhook",
    });
  }
}
