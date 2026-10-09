(() => {
	const PY_CONTROL = new Set(
		"if elif else for while return yield break continue pass raise try except finally with as import from in not and or is lambda assert del global nonlocal await async".split(" "),
	);
	const PY_STORAGE = new Set("def class True False None".split(" "));
	const PY_SELF = new Set(["self", "cls"]);
	const PY_TYPES = new Set(
		"int str list dict set tuple float bool bytes object type frozenset ValueError TypeError KeyError IndexError StopIteration Exception NotImplementedError AttributeError".split(" "),
	);
	const PY_BUILTINS = new Set(
		"len range isinstance min max sum enumerate zip sorted reversed print super any all map filter iter next abs hash id repr getattr setattr hasattr divmod round".split(" "),
	);
	const C_CONTROL = new Set("if else for while do switch case default break continue return goto".split(" "));
	const C_STORAGE = new Set(
		"int unsigned signed char void struct union enum const static extern register typedef sizeof long short local volatile inline".split(" "),
	);
	const C_TYPES = new Set(
		"z_streamp z_stream Bytef uInt uLong code ZLIB_INTERNAL voidpf gz_headerp inflate_mode size_t uint32_t uint8_t ptrdiff_t".split(" "),
	);

	function classifyIdent(lang, word, prevWord, nextChar) {
		if (lang === "py") {
			if (PY_CONTROL.has(word)) return "kw";
			if (PY_STORAGE.has(word)) return "st";
			if (PY_SELF.has(word)) return "self";
			if (prevWord === "def") return "fn";
			if (prevWord === "class") return "ty";
			if (PY_TYPES.has(word)) return "ty";
			if (nextChar === "(") return "fn";
			if (/^[A-Z][a-z]/.test(word)) return "ty";
			if (/^[A-Z_][A-Z0-9_]+$/.test(word)) return "num";
			return "var";
		}
		if (C_CONTROL.has(word)) return "kw";
		if (C_STORAGE.has(word)) return "st";
		if (C_TYPES.has(word)) return "ty";
		if (/^[A-Z_][A-Z0-9_]+$/.test(word) && word.length > 1) return "mac";
		if (nextChar === "(") return "fn";
		if (prevWord === "struct") return "ty";
		return "var";
	}

	function tokenize(lang, line, state) {
		const out = [];
		let i = 0;
		let prevWord = "";
		const n = line.length;
		const pushTok = (cls, text) => {
			if (!text) return;
			const last = out[out.length - 1];
			if (last && last[0] === cls) last[1] += text;
			else out.push([cls, text]);
		};
		if (lang === "c" && state.comment) {
			const end = line.indexOf("*/");
			if (end < 0) {
				pushTok("com", line);
				return { tokens: out, state: { comment: true } };
			}
			pushTok("com", line.slice(0, end + 2));
			i = end + 2;
		}
		if (lang === "py" && state.str) {
			const end = line.indexOf(state.str);
			if (end < 0) {
				pushTok("str", line);
				return { tokens: out, state: { str: state.str } };
			}
			pushTok("str", line.slice(0, end + 3));
			i = end + 3;
		}
		if (lang === "c") {
			const m = /^(\s*)(#\s*\w+)(.*)$/.exec(line);
			if (m && i === 0) {
				pushTok("plain", m[1]);
				pushTok("pp", m[2]);
				const rest = m[3];
				const inc = /^(\s*)(<[^>]*>|"[^"]*")(.*)$/.exec(rest);
				if (inc) {
					pushTok("plain", inc[1]);
					pushTok("str", inc[2]);
					pushTok("com", inc[3]);
					return { tokens: out, state: {} };
				}
				const def = /^(\s+)([A-Za-z_]\w*)(.*)$/.exec(rest);
				if (def) {
					pushTok("plain", def[1]);
					pushTok("mac", def[2]);
					line = def[3];
					i = 0;
					const sub = tokenize("c", line, {});
					for (const t of sub.tokens) pushTok(t[0], t[1]);
					return { tokens: out, state: sub.state };
				}
				line = rest;
				i = 0;
			}
		}
		const len = line.length;
		while (i < len) {
			const ch = line[i];
			const rest = line.slice(i);
			if (ch === " " || ch === "\t") {
				let j = i;
				while (j < len && (line[j] === " " || line[j] === "\t")) j++;
				pushTok("plain", line.slice(i, j));
				i = j;
				continue;
			}
			if (lang === "py" && ch === "#") {
				pushTok("com", rest);
				break;
			}
			if (lang === "c" && rest.startsWith("//")) {
				pushTok("com", rest);
				break;
			}
			if (lang === "c" && rest.startsWith("/*")) {
				const end = line.indexOf("*/", i + 2);
				if (end < 0) {
					pushTok("com", rest);
					return { tokens: out, state: { comment: true } };
				}
				pushTok("com", line.slice(i, end + 2));
				i = end + 2;
				continue;
			}
			if (lang === "py") {
				const tm = /^([rRbBuUfF]{0,2})("""|''')/.exec(rest);
				if (tm) {
					const delim = tm[2];
					const start = i + tm[0].length;
					const end = line.indexOf(delim, start);
					if (end < 0) {
						pushTok("str", rest);
						return { tokens: out, state: { str: delim } };
					}
					pushTok("str", line.slice(i, end + 3));
					i = end + 3;
					continue;
				}
			}
			const sm = (lang === "py" ? /^[rRbBuUfF]{0,2}("|")/ : /^(\"|")/).exec(rest);
			if (sm) {
				const q = sm[1];
				let j = i + sm[0].length;
				while (j < len && line[j] !== q) {
					if (line[j] === "\\") j++;
					j++;
				}
				pushTok("str", line.slice(i, Math.min(len, j + 1)));
				i = Math.min(len, j + 1);
				continue;
			}
			const nm = /^(0[xX][0-9a-fA-F]+[uUlL]*|\d+(\.\d+)?([eE][+-]?\d+)?[uUlLj]*)/.exec(rest);
			if (nm && !/[A-Za-z_]/.test(line[i - 1] || "")) {
				pushTok("num", nm[0]);
				i += nm[0].length;
				continue;
			}
			if (lang === "py" && ch === "@") {
				const dm = /^@[A-Za-z_][\w.]*/.exec(rest);
				if (dm) {
					pushTok("fn", dm[0]);
					i += dm[0].length;
					continue;
				}
			}
			const im = /^[A-Za-z_]\w*/.exec(rest);
			if (im) {
				const word = im[0];
				let k = i + word.length;
				while (k < len && line[k] === " ") k++;
				pushTok(classifyIdent(lang, word, prevWord, line[k]), word);
				prevWord = word;
				i += word.length;
				continue;
			}
			pushTok("plain", ch);
			if (ch !== "." && ch !== "*") prevWord = "";
			i++;
		}
		return { tokens: out, state: {} };
	}

	const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	class CodeEditor {
		constructor(host, opts) {
			this.host = host;
			this.lang = opts.lang;
			this.lines = opts.text.replace(/\r/g, "").split("\n");
			if (this.lines[this.lines.length - 1] === "") this.lines.pop();
			this.fontSize = opts.fontSize || 13;
			this.lineHeight = opts.lineHeight || 19;
			this.onStatus = opts.onStatus || (() => {});
			this.onDirty = opts.onDirty || (() => {});
			this.minimapColors = opts.minimapColors;
			this.added = new Set();
			this.modified = new Set();
			this.caret = { line: opts.caretLine || 0, col: 0 };
			this.focused = false;
			this.states = [];
			this.build();
			this.retokenizeFrom(0, true);
			this.renderAll();
			this.updateCaret(false);
			this.bind();
		}

		build() {
			const h = this.host;
			h.classList.add("ce");
			h.innerHTML = "";
			this.scroller = document.createElement("div");
			this.scroller.className = "ce-scroller";
			this.scroller.dataset.scrollId = this.host.id || "editor";
			this.content = document.createElement("div");
			this.content.className = "ce-content";
			this.lineHL = document.createElement("div");
			this.lineHL.className = "ce-linehl";
			this.selEl = document.createElement("div");
			this.selEl.className = "ce-sel";
			this.rowsEl = document.createElement("div");
			this.rowsEl.className = "ce-rows";
			this.caretEl = document.createElement("div");
			this.caretEl.className = "ce-caret blink";
			this.suggest = document.createElement("div");
			this.suggest.className = "ce-suggest";
			this.content.append(this.lineHL, this.selEl, this.rowsEl, this.caretEl, this.suggest);
			this.scroller.append(this.content);
			this.minimap = document.createElement("canvas");
			this.minimap.className = "ce-minimap";
			this.vbar = document.createElement("div");
			this.vbar.className = "ce-vbar";
			this.vthumb = document.createElement("div");
			this.vthumb.className = "ce-vthumb";
			this.vbar.append(this.vthumb);
			for (const [pos, cls] of [
				[0.12, "warn"],
				[0.31, "mod"],
				[0.47, "warn"],
				[0.66, "add"],
				[0.83, "mod"],
			]) {
				const m = document.createElement("div");
				m.className = `ce-mark ${cls}`;
				m.style.top = `${pos * 100}%`;
				this.vbar.append(m);
			}
			h.append(this.scroller, this.minimap, this.vbar);
			const probe = document.createElement("span");
			probe.className = "ce-probe";
			probe.textContent = "M".repeat(100);
			this.rowsEl.append(probe);
			this.cw = probe.getBoundingClientRect().width / 100;
			probe.remove();
			this.gutter = 66;
		}

		retokenizeFrom(start, all) {
			let state = start > 0 ? this.states[start - 1].end : {};
			this.tokens = this.tokens || [];
			for (let i = start; i < this.lines.length; i++) {
				const prev = this.states[i];
				const r = tokenize(this.lang, this.lines[i], state);
				const changedEnd = !prev || JSON.stringify(prev.end) !== JSON.stringify(r.state);
				const changedStart = !prev || JSON.stringify(prev.start) !== JSON.stringify(state);
				this.states[i] = { start: state, end: r.state };
				this.tokens[i] = r.tokens;
				if (!all && i > start && !changedEnd && !changedStart) {
					this.dirtyRows.add(i);
					break;
				}
				if (this.dirtyRows) this.dirtyRows.add(i);
				state = r.state;
			}
		}

		rowHTML(i) {
			const line = this.lines[i];
			const toks = this.tokens[i] || [];
			let html = "";
			const lead = /^ */.exec(line)[0].length;
			let col = 0;
			for (const [cls, text] of toks) {
				let t = text;
				if (col < lead && cls === "plain") {
					const take = Math.min(t.length, lead - col);
					let guides = "";
					let k = 0;
					while (k + 4 <= take) {
						guides += "<span class=\"ig\">    </span>";
						k += 4;
					}
					if (k < take) guides += " ".repeat(take - k);
					html += guides;
					t = t.slice(take);
					col += take;
					if (!t) continue;
				}
				html += cls === "plain" ? esc(t) : `<span class="tk-${cls}">${esc(t)}</span>`;
				col += t.length;
			}
			const mark = this.added.has(i) ? " add" : this.modified.has(i) ? " mod" : "";
			return `<span class="ln${mark}">${i + 1}</span><span class="code">${html || " "}</span>`;
		}

		renderAll() {
			const frag = document.createDocumentFragment();
			this.rowsEl.innerHTML = "";
			this.rowEls = [];
			for (let i = 0; i < this.lines.length; i++) {
				const d = document.createElement("div");
				d.className = "ce-row";
				d.innerHTML = this.rowHTML(i);
				this.rowEls.push(d);
				frag.append(d);
			}
			this.rowsEl.append(frag);
			this.content.style.height = `${(this.lines.length + Math.floor(this.visibleLines() - 2)) * this.lineHeight}px`;
			this.renderMinimapFull();
			this.updateScrollUI();
		}

		renderRows(rows) {
			for (const i of rows) {
				if (!this.rowEls[i]) continue;
				this.rowEls[i].innerHTML = this.rowHTML(i);
			}
		}

		insertRow(at) {
			const d = document.createElement("div");
			d.className = "ce-row";
			d.innerHTML = "<span class=\"ln\"></span><span class=\"code\"> </span>";
			const ref = this.rowEls[at] || null;
			this.rowsEl.insertBefore(d, ref);
			this.rowEls.splice(at, 0, d);
			this.states.splice(at, 0, null);
			this.tokens.splice(at, 0, []);
			this.shiftSets(at, 1);
			this.content.style.height = `${(this.lines.length + Math.floor(this.visibleLines() - 2)) * this.lineHeight}px`;
			this.renumber(at);
		}

		removeRow(at) {
			this.rowEls[at].remove();
			this.rowEls.splice(at, 1);
			this.states.splice(at, 1);
			this.tokens.splice(at, 1);
			this.shiftSets(at, -1);
			this.renumber(at);
		}

		renumber(from) {
			for (let i = from; i < this.rowEls.length; i++) this.rowEls[i].firstChild.textContent = i + 1;
		}

		shiftSets(at, delta) {
			for (const name of ["added", "modified"]) {
				const next = new Set();
				for (const v of this[name]) next.add(v >= at ? v + delta : v);
				this[name] = next;
			}
		}

		visibleLines() {
			return this.scroller.clientHeight / this.lineHeight;
		}

		bind() {
			this.scroller.addEventListener(
				"wheel",
				(e) => {
					e.preventDefault();
					const lines = Math.round((e.deltaY / 120) * 3) || Math.sign(e.deltaY);
					this.scrollTo(this.scroller.scrollTop + lines * this.lineHeight);
				},
				{ passive: false },
			);
			this.scroller.addEventListener("scroll", () => this.updateScrollUI());
			this.scroller.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.focus();
				const r = this.content.getBoundingClientRect();
				const line = Math.max(0, Math.min(this.lines.length - 1, Math.floor((e.clientY - r.top) / this.lineHeight)));
				const col = Math.max(0, Math.min(this.lines[line].length, Math.round((e.clientX - r.left - this.gutter) / this.cw)));
				this.caret = { line, col };
				this.hideSuggest();
				this.clearSel();
				this.updateCaret(false);
				if (e.detail === 2) this.selectWord();
			});
			window.addEventListener("keydown", (e) => {
				if (!this.focused) return;
				if (this.handleKey(e)) e.preventDefault();
			});
		}

		focus() {
			this.focused = true;
			this.host.classList.add("focused");
			if (this.onFocus) this.onFocus();
		}

		blur() {
			this.focused = false;
			this.host.classList.remove("focused");
			this.hideSuggest();
		}

		pointFor(line, col) {
			const l = Math.max(0, Math.min(this.lines.length - 1, line));
			const c = Math.max(0, Math.min(this.lines[l].length, col));
			const r = this.content.getBoundingClientRect();
			return [Math.round(r.left + this.gutter + c * this.cw), Math.round(r.top + l * this.lineHeight + this.lineHeight / 2)];
		}

		scrollTo(y) {
			const max = this.scroller.scrollHeight - this.scroller.clientHeight;
			this.scroller.scrollTop = Math.max(0, Math.min(max, Math.round(y)));
		}

		edited(line) {
			if (!this.added.has(line)) this.modified.add(line);
			this.onDirty();
		}

		handleKey(e) {
			const { line, col } = this.caret;
			const text = this.lines[line];
			if (e.ctrlKey && e.key === "s") {
				if (this.onSave) this.onSave();
				return true;
			}
			if (e.ctrlKey && e.key === "Home") {
				this.caret = { line: 0, col: 0 };
				this.updateCaret(true);
				return true;
			}
			if (e.ctrlKey && e.key === "End") {
				const l = this.lines.length - 1;
				this.caret = { line: l, col: this.lines[l].length };
				this.updateCaret(true);
				return true;
			}
			if (e.ctrlKey || e.metaKey || e.altKey) return false;
			this.dirtyRows = new Set();
			let handled = true;
			this.clearSel();
			if (e.key.length === 1) {
				this.typeChar(e.key);
			} else if (e.key === "Enter") {
				this.hideSuggest();
				const before = text.slice(0, col);
				const after = text.slice(col);
				let indent = /^ */.exec(text)[0].length;
				const trimmed = before.trimEnd();
				if ((this.lang === "py" && trimmed.endsWith(":")) || (this.lang === "c" && trimmed.endsWith("{"))) indent += 4;
				this.lines[line] = before.replace(/ +$/, "") || (before.trim() ? before : "");
				this.lines.splice(line + 1, 0, " ".repeat(indent) + after.replace(/^ +/, ""));
				this.insertRow(line + 1);
				this.added.add(line + 1);
				this.edited(line);
				this.caret = { line: line + 1, col: indent };
				this.retokenizeFrom(line);
				this.dirtyRows.add(line);
				this.dirtyRows.add(line + 1);
			} else if (e.key === "Backspace") {
				if (col > 0) {
					const lead = /^ */.exec(text)[0].length;
					let n = 1;
					if (col <= lead && col % 4 === 0) n = 4;
					else if (col <= lead) n = col % 4;
					const pair = text[col - 1] + (text[col] || "");
					if (["()", "[]", "\"\"", "''"].includes(pair)) {
						this.lines[line] = text.slice(0, col - 1) + text.slice(col + 1);
					} else {
						this.lines[line] = text.slice(0, col - n) + text.slice(col);
					}
					this.caret.col = col - n;
					this.edited(line);
					this.retokenizeFrom(line);
					this.dirtyRows.add(line);
					this.updateSuggest();
				} else if (line > 0) {
					const prev = this.lines[line - 1];
					this.lines[line - 1] = prev + text;
					this.lines.splice(line, 1);
					this.removeRow(line);
					this.caret = { line: line - 1, col: prev.length };
					this.edited(line - 1);
					this.retokenizeFrom(line - 1);
					this.dirtyRows.add(line - 1);
				}
			} else if (e.key === "Delete") {
				this.lines[line] = text.slice(0, col) + text.slice(col + 1);
				this.edited(line);
				this.retokenizeFrom(line);
			} else if (e.key === "Tab") {
				const n = 4 - (col % 4);
				this.lines[line] = text.slice(0, col) + " ".repeat(n) + text.slice(col);
				this.caret.col += n;
				this.edited(line);
				this.retokenizeFrom(line);
			} else if (e.key === "ArrowLeft") {
				if (col > 0) this.caret.col--;
				else if (line > 0) this.caret = { line: line - 1, col: this.lines[line - 1].length };
				this.hideSuggest();
			} else if (e.key === "ArrowRight") {
				if (col < text.length) this.caret.col++;
				else if (line < this.lines.length - 1) this.caret = { line: line + 1, col: 0 };
				this.hideSuggest();
			} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				const d = e.key === "ArrowUp" ? -1 : 1;
				const l = Math.max(0, Math.min(this.lines.length - 1, line + d));
				this.goalCol = this.goalCol ?? col;
				this.caret = { line: l, col: Math.min(this.lines[l].length, this.goalCol) };
				this.hideSuggest();
				this.updateCaret(true, true);
				this.renderRows(this.dirtyRows);
				return true;
			} else if (e.key === "Home") {
				const lead = /^ */.exec(text)[0].length;
				this.caret.col = col === lead ? 0 : lead;
			} else if (e.key === "End") {
				this.caret.col = text.length;
			} else if (e.key === "PageDown" || e.key === "PageUp") {
				const page = Math.max(1, Math.floor(this.visibleLines()) - 1);
				const d = e.key === "PageDown" ? page : -page;
				const l = Math.max(0, Math.min(this.lines.length - 1, line + d));
				this.caret = { line: l, col: Math.min(this.lines[l].length, col) };
				this.scrollTo(this.scroller.scrollTop + d * this.lineHeight);
			} else if (e.key === "Escape") {
				this.hideSuggest();
			} else {
				handled = false;
			}
			if (!["ArrowUp", "ArrowDown"].includes(e.key)) this.goalCol = null;
			this.renderRows(this.dirtyRows);
			this.renderMinimapRows(this.dirtyRows);
			this.updateCaret(true);
			return handled;
		}

		typeChar(ch) {
			const { line, col } = this.caret;
			const text = this.lines[line];
			const next = text[col] || "";
			const closers = { "(": ")", "[": "]" };
			if ((ch === ")" || ch === "]" || ch === "\"" || ch === "'") && next === ch) {
				this.caret.col++;
				this.updateSuggest();
				return;
			}
			let ins = ch;
			if (closers[ch] && (!next || /[\s)\],:]/.test(next))) ins = ch + closers[ch];
			else if ((ch === "\"" || ch === "'") && !/\w/.test(text[col - 1] || "") && text[col - 1] !== ch && (!next || /[\s)\],:]/.test(next))) ins = ch + ch;
			let newText = text.slice(0, col) + ins + text.slice(col);
			let newCol = col + 1;
			if (this.lang === "c" && ch === "}" && /^ +$/.test(text.slice(0, col)) && col >= 4) {
				newText = text.slice(0, col - 4) + "}" + text.slice(col);
				newCol = col - 3;
			}
			this.lines[line] = newText;
			this.caret.col = newCol;
			this.edited(line);
			this.retokenizeFrom(line);
			this.dirtyRows.add(line);
			this.updateSuggest();
		}

		wordBeforeCaret() {
			const { line, col } = this.caret;
			const m = /[A-Za-z_]\w*$/.exec(this.lines[line].slice(0, col));
			return m ? m[0] : "";
		}

		updateSuggest() {
			const w = this.wordBeforeCaret();
			if (w.length < 2) return this.hideSuggest();
			if (!this.vocab) {
				const counts = new Map();
				for (const l of this.lines) for (const m of l.matchAll(/[A-Za-z_]\w{2,}/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
				this.vocab = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
			}
			const lw = w.toLowerCase();
			const items = this.vocab.filter((v) => v.toLowerCase().startsWith(lw) && v !== w).slice(0, 8);
			if (!items.length) return this.hideSuggest();
			const kinds = ["method", "variable", "field", "keyword", "class"];
			this.suggest.innerHTML = items
				.map((it, k) => {
					const kind = /^[A-Z]/.test(it) ? "class" : kinds[(it.length * 7 + k) % 3];
					return `<div class="sg-item${k === 0 ? " active" : ""}"><span class="sg-icon ${kind}"></span><b>${esc(it.slice(0, w.length))}</b>${esc(it.slice(w.length))}${k === 0 ? `<span class="sg-detail">${kind}</span>` : ""}</div>`;
				})
				.join("");
			const { line, col } = this.caret;
			this.suggest.style.left = `${this.gutter + (col - w.length) * this.cw - 4}px`;
			this.suggest.style.top = `${(line + 1) * this.lineHeight + 2}px`;
			this.suggest.style.display = "block";
		}

		hideSuggest() {
			this.suggest.style.display = "none";
		}

		selectWord() {
			const { line, col } = this.caret;
			const t = this.lines[line];
			let a = col;
			let b = col;
			while (a > 0 && /\w/.test(t[a - 1])) a--;
			while (b < t.length && /\w/.test(t[b])) b++;
			if (b <= a) return;
			this.selEl.style.display = "block";
			this.selEl.style.left = `${this.gutter + a * this.cw}px`;
			this.selEl.style.top = `${line * this.lineHeight}px`;
			this.selEl.style.width = `${(b - a) * this.cw}px`;
			this.selEl.style.height = `${this.lineHeight}px`;
			this.caret.col = b;
			this.updateCaret(false);
		}

		clearSel() {
			this.selEl.style.display = "none";
		}

		updateCaret(reveal, keepGoal) {
			const { line, col } = this.caret;
			const lh = this.lineHeight;
			this.caretEl.style.transform = `translate(${this.gutter + col * this.cw}px, ${line * lh}px)`;
			this.lineHL.style.transform = `translateY(${line * lh}px)`;
			this.caretEl.classList.remove("blink");
			void this.caretEl.offsetWidth;
			clearTimeout(this.blinkTimer);
			this.blinkTimer = setTimeout(() => this.caretEl.classList.add("blink"), 550);
			const ln = this.rowEls[line] && this.rowEls[line].firstChild;
			if (this.curLnEl && this.curLnEl !== ln) this.curLnEl.classList.remove("cur");
			if (ln) ln.classList.add("cur");
			this.curLnEl = ln;
			if (reveal) {
				const top = this.scroller.scrollTop;
				const h = this.scroller.clientHeight;
				const y = line * lh;
				if (y < top) this.scrollTo(y - 2 * lh);
				else if (y + lh > top + h) this.scrollTo(y + lh - h + 2 * lh);
			}
			this.onStatus({ line: line + 1, col: col + 1 });
		}

		renderMinimapFull() {
			const dpr = window.devicePixelRatio || 1;
			const w = this.minimap.clientWidth;
			this.miniLineH = 2;
			const total = this.lines.length * this.miniLineH;
			this.mini = document.createElement("canvas");
			this.mini.width = Math.round(w * dpr);
			this.mini.height = Math.round((total + 200) * dpr);
			this.miniCtx = this.mini.getContext("2d");
			this.miniCtx.scale(dpr, dpr);
			for (let i = 0; i < this.lines.length; i++) this.drawMiniLine(i);
			this.minimap.width = Math.round(w * dpr);
			this.minimap.height = Math.round(this.minimap.clientHeight * dpr);
		}

		drawMiniLine(i) {
			const ctx = this.miniCtx;
			const y = i * this.miniLineH;
			ctx.clearRect(0, y, this.minimap.clientWidth, this.miniLineH);
			let x = 4;
			for (const [cls, text] of this.tokens[i] || []) {
				const colr = this.minimapColors[cls] || this.minimapColors.plain;
				let start = 0;
				for (const seg of text.split(/(\s+)/)) {
					if (seg && !/^\s+$/.test(seg)) {
						ctx.fillStyle = colr;
						ctx.fillRect(x + start * 1, y, seg.length * 1, this.miniLineH - 0.5);
					}
					start += seg.length;
				}
				x += text.length;
			}
		}

		renderMinimapRows(rows) {
			if (!rows || !rows.size || !this.miniCtx) return;
			if (this.lines.length * this.miniLineH + 200 > this.mini.height / (window.devicePixelRatio || 1)) {
				this.renderMinimapFull();
			} else {
				const first = Math.min(...rows);
				for (let i = first; i < this.lines.length; i++) this.drawMiniLine(i);
			}
			this.updateScrollUI();
		}

		updateScrollUI() {
			const sc = this.scroller;
			const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
			const frac = sc.scrollTop / max;
			const barH = this.vbar.clientHeight;
			const thumbH = Math.max(20, (sc.clientHeight / sc.scrollHeight) * barH);
			this.vthumb.style.height = `${thumbH}px`;
			this.vthumb.style.transform = `translateY(${frac * (barH - thumbH)}px)`;
			if (!this.mini) return;
			const dpr = window.devicePixelRatio || 1;
			const ctx = this.minimap.getContext("2d");
			const mh = this.minimap.clientHeight;
			const total = this.lines.length * this.miniLineH;
			const firstLine = sc.scrollTop / this.lineHeight;
			const visLines = sc.clientHeight / this.lineHeight;
			const miniTop = total > mh ? frac * (total + visLines * this.miniLineH - mh) : 0;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
			ctx.drawImage(this.mini, 0, Math.round(miniTop * dpr), this.minimap.width, this.minimap.height, 0, 0, this.minimap.width, this.minimap.height);
			ctx.fillStyle = this.minimapColors.slider;
			ctx.fillRect(0, Math.round((firstLine * this.miniLineH - miniTop) * dpr), this.minimap.width, Math.round(visLines * this.miniLineH * dpr));
		}
	}

	window.CodeEditor = CodeEditor;
})();
