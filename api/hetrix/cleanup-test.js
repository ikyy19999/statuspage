export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return res.status(500).json({
      ok: false,
      error: "Missing KV_REST_API_URL or KV_REST_API_TOKEN",
    });
  }

  const monitorId = "ThisWillBeTheMonitorID32CharLong";
  const key = `hetrix:incident:${monitorId}`;

  const response = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    return res.status(502).json({
      ok: false,
      error: "Redis request failed",
      details,
    });
  }

  const data = await response.json();

  return res.status(200).json({
    ok: true,
    deleted: data.result === 1,
    key,
  });
}
