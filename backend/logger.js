import path from "node:path";
import { dataDir } from "./datadir.js";
import { createLogger } from "./ezlog.js";

// The server and the worker each need their own file. Under PM2 the entry point
// is PM2's wrapper, so the name comes from EZ_LOG_NAME (ecosystem.config.js);
// Bun.main covers running server.js or worker.js directly.
const role = process.env.EZ_LOG_NAME || path.basename(Bun.main ?? "server.js", ".js");
const name = role === "worker" ? "eztunes-worker" : "eztunes";

const logger = createLogger(path.join(dataDir(path.join(import.meta.dir, "..")), "logs"), name);

export default logger;
