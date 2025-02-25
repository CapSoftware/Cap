import { cx } from "cva";

function TargetSelectInfoPill<T>(props: {
  value: T | null;
  permissionGranted: boolean;
  requestPermission: () => void;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      class={cx(
        "px-2.5 rounded-full text-[0.75rem] text-white",
        props.value !== null && props.permissionGranted
          ? "bg-blue-300"
          : "bg-red-300"
      )}
      onPointerDown={(e) => {
        if (!props.permissionGranted || props.value === null) return;

        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();

        if (!props.permissionGranted) {
          props.requestPermission();
          return;
        }

        props.onClear();
      }}
    >
      {!props.permissionGranted
        ? "Request Permission"
        : props.value !== null
        ? "On"
        : "Off"}
    </button>
  );
}

export default TargetSelectInfoPill;
