import { getCurrentUser } from "@cap/database/auth/session";
import { cache } from "react";

export const getUser = cache(getCurrentUser);
