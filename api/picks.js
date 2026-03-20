// api/picks.js — Vercel Serverless Function
// Step 1: football-data.org  → REAL fixtures
// Step 2: OpenRouter FREE models → AI analysis (with robust fallback)

const FREE_MODELS = [
  "stepfun/step-3.5-flash:free",
  "google/gemini-2.0-flash-001:free",
  "google/gemini-2.0-flash-exp:free",
  "deepseek/deepseek-chat:free",
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-4-maverick:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "nousresearch/deephermes-3-llama-3-8b-preview:free",
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

// Try each free model — skip on provider error, move to next
async function callOpenRouter(messages, systemPrompt, orKey) {
  const errors = [];

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
          temperature: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
        }),
      });

      const data = await res.json();

      // Skip if provider error (model down/overloaded)
      if (!res.ok) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        errors.push(`${model}: ${msg}`);
        continue;
      }

      // Skip if OpenRouter returned an error in the body
      if (data?.error) {
        errors.push(`${model}: ${data.error.message || "error"}`);
        continue;
      }

      const content = data.choices?.[0]?.message?.content || "";
      if (content.trim().length > 10) {
        console.log(`Success with model: ${model}`);
        return content;
      }

      errors.push(`${model}: empty response`);

    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }

  // All models failed — return detailed error
  throw new Error(`All free models failed:\n${errors.slice(0,5).join("\n")}`);
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
    // STEP 1: Real fixtures
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

    // STEP 2: AI picks
    const maxPicks = Math.min(10, matches.length);

    const aiText = await callOpenRouter(
      [{ role: "user", content: `REAL football matches from football-data.org (${dateRange}):

${fixtureText}

Total: ${matches.length} matches available.

Select ${maxPicks} BEST value bets. Rules:
- ONE bet per match MAX — each pick must be a different match
- Use EXACT team names from the list above
- Do NOT invent or add matches

Return ONLY a raw JSON array of ${maxPicks} picks sorted by odds DESCENDING:
[{"home":"Exact Name","away":"Exact Name","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 word reason","reasoning":"Two sentences."}]

tip: Home Win | Away Win | Draw | Both Teams Score | Over 2.5 Goals | Over 1.5 Goals | Home Win or Draw | Away Win or Draw
conf: 60-85 integer. odds: 1.25-3.50.
Output ONLY the JSON array, nothing else.` }],
      "You are a sports betting analyst. Output ONLY a raw JSON array — no markdown, no explanation, no text before or after. Never pick the same match twice.",
      orKey
    );

    let parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI could not generate valid picks. Please try again." });

    // Deduplicate
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
    console.error("BETIQ API error:", err.message);
    return res.status(500).json({ picks: [], fixtureText: "", error: err.message });
  }
}
