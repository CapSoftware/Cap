import { getCurrentUser } from "@inflight/database/auth/session";
import { cache } from "react";

export const getUser = cache(getCurrentUser);
