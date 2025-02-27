import ModeSelect from "~/components/ModeSelect";

const ModeSelectWindow = () => {
  return (
    <div
      data-tauri-drag-region
      class="flex relative justify-center items-center p-4 min-h-screen bg-gray-50"
    >
      <div class="relative z-10 w-full max-w-3xl">
        <h2 class="mb-5 text-[24px] font-semibold text-center text-gray-500">
          Select your recording mode
        </h2>
        <ModeSelect />
      </div>
    </div>
  );
};

export default ModeSelectWindow;
