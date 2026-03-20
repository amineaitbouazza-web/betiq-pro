// api/picks.js — Vercel Serverless Function
// Uses OpenRouter API (openrouter.ai) — no CORS issues, key stays secret on server

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

// Call OpenRouter using OpenAI-compatible format
async function callOpenRouter(messages, systemPrompt, apiKey, model = "anthropic/claude-sonnet-4-5") {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENROUTER_API_KEY not set in Vercel environment variables." });

  const { date, leagues, sortBy = "odds" } = req.body || {};
  if (!date || !leagues?.length) return res.status(400).json({ error: "Missing date or leagues." });

  const leaguesList = leagues.slice(0, 12).join(", ");

  try {
    // Step 1: Ask AI to generate realistic fixtures for the date
    const fixtureText = await callOpenRouter(
      [{ role: "user", content: `List realistic football matches that would typically be scheduled for ${date} in these competitions: ${leaguesList}.

Use real team names from those leagues. Format each match as:
HOME TEAM vs AWAY TEAM | League | Time

List at least 20 matches across the leagues. Only use real team names.` }],
      "You are a football fixture expert with deep knowledge of all major leagues. Generate realistic fixture lists using real team names.",
      apiKey,
      "anthropic/claude-sonnet-4-5"
    );

    if (!fixtureText || fixtureText.trim().length < 20) {
      return res.status(200).json({ picks: [], fixtureText: "", error: `Could not generate fixtures for ${date}. Please try again.` });
    }

    // Step 2: Pick 10 best value bets from those fixtures
    const aiText = await callOpenRouter(
      [{ role: "user", content: `FOOTBALL FIXTURES for ${date}:
${fixtureText}

You are an expert football betting analyst. From these fixtures, select the 10 BEST value bets.

Return ONLY a raw JSON array of exactly 10 picks sorted by odds DESCENDING:
[{"home":"Team","away":"Team","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 word reason","reasoning":"Two sentences of analysis."}]

tip options: Home Win | Away Win | Draw | Both Teams Score | Over 2.5 Goals | Over 1.5 Goals | Home Win or Draw | Away Win or Draw
conf: 60-85 integer. odds: 1.25-3.50. Use EXACT team names from fixtures above.
Output ONLY the JSON array, nothing else.` }],
      "You are a sports betting analyst. Respond ONLY with a raw JSON array. No markdown, no text before or after.",
      apiKey,
      "anthropic/claude-sonnet-4-5"
    );

    const parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI failed to return valid picks. Please try again." });

    let picks = parsed.slice(0, 10).map((p, i) => ({
      id: i + 1,
      home: String(p.home || ""), away: String(p.away || ""),
      league: String(p.league || leagues[0]), tip: String(p.tip || "Home Win"),
      conf: Math.min(88, Math.max(60, parseInt(p.conf) || 70)),
      odds: parseFloat(p.odds) || 1.80,
      homeForm: String(p.homeForm || ""), awayForm: String(p.awayForm || ""),
      factor: String(p.factor || ""), reasoning: String(p.reasoning || ""),
    }));

    picks = sortBy === "odds" ? picks.sort((a, b) => b.odds - a.odds) : picks.sort((a, b) => b.conf - a.conf);

    const fixtureLines = fixtureText.split("\n").filter(l => l.includes("vs") || l.includes("|")).slice(0, 8);
    return res.status(200).json({ picks, fixtureText: fixtureLines.join("\n"), error: null });

  } catch (err) {
    console.error("BETIQ API error:", err);
    return res.status(500).json({ picks: [], fixtureText: "", error: err.message });
  }
}
