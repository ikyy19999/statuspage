const DISPLAY_NAMES = {
  aa30f6893c27e5421ac3ef4471fca386: "Sportix",
  197f125b46a6449c2d034beb044a6e34: "Portfolio",
};

const STATUS_PAGE_MONITOR_IDS = Object.keys(DISPLAY_NAMES);
const { getMonitorStats } = require("./hetrix/stats");

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

async function readMonitor(monitorId) {
  const monitorRaw = await redis(["GET", `hetrix:monitor:${monitorId}`]);
  if (!monitorRaw) return null;

  const monitor = typeof monitorRaw === "string" ? JSON.parse(monitorRaw) : monitorRaw;
  const name = displayName({ ...monitor, monitor_id: monitorId });

  monitor.monitor_id = monitorId;
  monitor.display_name = name;
  monitor.monitor_name = name;

  try {
    monitor.stats = await getMonitorStats(monitorId);
  } catch (statsError) {
    console.error(`stats error for ${monitorId}`, statsError);
    monitor.stats = null;
  }

  return monitor;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const redisMonitorIds = (await redis(["SMEMBERS", "hetrix:monitors"])) || [];

    // Always read the monitors configured for this status page. Redis membership
    // is only used to include any additional monitors that are not mapped here.
    const monitorIds = [
      ...STATUS_PAGE_MONITOR_IDS,
      ...redisMonitorIds.filter((id) => !STATUS_PAGE_MONITOR_IDS.includes(id)),
    ];

    const monitors = [];
    const active_incidents = [];

    for (const monitorId of monitorIds) {
      const monitor = await readMonitor(monitorId);
      const incidentRaw = await redis(["GET", `hetrix:incident:${monitorId}`]);

      if (monitor) monitors.push(monitor);

      if (incidentRaw && STATUS_PAGE_MONITOR_IDS.includes(monitorId)) {
        const incident = typeof incidentRaw === "string" ? JSON.parse(incidentRaw) : incidentRaw;
        incident.monitor_id = monitorId;
        incident.display_name =
          DISPLAY_NAMES[monitorId] || incident.display_name || incident.monitor_name;
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
