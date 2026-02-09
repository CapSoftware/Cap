import { execSync } from "child_process";
import { executeDeepLink } from "./utils";

function getMainDisplayName(): string {
  try {
    const output = execSync("system_profiler SPDisplaysDataType -detailLevel mini", {
      encoding: "utf-8",
    });
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^\s{8}(\S.*):$/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch {
  }
  return "Main Display";
}

export default async function TakeScreenshot() {
  const displayName = getMainDisplayName();
  await executeDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: displayName },
      },
    },
    "Taking screenshot with Cap",
  );
}
