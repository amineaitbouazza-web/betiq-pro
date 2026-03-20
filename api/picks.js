// api/picks.js — Vercel Serverless Function
// Runs on Vercel servers (no CORS), keeps API key secret

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

function extractText(content = []) {
  return content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function runAgenticLoop(messages, system, tools, apiKey, maxRounds = 8) {
  let msgs = [...messages];
  let lastContent = [];

  for (let i = 0; i < maxRounds; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system,
        tools,
        messages: msgs,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Anthropic API error ${res.status}`);
    }

    const data = await res.json();
    lastContent = data.content || [];
    msgs.push({ role: "assistant", content: lastContent });

    if (data.stop_reason === "end_turn") break;

    const toolUseBlocks = lastContent.filter(b => b.type === "tool_use");
    if (toolUseBlocks.length === 0) break;

    const toolResults = toolUseBlocks.map(tu => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: "Search executed.",
    }));

    msgs.push({ role: "user", content: toolResults });
  }

  return extractText(lastContent);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables." });

  const { date, leagues, sortBy = "odds" } = req.body || {};
  if (!date || !leagues?.length) return res.status(400).json({ error: "Missing date or leagues." });

  const leaguesList = leagues.slice(0, 12).join(", ");

  try {
    // Step 1: Search web for real fixtures
    const fixtureText = await runAgenticLoop(
      [{ role: "user", content: `Search for real football matches scheduled for ${date} in: ${leaguesList}. List all confirmed matches as: HOME vs AWAY | League | Time` }],
      "You are a football fixture researcher. Search the web for real scheduled matches. Only return confirmed fixtures.",
      [{ type: "web_search_20250305", name: "web_search" }],
      apiKey, 8
    );

    if (!fixtureText || fixtureText.trim().length < 20) {
      return res.status(200).json({ picks: [], fixtureText: "", error: `No fixtures found for ${date}. Try a weekend date.` });
    }

    // Step 2: Pick best bets from real fixtures
    const analysisRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: "You are a sports betting analyst. Respond ONLY with a raw JSON array. No markdown, no extra text.",
        messages: [{ role: "user", content: `REAL FIXTURES for ${date}:\n${fixtureText}\n\nPick 10 best value bets. Return ONLY JSON array sorted by odds desc:\n[{"home":"Team","away":"Team","league":"League","tip":"Home Win","conf":74,"odds":1.95,"homeForm":"WWDWL","awayForm":"DLWDL","factor":"5 words","reasoning":"2 sentences."}]\ntip: Home Win|Away Win|Draw|Both Teams Score|Over 2.5 Goals|Over 1.5 Goals|Home Win or Draw|Away Win or Draw\nconf:60-85, odds:1.25-3.50. Use ONLY teams from fixtures above.` }],
      }),
    });

    const analysisData = await analysisRes.json();
    const aiText = extractText(analysisData.content);
    const parsed = extractJSON(aiText);
    if (!parsed) return res.status(200).json({ picks: [], fixtureText, error: "AI failed to return valid picks. Try again." });

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
