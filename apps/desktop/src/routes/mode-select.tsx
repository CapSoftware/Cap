import ModeSelect from "~/components/ModeSelect";
import InstantToggleBg from "~/assets/instant-toggle.jpg";

const ModeSelectWindow = () => {
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
        <h2 class="text-xl font-semibold mb-8 text-center text-[--gray-500] dark:text-[--gray-50]">
          Select your recording mode
        </h2>
        <ModeSelect />
      </div>
    </div>
  );
};

export default ModeSelectWindow;
