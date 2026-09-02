const MONITOR_ID = "aa30f6893c27e5421ac3ef4471fca386";
const CACHE_TTL_SECONDS = 300;
const CACHE_KEY = `hetrix:stats:v2:${MONITOR_ID}`;

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
// This endpoint returns the same uptime/report data represented by the
// monitor's HetrixTools report, including uptime statistics and response
// times by monitoring location.
async function hetrixReport() {
  const token = process.env.HETRIX_API_KEY;
  if (!token) throw new Error("HETRIX_API_KEY is not configured");

  const response = await fetch(
    `https://api.hetrixtools.com/v1/${encodeURIComponent(token)}/uptime/report/${MONITOR_ID}/`,
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

function extractResponseTimes(report) {
  const source =
    report?.Response_Time ||
    report?.ResponseTime ||
    report?.response_time ||
    report?.summary?.response_time ||
    {};

  return Object.entries(source)
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

function buildStats(report) {
  const responseTimes = extractResponseTimes(report);
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
    // This is HetrixTools' report uptime value, so the number matches the
    // uptime shown by HetrixTools instead of being calculated independently.
    uptime_90d: uptime !== null ? formatUptime(uptime) : "Unavailable",
    response_time: formatResponseTime(averageResponse),
    monitoring_region: regions.length ? regions.join(" · ") : "Unavailable",
    source: "HetrixTools",
    updated_at: new Date().toISOString(),
  };
}

async function loadStats() {
  const report = await hetrixReport();
  return buildStats(report);
}

async function getSportixStats() {
  const cached = await redis(["GET", CACHE_KEY]);
  if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;

  const stats = await loadStats();
  await redis(["SET", CACHE_KEY, JSON.stringify(stats), "EX", CACHE_TTL_SECONDS]);
  return stats;
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const stats = await getSportixStats();
    return json(res, 200, {
      ok: true,
      monitor_id: MONITOR_ID,
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
module.exports.getSportixStats = getSportixStats;
