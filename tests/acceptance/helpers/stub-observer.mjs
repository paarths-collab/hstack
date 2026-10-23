// TEST DOUBLE observation only: real Telegram needs its own independently
// correlated acknowledgement. Historic or unrelated outbox entries are not
// evidence that the dispatch requested by this observer delivered anything.
import { createHash } from "node:crypto";

export function freshStubDeliveries(before, after, runId, secrets = []) {
  if (typeof before !== "string" || typeof after !== "string" || !/^[0-9a-f]{32}$/.test(runId)) return [];
  if (!after.startsWith(before) || (before !== "" && !before.endsWith("\n"))) return [];
  const fresh = after.slice(before.length);
  if (fresh !== "" && !fresh.endsWith("\n")) return [];
  return fresh.split("\n").flatMap((line) => {
    const match = /^to=(-?[0-9]+) run=([0-9a-f]{32}) body=/.exec(line);
    if (!match || match[2] !== runId) return [];
    return [{
      to_fp: createHash("sha256").update(`telegram:${match[1]}`).digest("hex").slice(0, 16),
      body_has_secret: secrets.some((secret) => typeof secret === "string" && secret !== "" && line.includes(secret)),
    }];
  });
}
