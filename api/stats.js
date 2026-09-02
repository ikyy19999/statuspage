const MONITOR_ID = "aa30f6893c27e5421ac3ef4471fca386";
const CACHE_TTL_SECONDS = 300;

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

async function hetrix(path, query = {}) {
  const token = process.env.HETRIX_API_KEY;
  if (!token) throw new Error("HETRIX_API_KEY is not configured");

  const url = new URL(`https://api.hetrixtools.com/v3${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HetrixTools API returned HTTP ${response.status}`);
  }

  return response.json();
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const valid = values.map(numeric).filter((value) => value !== null && value > 0);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function formatResponseTime(value) {
  if (value === null) return "Unavailable";
  if (value >= 1000) return `${(value / 1000).toFixed(2).replace(/\.00$/, "")} sec`;
  return `${Math.round(value)} ms`;
}

function getRegionalResponseTimes(summary) {
  const responseTime = summary?.response_time || {};
  const locations = {
    new_york: "New York",
    san_francisco: "San Francisco",
    dallas: "Dallas",
    amsterdam: "Amsterdam",
    london: "London",
    frankfurt: "Frankfurt",
    singapore: "Singapore",
    sydney: "Sydney",
    sao_paulo: "Sao Paulo",
    tokyo: "Tokyo",
    mumbai: "Mumbai",
    warsaw: "Warsaw",
  };

  return Object.entries(locations)
    .filter(([key]) => numeric(responseTime[key]) !== null && numeric(responseTime[key]) > 0)
    .map(([, label]) => label);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval[0] > last[1]) {
      merged.push([...interval]);
    } else if (interval[1] > last[1]) {
      last[1] = interval[1];
    }
  }
  return merged;
}

async function get90DayUptime(activeIncident) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 90 * 24 * 60 * 60;
  const intervals = [];

  let page = 1;
  while (page <= 50) {
    const payload = await hetrix(`/uptime-monitors/${MONITOR_ID}/downtimes`, {
      page,
      per_page: 200,
      start_after: windowStart,
      start_before: now,
    });

    const entries = Array.isArray(payload?.downtimes) ? payload.downtimes : [];

    for (const downtime of entries) {
      if (downtime.maintenance) continue;
      const start = Math.max(windowStart, Number(downtime.start));
      const end = Math.min(now, Number(downtime.end) || now);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        intervals.push([start, end]);
      }
    }

    const next = payload?.meta?.pagination?.next;
    if (!next) break;
    page = Number(next);
    if (!Number.isFinite(page)) break;
  }

  if (activeIncident?.started_at) {
    const start = Math.max(windowStart, Number(activeIncident.started_at));
    if (Number.isFinite(start) && now > start) intervals.push([start, now]);
  }

  const merged = mergeIntervals(intervals);
  const downtimeSeconds = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  const totalSeconds = 90 * 24 * 60 * 60;
  const percentage = Math.max(0, Math.min(100, ((totalSeconds - downtimeSeconds) / totalSeconds) * 100));

  return percentage;
}

async function loadStats(activeIncident) {
  const [report, uptime] = await Promise.all([
    hetrix(`/uptime-monitors/${MONITOR_ID}/report`, {
      days: 30,
      timezone: "+07:00",
    }),
    get90DayUptime(activeIncident),
  ]);

  const responseTime = average(Object.values(report?.summary?.response_time || {}));
  const regions = getRegionalResponseTimes(report?.summary);

  return {
    uptime_90d: `${uptime.toFixed(4)}%`,
    response_time: formatResponseTime(responseTime),
    monitoring_region: regions.length ? regions.join(" · ") : "Unavailable",
    source: "HetrixTools",
    updated_at: new Date().toISOString(),
  };
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const incidentRaw = await redis(["GET", `hetrix:incident:${MONITOR_ID}`]);
    const activeIncident = incidentRaw
      ? typeof incidentRaw === "string" ? JSON.parse(incidentRaw) : incidentRaw
      : null;
    const stats = await module.exports.getSportixStats(activeIncident);

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
};

module.exports = handler;
module.exports.getSportixStats = async function getSportixStats(activeIncident) {
  const cached = await redis(["GET", `hetrix:stats:${MONITOR_ID}`]);
  if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
  const stats = await loadStats(activeIncident);
  await redis(["SET", `hetrix:stats:${MONITOR_ID}`, JSON.stringify(stats), "EX", CACHE_TTL_SECONDS]);
  return stats;
};
