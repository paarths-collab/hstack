import { getReadyAuth } from "./auth.js";

await getReadyAuth();
process.stdout.write("Agent Builder database is ready.\n");
