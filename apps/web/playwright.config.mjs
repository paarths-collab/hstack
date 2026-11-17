import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 18882;
const testDatabase = path.join(tmpdir(), `agent-builder-e2e-${randomUUID()}.sqlite`);

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run start -- -p ${port} -H 127.0.0.1`,
    url: `http://127.0.0.1:${port}/`,
    env: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      BETTER_AUTH_SECRET: "agent-builder-e2e-only-secret-never-use-in-production-12345",
      AGENT_BUILDER_DB_PATH: testDatabase,
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
