import { createSignal } from "solid-js";
import ModeSelect from "~/components/ModeSelect";
import InstantToggleBg from "~/assets/instant-toggle.jpg";

const ModeSelectWindow = () => {
  const [currentMode, setCurrentMode] = createSignal<"instant" | "studio">(
    "studio"
  );

  const handleModeChange = (mode: "instant" | "studio") => {
    setCurrentMode(mode);
    // We'll implement this later with a proper state management solution
    console.log("Mode changed to:", mode);
  };

  return (
    <div
      data-tauri-drag-region
      class="min-h-screen flex items-center justify-center p-4 relative"
      style={{
        "background-image": `url(${InstantToggleBg})`,
        "background-size": "cover",
        "background-position": "center",
        "background-repeat": "no-repeat",
      }}
    >
      <div class="w-full max-w-3xl relative z-10">
        <ModeSelect
          initialMode={currentMode()}
          onModeChange={handleModeChange}
        />
      </div>
    </div>
  );
};

export default ModeSelectWindow;
