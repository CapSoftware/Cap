declare type MaybePromise<T> = T | Promise<T>;

declare type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;
