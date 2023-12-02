import { DependencyList, useEffect, useRef } from "react";

// USE ONLY IF YOU DON'T HAVE A WAY TO UNMOUNT
export const useDidMountEffect = (
  func: () => void,
  deps: DependencyList | undefined
) => {
  const didMount = useRef(false);

  useEffect(() => {
    if (didMount.current) {
      func();
    }
    return () => {
      didMount.current = true;
    };
  }, deps);
};
