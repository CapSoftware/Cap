import { ManagedRuntime } from "effect";
import { LicenseApiClient } from "./web-api";

export const effectRuntime = ManagedRuntime.make(LicenseApiClient.Default)
