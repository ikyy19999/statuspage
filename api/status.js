const DISPLAY_NAMES = {
  aa30f6893c27e5421ac3ef4471fca386: "Sportix",
};

const SPORTIX_MONITOR_ID = "aa30f6893c27e5421ac3ef4471fca386";
const { getSportixStats } = require("./hetrix/stats");

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) throw new Error("Redis environment variables are missing");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) throw new Error(`Redis request failed: ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function displayName(monitor) {
  return DISPLAY_NAMES[monitor.monitor_id] || monitor.monitor_name;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const ids = (await redis(["SMEMBERS", "hetrix:monitors"])) || [];
    const monitors = [];
    const active_incidents = [];

    for (const monitorId of ids) {
      const monitorRaw = await redis(["GET", `hetrix:monitor:${monitorId}`]);
      const incidentRaw = await redis(["GET", `hetrix:incident:${monitorId}`]);

      if (monitorRaw) {
        const monitor = typeof monitorRaw === "string" ? JSON.parse(monitorRaw) : monitorRaw;
        monitor.display_name = displayName(monitor);

        if (monitor.monitor_id === SPORTIX_MONITOR_ID) {
          const activeIncident = incidentRaw
            ? typeof incidentRaw === "string" ? JSON.parse(incidentRaw) : incidentRaw
            : null;

          try {
            monitor.stats = await getSportixStats(activeIncident);
          } catch (statsError) {
            console.error("sportix stats error", statsError);
            monitor.stats = null;
          }
        }

        monitors.push(monitor);
      }

      if (incidentRaw) {
        const incident = typeof incidentRaw === "string" ? JSON.parse(incidentRaw) : incidentRaw;
        incident.display_name =
          DISPLAY_NAMES[incident.monitor_id] || incident.display_name || incident.monitor_name;
        active_incidents.push(incident);
      }
    }

    return json(res, 200, {
      ok: true,
      checked_at: new Date().toISOString(),
      monitors,
      active_incidents,
    });
  } catch (error) {
    console.error("status api error", error);
    return json(res, 500, {
      ok: false,
      error: "Unable to read live status",
    });
  }
};
