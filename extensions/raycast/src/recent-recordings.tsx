import { Action, ActionPanel, List, open, showHUD } from "@raycast/api";
import { useState, useEffect } from "react";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { getRecordingsDir } from "./utils";

interface Recording {
  name: string;
  path: string;
  date: Date;
}

function getRecordings(): Recording[] {
  const dir = getRecordingsDir();
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter((name) => {
        const fullPath = join(dir, name);
        return statSync(fullPath).isDirectory();
      })
      .map((name) => {
        const fullPath = join(dir, name);
        const stat = statSync(fullPath);
        return { name, path: fullPath, date: stat.mtime };
      })
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 50);
  } catch {
    return [];
  }
}

export default function Command() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setRecordings(getRecordings());
    setIsLoading(false);
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search recordings...">
      {recordings.length === 0 ? (
        <List.EmptyView title="No recordings found" description="Record something with Cap first!" />
      ) : (
        recordings.map((rec) => (
          <List.Item
            key={rec.path}
            title={rec.name}
            subtitle={rec.date.toLocaleDateString()}
            accessories={[{ date: rec.date }]}
            actions={
              <ActionPanel>
                <Action
                  title="Open in Cap"
                  onAction={async () => {
                    await open(`file://${rec.path}`);
                    await showHUD("Opening in Cap...");
                  }}
                />
                <Action.ShowInFinder path={rec.path} />
                <Action.CopyToClipboard title="Copy Path" content={rec.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
