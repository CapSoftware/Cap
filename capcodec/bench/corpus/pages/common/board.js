(() => {
	const D = window.BOARD;
	const P = {
		inbox: "<path d=\"M3 13l3-8h12l3 8v6H3z\"/><path d=\"M3 13h5l1 3h6l1-3h5\"/>",
		user: "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c1-4 4-6 8-6s7 2 8 6\"/>",
		review: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z\"/>",
		pulse: "<path d=\"M3 12h4l3-7 4 14 3-7h4\"/>",
		box: "<path d=\"M4 7l8-4 8 4v10l-8 4-8-4z\"/><path d=\"M4 7l8 4 8-4M12 11v10\"/>",
		layers: "<path d=\"M12 3l9 5-9 5-9-5z\"/><path d=\"M3 13l9 5 9-5\"/>",
		target: "<circle cx=\"12\" cy=\"12\" r=\"8\"/><circle cx=\"12\" cy=\"12\" r=\"4\"/>",
		users: "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5\"/><path d=\"M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5c1.6.8 2.6 2.7 3 5.5\"/>",
		issue: "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"4\"/><path d=\"M9 12l2 2 4-4\"/>",
		cycle: "<path d=\"M20 12a8 8 0 1 1-3-6.2\"/><path d=\"M20 4v5h-5\"/>",
		search: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M16 16l4.5 4.5\"/>",
		edit: "<path d=\"M4 20h4L19 9l-4-4L4 16z\"/>",
		star: "<path d=\"M12 4l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z\"/>",
		chev: "<path d=\"M9 6l6 6-6 6\"/>",
		down: "<path d=\"M6 9l6 6 6-6\"/>",
		board: "<rect x=\"4\" y=\"4\" width=\"5\" height=\"16\" rx=\"1.5\"/><rect x=\"10.5\" y=\"4\" width=\"5\" height=\"11\" rx=\"1.5\"/><rect x=\"17\" y=\"4\" width=\"3\" height=\"7\" rx=\"1\"/>",
		list: "<path d=\"M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5\"/>",
		timeline: "<path d=\"M4 6h9M8 12h12M6 18h8\"/>",
		cal: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"15\" rx=\"2\"/><path d=\"M4 10h16M9 3v4M15 3v4\"/>",
		filter: "<path d=\"M4 6h16M7 12h10M10 18h4\"/>",
		display: "<path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"10\" cy=\"17\" r=\"2\"/>",
		plus: "<path d=\"M12 5v14M5 12h14\"/>",
		more: "<circle cx=\"6\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"18\" cy=\"12\" r=\"1.2\"/>",
		comment: "<path d=\"M5 5h14v10H9l-4 4z\"/>",
		subtask: "<path d=\"M6 4v10a3 3 0 0 0 3 3h9\"/><path d=\"M15 14l3 3-3 3\"/>",
		date: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"15\" rx=\"2\"/><path d=\"M4 10h16\"/>",
		link: "<path d=\"M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1\"/>",
		close: "<path d=\"M6 6l12 12M18 6L6 18\"/>",
		share: "<path d=\"M12 4v11M8 8l4-4 4 4M5 14v5h14v-5\"/>",
		help: "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 16.5v.5\"/>",
		bell: "<path d=\"M6 16V11a6 6 0 0 1 12 0v5l2 2H4z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/>",
		trash: "<path d=\"M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13\"/>",
		copy: "<rect x=\"8\" y=\"8\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3\"/>",
		archive: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"5\" rx=\"1\"/><path d=\"M5 9v10h14V9M10 13h4\"/>",
	};
	const ic = (n) => `<svg class="i" viewBox="0 0 24 24">${P[n] || ""}</svg>`;
	const STATUS = {
		backlog: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#9a9eab\"><circle cx=\"12\" cy=\"12\" r=\"7.5\" stroke-dasharray=\"3 2.6\"/></svg>",
		todo: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#9a9eab\"><circle cx=\"12\" cy=\"12\" r=\"7.5\"/></svg>",
		progress: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#eab308\"><circle cx=\"12\" cy=\"12\" r=\"7.5\"/><path d=\"M12 7.5a4.5 4.5 0 0 1 0 9z\" fill=\"#eab308\" stroke=\"none\"/></svg>",
		review: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#22c55e\"><circle cx=\"12\" cy=\"12\" r=\"7.5\"/><path d=\"M12 7.5a4.5 4.5 0 1 1-4.5 4.5H12z\" fill=\"#22c55e\" stroke=\"none\"/></svg>",
		done: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#6366f1\"><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"#6366f1\" stroke=\"none\"/><path d=\"M8.5 12.2l2.4 2.4 4.6-4.8\" stroke=\"#fff\"/></svg>",
		canceled: "<svg class=\"i\" viewBox=\"0 0 24 24\" style=\"color:#9a9eab\"><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"#b4b7c0\" stroke=\"none\"/><path d=\"M9.5 9.5l5 5M14.5 9.5l-5 5\" stroke=\"#fff\"/></svg>",
	};
	const av = (k, size) => {
		if (!k) return `<span class="av" style="background:#fff;border:1.5px dashed #b4b7c0;color:#9a9eab${size ? `;width:${size}px;height:${size}px` : ""}"></span>`;
		const [, c] = D.people[k];
		return `<span class="av" style="background:${c}${size ? `;width:${size}px;height:${size}px` : ""}">${k}</span>`;
	};
	const prio = (p) => {
		if (p === 4) return "<span class=\"prio urgent\">!</span>";
		if (p === 0) return "<span class=\"prio\"><i style=\"height:2px\"></i><i style=\"height:2px\"></i><i style=\"height:2px\"></i></span>";
		return `<span class="prio"><i class="on" style="height:5px"></i><i class="${p >= 2 ? "on" : ""}" style="height:8px"></i><i class="${p >= 3 ? "on" : ""}" style="height:11px"></i></span>`;
	};
	const PRIO_NAMES = ["No priority", "Low", "Medium", "High", "Urgent"];

	document.getElementById("side").innerHTML = `
<div class="ws"><span class="sq">N</span>Northwind<span style="color:#9a9eab">${ic("down")}</span><span class="acts"><span class="ibtn" data-tip="Search" data-key="/">${ic("search")}</span><span class="ibtn" data-tip="New issue" data-key="C">${ic("edit")}</span></span></div>
<div class="nav">
<div class="ni" data-k="nav-inbox">${ic("inbox")}Inbox<span class="badge">4</span></div>
<div class="ni" data-k="nav-my">${ic("user")}My issues</div>
<div class="ni" data-k="nav-reviews">${ic("review")}Reviews<span class="badge">2</span></div>
<div class="ni" data-k="nav-pulse">${ic("pulse")}Pulse</div>
</div>
<div class="sec">Workspace ${ic("down")}</div>
<div class="ni" data-k="nav-projects">${ic("box")}Projects</div>
<div class="ni" data-k="nav-views">${ic("layers")}Views</div>
<div class="ni" data-k="nav-init">${ic("target")}Initiatives</div>
<div class="ni" data-k="nav-teams">${ic("users")}Teams</div>
<div class="sec">Your teams ${ic("down")}</div>
<div class="ni" data-k="team-capture"><span class="team" style="background:#7c3aed">C</span>Capture<span style="margin-left:auto;color:#9a9eab">${ic("down")}</span></div>
<div class="ni sub active" data-k="team-issues">${ic("issue")}Issues</div>
<div class="ni sub" data-k="team-cycles">${ic("cycle")}Cycles</div>
<div class="ni sub" data-k="team-projects">${ic("box")}Projects</div>
<div class="ni sub" data-k="team-views">${ic("layers")}Views</div>
<div class="ni" data-k="team-web"><span class="team" style="background:#0891b2">W</span>Web<span style="margin-left:auto;color:#9a9eab">${ic("chev")}</span></div>
<div class="ni" data-k="team-infra"><span class="team" style="background:#db2777">I</span>Infra<span style="margin-left:auto;color:#9a9eab">${ic("chev")}</span></div>
<div class="sec">Favorites ${ic("down")}</div>
<div class="ni" data-k="fav-1">${ic("board")}Sprint 42 board</div>
<div class="ni" data-k="fav-2">${ic("pulse")}Encoder performance</div>
<div class="ni" data-k="fav-3">${ic("filter")}Bug triage</div>
<div class="ni" data-k="fav-4">${ic("timeline")}Q4 roadmap</div>
<div class="side-bottom"><div class="ni" data-k="nav-invite">${ic("plus")}Invite people</div><div class="ni" data-k="nav-help">${ic("help")}Help &amp; support</div></div>`;

	document.getElementById("topbar").innerHTML = `
<div class="crumb"><span class="team" style="background:#7c3aed">C</span><span class="dim">Capture</span><span class="dim">${ic("chev")}</span>Sprint 42<span class="ibtn" data-tip="Add to favorites" data-k="star">${ic("star")}</span></div>
<div class="seg"><span class="on" data-k="view-board">${ic("board")}Board</span><span data-k="view-list">${ic("list")}List</span><span data-k="view-timeline">${ic("timeline")}Timeline</span><span data-k="view-cal">${ic("cal")}Calendar</span></div>
<div class="tr">
<div class="avs">${["ML", "MF", "PR", "DO"].map((k) => av(k)).join("")}<span class="av" style="background:#e5e6ea;color:#5d6170;border:2px solid #fff;margin-left:-6px;width:28px;height:28px">+4</span></div>
<span class="btn" data-k="btn-filter" data-tip="Filter issues" data-key="F">${ic("filter")}Filter</span>
<span class="btn" data-k="btn-display" data-tip="Display options" data-key="⇧ V">${ic("display")}Display</span>
<span class="ibtn" data-k="btn-bell" data-tip="Notifications">${ic("bell")}</span>
<span class="btn" data-k="btn-share">${ic("share")}Share</span>
<span class="btn primary" data-k="btn-new" data-tip="Create new issue" data-key="C">${ic("plus")}New issue</span>
</div>`;

	document.getElementById("filters").innerHTML = `
<span class="fchip"><span class="k">${ic("user")}Assignee</span><span>is any of</span><span>${av("MF", 16)}${av("PR", 16)} 3 people</span><span>${ic("close")}</span></span>
<span class="fchip"><span class="k">${ic("layers")}Label</span><span>includes</span><span><span class="lab" style="color:#7c3aed;background:#f3e8ff">encoder</span></span><span>${ic("close")}</span></span>
<span class="fchip"><span class="k">${ic("pulse")}Priority</span><span>is at least</span><span>Medium</span><span>${ic("close")}</span></span>
<span class="addf" data-k="add-filter">${ic("plus")}Add filter</span>
<span class="right"><span>Cycle 42 · Oct 6 – Oct 19</span><span>31 issues</span><span style="display:flex;align-items:center;gap:6px"><span style="width:90px;height:6px;border-radius:3px;background:#e5e6ea;overflow:hidden;display:inline-block"><span style="display:block;width:38%;height:100%;background:#6366f1"></span></span>38%</span></span>`;

	const board = document.getElementById("board");
	const cardEls = new Map();
	function cardHTML(c) {
		const [id, title, labels, who, p, due, sub, comments] = c;
		const labs = labels
			.map((l) => {
				const [fg, bg] = D.labels[l];
				return `<span class="lab" style="color:${fg};background:${bg}">${l}</span>`;
			})
			.join("");
		return `<div class="r1">${prio(p)}<span>${id}</span>${av(who)}</div><span class="more" data-tip="More actions">${ic("more")}</span>
<div class="tt">${title}</div>
<div class="r3">${labs}${due ? `<span class="meta">${ic("date")}${due}</span>` : ""}${sub ? `<span class="meta">${ic("subtask")}${sub}</span>` : ""}${comments ? `<span class="meta">${ic("comment")}${comments}</span>` : ""}</div>`;
	}
	for (const col of D.columns) {
		const el = document.createElement("div");
		el.className = "col";
		el.dataset.col = col.id;
		el.innerHTML = `<div class="colh">${STATUS[col.icon]}<span>${col.name}</span><span class="cnt">${col.cards.length}</span><span class="acts"><span class="ibtn" data-tip="Add issue">${ic("plus")}</span><span class="ibtn" data-tip="Column options">${ic("more")}</span></span></div><div class="list" data-scroll-id="col-${col.id}"></div>`;
		const list = el.querySelector(".list");
		for (const c of col.cards) {
			const ce = document.createElement("div");
			ce.className = "card";
			ce.dataset.id = c[0];
			ce.innerHTML = cardHTML(c);
			list.append(ce);
			cardEls.set(c[0], { el: ce, data: c, col: col.id });
		}
		board.append(el);
	}

	function updateCounts() {
		for (const col of board.querySelectorAll(".col")) col.querySelector(".cnt").textContent = col.querySelectorAll(".list .card").length;
	}

	const tooltip = document.getElementById("tooltip");
	let tipTimer = null;
	let tipFor = null;
	document.addEventListener("mouseover", (e) => {
		const t = e.target.closest("[data-tip]");
		if (t === tipFor) return;
		clearTimeout(tipTimer);
		tooltip.style.display = "none";
		tipFor = t;
		if (!t || dragging) return;
		tipTimer = setTimeout(() => {
			const r = t.getBoundingClientRect();
			tooltip.innerHTML = `${t.dataset.tip}${t.dataset.key ? `<kbd>${t.dataset.key}</kbd>` : ""}`;
			tooltip.style.display = "flex";
			const w = tooltip.offsetWidth;
			tooltip.style.left = `${Math.round(Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)))}px`;
			tooltip.style.top = `${Math.round(r.bottom + 8)}px`;
			cap.event("tooltip", { tip: t.dataset.tip });
		}, 480);
	});

	const menu = document.getElementById("menu");
	let menuOpen = false;
	const MENUS = {
		filter: `<div class="search">${ic("search")}Filter…</div><div class="mi">${STATUS.todo}Status<span class="sc">S</span></div><div class="mi">${ic("user")}Assignee<span class="sc">A</span></div><div class="mi">${ic("user")}Creator</div><div class="mi">${ic("pulse")}Priority<span class="sc">P</span></div><div class="mi">${ic("layers")}Labels<span class="sc">L</span></div><div class="mi">${ic("box")}Project</div><div class="mi">${ic("cycle")}Cycle</div><div class="mi">${ic("date")}Due date</div><div class="sep"></div><div class="mi">${ic("target")}Estimate</div><div class="mi">${ic("link")}Links</div>`,
		display: `<div class="mh">Grouping</div><div class="mi">${ic("board")}Status<span class="sc">✓</span></div><div class="mi">${ic("user")}Assignee</div><div class="mi">${ic("pulse")}Priority</div><div class="sep"></div><div class="mh">Ordering</div><div class="mi">${ic("filter")}Manual<span class="sc">✓</span></div><div class="mi">${ic("date")}Due date</div><div class="mi">${ic("cycle")}Last updated</div><div class="sep"></div><div class="mi">Show sub-issues<span class="sc">On</span></div><div class="mi">Show empty columns<span class="sc">Off</span></div>`,
		card: `<div class="mi">${ic("review")}Open<span class="sc">↵</span></div><div class="mi">${ic("link")}Copy link<span class="sc">⌘ L</span></div><div class="mi">${ic("copy")}Copy ID<span class="sc">⌘ .</span></div><div class="sep"></div><div class="mi">${STATUS.progress}Status<span class="sc">›</span></div><div class="mi">${ic("user")}Assignee<span class="sc">›</span></div><div class="mi">${ic("pulse")}Priority<span class="sc">›</span></div><div class="mi">${ic("layers")}Labels<span class="sc">›</span></div><div class="sep"></div><div class="mi">${ic("archive")}Archive</div><div class="mi danger">${ic("trash")}Delete<span class="sc">⌘ ⌫</span></div>`,
	};
	function openMenu(kind, anchor) {
		const r = anchor.getBoundingClientRect();
		menu.innerHTML = MENUS[kind];
		menu.style.display = "block";
		const w = menu.offsetWidth;
		menu.style.left = `${Math.round(Math.min(innerWidth - w - 8, r.left))}px`;
		menu.style.top = `${Math.round(r.bottom + 6)}px`;
		menuOpen = true;
		cap.event("menu_open", { kind });
	}
	function closeMenu() {
		if (!menuOpen) return;
		menu.style.display = "none";
		menuOpen = false;
		cap.event("menu_close");
	}

	const details = document.getElementById("details");
	function openDetails(id) {
		const { data, col } = cardEls.get(id);
		const [cid, title, labels, who, p, due, sub, comments] = data;
		const colDef = D.columns.find((c) => c.id === col);
		details.innerHTML = `<div class="dh">${STATUS[colDef.icon]}<span>${cid}</span><span class="acts"><span class="ibtn" data-tip="Copy link">${ic("link")}</span><span class="ibtn" data-tip="More">${ic("more")}</span><span class="ibtn" data-k="details-close" data-tip="Close" data-key="Esc">${ic("close")}</span></span></div>
<div class="db"><h3>${title}</h3>
<div class="prop"><span class="k">Status</span><span class="v">${STATUS[colDef.icon]}${colDef.name}</span></div>
<div class="prop"><span class="k">Priority</span><span class="v">${prio(p)}${PRIO_NAMES[p]}</span></div>
<div class="prop"><span class="k">Assignee</span><span class="v">${av(who, 20)}${who ? D.people[who][0] : "Unassigned"}</span></div>
<div class="prop"><span class="k">Labels</span><span class="v">${labels.map((l) => `<span class="lab" style="color:${D.labels[l][0]};background:${D.labels[l][1]}">${l}</span>`).join("")}</span></div>
<div class="prop"><span class="k">Cycle</span><span class="v">${ic("cycle")}Cycle 42</span></div>
<div class="prop"><span class="k">Due date</span><span class="v">${ic("date")}${due || "No due date"}</span></div>
<div class="prop"><span class="k">Sub-issues</span><span class="v">${ic("subtask")}${sub || "None"}</span></div>
<div class="desc">We see this on roughly 3% of sessions according to the telemetry dashboard. The first step is to reproduce it reliably on the test machines, then capture a trace with the frame pool counters enabled so we can tell whether the problem is in capture, conversion or upload.</div>
<div class="act">${av("MF", 22)}<div><b>Marcus Feld</b> moved this from Todo to In Progress · 2 days ago</div></div>
<div class="act">${av("PR", 22)}<div><b>Priya Raman</b> commented: Could we gate this behind the new encoder flag first? · yesterday</div></div>
<div class="act">${av("DO", 22)}<div><b>Daniel Okafor</b> added the label ${labels[0]} · 5 hours ago</div></div>
<div class="act" style="color:#9a9eab">${ic("comment")}<div>${comments} comments · Leave a comment…</div></div></div>`;
		details.classList.add("open");
		cap.event("details_open", { id });
	}
	function closeDetails() {
		if (!details.classList.contains("open")) return;
		details.classList.remove("open");
		cap.event("details_close");
	}

	const toast = document.getElementById("toast");
	let toastTimer = null;
	function showToast(html) {
		toast.innerHTML = html;
		toast.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
	}

	let press = null;
	let dragging = null;
	document.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
		if (menuOpen && !e.target.closest("#menu")) {
			closeMenu();
			if (!e.target.closest("[data-k=btn-filter],[data-k=btn-display],.more")) return;
		}
		const k = e.target.closest("[data-k]");
		if (k && k.dataset.k === "btn-filter") return openMenu("filter", k);
		if (k && k.dataset.k === "btn-display") return openMenu("display", k);
		if (k && k.dataset.k === "details-close") return closeDetails();
		if (e.target.closest(".more")) return openMenu("card", e.target.closest(".more"));
		if (e.target.closest("#menu .mi")) return closeMenu();
		if (k && k.classList.contains("ni")) {
			for (const n of document.querySelectorAll(".ni.active")) n.classList.remove("active");
			k.classList.add("active");
			setTimeout(() => {
				k.classList.remove("active");
				document.querySelector("[data-k=team-issues]").classList.add("active");
			}, 900);
			return;
		}
		const card = e.target.closest(".card");
		if (card) {
			const r = card.getBoundingClientRect();
			press = { card, x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, h: r.height };
			e.preventDefault();
			return;
		}
		if (!e.target.closest("#details")) closeDetails();
	});
	document.addEventListener("mousemove", (e) => {
		if (press && !dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
			const { card } = press;
			const ghost = card.cloneNode(true);
			ghost.classList.add("ghost");
			ghost.style.width = `${press.w}px`;
			document.body.append(ghost);
			const ph = document.createElement("div");
			ph.className = "placeholder";
			ph.style.height = `${press.h}px`;
			card.replaceWith(ph);
			dragging = { card, ghost, ph };
			tooltip.style.display = "none";
			cap.event("drag_start", { id: card.dataset.id });
		}
		if (!dragging) return;
		dragging.ghost.style.left = `${e.clientX - press.ox}px`;
		dragging.ghost.style.top = `${e.clientY - press.oy}px`;
		const under = document.elementFromPoint(e.clientX, e.clientY);
		const list = under && under.closest(".list");
		for (const l of document.querySelectorAll(".list.over")) if (l !== list) l.classList.remove("over");
		if (!list) return;
		list.classList.add("over");
		const cards = [...list.querySelectorAll(".card")];
		let before = null;
		for (const c of cards) {
			const r = c.getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) {
				before = c;
				break;
			}
		}
		if (before) {
			if (dragging.ph.nextSibling !== before) list.insertBefore(dragging.ph, before);
		} else if (list.lastElementChild !== dragging.ph) {
			list.append(dragging.ph);
		}
	});
	document.addEventListener("mouseup", () => {
		if (dragging) {
			const { card, ghost, ph } = dragging;
			ph.replaceWith(card);
			ghost.remove();
			for (const l of document.querySelectorAll(".list.over")) l.classList.remove("over");
			const col = card.closest(".col").dataset.col;
			const info = cardEls.get(card.dataset.id);
			const moved = info.col !== col;
			info.col = col;
			updateCounts();
			const name = D.columns.find((c) => c.id === col).name;
			if (moved) showToast(`${STATUS[D.columns.find((c) => c.id === col).icon]}<span>Moved <b>${card.dataset.id}</b> to ${name}</span><span class="undo">Undo</span>`);
			cap.event("drop", { id: card.dataset.id, col });
			dragging = null;
			press = null;
			return;
		}
		if (press) {
			openDetails(press.card.dataset.id);
			press = null;
		}
	});
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closeMenu();
			closeDetails();
		}
	});

	function center(el) {
		const r = el.getBoundingClientRect();
		return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height)];
	}
	window.capFind = (what) => {
		let el = null;
		if (what.startsWith("card:")) el = cardEls.get(what.slice(5)).el;
		else if (what.startsWith("more:")) {
			const c = cardEls.get(what.slice(5)).el;
			const r = c.getBoundingClientRect();
			return [Math.round(r.right - 47), Math.round(r.top + 18), 22, 22];
		} else if (what.startsWith("col:")) el = board.querySelector(`[data-col=${what.slice(4)}] .list`);
		else if (what.startsWith("colhead:")) el = board.querySelector(`[data-col=${what.slice(8)}] .colh`);
		else if (what.startsWith("menuitem:")) el = menu.querySelectorAll(".mi")[Number(what.slice(9))];
		else if (what.startsWith("prop:")) el = details.querySelectorAll(".prop")[Number(what.slice(5))];
		else el = document.querySelector(`[data-k="${what}"]`);
		return el ? center(el) : null;
	};
	window.capCardsIn = (col) => [...board.querySelectorAll(`[data-col=${col}] .card`)].map((c) => c.dataset.id);
	window.capTextRegions = () => {
		const s = document.getElementById("side").getBoundingClientRect();
		const cols = [...board.querySelectorAll(".col")];
		const a = cols[0].getBoundingClientRect();
		const b = cols[2].getBoundingClientRect();
		return [
			[s.left + 4, 60, 236, 560],
			[a.left, a.top + 42, a.width, 600],
			[b.left, b.top + 42, b.width, 600],
		];
	};
})();
