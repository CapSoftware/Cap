import { exit } from "@tauri-apps/api/process";

export const WindowActions = () => {
  const actionButtonBase = "w-3 h-3 bg-gray-500 rounded-full m-0 p-0 block";

  return (
    <div className="absolute top-3 left-3 w-full flex items-center justify-start gap-x-2">
      <div>
        <button
          onClick={() => {
            exit();
          }}
          className={`bg-red-500 hover:bg-red-700 transition-all ${actionButtonBase}`}
        ></button>
      </div>
      <div>
        <span className={actionButtonBase}></span>
      </div>
      <div>
        <span className={actionButtonBase}></span>
      </div>
    </div>
  );
};
