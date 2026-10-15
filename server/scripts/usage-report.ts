// Read-only token report: bun scripts/usage-report.ts [path/to/pipaya.db]
// Shows per session: calls, prompt size, cache hit %, output, cost; then how much of the tool output the 10 biggest results take.
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2] ?? "data/pipaya.db", { readonly: true });
const rows = db.query("SELECT s.id, s.title, s.provider, s.model, m.data FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.role = 'assistant'").all() as any[];
type A = { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; cost: number; title: string; model: string };
const by = new Map<string, A>();
for (const r of rows) {
  const u = JSON.parse(r.data)?.usage; if (!u) continue;
  const a = by.get(r.id) ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, title: r.title.slice(0, 28), model: `${r.provider}/${r.model}` };
  a.calls++; a.input += u.input ?? 0; a.cacheRead += u.cacheRead ?? 0; a.cacheWrite += u.cacheWrite ?? 0; a.output += u.output ?? 0; a.cost += u.cost?.total ?? 0;
  by.set(r.id, a);
}
const list = [...by.values()].sort((x, y) => y.calls - x.calls);
console.log("sessions with usage:", list.length);
for (const a of list.slice(0, 12)) {
  const prompt = a.input + a.cacheRead + a.cacheWrite;
  console.log(`${a.model.padEnd(28)} calls=${String(a.calls).padStart(3)} prompt=${String(prompt).padStart(8)} cacheRead=${prompt ? Math.round(100 * a.cacheRead / prompt) : 0}% out=${a.output} cost=${a.cost.toFixed(3)} | ${a.title}`);
}
const t = list.reduce((s, a) => ({ i: s.i + a.input, r: s.r + a.cacheRead, w: s.w + a.cacheWrite, o: s.o + a.output }), { i: 0, r: 0, w: 0, o: 0 });
const p = t.i + t.r + t.w;
console.log(`TOTAL prompt=${p} (fresh ${t.i}, cacheRead ${t.r}, cacheWrite ${t.w}) output=${t.o} cacheHit=${p ? Math.round(100 * t.r / p) : 0}%`);
const tools = db.query("SELECT data FROM messages WHERE role = 'toolResult'").all() as any[];
const sizes = tools.map((r) => JSON.stringify(JSON.parse(r.data).content ?? "").length).sort((a, b) => b - a);
const sum = sizes.reduce((s, n) => s + n, 0);
console.log(`tool results: n=${sizes.length} totalChars=${sum} top10=${sizes.slice(0, 10).reduce((s, n) => s + n, 0)} (${sum ? Math.round(100 * sizes.slice(0, 10).reduce((s, n) => s + n, 0) / sum) : 0}%)`);
