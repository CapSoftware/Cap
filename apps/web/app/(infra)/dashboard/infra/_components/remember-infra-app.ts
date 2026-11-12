import Cookies from "js-cookie";
import { INFRA_APP_COOKIE } from "@/lib/infra-routes";

export function rememberInfraApp(appId: string) {
	Cookies.set(INFRA_APP_COOKIE, appId, { expires: 365, sameSite: "lax" });
}

export function forgetInfraApp() {
	Cookies.remove(INFRA_APP_COOKIE);
}
