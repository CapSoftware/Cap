// Fix for Issue #1540 - Deep Links & Raycast Support
//
// Command: cap-control
// Purpose: Provides keyboard-driven recording controls for Cap desktop app.
//
// Actions available:
//   - Start Recording (Studio or Instant mode)
//   - Stop Recording
//   - Pause Recording
//   - Resume Recording
//   - Toggle Pause / Resume
//
// All actions open a `cap-desktop://action?value=<JSON>` deep link so Cap
// handles the actual state transition. This keeps the extension stateless.

import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  open,
  showToast,
} from "@raycast/api";

// ---------------------------------------------------------------------------
// Deep-link builder — the single source of truth for the URL schema.
// cap-desktop://action?value=<URL-encoded JSON>
// ---------------------------------------------------------------------------

function buildDeepLink(action: CapAction): string {
  const json = JSON.stringify(action);
  return `cap-desktop://action?value=${encodeURIComponent(json)}`;
}

async function sendAction(action: CapAction, successMessage: string): Promise<void> {
  const url = buildDeepLink(action);
  try {
    await open(url);
    await showToast({
      style: Toast.Style.Success,
      title: "Cap",
      message: successMessage,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap — Action Failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ---------------------------------------------------------------------------
// Discriminated union for every supported action.
// Must match the `DeepLinkAction` enum in deeplink_actions.rs.
// ---------------------------------------------------------------------------

type CapAction =
  | { type: "startRecording"; captureMode: CaptureMode; camera: null; micLabel: null; captureSystemAudio: boolean; mode: "studio" | "instant" }
  | { type: "stopRecording" }
  | { type: "pauseRecording" }
  | { type: "resumeRecording" }
  | { type: "togglePauseRecording" }
  | { type: "switchMicrophone"; label: string | null }
  | { type: "switchCamera"; id: string | null };

type CaptureMode = { screen: string } | { window: string };

// ---------------------------------------------------------------------------
// Recording control items shown in the list.
// ---------------------------------------------------------------------------

interface ControlItem {
  id: string;
  title: string;
  subtitle: string;
  icon: { source: Icon; tintColor: Color };
  keywords: string[];
  action: CapAction;
  confirmTitle?: string;
  confirmMessage?: string;
  successMessage: string;
}

const CONTROL_ITEMS: ControlItem[] = [
  {
    id: "start-studio",
    title: "Start Recording",
    subtitle: "Studio mode — primary display",
    icon: { source: Icon.Circle, tintColor: Color.Red },
    keywords: ["start", "record", "studio", "begin"],
    action: {
      type: "startRecording",
      captureMode: { screen: "Built-in Display" },
      camera: null,
      micLabel: null,
      captureSystemAudio: false,
      mode: "studio",
    },
    successMessage: "Starting Cap recording…",
  },
  {
    id: "start-instant",
    title: "Start Instant Recording",
    subtitle: "Instant mode — primary display",
    icon: { source: Icon.Bolt, tintColor: Color.Orange },
    keywords: ["start", "instant", "quick", "record"],
    action: {
      type: "startRecording",
      captureMode: { screen: "Built-in Display" },
      camera: null,
      micLabel: null,
      captureSystemAudio: false,
      mode: "instant",
    },
    successMessage: "Starting Cap instant recording…",
  },
  {
    id: "stop",
    title: "Stop Recording",
    subtitle: "End the current session",
    icon: { source: Icon.Stop, tintColor: Color.Red },
    keywords: ["stop", "end", "finish", "record"],
    action: { type: "stopRecording" },
    confirmTitle: "Stop Recording?",
    confirmMessage: "This will end your current Cap recording session.",
    successMessage: "Stopping recording…",
  },
  {
    id: "pause",
    title: "Pause Recording",
    subtitle: "Temporarily pause the session",
    icon: { source: Icon.Pause, tintColor: Color.Yellow },
    keywords: ["pause", "hold"],
    action: { type: "pauseRecording" },
    successMessage: "Pausing recording…",
  },
  {
    id: "resume",
    title: "Resume Recording",
    subtitle: "Continue the paused session",
    icon: { source: Icon.Play, tintColor: Color.Green },
    keywords: ["resume", "continue", "unpause", "play"],
    action: { type: "resumeRecording" },
    successMessage: "Resuming recording…",
  },
  {
    id: "toggle",
    title: "Toggle Pause / Resume",
    subtitle: "Flip the current pause state",
    icon: { source: Icon.ArrowClockwise, tintColor: Color.Blue },
    keywords: ["toggle", "pause", "resume", "flip"],
    action: { type: "togglePauseRecording" },
    successMessage: "Toggling pause state…",
  },
];

// ---------------------------------------------------------------------------
// Main command component
// ---------------------------------------------------------------------------

export default function CapControlCommand() {
  async function handleItem(item: ControlItem) {
    if (item.confirmTitle && item.confirmMessage) {
      const confirmed = await confirmAlert({
        title: item.confirmTitle,
        message: item.confirmMessage,
        primaryAction: {
          title: "Confirm",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!confirmed) return;
    }
    await sendAction(item.action, item.successMessage);
  }

  return (
    <List
      navigationTitle="Cap — Recording Controls"
      searchBarPlaceholder="Search recording actions…"
    >
      <List.Section title="Recording Controls">
        {CONTROL_ITEMS.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.subtitle}
            icon={item.icon}
            keywords={item.keywords}
            actions={
              <ActionPanel>
                <Action
                  title={item.title}
                  icon={item.icon}
                  onAction={() => handleItem(item)}
                />
                <Action.CopyToClipboard
                  title="Copy Deep Link URL"
                  content={buildDeepLink(item.action)}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Quick Reference" subtitle="URL Schema">
        <List.Item
          title="URL Format"
          subtitle="cap-desktop://action?value=<JSON>"
          icon={{ source: Icon.Link, tintColor: Color.SecondaryText }}
          accessories={[{ text: "cap-desktop://" }]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="Copy URL Schema"
                content="cap-desktop://action?value="
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
