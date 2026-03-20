// api/picks.js — Vercel Serverless Function
// Fast version: races multiple free models in parallel, takes first winner

const FREE_MODELS = [
  "google/gemini-2.0-flash-001:free",
  "stepfun/step-3.5-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "arcee-ai/trinity-large-preview:free",
  "z-ai/glm-4.5-air:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "arcee-ai/trinity-mini:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "stepfun/step-3.5-flash:free",
  "google/gemini-2.0-flash-exp:free",
  "deepseek/deepseek-chat:free",
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  
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
    { from: date,              to: date },
    { from: addDays(date, -1), to: addDays(date, 1) },
    { from: addDays(date, -2), to: addDays(date, 2) },
    { from: addDays(date, -3), to: addDays(date, 3) },
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

// Call one model — resolves with text or rejects on failure
async function callModel(model, messages, systemPrompt, orKey) {
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
      max_tokens: 1500,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error?.message || `${model} failed`);
  const content = data.choices?.[0]?.message?.content || "";
  if (content.trim().length < 10) throw new Error(`${model} empty response`);
  return content;
}

// Race all models in parallel — return first valid response
async function callOpenRouterFast(messages, systemPrompt, orKey) {
  // Use Promise.any() — resolves with first success, rejects only if ALL fail
  return Promise.any(
    FREE_MODELS.map(model => callModel(model, messages, systemPrompt, orKey))
  ).catch(() => {
    throw new Error("All free AI models are currently busy. Please try again in a few seconds.");
  });
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
    // STEP 1: Fetch real fixtures (and AI analysis in parallel)
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

    const maxPicks = Math.min(10, matches.length);

    // STEP 2: Race all models — fastest one wins
    const aiText = await callOpenRouterFast(
      [{ role: "user", content: `REAL football fixtures (${dateRange}):
${fixtureText}

Pick ${maxPicks} best value bets. ONE bet per match, different match each time.
Return ONLY JSON array sorted by odds DESC:
[{"home":"Name","away":"Name","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 words","reasoning":"2 sentences."}]
tip: Home Win|Away Win|Draw|Both Teams Score|Over 2.5 Goals|Over 1.5 Goals|Home Win or Draw|Away Win or Draw
conf:60-85, odds:1.25-3.50. Use EXACT names from list. Output ONLY JSON array.` }],
      "You are a sports betting analyst. Output ONLY a raw JSON array. No markdown, no extra text. Never pick the same match twice.",
      orKey
    );

    let parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI returned invalid data. Please try again." });

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
      conf:      Math.min(88, Math.max(60, parseInt(p.conf)  || 70)),
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
    console.error("BETIQ error:", err.message);
    return res.status(500).json({ picks: [], fixtureText: "", error: err.message });
  }
}
