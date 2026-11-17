import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { getDatabase } from "./database.js";

let authInstance;
let migrationPromise;
let options;

function authConfig() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || secret === "replace-with-a-random-secret-of-at-least-32-bytes") {
    throw new Error("BETTER_AUTH_SECRET must be set to a random value of at least 32 bytes.");
  }
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!baseURL) throw new Error("BETTER_AUTH_URL must be set to the public origin of this server.");
  let url;
  try { url = new URL(baseURL); }
  catch { throw new Error("BETTER_AUTH_URL must be a valid absolute URL."); }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin, or an HTTP loopback origin for local development.");
  }
  return { secret, baseURL: url.origin };
}

/** Migrate Better Auth's tables on first request so a fresh clone starts safely. */
export async function getReadyAuth() {
  if (!options) {
    const { secret, baseURL } = authConfig();
    options = {
      appName: "Agent Builder",
      baseURL,
      secret,
      database: getDatabase(),
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    };
  }
  migrationPromise ??= getMigrations(options)
    .then(({ runMigrations }) => runMigrations())
    .catch((error) => { migrationPromise = undefined; throw error; });
  await migrationPromise;
  authInstance ??= betterAuth(options);
  return authInstance;
}

export async function getSession(request) {
  const auth = await getReadyAuth();
  return auth.api.getSession({ headers: request.headers });
}
