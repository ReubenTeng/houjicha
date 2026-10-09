import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { groupSettings } from "../src/group-buy/runtime.js";
import { supabaseConfig } from "../src/orchestration/supabase.js";
import { loadConfig, readEnvironment } from "../src/mcp/config.js";
import { asAppError, log } from "../src/mcp/errors.js";

readEnvironment();
let pool: Pool | undefined;
try {
  const settings = groupSettings(loadConfig(), process.env);
  if (!settings) throw new Error("Enable the group backend before setup.");
  const sql = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  pool = new Pool(supabaseConfig());
  await pool.query(sql.replaceAll("orchestration", settings.schema));
  log("group_schema_ready");
} catch (error) {
  const failure = asAppError(error);
  log("group_setup_failed", { code: failure.code, trace_id: failure.traceId });
  process.exitCode = 1;
} finally { await pool?.end(); }
