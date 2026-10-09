// Vercel 서버 함수: 상담 화면의 AI 분석 요청을 Anthropic API로 전달합니다.
// 필요한 환경변수: ANTHROPIC_API_KEY (필수), ACCESS_CODE (선택), ANTHROPIC_MODEL (선택)
// stream:true 요청이면 글자가 만들어지는 대로 보내서, 긴 분석도 끊기지 않게 합니다.
const API = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-sonnet-4-5";

async function pickModel(key) {
  try {
    const r = await fetch(`${API}/models?limit=50`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id);
    return ids.find(id => /sonnet/.test(id)) || ids[0] || null;
  } catch (e) { return null; }
}

function callClaude(key, model, prompt, images, stream) {
  const content = (images || []).slice(0, 8).map(data => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
  content.push({ type: "text", text: prompt });
  return fetch(`${API}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 12000, stream: !!stream, messages: [{ role: "user", content }] })
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return res.status(503).json({ error: "no_key" });
  const code = process.env.ACCESS_CODE;
  let sent = String(req.headers["x-access-code"] || "");
  try { sent = decodeURIComponent(sent); } catch (e) {}
  if (code && sent.trim() !== code.trim()) return res.status(401).json({ error: "access_code" });
  const { prompt, images, stream } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.length > 300000) return res.status(400).json({ error: "bad_request" });
  try {
    let model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    let r = await callClaude(key, model, prompt, images, stream);
    if (r.status === 404 || r.status === 400) {
      const t = await r.text();
      if (/model/i.test(t)) {
        const alt = await pickModel(key);
        if (alt && alt !== model) { model = alt; r = await callClaude(key, model, prompt, images, stream); }
        else return res.status(502).json({ error: "model", detail: t.slice(0, 300) });
      } else return res.status(502).json({ error: "upstream", detail: t.slice(0, 300) });
    }
    if (r.status === 429 || r.status === 529) return res.status(429).json({ error: "rate_limited" });
    if (!r.ok) return res.status(502).json({ error: "upstream", detail: (await r.text()).slice(0, 300) });

    if (!stream) {
      const j = await r.json();
      const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      return res.status(200).json({ text, model, truncated: j.stop_reason === "max_tokens" });
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", stop = null, err = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") res.write(ev.delta.text);
        else if (ev.type === "message_delta" && ev.delta) stop = ev.delta.stop_reason || stop;
        else if (ev.type === "error") err = (ev.error && (ev.error.type + ": " + ev.error.message)) || "stream error";
      }
    }
    if (err) res.write("\u0000ERR:" + err);
    else if (stop === "max_tokens") res.write("\u0000TRUNC");
    return res.end();
  } catch (e) {
    if (res.headersSent) { try { res.write("\u0000ERR:" + String(e).slice(0, 150)); } catch (_) {} return res.end(); }
    return res.status(502).json({ error: "upstream", detail: String(e).slice(0, 200) });
  }
};
