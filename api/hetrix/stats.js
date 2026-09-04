const MONITOR_CONFIG = {
  "aa30f6893c27e5421ac3ef4471fca386": {},
  "197f125b46a6449c2d034beb044a6e34": {
    regions: ["New_York", "Singapore", "Tokyo", "Mumbai"],
  },
};

const CACHE_TTL_SECONDS = 60;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

// HetrixTools v1 Uptime Report API.
// The report contains the uptime shown by HetrixTools plus response times
// for the monitor's configured monitoring locations.
async function hetrixReport(monitorId) {
  const token = process.env.HETRIX_API_KEY;
  if (!token) throw new Error("HETRIX_API_KEY is not configured");

  const response = await fetch(
    `https://api.hetrixtools.com/v1/${encodeURIComponent(token)}/uptime/report/${encodeURIComponent(monitorId)}/`,
    {
      headers: { Accept: "application/json" },
    },
  );

  if (!response.ok) {
    throw new Error(`HetrixTools API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.status === "ERROR" || payload?.error_message) {
    throw new Error(payload.error_message || "HetrixTools API returned an error");
  }

  return payload;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumeric(...values) {
  for (const value of values) {
    const number = numeric(value);
    if (number !== null) return number;
  }
  return null;
}

function formatResponseTime(value) {
  const number = numeric(value);
  if (number === null) return "Unavailable";
  if (number >= 1000) {
    const seconds = number / 1000;
    return `${Number(seconds.toFixed(2))} sec`;
  }
  return `${Math.round(number)} ms`;
}

function formatUptime(value) {
  const number = numeric(value);
  if (number === null) return null;
  return `${number}%`;
}

const REGION_LABELS = {
  New_York: "New York",
  San_Francisco: "San Francisco",
  Dallas: "Dallas",
  Amsterdam: "Amsterdam",
  London: "London",
  Frankfurt: "Frankfurt",
  Singapore: "Singapore",
  Sydney: "Sydney",
  Sao_Paulo: "Sao Paulo",
  Tokyo: "Tokyo",
  Mumbai: "Mumbai",
  Warsaw: "Warsaw",
};

function extractResponseTimes(report, allowedRegions) {
  const source =
    report?.Response_Time ||
    report?.ResponseTime ||
    report?.response_time ||
    report?.summary?.response_time ||
    {};

  return Object.entries(source)
    .filter(([key]) => !allowedRegions || allowedRegions.includes(key))
    .map(([key, value]) => ({
      key,
      label: REGION_LABELS[key] || key.replace(/_/g, " "),
      value: numeric(value),
    }))
    .filter((item) => item.value !== null && item.value > 0);
}

function getUptime(report) {
  const candidates = [
    report?.Uptime_Stats?.Total?.Uptime,
    report?.Uptime_Stats?.total?.uptime,
    report?.uptime_stats?.Total?.Uptime,
    report?.uptime_stats?.total?.uptime,
    report?.Uptime,
    report?.uptime,
  ];

  return firstNumeric(...candidates);
}


function normalizeMonitorStatus(value) {
  const status = String(value || "").toLowerCase().trim();
  if (["online", "up", "operational", "ok", "passing", "available"].includes(status)) return "operational";
  if (["offline", "down", "major_outage", "failing", "failed", "unavailable"].includes(status)) return "major_outage";
  if (["degraded", "warning", "partial_outage"].includes(status)) return status === "warning" ? "degraded" : status;
  return null;
}

function getCurrentStatus(report) {
  const candidates = [
    report?.Global_Status,
    report?.GlobalStatus,
    report?.global_status,
    report?.Status,
    report?.status,
    report?.Uptime_Stats?.Total?.Status,
    report?.Uptime_Stats?.Total?.status,
    report?.Uptime_Stats?.total?.Status,
    report?.Uptime_Stats?.total?.status,
  ];

  for (const value of candidates) {
    const normalized = normalizeMonitorStatus(value);
    if (normalized) return normalized;
  }

  return null;
}

function buildStats(report, config = {}) {
  const responseTimes = extractResponseTimes(report, config.regions);
  const uptime = getUptime(report);

  const averageResponse = responseTimes.length
    ? responseTimes.reduce((sum, item) => sum + item.value, 0) / responseTimes.length
    : firstNumeric(
        report?.Average_Response_Time,
        report?.average_response_time,
        report?.summary?.average_response_time,
      );

  const regions = responseTimes.map((item) => item.label);

  return {
    status: getCurrentStatus(report),
    // This is HetrixTools' report uptime value, so the displayed number is
    // taken directly from HetrixTools instead of being calculated here.
    uptime_90d: uptime !== null ? formatUptime(uptime) : "Unavailable",
    response_time: formatResponseTime(averageResponse),
    monitoring_region: regions.length ? regions.join(" · ") : "Unavailable",
    source: "HetrixTools",
    updated_at: new Date().toISOString(),
  };
}

async function loadStats(monitorId) {
  const config = MONITOR_CONFIG[monitorId];
  if (!config) throw new Error(`Unsupported Hetrix monitor: ${monitorId}`);

  const report = await hetrixReport(monitorId);
  return buildStats(report, config);
}

async function getMonitorStats(monitorId) {
  const cacheKey = `hetrix:stats:v3:${monitorId}`;
  const cached = await redis(["GET", cacheKey]);
  if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;

  const stats = await loadStats(monitorId);
  await redis(["SET", cacheKey, JSON.stringify(stats), "EX", CACHE_TTL_SECONDS]);
  return stats;
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const monitorId = req.query?.monitor_id;
    if (!monitorId || !MONITOR_CONFIG[monitorId]) {
      return json(res, 400, { ok: false, error: "Unsupported or missing monitor_id" });
    }

    const stats = await getMonitorStats(monitorId);
    return json(res, 200, {
      ok: true,
      monitor_id: monitorId,
      stats,
    });
  } catch (error) {
    console.error("hetrix stats error", error);
    return json(res, 502, {
      ok: false,
      error: "Unable to read HetrixTools statistics",
    });
  }
}

module.exports = handler;
module.exports.getMonitorStats = getMonitorStats;
module.exports.getSportixStats = () =>
  getMonitorStats("aa30f6893c27e5421ac3ef4471fca386");
