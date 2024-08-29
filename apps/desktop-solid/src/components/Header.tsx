export default function Header() {
  return (
    <div
      class="flex items-center justify-start space-x-1 h-[44px] px-3 border-gray-200 border-b"
      data-tauri-drag-region
    >
      <div class="w-[12px] h-[12px] bg-[#FF5E57] border-1 border-[#E0443B] rounded-full m-0 p-0"></div>
      <div class="w-[12px] h-[12px] bg-[#FFBC2E] border-1 border-[#DF9D21] rounded-full m-0 p-0"></div>
      <div class="w-[12px] h-[12px] bg-[#28C83E] border-1 border-[#15A923] rounded-full m-0 p-0"></div>
    </div>
  );
}
