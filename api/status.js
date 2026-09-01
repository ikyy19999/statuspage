const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const monitorIds = (await redis(["SMEMBERS", "hetrix:monitors"])) || [];

    const monitors = await Promise.all(
      monitorIds.map((monitorId) => redis(["GET", `hetrix:monitor:${monitorId}`])),
    );

    const activeIncidents = await Promise.all(
      monitorIds.map(async (monitorId) => {
        const raw = await redis(["GET", `hetrix:incident:${monitorId}`]);
        return raw ? JSON.parse(raw) : null;
      }),
    );

    return json(res, 200, {
      ok: true,
      checked_at: new Date().toISOString(),
      monitors: monitors.filter(Boolean).map((item) => JSON.parse(item)),
      active_incidents: activeIncidents.filter(Boolean),
    });
  } catch (error) {
    console.error("Status API error:", error);
    return json(res, 500, {
      ok: false,
      error: "Unable to load live status",
    });
  }
}
