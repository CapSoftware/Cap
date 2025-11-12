#!/usr/bin/env node

import { createTinybirdClient, resolveTinybirdAuth } from "./shared.js";
import { intro, outro, text, isCancel, log } from "@clack/prompts";

async function getAllDatasources(client) {
  try {
    const payload = await client.request(`/v0/datasources`);
    const list = Array.isArray(payload?.datasources)
      ? payload.datasources
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
    const names = list
      .map((ds) => (typeof ds === "string" ? ds : ds?.name))
      .filter(Boolean);
    const unique = Array.from(new Set(names));
    if (unique.length > 0) return unique;
  } catch {
    // fall through to fallback list
  }
  return ["analytics_events", "analytics_pages_mv", "analytics_sessions_mv"];
}

async function doubleConfirm({ workspaceName, workspaceId, host, datasources }) {
  const workspaceLabel =
    workspaceName || workspaceId || new URL(host).host || "unknown-workspace";

  intro("Delete ALL analytics data from Tinybird");
  log.warn(
    `This will TRUNCATE all datasources in the Tinybird workspace:\n` +
      `- Workspace: ${workspaceLabel}\n` +
      `- Host: ${host}\n` +
      `- Datasources (${datasources.length}): ${datasources.join(", ")}`
  );

  const first = await text({
    message: `Type the workspace name or ID to confirm (${workspaceLabel})`,
    placeholder: workspaceLabel,
    defaultValue: "",
    validate: (value) => {
      if (!value) return "Required";
      if (value !== workspaceName && value !== workspaceId && value !== workspaceLabel) {
        return "Value does not match the workspace name or ID";
      }
    },
  });
  if (isCancel(first)) {
    outro("Cancelled.");
    process.exit(0);
  }

  const second = await text({
    message: 'Final confirmation: type "DELETE ALL" to proceed',
    placeholder: "DELETE ALL",
    defaultValue: "",
    validate: (value) => (value === "DELETE ALL" ? undefined : 'You must type "DELETE ALL"'),
  });
  if (isCancel(second)) {
    outro("Cancelled.");
    process.exit(0);
  }
}

async function deleteAllData() {
  const auth = resolveTinybirdAuth();
  const client = createTinybirdClient(auth);

  const datasources = await getAllDatasources(client);

  await doubleConfirm({
    workspaceName: client.workspaceName,
    workspaceId: client.workspaceId,
    host: client.host,
    datasources,
  });

  console.log("\nDeleting all data from Tinybird datasources...\n");

  const successes = [];
  const failures = [];
  for (const datasource of datasources) {
    try {
      console.log(`Deleting data from ${datasource}...`);
      let ok = false;
      try {
        await client.request(`/v0/datasources/${encodeURIComponent(datasource)}/truncate`, {
          method: "POST",
        });
        ok = true;
      } catch (e1) {
        try {
          await client.request(`/v0/datasources/${encodeURIComponent(datasource)}/data`, {
            method: "DELETE",
          });
          ok = true;
        } catch (e2) {
          await client.request(`/v0/datasources/${encodeURIComponent(datasource)}`, {
            method: "DELETE",
          });
          ok = true;
        }
      }
      if (ok) {
        console.log(`✅ Deleted data from ${datasource}`);
        successes.push(datasource);
      } else {
        failures.push(datasource);
      }
    } catch (error) {
      console.error(`❌ Failed to delete data from ${datasource}:`, error.message);
      if (error.payload) {
        console.error("   Details:", JSON.stringify(error.payload, null, 2));
      }
      failures.push(datasource);
    }
  }

  if (failures.length === 0) {
    console.log("\n✅ Finished deleting all data");
  } else {
    console.log(
      `\n⚠️  Finished with errors. Deleted: ${successes.length}. Failed: ${failures.length} -> ${failures.join(", ")}`,
    );
    process.exitCode = 1;
  }
}

deleteAllData().catch((error) => {
  console.error("❌ Failed to delete data:", error.message);
  process.exit(1);
});

