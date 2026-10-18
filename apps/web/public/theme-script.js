(() => {
	var cookie = (() => {
		if (!document.cookie) return undefined;
		var match = document.cookie.match(/\W?theme=(\w+)/);
		return match ? match[1] : undefined;
	})();

	var pathname = window.location.pathname;
	var isDashboardPath =
		pathname.indexOf("/dashboard") === 0 ||
		pathname.indexOf("/login") === 0 ||
		pathname.indexOf("/onboarding") === 0;
	var applyTheme = () => {
		document.body.classList.add(cookie || "light");
	};

	if (isDashboardPath) {
		if (document.body) {
			applyTheme();
		} else {
			window.addEventListener("DOMContentLoaded", applyTheme, { once: true });
		}
	}
})();
