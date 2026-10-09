(() => {
	function mulberry32(seed) {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	window.mulberry32 = mulberry32;

	const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	class Terminal {
		constructor(host, opts) {
			this.host = host;
			this.rng = mulberry32(opts.seed || 7);
			this.prompt = opts.prompt;
			this.scroller = document.createElement("div");
			this.scroller.className = "term-scroller";
			this.scroller.dataset.scrollId = "terminal";
			this.body = document.createElement("div");
			this.body.className = "term-body";
			this.scroller.append(this.body);
			host.append(this.scroller);
			this.input = "";
			this.proc = null;
			this.queue = [];
			this.commands = opts.commands || {};
			this.focused = false;
			this.inputLine = null;
			window.addEventListener("keydown", (e) => {
				if (!this.focused) return;
				if (this.key(e)) e.preventDefault();
			});
			host.addEventListener("mousedown", () => this.focus());
		}

		focus() {
			this.focused = true;
			this.host.classList.add("focused");
			if (this.onFocus) this.onFocus();
		}

		blur() {
			this.focused = false;
			this.host.classList.remove("focused");
		}

		line(html, cls) {
			const d = document.createElement("div");
			d.className = `tl${cls ? ` ${cls}` : ""}`;
			d.innerHTML = html || " ";
			if (this.inputLine && this.inputLine.isConnected) this.body.insertBefore(d, this.inputLine);
			else this.body.append(d);
			while (this.body.childElementCount > 2000) this.body.firstChild.remove();
			this.scrollBottom();
			return d;
		}

		scrollBottom() {
			this.scroller.scrollTop = this.scroller.scrollHeight;
		}

		showPrompt() {
			this.inputLine = document.createElement("div");
			this.inputLine.className = "tl";
			this.body.append(this.inputLine);
			this.input = "";
			this.renderInput();
			this.scrollBottom();
		}

		renderInput() {
			if (!this.inputLine) return;
			this.inputLine.innerHTML = `${this.prompt}${esc(this.input)}<span class="tcur"> </span>`;
		}

		key(e) {
			if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
				if (this.proc) {
					this.proc.stop = true;
					const p = this.proc;
					this.proc = null;
					if (p.onInterrupt) for (const l of p.onInterrupt()) this.line(l);
					this.showPrompt();
				} else {
					this.input += "^C";
					this.renderInput();
					this.inputLine = null;
					this.showPrompt();
				}
				return true;
			}
			if (e.ctrlKey || e.altKey || e.metaKey) return false;
			if (this.proc || !this.inputLine) return true;
			if (e.key.length === 1) {
				this.input += e.key;
				this.renderInput();
			} else if (e.key === "Backspace") {
				this.input = this.input.slice(0, -1);
				this.renderInput();
			} else if (e.key === "Enter") {
				const cmd = this.input.trim();
				this.inputLine.innerHTML = `${this.prompt}${esc(this.input)}`;
				this.inputLine = null;
				this.run(cmd);
			} else {
				return e.key === "Tab";
			}
			return true;
		}

		run(cmd) {
			cap.event("term_run", { cmd });
			const name = Object.keys(this.commands).find((k) => cmd.startsWith(k));
			if (!cmd) return this.showPrompt();
			if (!name) {
				this.line(esc(`${cmd.split(" ")[0]}: command not found`));
				return this.showPrompt();
			}
			this.start(this.commands[name](cmd, this.rng, this));
		}

		start(proc) {
			this.proc = proc;
			const step = () => {
				if (proc.stop) return;
				const next = proc.next();
				if (next.done) {
					if (this.proc === proc) {
						this.proc = null;
						this.showPrompt();
					}
					return;
				}
				const [delay, lines] = next.value;
				setTimeout(() => {
					if (proc.stop) return;
					for (const l of lines) this.line(l);
					step();
				}, delay);
			};
			step();
		}
	}
	window.Terminal = Terminal;
})();
