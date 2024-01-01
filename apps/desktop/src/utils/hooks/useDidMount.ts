import { DependencyList, useEffect, useRef } from "react";

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
