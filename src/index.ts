import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import { discoverAuthorization } from "./mcp/auth.js";
import { loadConfig } from "./mcp/config.js";
import { asAppError, log } from "./mcp/errors.js";
import { createHttpApp } from "./mcp/http.js";
import { createRuntime } from "./mcp/runtime.js";

async function initialize() {
  const ca = new X509Certificate(readFileSync(new URL("../certs/supabase-ca.crt", import.meta.url)));
  log("bundled_ca_ready", { fingerprint_sha256: ca.fingerprint256 });
  const config = loadConfig({ ...process.env, TRUST_PROXY_HOPS: "1" });
  const authorization = await discoverAuthorization(config);
  const runtime = await createRuntime(config);
  try {
    return createHttpApp(runtime.commerce, { ...authorization, remote: true, groups: runtime.groups });
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

let application: ReturnType<typeof initialize> | undefined;
function getApplication() {
  application ??= initialize().catch((error: unknown) => {
    application = undefined;
    throw error;
  });
  return application;
}

const app = express();
app.disable("x-powered-by");
app.use(async (request, response, next) => {
  try {
    const http = await getApplication();
    http.app(request, response, next);
  } catch (error) {
    const failure = asAppError(error);
    log("startup_failed", { code: failure.code, trace_id: failure.traceId });
    response.setHeader("Cache-Control", "no-store");
    response.status(503).json({ error: "application_unavailable" });
  }
});
export default app;
