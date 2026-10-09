(() => {
	const ICONS = {
		files: "<path d=\"M14 3H8a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z\"/><path d=\"M14 3v5h5\"/><path d=\"M4 7v13a1 1 0 0 0 1 1h10\"/>",
		search: "<circle cx=\"10.5\" cy=\"10.5\" r=\"6.5\"/><path d=\"M15.5 15.5 21 21\"/>",
		scm: "<circle cx=\"6.5\" cy=\"5\" r=\"2\"/><circle cx=\"6.5\" cy=\"19\" r=\"2\"/><circle cx=\"17.5\" cy=\"8\" r=\"2\"/><path d=\"M6.5 7v10\"/><path d=\"M17.5 10c0 4.5-5 3.5-10 7.5\"/>",
		run: "<path d=\"M7 4.5v15l12-7.5z\"/><circle cx=\"18\" cy=\"18\" r=\"3\"/>",
		ext: "<rect x=\"3.5\" y=\"10.5\" width=\"5\" height=\"5\"/><rect x=\"8.5\" y=\"10.5\" width=\"5\" height=\"5\"/><rect x=\"3.5\" y=\"15.5\" width=\"5\" height=\"5\"/><rect x=\"8.5\" y=\"15.5\" width=\"5\" height=\"5\"/><rect x=\"14.5\" y=\"3.5\" width=\"5\" height=\"5\" transform=\"rotate(12 17 6)\"/>",
		test: "<path d=\"M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3\"/><path d=\"M8 3h8\"/>",
		account: "<circle cx=\"12\" cy=\"8.5\" r=\"4\"/><path d=\"M4 21c1-4.5 4.5-6.5 8-6.5s7 2 8 6.5\"/>",
		gear: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1\"/>",
		split: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"1\"/><path d=\"M12 4.5v15\"/>",
		more: "<circle cx=\"6\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"18\" cy=\"12\" r=\"1\"/>",
		branch: "<circle cx=\"6\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"7\" r=\"2\"/><path d=\"M6 7v10M18 9c0 4-5 4-11 8\"/>",
		sync: "<path d=\"M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3\"/><path d=\"M18 3v4h-4M6 21v-4h4\"/>",
		err: "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M9 9l6 6M15 9l-6 6\"/>",
		warn: "<path d=\"M12 4 21 20H3z\"/><path d=\"M12 10v5M12 17.5v.5\"/>",
		bell: "<path d=\"M6 16V11a6 6 0 0 1 12 0v5l2 2H4z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/>",
		layout1: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"1\"/><path d=\"M9 4.5v15\"/>",
		layout2: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"1\"/><path d=\"M3.5 14h17\"/>",
		layout3: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"1\"/><path d=\"M15 4.5v15\"/>",
		newfile: "<path d=\"M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z\"/><path d=\"M12 11v6M9 14h6\"/>",
		refresh: "<path d=\"M19 12a7 7 0 1 1-2-5\"/><path d=\"M19 4v4h-4\"/>",
		collapse: "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/><path d=\"M8 12h8\"/>",
		close: "<path d=\"M6 6l12 12M18 6 6 18\"/>",
		min: "<path d=\"M5 12h14\"/>",
		max: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\"/>",
		trash: "<path d=\"M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13\"/>",
		plus: "<path d=\"M12 5v14M5 12h14\"/>",
		chevup: "<path d=\"M6 15l6-6 6 6\"/>",
		term: "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"1\"/><path d=\"M7 9l3 3-3 3M12 15h5\"/>",
	};
	const icon = (name, extra) => `<svg class="ic ${extra || ""}" viewBox="0 0 24 24">${ICONS[name] || ""}</svg>`;
	window.wbIcon = icon;

	const FILE_BADGES = {
		py: ["#3572a5", "py"],
		c: ["#555599", "C"],
		h: ["#a074c4", "h"],
		md: ["#519aba", "M"],
		json: ["#cbcb41", "{}"],
		toml: ["#9c4221", "≡"],
		yml: ["#a074c4", "!"],
		txt: ["#888888", "≡"],
		rs: ["#dea584", "R"],
		lock: ["#888888", "🔒"],
		cfg: ["#6d8086", "⚙"],
		ini: ["#6d8086", "⚙"],
		sh: ["#89e051", "$"],
		gitignore: ["#41535b", "◆"],
	};

	function treeHTML(items) {
		return items
			.map((it) => {
				const pad = 8 + it.depth * 8;
				if (it.dir) {
					return `<div class="ti" style="padding-left:${pad}px"><span class="chev">${it.open ? "⌄" : "›"}</span><span class="nm">${it.name}</span>${it.gs ? `<span class="gs ${it.gs === "M" ? "m" : "u"}" style="opacity:.6">●</span>` : ""}</div>`;
				}
				const ext = it.name.includes(".") ? it.name.split(".").pop() : "txt";
				const [color, glyph] = FILE_BADGES[ext] || FILE_BADGES.txt;
				const cls = [it.active ? "active" : "", it.gs === "M" ? "mod" : it.gs === "U" ? "unt" : ""].join(" ");
				return `<div class="ti ${cls}" style="padding-left:${pad + 16}px"><span class="fi" style="color:${color}">${glyph}</span><span class="nm">${it.name}</span>${it.gs ? `<span class="gs ${it.gs === "M" ? "m" : "u"}">${it.gs}</span>` : ""}</div>`;
			})
			.join("");
	}

	function buildWorkbench(cfg) {
		document.body.classList.add(cfg.theme === "dark" ? "theme-dark" : "theme-light");
		const tabs = cfg.tabs
			.map((t) => {
				const ext = t.name.split(".").pop();
				const [color, glyph] = FILE_BADGES[ext] || FILE_BADGES.txt;
				return `<div class="tab${t.active ? " active" : ""}${t.preview ? " preview" : ""}" data-name="${t.name}"><span class="fi" style="color:${color};font:700 10px 'DejaVu Sans Mono'">${glyph}</span><span class="${t.preview ? "it" : ""}">${t.name}</span><span class="x">${t.active ? "×" : ""}</span></div>`;
			})
			.join("");
		const crumbs = cfg.crumbs.map((c, i) => `<span>${c}</span>${i < cfg.crumbs.length - 1 ? "<span class=\"sep\">❯</span>" : ""}`).join("");
		document.body.innerHTML = `
<div id="wb">
  <div id="titlebar">
    <svg class="appicon" viewBox="0 0 24 24"><path d="M17 2 8 11 4 8 2 9v6l2 1 4-3 9 9 5-2V4z" fill="#0078d4"/><path d="M17 7v10l-6-5z" fill="#fff"/></svg>
    <div class="menu">${["File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Help"].map((m) => `<span>${m}</span>`).join("")}</div>
    <div class="cc">${icon("search")}<span>${cfg.project}</span></div>
    <div class="layout">${icon("layout1")}${icon("layout2")}${icon("layout3")}</div>
    <div class="wctl"><span>${icon("min")}</span><span>${icon("max")}</span><span>${icon("close")}</span></div>
  </div>
  <div id="main">
    <div id="activity">
      <div class="ai active">${icon("files")}</div>
      <div class="ai">${icon("search")}</div>
      <div class="ai">${icon("scm")}<span class="badge">${cfg.scmCount}</span></div>
      <div class="ai">${icon("run")}</div>
      <div class="ai">${icon("ext")}</div>
      <div class="ai">${icon("test")}</div>
      <div class="spacer"></div>
      <div class="ai">${icon("account")}</div>
      <div class="ai">${icon("gear")}</div>
    </div>
    <div id="sidebar">
      <div class="sb-head">EXPLORER<span class="acts">${icon("more")}</span></div>
      <div class="sec">⌄ ${cfg.project.toUpperCase()}<span style="margin-left:auto;display:flex;gap:6px;padding-right:8px;opacity:.8;font-weight:400">${icon("newfile")}${icon("refresh")}${icon("collapse")}</span></div>
      <div class="tree">${treeHTML(cfg.tree)}</div>
      <div class="outline"><div class="sec">› OUTLINE</div><div class="sec">› TIMELINE</div></div>
    </div>
    <div id="edarea">
      <div id="tabs">${tabs}<div class="tacts">${icon("run")}${icon("split")}${icon("more")}</div></div>
      <div id="crumbs">${crumbs}</div>
      <div id="editor"></div>
      ${cfg.panel ? "<div id=\"panel\"></div>" : ""}
    </div>
  </div>
  <div id="statusbar">
    <div class="si remote">&gt;&lt;</div>
    <div class="si">${icon("branch")}<span>${cfg.branch}</span></div>
    <div class="si">${icon("sync")}</div>
    <div class="si">${icon("err")}<span>0</span>${icon("warn")}<span>${cfg.warnings}</span></div>
    <div class="right">
      <div class="si" id="st-pos">Ln 1, Col 1</div>
      <div class="si">Spaces: 4</div>
      <div class="si">UTF-8</div>
      <div class="si">LF</div>
      <div class="si">${cfg.langLabel}</div>
      ${cfg.interp ? `<div class="si">${cfg.interp}</div>` : ""}
      <div class="si">${icon("bell")}</div>
    </div>
  </div>
</div>`;
		const pos = document.getElementById("st-pos");
		const activeTab = document.querySelector(".tab.active");
		const editor = new CodeEditor(document.getElementById("editor"), {
			text: cfg.source,
			lang: cfg.lang,
			minimapColors: cfg.minimapColors,
			onStatus: ({ line, col }) => {
				pos.textContent = `Ln ${line}, Col ${col}`;
			},
			onDirty: () => {
				if (!activeTab.classList.contains("dirty")) {
					activeTab.classList.add("dirty");
					activeTab.querySelector(".x").textContent = "●";
					cap.event("dirty");
				}
			},
		});
		editor.onSave = () => {
			activeTab.classList.remove("dirty");
			activeTab.querySelector(".x").textContent = "×";
			cap.event("save");
		};
		return editor;
	}

	window.buildWorkbench = buildWorkbench;
	window.MINIMAP_LIGHT = {
		plain: "#00000055",
		kw: "#af00db99",
		st: "#0000ff99",
		self: "#0000ff99",
		str: "#a3151599",
		com: "#00800099",
		num: "#09865899",
		fn: "#795e2699",
		ty: "#267f9999",
		var: "#00108099",
		mac: "#0000ff99",
		pp: "#0000ff99",
		slider: "#64646420",
	};
	window.MINIMAP_DARK = {
		plain: "#d4d4d455",
		kw: "#c586c099",
		st: "#569cd699",
		self: "#569cd699",
		str: "#ce917899",
		com: "#6a995599",
		num: "#b5cea899",
		fn: "#dcdcaa99",
		ty: "#4ec9b099",
		var: "#9cdcfe99",
		mac: "#569cd699",
		pp: "#c586c099",
		slider: "#79797933",
	};
})();
