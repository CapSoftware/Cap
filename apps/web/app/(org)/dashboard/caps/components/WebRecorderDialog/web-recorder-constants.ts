export const NO_MICROPHONE = "No Microphone";
export const NO_MICROPHONE_VALUE = "__no_microphone__";
export const NO_CAMERA = "No Camera";
export const NO_CAMERA_VALUE = "__no_camera__";

export const dialogVariants = {
  hidden: {
    opacity: 0,
    scale: 0.9,
    y: 20,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring",
      duration: 0.4,
      damping: 25,
      stiffness: 500,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: {
      duration: 0.2,
    },
  },
};

