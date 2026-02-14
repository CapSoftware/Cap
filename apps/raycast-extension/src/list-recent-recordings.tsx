import { Action, ActionPanel, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { openDeeplink } from "./deeplink";

function getRecordingsDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "so.cap.desktop",
    "recordings",
  );
}

interface Recording {
  name: string;
  path: string;
  modifiedAt: Date;
}

function listRecordings(): Recording[] {
  const dir = getRecordingsDir();
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".cap"))
      .map((f) => {
        const fullPath = join(dir, f);
        const stat = statSync(fullPath);
        return {
          name: f.replace(/\.cap$/, ""),
          path: fullPath,
          modifiedAt: stat.mtime,
        };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  } catch {
    return [];
  }
}

export default function RecentRecordings() {
  const { data: recordings, isLoading } = usePromise(async () => listRecordings());

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search recordings...">
      {recordings?.length === 0 ? (
        <List.EmptyView
          title="No Recordings Found"
          description="Record something with Cap first"
        />
      ) : (
        recordings?.map((rec) => (
          <List.Item
            key={rec.path}
            title={rec.name}
            subtitle={rec.modifiedAt.toLocaleDateString()}
            accessories={[{ date: rec.modifiedAt }]}
            actions={
              <ActionPanel>
                <Action
                  title="Open in Editor"
                  onAction={async () =>
                    openDeeplink({ open_editor: { project_path: rec.path } })
                  }
                />
                <Action.ShowInFinder path={rec.path} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
