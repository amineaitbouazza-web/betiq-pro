// api/picks.js — Vercel Serverless Function
// Step 1: football-data.org  → REAL fixtures (free, no credit card)
// Step 2: OpenRouter         → AI picks the best value bets

// football-data.org free tier competition IDs
const COMPETITION_MAP = {
  "Premier League":        "PL",
  "La Liga":               "PD",
  "Bundesliga":            "BL1",
  "Serie A":               "SA",
  "Ligue 1":               "FL1",
  "Champions League":      "CL",
  "Europa League":         "EL",
  "Eredivisie":            "DED",
  "Primeira Liga":         "PPL",
  "Championship":          "ELC",
  "World Cup Qualifiers":  "WC",
};

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

// Fetch real fixtures from football-data.org for a given date
async function fetchRealFixtures(date, fdKey) {
  const url = `https://api.football-data.org/v4/matches?dateFrom=${date}&dateTo=${date}&status=SCHEDULED,TIMED`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": fdKey },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message || `football-data.org error ${res.status}`);
  }

  const data = await res.json();
  const matches = data.matches || [];

  return matches.map(m => ({
    home:    m.homeTeam?.name || "?",
    away:    m.awayTeam?.name || "?",
    league:  m.competition?.name || "Football",
    time:    m.utcDate ? new Date(m.utcDate).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "",
    status:  m.status,
  })).filter(m => m.home !== "?" && m.away !== "?");
}

// Call OpenRouter (OpenAI-compatible)
async function callOpenRouter(messages, systemPrompt, orKey) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${orKey}`,
      "HTTP-Referer": "https://betiqpro.app",
      "X-Title": "BETIQ PRO",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 2000,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenRouter error ${res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
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
    // ── STEP 1: Fetch REAL fixtures from football-data.org ────────────────
    const fixtures = await fetchRealFixtures(date, fdKey);

    if (fixtures.length === 0) {
      return res.status(200).json({
        picks: [],
        fixtureText: "",
        error: `No fixtures scheduled for ${date}. Try a different date — weekends usually have the most matches.`,
      });
    }

    // Format for AI
    const fixtureText = fixtures
      .map((f, i) => `${i + 1}. ${f.home} vs ${f.away} | ${f.league}${f.time ? " | " + f.time : ""}`)
      .join("\n");

    // ── STEP 2: OpenRouter picks best value bets ──────────────────────────
    const aiText = await callOpenRouter(
      [{ role: "user", content: `These are REAL football matches scheduled for ${date} from football-data.org:

${fixtureText}

You are an expert football betting analyst. Select the 10 BEST value bets from these real matches using your knowledge of current team form, standings, head-to-head records, and betting value.

Return ONLY a raw JSON array of exactly 10 picks sorted by odds DESCENDING:
[{"home":"Exact Team Name","away":"Exact Team Name","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 word reason","reasoning":"Two sentences of analysis."}]

tip: Home Win | Away Win | Draw | Both Teams Score | Over 2.5 Goals | Over 1.5 Goals | Home Win or Draw | Away Win or Draw
conf: 60-85 integer. odds: 1.25-3.50.
Use EXACT team names from the fixture list above. Do NOT invent matches.
Output ONLY the JSON array.` }],
      "You are a sports betting analyst. Respond ONLY with a raw JSON array. No markdown, no text before or after — just the JSON.",
      orKey
    );

    const parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI failed to return valid picks. Please try again." });

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

    const fixtureLines = fixtureText.split("\n").slice(0, 8);
    return res.status(200).json({
      picks,
      fixtureText: fixtureLines.join("\n"),
      totalFixtures: fixtures.length,
      error: null,
    });

  } catch (err) {
    console.error("BETIQ API error:", err);
    return res.status(500).json({ picks: [], fixtureText: "", error: err.message });
  }
}
