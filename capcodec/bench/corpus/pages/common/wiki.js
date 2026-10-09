(() => {
	const FIGS = {
		pellegrino: {
			w: 260,
			h: 210,
			cap: "Rasmus Malling-Hansen's writing ball (1870), the first typewriter sold commercially",
			svg: `<rect width="260" height="210" fill="url(#sepia)"/>
<ellipse cx="130" cy="186" rx="110" ry="16" fill="#3b2a18" opacity=".55"/>
<rect x="40" y="150" width="180" height="36" rx="4" fill="#4a3420"/>
<ellipse cx="130" cy="120" rx="82" ry="62" fill="#b08d3c"/>
<ellipse cx="118" cy="98" rx="54" ry="34" fill="#e6cf86" opacity=".55"/>
${Array.from({ length: 52 }, (_, i) => {
	const row = Math.floor(i / 13);
	const col = i % 13;
	const a = (col / 12 - 0.5) * 2.4;
	const x = 130 + Math.sin(a) * (70 - row * 11);
	const y = 82 + row * 17 + Math.cos(a) * 6;
	return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(5.6 - row * 0.5).toFixed(1)}" fill="#f2ead3" stroke="#3a2a12" stroke-width="1.2"/>`;
}).join("")}
<rect x="200" y="40" width="34" height="110" rx="3" fill="#2b1d10" opacity=".8"/>
<rect width="260" height="210" fill="url(#vign)"/>`,
		},
		sholes: {
			w: 300,
			h: 220,
			cap: "The Sholes and Glidden typewriter, produced by E. Remington and Sons from 1873",
			svg: `<rect width="300" height="220" fill="url(#sepia)"/>
<rect x="0" y="150" width="300" height="70" fill="#6d5233" opacity=".8"/>
<path d="M60 60h180l20 90H40z" fill="#2c2117"/>
<path d="M70 70h160l10 40H60z" fill="#7a5c34" opacity=".75"/>
<path d="M80 76q70 18 140 0" stroke="#e8d7a8" stroke-width="2" fill="none" opacity=".7"/>
<rect x="56" y="40" width="188" height="20" rx="10" fill="#1a130c"/>
<rect x="90" y="18" width="120" height="26" fill="#efe6cf" opacity=".9"/>
${Array.from({ length: 44 }, (_, i) => {
	const row = Math.floor(i / 11);
	const col = i % 11;
	const x = 64 + col * 16 + row * 5;
	const y = 118 + row * 10;
	return `<ellipse cx="${x}" cy="${y}" rx="5.5" ry="4" fill="#f4ecd6" stroke="#20160c" stroke-width="1"/>`;
}).join("")}
<rect x="30" y="160" width="240" height="10" fill="#1e150c"/>
<rect width="300" height="220" fill="url(#vign)"/>`,
		},
		selectric: {
			w: 300,
			h: 200,
			cap: "An IBM Selectric typewriter, with its spherical type element visible",
			svg: `<defs><linearGradient id="sb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b79b8"/><stop offset="1" stop-color="#1d3d6b"/></linearGradient>
<radialGradient id="ball" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#f5f5f5"/><stop offset=".6" stop-color="#9aa0a6"/><stop offset="1" stop-color="#3c4043"/></radialGradient>
<linearGradient id="room" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9e4da"/><stop offset="1" stop-color="#b8b1a4"/></linearGradient></defs>
<rect width="300" height="200" fill="url(#room)"/>
<rect y="150" width="300" height="50" fill="#8b7355"/>
<path d="M30 80h240l18 78H12z" fill="url(#sb)"/>
<rect x="44" y="56" width="212" height="28" rx="12" fill="#1f2a36"/>
<rect x="96" y="20" width="108" height="40" fill="#fbfaf6"/>
<path d="M104 30h86M104 38h80M104 46h90" stroke="#777" stroke-width="1.2"/>
<circle cx="150" cy="84" r="12" fill="url(#ball)"/>
${Array.from({ length: 48 }, (_, i) => {
	const row = Math.floor(i / 12);
	const col = i % 12;
	const x = 46 + col * 18 + row * 3;
	const y = 112 + row * 11;
	return `<rect x="${x}" y="${y}" width="14" height="8" rx="2" fill="#e8eaed" stroke="#1d2b3a" stroke-width=".8"/>`;
}).join("")}
<rect x="96" y="158" width="110" height="8" rx="3" fill="#e8eaed"/>
<rect width="300" height="200" fill="url(#vign)" opacity=".7"/>`,
		},
		office: {
			w: 320,
			h: 210,
			cap: "A typing pool at an insurance company in the 1940s",
			svg: `<rect width="320" height="210" fill="url(#sepia)"/>
<path d="M0 0h320v70L160 40 0 70z" fill="#cdbb95"/>
${Array.from({ length: 5 }, (_, r) => {
	const y = 70 + r * 26;
	const s = 0.5 + r * 0.14;
	return Array.from({ length: 6 }, (_, c) => {
		const x = 160 + (c - 2.5) * 52 * s;
		return `<g transform="translate(${x.toFixed(1)} ${y}) scale(${s.toFixed(2)})"><rect x="-22" y="10" width="44" height="12" fill="#4b3621"/><rect x="-10" y="0" width="20" height="10" fill="#2b2016"/><circle cx="0" cy="-14" r="7" fill="#6b5236"/><path d="M-10 -6h20l3 16h-26z" fill="#3e3022"/></g>`;
	}).join("");
}).join("")}
<rect width="320" height="210" fill="url(#vign)"/>`,
		},
		production: {
			w: 330,
			h: 236,
			cap: "Estimated typewriter production in the United States, 1900–1990 (millions of units per year)",
			svg: (() => {
				const data = [0.12, 0.31, 0.55, 0.9, 1.15, 0.72, 1.05, 1.42, 1.9, 2.35, 2.62, 2.1, 1.35, 0.6, 0.22, 0.08, 0.04, 0.02, 0.01];
				const years = [1900, 1905, 1910, 1915, 1920, 1925, 1930, 1935, 1940, 1945, 1950, 1955, 1960, 1965, 1970, 1975, 1980, 1985, 1990];
				const series = [0.12, 0.3, 0.52, 0.85, 1.1, 0.95, 0.8, 0.98, 1.3, 1.6, 2.1, 2.55, 2.75, 2.6, 2.2, 1.6, 0.9, 0.35, 0.12];
				let s = "<rect width=\"330\" height=\"236\" fill=\"#fff\"/>";
				for (let i = 0; i <= 6; i++) {
					const y = 196 - i * 28;
					s += `<line x1="40" x2="320" y1="${y}" y2="${y}" stroke="#e5e5e5"/><text x="34" y="${y + 4}" font-size="10" text-anchor="end" fill="#444" font-family="Noto Sans">${(i * 0.5).toFixed(1)}</text>`;
				}
				series.forEach((v, i) => {
					const x = 46 + i * 14.4;
					const h = v * 56;
					s += `<rect x="${x}" y="${196 - h}" width="10" height="${h}" fill="#5b8ccf"/>`;
					if (i % 3 === 0) s += `<text x="${x + 5}" y="210" font-size="9.5" text-anchor="middle" fill="#444" font-family="Noto Sans">${years[i]}</text>`;
				});
				s += `<polyline fill="none" stroke="#d9534f" stroke-width="2" points="${data.map((v, i) => `${51 + i * 14.4},${196 - v * 56}`).join(" ")}"/>`;
				s += "<line x1=\"40\" x2=\"320\" y1=\"196\" y2=\"196\" stroke=\"#333\"/><line x1=\"40\" x2=\"40\" y1=\"20\" y2=\"196\" stroke=\"#333\"/>";
				s += "<rect x=\"196\" y=\"16\" width=\"10\" height=\"10\" fill=\"#5b8ccf\"/><text x=\"210\" y=\"25\" font-size=\"10\" fill=\"#222\" font-family=\"Noto Sans\">All typewriters</text>";
				s += "<line x1=\"196\" x2=\"206\" y1=\"38\" y2=\"38\" stroke=\"#d9534f\" stroke-width=\"2\"/><text x=\"210\" y=\"41\" font-size=\"10\" fill=\"#222\" font-family=\"Noto Sans\">Portable models</text>";
				s += "<text x=\"180\" y=\"230\" font-size=\"10\" text-anchor=\"middle\" fill=\"#222\" font-family=\"Noto Sans\">Year</text>";
				return s;
			})(),
		},
		typebar: {
			w: 300,
			h: 210,
			cap: "Simplified diagram of a front-strike typebar mechanism: key lever (A), sublever (B), typebar (C), platen (D) and ribbon (E)",
			svg: `<rect width="300" height="210" fill="#fff"/>
<circle cx="236" cy="56" r="26" fill="#ddd" stroke="#333" stroke-width="2"/>
<circle cx="236" cy="56" r="4" fill="#333"/>
<path d="M196 70h30" stroke="#c0392b" stroke-width="4"/>
<path d="M30 180l90-10" stroke="#333" stroke-width="4"/>
<rect x="18" y="172" width="26" height="12" rx="3" fill="#f2f2f2" stroke="#333" stroke-width="2"/>
<path d="M120 170l30-40" stroke="#555" stroke-width="3"/>
<path d="M150 130l60-56" stroke="#2c3e50" stroke-width="4"/>
<rect x="204" y="64" width="12" height="16" fill="#2c3e50" transform="rotate(-42 210 72)"/>
<circle cx="150" cy="130" r="4" fill="#fff" stroke="#333" stroke-width="2"/>
<circle cx="120" cy="170" r="4" fill="#fff" stroke="#333" stroke-width="2"/>
<path d="M140 150a40 40 0 0 1 40-40" fill="none" stroke="#888" stroke-dasharray="4 3"/>
${[
	["A", 70, 196],
	["B", 128, 150],
	["C", 176, 96],
	["D", 270, 40],
	["E", 206, 92],
]
	.map(([t, x, y]) => `<text x="${x}" y="${y}" font-family="Noto Sans" font-weight="700" font-size="14" fill="#222">${t}</text>`)
	.join("")}`,
		},
		keyboard: {
			w: 330,
			h: 128,
			cap: "The QWERTY layout as used on most English-language typewriters",
			svg: (() => {
				const rows = ["1234567890-", "QWERTYUIOP", "ASDFGHJKL;", "ZXCVBNM,./"];
				let s = "<rect width=\"330\" height=\"128\" fill=\"#f4f4f4\"/>";
				rows.forEach((r, ri) => {
					[...r].forEach((ch, ci) => {
						const x = 10 + ri * 9 + ci * 27;
						const y = 8 + ri * 27;
						s += `<rect x="${x}" y="${y}" width="24" height="24" rx="4" fill="#fff" stroke="#888"/><text x="${x + 12}" y="${y + 16.5}" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="12" fill="#222">${ch}</text>`;
					});
				});
				s += "<rect x=\"80\" y=\"116\" width=\"170\" height=\"10\" rx=\"3\" fill=\"#fff\" stroke=\"#888\"/>";
				return s;
			})(),
		},
	};

	const TABLES = {
		models: `<table class="wikitable"><caption>Selected typewriter models</caption>
<tr><th>Year</th><th>Manufacturer</th><th>Model</th><th>Type</th><th>Notable features</th></tr>
${[
	["1865", "Malling-Hansen", "Writing ball", "Index/keyboard", "First commercially sold typewriter"],
	["1873", "E. Remington and Sons", "Sholes and Glidden", "Upstrike", "QWERTY layout, capitals only"],
	["1878", "Remington", "No. 2", "Upstrike", "Shift key for upper and lower case"],
	["1893", "Blickensderfer", "No. 5", "Typewheel", "Portable, interchangeable typewheel"],
	["1895", "Underwood", "No. 1", "Front-strike", "Visible writing"],
	["1900", "Underwood", "No. 5", "Front-strike", "Best-selling desktop model for decades"],
	["1909", "Corona", "No. 3", "Front-strike", "Folding carriage portable"],
	["1935", "IBM", "Electromatic Model 01", "Electric", "First mass-produced IBM electric"],
	["1950", "Olivetti", "Lettera 22", "Portable", "Industrial design award winner"],
	["1961", "IBM", "Selectric", "Typeball", "Moving element, stationary paper"],
	["1973", "IBM", "Correcting Selectric II", "Typeball", "Built-in lift-off correction"],
	["1984", "Brother", "AX-10", "Daisy wheel", "Electronic, line memory"],
]
	.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
	.join("")}
</table>`,
		layouts: `<table class="wikitable"><caption>Common keyboard layouts</caption>
<tr><th>Layout</th><th>Main region</th><th>Top letter row</th><th>Introduced</th></tr>
${[
	["QWERTY", "English-speaking countries, many others", "Q W E R T Y U I O P", "1873"],
	["QWERTZ", "Germany, Austria, Central Europe", "Q W E R T Z U I O P Ü", "c. 1890"],
	["AZERTY", "France, Belgium", "A Z E R T Y U I O P", "c. 1900"],
	["QZERTY", "Italy (historical)", "Q Z E R T Y U I O P", "c. 1910"],
	["Dvorak", "Alternative for English", "' , . P Y F G C R L", "1936"],
	["JCUKEN", "Russia and other Cyrillic users", "Й Ц У К Е Н Г Ш Щ З", "c. 1900"],
]
	.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
	.join("")}
</table>`,
	};

	function refs() {
		const authors = [
			"Beeching, Wilfred A.", "Current, Richard N.", "Polt, Richard", "Adler, Michael H.", "Rehr, Darryl", "Romano, Frank J.", "Yamada, Hisao", "David, Paul A.", "Liebowitz, S. J.; Margolis, Stephen E.", "Utterback, James M.", "Hoke, Donald", "Davies, Margery W.", "Kittler, Friedrich", "Wershler-Henry, Darren", "Masi, Frank T.", "Bliven, Bruce Jr.", "Lundmark, Torbjörn", "Herkimer County Historical Society", "Stamp, Jimmy", "Nesmith Graham, Bette",
		];
		const titles = [
			["<i>Century of the Typewriter</i>", "London: Heinemann"],
			["<i>The Typewriter and the Men Who Made It</i>", "Urbana: University of Illinois Press"],
			["<i>The Typewriter Revolution</i>", "Woodstock, VT: Countryman Press"],
			["<i>The Writing Machine</i>", "London: George Allen &amp; Unwin"],
			["<i>Antique Typewriters and Office Collectibles</i>", "Paducah: Collector Books"],
			["<i>Machine Writing and Typesetting</i>", "Salem, NH: GAMA"],
			["\"A historical study of typewriters and typing methods\"", "<i>Journal of Information Processing</i>"],
			["\"Clio and the Economics of QWERTY\"", "<i>American Economic Review</i>"],
			["\"The Fable of the Keys\"", "<i>Journal of Law and Economics</i>"],
			["<i>Mastering the Dynamics of Innovation</i>", "Boston: Harvard Business School Press"],
			["<i>Ingenious Yankees</i>", "New York: Columbia University Press"],
			["<i>Woman's Place Is at the Typewriter</i>", "Philadelphia: Temple University Press"],
			["<i>Gramophone, Film, Typewriter</i>", "Stanford: Stanford University Press"],
			["<i>The Iron Whim: A Fragmented History of Typewriting</i>", "Ithaca: Cornell University Press"],
			["<i>The Typewriter Legend</i>", "Secaucus, NJ: Matsushita Electric"],
			["<i>The Wonderful Writing Machine</i>", "New York: Random House"],
			["\"The keyboard that would not die\"", "<i>Smithsonian Magazine</i>"],
			["<i>The Story of the Typewriter, 1873–1923</i>", "Herkimer, NY"],
			["\"How the typewriter changed office work\"", "<i>The Atlantic</i>"],
			["\"Mistake Out: the invention of correction fluid\"", "<i>Texas Monthly</i>"],
		];
		const out = [];
		for (let i = 0; i < 38; i++) {
			const a = authors[(i * 7) % authors.length];
			const [t, p] = titles[(i * 11 + 3) % titles.length];
			const y = 1923 + ((i * 37) % 98);
			const pg = 12 + ((i * 53) % 290);
			const back = i % 4 === 1 ? "<span class=\"up\">^ <sup>a</sup> <sup>b</sup></span>" : "<span class=\"up\">^</span>";
			const isbn = i % 3 === 0 ? ` ISBN 978-0-${String(100000 + i * 7919).slice(0, 3)}-${String(10000 + i * 3571).slice(0, 5)}-${i % 10}.` : "";
			out.push(`<li>${back}${a} (${y}). ${t}. ${p}. p. ${pg}.${isbn}${i % 5 === 2 ? " Retrieved 14 March 2024." : ""}</li>`);
		}
		return `<ol class="refs">${out.join("")}</ol>`;
	}

	const SEEALSO = `<div class="cols"><ul>${["Daisy wheel printing", "Index typewriter", "Keyboard layout", "List of typewriter brands", "Mimeograph", "Stenotype", "Teleprinter", "Typewriter ribbon", "Typing", "Word processor"].map((s) => `<li><a data-p="${s}">${s}</a></li>`).join("")}</ul></div>`;

	const NAVBOX = `<table class="navbox">
<tr><th class="nt" colspan="2">Writing and office technology</th></tr>
${[
	["Handwriting", ["Pen", "Pencil", "Fountain pen", "Ballpoint pen", "Quill", "Stylus"]],
	["Mechanical", ["Typewriter", "Index typewriter", "Stenotype", "Mimeograph", "Hectograph", "Adding machine"]],
	["Electromechanical", ["Electric typewriter", "Teleprinter", "Flexowriter", "Dictaphone", "Telex"]],
	["Electronic", ["Electronic typewriter", "Word processor", "Daisy wheel printer", "Dot matrix printer", "Personal computer"]],
	["Copying", ["Carbon paper", "Photocopier", "Spirit duplicator", "Fax"]],
]
	.map(([g, items]) => `<tr><th class="ng">${g}</th><td>${items.map((x) => `<a>${x}</a>`).join("")}</td></tr>`)
	.join("")}
</table>`;

	function figure(key) {
		const f = FIGS[key];
		return `<div class="thumb" style="width:${f.w + 2}px"><svg viewBox="0 0 ${f.w} ${f.h}" width="${f.w}" height="${f.h}" ${key === "production" || key === "typebar" || key === "keyboard" ? "" : "filter=\"url(#grain)\""}>${f.svg}</svg><div class="cap">${f.cap}</div></div>`;
	}

	const article = document.getElementById("article");
	const toc = document.getElementById("toclist");
	let h2n = 0;
	let h3n = 0;
	let html = "";
	const tocItems = ["<li class=\"top\">(Top)</li>"];
	for (const sec of window.ARTICLE) {
		let body = sec.html
			.replace(/\{fig:(\w+)\}/g, (_, k) => figure(k))
			.replace(/\{table:(\w+)\}/g, (_, k) => TABLES[k])
			.replace("{refs}", refs())
			.replace("{seealso}", SEEALSO)
			.replace("{navbox}", NAVBOX);
		if (sec.lead) {
			html += body;
			continue;
		}
		if (sec.h === 2) {
			h2n++;
			h3n = 0;
			tocItems.push(`<li><span class="tn">${h2n}</span>${sec.title}</li>`);
			html += `<h2>${sec.title}<span class="edit">[edit]</span></h2>${body}`;
		} else {
			h3n++;
			tocItems.push(`<li class="l3"><span class="tn">${h2n}.${h3n}</span>${sec.title}</li>`);
			html += `<h3>${sec.title}<span class="edit">[edit]</span></h3>${body}`;
		}
	}
	html += `<div id="footer">This page was last edited on 2 October 2026, at 14:12<span> (UTC)</span>.<br>Text is available under the Creative Commons Attribution-ShareAlike 4.0 License; additional terms may apply. By using this site, you agree to the Terms of Use and Privacy Policy. Wikipedia® is a registered trademark of the Wikimedia Foundation, Inc., a non-profit organization.
<div class="fl"><span>Privacy policy</span><span>About Wikipedia</span><span>Disclaimers</span><span>Contact Wikipedia</span><span>Code of Conduct</span><span>Developers</span><span>Statistics</span><span>Cookie statement</span><span>Mobile view</span></div></div>`;
	article.innerHTML = html;
	toc.innerHTML = tocItems.join("");

	const keys = document.getElementById("keys");
	let k = "";
	for (let r = 0; r < 4; r++) {
		for (let c = 0; c < 11; c++) {
			const x = 58 + c * 15.5 + r * 6;
			const y = 108 + r * 12;
			k += `<circle cx="${x}" cy="${y}" r="5" fill="url(#key)" stroke="#111" stroke-width="1"/>`;
		}
	}
	keys.innerHTML = k;

	const preview = document.getElementById("preview");
	let hoverTimer = null;
	let hideTimer = null;
	const SUMMARIES = {
		"Personal computer": "A personal computer is a computer designed for individual use. It is intended to be operated directly by an end user, rather than by a computer expert or technician.",
		"Word processor": "A word processor is a device or computer program that provides for input, editing, formatting, and output of text, often with some additional features.",
		QWERTY: "QWERTY is a keyboard layout for Latin-script alphabets. The name comes from the order of the first six keys on the top letter row of the keyboard.",
	};
	document.addEventListener("mouseover", (e) => {
		const a = e.target.closest("a");
		if (!a) return;
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => {
			const name = a.dataset.p || a.textContent;
			const summary =
				SUMMARIES[name] ||
				`${name} is a topic related to the history of writing machines and office technology. It is covered in more detail in its own article.`;
			const r = a.getBoundingClientRect();
			preview.innerHTML = `<div class="pb"><div class="pt"></div></div><div class="pf"><span>⚙ Preferences</span><span>Read more ›</span></div>`;
			preview.querySelector(".pt").textContent = name;
			preview.querySelector(".pb").append(document.createTextNode(summary));
			preview.style.left = `${Math.round(r.left + scrollX)}px`;
			preview.style.top = `${Math.round(r.bottom + scrollY + 6)}px`;
			preview.style.display = "block";
			cap.event("preview_show", { name });
		}, 700);
	});
	document.addEventListener("mouseout", (e) => {
		if (!e.target.closest("a")) return;
		clearTimeout(hoverTimer);
		hideTimer = setTimeout(() => {
			if (preview.style.display !== "none") cap.event("preview_hide");
			preview.style.display = "none";
		}, 300);
	});
	window.addEventListener("scroll", () => {
		clearTimeout(hoverTimer);
		if (preview.style.display !== "none") {
			preview.style.display = "none";
			cap.event("preview_hide");
		}
	});

	window.capTextRegions = () => {
		const c = document.getElementById("content").getBoundingClientRect();
		return [
			[c.left, 120, 600, 440],
			[c.left, 580, 600, 440],
		];
	};
})();
