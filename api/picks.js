// api/picks.js — Vercel Serverless Function
// Step 1: football-data.org  → REAL fixtures (free API)
// Step 2: OpenRouter FREE models → AI picks best value bets (1 pick per match)

// ── Free models on OpenRouter (no credits needed) ─────────────────────────
const FREE_MODELS = [
  "stepfun/step-3.5-flash:free",
  "google/gemini-2.0-flash-001:free",
  "deepseek/deepseek-chat:free",
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

function extractJSON(raw) {
  if (!raw) return null;
  const tries = [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```(?:json)?/gi, "").trim()),
    () => { const m = raw.match(/(\[[\s\S]*\])/); return m ? JSON.parse(m[1]) : null; },
    () => { const s = raw.indexOf("["), e = raw.lastIndexOf("]"); return s > -1 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null; },
  ];
  for (const fn of tries) {
    try { const r = fn(); if (Array.isArray(r) && r.length) return r; } catch {}
  }
  return null;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// Fetch real fixtures — auto-expands date window if too few matches
async function fetchRealFixtures(date, fdKey) {
  const tryDates = [
    { from: date,             to: date },
    { from: addDays(date,-1), to: addDays(date, 1) },
    { from: addDays(date,-2), to: addDays(date, 2) },
    { from: addDays(date,-3), to: addDays(date, 3) },
  ];

  for (const range of tryDates) {
    const url = `https://api.football-data.org/v4/matches?dateFrom=${range.from}&dateTo=${range.to}&status=SCHEDULED,TIMED`;
    const res = await fetch(url, { headers: { "X-Auth-Token": fdKey } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.message || `football-data.org error ${res.status}`);
    }
    const data = await res.json();
    const matches = (data.matches || [])
      .map(m => ({
        home:   m.homeTeam?.shortName || m.homeTeam?.name || "?",
        away:   m.awayTeam?.shortName || m.awayTeam?.name || "?",
        league: m.competition?.name || "Football",
        date:   m.utcDate ? m.utcDate.split("T")[0] : date,
        time:   m.utcDate ? new Date(m.utcDate).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "",
      }))
      .filter(m => m.home !== "?" && m.away !== "?");

    if (matches.length >= 5) return { matches, dateRange: `${range.from} to ${range.to}` };
  }
  return { matches: [], dateRange: date };
}

// Call OpenRouter — tries FREE models in order until one works
async function callOpenRouter(messages, systemPrompt, orKey) {
  let lastError = null;

  for (const model of FREE_MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${orKey}`,
          "HTTP-Referer": "https://betiqpro.app",
          "X-Title": "BETIQ PRO",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastError = new Error(err?.error?.message || `OpenRouter ${model} error ${res.status}`);
        continue; // try next model
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      if (content.trim().length > 10) return content; // success
      lastError = new Error(`${model} returned empty response`);

    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("All free models failed. Please try again.");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const orKey = process.env.OPENROUTER_API_KEY;
  const fdKey = process.env.FOOTBALL_DATA_KEY;

  if (!orKey) return res.status(500).json({ error: "OPENROUTER_API_KEY not set in Vercel environment variables." });
  if (!fdKey) return res.status(500).json({ error: "FOOTBALL_DATA_KEY not set in Vercel environment variables." });

  const { date, sortBy = "odds" } = req.body || {};
  if (!date) return res.status(400).json({ error: "Missing date." });

  try {
    // STEP 1: Real fixtures from football-data.org
    const { matches, dateRange } = await fetchRealFixtures(date, fdKey);

    if (matches.length === 0) {
      return res.status(200).json({
        picks: [], fixtureText: "",
        error: `No fixtures found around ${date}. Try a different date.`,
      });
    }

    const fixtureText = matches
      .map((m, i) => `${i + 1}. ${m.home} vs ${m.away} | ${m.league} | ${m.date}${m.time ? " " + m.time : ""}`)
      .join("\n");

    // STEP 2: Free AI picks — max 1 bet per match
    const maxPicks = Math.min(10, matches.length);

    const aiText = await callOpenRouter(
      [{ role: "user", content: `REAL football matches from football-data.org (${dateRange}):

${fixtureText}

TOTAL: ${matches.length} matches

Select ${maxPicks} BEST value bets. STRICT RULES:
- ONE bet per match MAX — every pick must be a different match
- Use EXACT team names from the list
- Do NOT invent matches

Return ONLY raw JSON array of ${maxPicks} picks sorted by odds DESC:
[{"home":"Exact Name","away":"Exact Name","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 word reason","reasoning":"Two sentences."}]

tip: Home Win | Away Win | Draw | Both Teams Score | Over 2.5 Goals | Over 1.5 Goals | Home Win or Draw | Away Win or Draw
conf: 60-85. odds: 1.25-3.50. Output ONLY the JSON array.` }],
      "You are a sports betting analyst. Output ONLY a raw JSON array — no markdown, no text before or after. Never pick the same match twice.",
      orKey
    );

    let parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI failed to return valid picks. Please try again." });

    // Server-side deduplication — enforce 1 pick per match
    const seen = new Set();
    parsed = parsed.filter(p => {
      const key = `${(p.home||"").toLowerCase().trim()}-${(p.away||"").toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let picks = parsed.slice(0, 10).map((p, i) => ({
      id: i + 1,
      home:      String(p.home      || ""),
      away:      String(p.away      || ""),
      league:    String(p.league    || "Football"),
      tip:       String(p.tip       || "Home Win"),
      conf:      Math.min(88, Math.max(60, parseInt(p.conf) || 70)),
      odds:      parseFloat(p.odds) || 1.80,
      homeForm:  String(p.homeForm  || ""),
      awayForm:  String(p.awayForm  || ""),
      factor:    String(p.factor    || ""),
      reasoning: String(p.reasoning || ""),
    }));

    picks = sortBy === "odds"
      ? picks.sort((a, b) => b.odds - a.odds)
      : picks.sort((a, b) => b.conf - a.conf);

    return res.status(200).json({
      picks,
      fixtureText: fixtureText.split("\n").slice(0, 10).join("\n"),
      totalFixtures: matches.length,
      dateRange,
      error: null,
    });

  } catch (err) {
    console.error("BETIQ API error:", err);
    return res.status(500).json({ picks: [], fixtureText: "", error: err.message });
  }
}
