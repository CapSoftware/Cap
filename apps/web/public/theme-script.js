(() => {
	var cookie = (() => {
		if (!document.cookie) return undefined;
		var match = document.cookie.match(/(?:^|;\s*)theme=(\w+)/);
		return match ? match[1] : undefined;
	})();

	var pathname = window.location.pathname;
	var isSharePath = pathname === "/s" || pathname.indexOf("/s/") === 0;
	var isThemedPath =
		pathname.indexOf("/dashboard") === 0 ||
		pathname.indexOf("/login") === 0 ||
		pathname.indexOf("/onboarding") === 0 ||
		isSharePath;
	var applyTheme = () => {
		var theme =
			cookie === "dark" || cookie === "light"
				? cookie
				: isSharePath &&
						window.matchMedia("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light";
		document.body.classList.remove("light", "dark");
		document.body.classList.add(theme);
	};

	if (isThemedPath) {
		if (document.body) {
			applyTheme();
		} else {
			window.addEventListener("DOMContentLoaded", applyTheme, { once: true });
		}
	}
})();
