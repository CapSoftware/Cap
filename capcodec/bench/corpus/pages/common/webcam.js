(() => {
	const params = new URLSearchParams(location.search);
	const bubble = document.getElementById("webcam");
	if (!bubble || params.get("webcam") !== "1") return;
	bubble.classList.add("on");
	const canvas = document.getElementById("cam");
	const dpr = window.devicePixelRatio || 1;
	const S = 320;
	const N = Math.round(S * dpr);
	canvas.width = N;
	canvas.height = N;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });

	let seed = 12345;
	const rand = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};

	const shelf = [];
	for (let i = 0; i < 26; i++) {
		shelf.push({
			x: 8 + i * 12 + rand() * 4,
			w: 7 + rand() * 6,
			h: 34 + rand() * 30,
			row: i % 2,
			c: `hsl(${Math.floor(rand() * 360)}, ${35 + Math.floor(rand() * 30)}%, ${30 + Math.floor(rand() * 30)}%)`,
		});
	}

	let noise = null;
	let frame = 0;
	let lastDraw = 0;

	function draw(tms) {
		const t = tms / 1000;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const exposure =
			0.94 + 0.05 * Math.sin(t * 0.21) + 0.02 * Math.sin(t * 1.3);
		const wall = ctx.createLinearGradient(0, 0, S, S);
		wall.addColorStop(
			0,
			`hsl(${32 + 6 * Math.sin(t * 0.13)}, 32%, ${Math.round(70 * exposure)}%)`,
		);
		wall.addColorStop(
			1,
			`hsl(${24 + 4 * Math.sin(t * 0.17)}, 28%, ${Math.round(46 * exposure)}%)`,
		);
		ctx.fillStyle = wall;
		ctx.fillRect(0, 0, S, S);
		const win = ctx.createRadialGradient(
			260 + 6 * Math.sin(t * 0.3),
			70,
			10,
			260,
			70,
			150,
		);
		win.addColorStop(0, `rgba(255,248,225,${0.55 + 0.1 * Math.sin(t * 0.4)})`);
		win.addColorStop(1, "rgba(255,248,225,0)");
		ctx.fillStyle = win;
		ctx.fillRect(0, 0, S, S);
		const sway = 3 * Math.sin(t * 0.37);
		ctx.save();
		ctx.globalAlpha = 0.55;
		for (const b of shelf) {
			ctx.fillStyle = b.c;
			const y = b.row ? 112 : 46;
			ctx.fillRect(b.x - 20 + sway * 0.4, y + (64 - b.h), b.w, b.h);
		}
		ctx.fillStyle = "rgba(70,45,25,0.6)";
		ctx.fillRect(-10 + sway * 0.4, 110, 200, 6);
		ctx.fillRect(-10 + sway * 0.4, 176, 200, 6);
		ctx.restore();
		const plant = ctx.createRadialGradient(
			286 + sway * 0.4,
			220,
			4,
			286,
			220,
			60,
		);
		plant.addColorStop(0, "rgba(60,110,50,0.85)");
		plant.addColorStop(1, "rgba(60,110,50,0)");
		ctx.fillStyle = plant;
		ctx.fillRect(200, 150, 140, 140);

		const breathe = 1 + 0.012 * Math.sin(t * 1.55);
		const hx = 162 + 9 * Math.sin(t * 0.61) + 3 * Math.sin(t * 1.9);
		const hy = 128 + 4 * Math.sin(t * 0.83) + 2 * Math.sin(t * 2.3);
		const tilt = 0.06 * Math.sin(t * 0.47);

		ctx.save();
		ctx.translate(160 + 4 * Math.sin(t * 0.61), 330);
		ctx.scale(breathe, breathe);
		const shirt = ctx.createLinearGradient(-150, -120, 150, 0);
		shirt.addColorStop(0, "#2f4f7a");
		shirt.addColorStop(0.5, "#3b6296");
		shirt.addColorStop(1, "#22395c");
		ctx.fillStyle = shirt;
		ctx.beginPath();
		ctx.moveTo(-170, 10);
		ctx.bezierCurveTo(-160, -90, -110, -118, -40, -128);
		ctx.lineTo(40, -128);
		ctx.bezierCurveTo(110, -118, 160, -90, 170, 10);
		ctx.closePath();
		ctx.fill();
		ctx.fillStyle = "rgba(0,0,0,0.18)";
		ctx.beginPath();
		ctx.moveTo(-36, -128);
		ctx.lineTo(0, -84);
		ctx.lineTo(36, -128);
		ctx.closePath();
		ctx.fill();
		ctx.restore();

		const neck = ctx.createLinearGradient(hx - 30, 0, hx + 30, 0);
		neck.addColorStop(0, "#b9805c");
		neck.addColorStop(1, "#d39b74");
		ctx.fillStyle = neck;
		ctx.fillRect(hx - 26, hy + 50, 52, 70);

		ctx.save();
		ctx.translate(hx, hy);
		ctx.rotate(tilt);
		const skin = ctx.createRadialGradient(-18, -22, 8, 0, 0, 82);
		skin.addColorStop(0, "#f1c7a3");
		skin.addColorStop(0.6, "#d9a07a");
		skin.addColorStop(1, "#a9704f");
		ctx.fillStyle = skin;
		ctx.beginPath();
		ctx.ellipse(0, 0, 54, 70, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#c48862";
		ctx.beginPath();
		ctx.ellipse(-54, 6, 9, 15, 0, 0, Math.PI * 2);
		ctx.ellipse(54, 6, 9, 15, 0, 0, Math.PI * 2);
		ctx.fill();
		const hair = ctx.createLinearGradient(0, -80, 0, -20);
		hair.addColorStop(0, "#2b1d14");
		hair.addColorStop(1, "#4a3122");
		ctx.fillStyle = hair;
		ctx.beginPath();
		ctx.moveTo(-58, -6);
		ctx.bezierCurveTo(-66, -70, -30, -84, 6, -82);
		ctx.bezierCurveTo(44, -82, 66, -60, 58, -6);
		ctx.bezierCurveTo(46, -40, 20, -48, -4, -46);
		ctx.bezierCurveTo(-30, -46, -46, -36, -58, -6);
		ctx.fill();
		const blink = t % 4.3 < 0.13;
		ctx.fillStyle = "#2a1a12";
		for (const ex of [-21, 21]) {
			ctx.beginPath();
			ctx.ellipse(
				ex + 2 * Math.sin(t * 0.9),
				-6,
				7,
				blink ? 1 : 4.5,
				0,
				0,
				Math.PI * 2,
			);
			ctx.fill();
		}
		ctx.strokeStyle = "rgba(60,35,25,0.6)";
		ctx.lineWidth = 3;
		for (const ex of [-21, 21]) {
			ctx.beginPath();
			ctx.moveTo(ex - 11, -20);
			ctx.quadraticCurveTo(ex, -25 - Math.sin(t * 0.7), ex + 11, -20);
			ctx.stroke();
		}
		ctx.strokeStyle = "rgba(120,70,50,0.45)";
		ctx.lineWidth = 2.5;
		ctx.beginPath();
		ctx.moveTo(-2, -2);
		ctx.quadraticCurveTo(-7, 18, 2, 22);
		ctx.stroke();
		const talk = Math.max(
			0,
			Math.sin(t * 9.1) * Math.sin(t * 2.3) + 0.25 * Math.sin(t * 13.7),
		);
		ctx.fillStyle = "#7a3b32";
		ctx.beginPath();
		ctx.ellipse(0, 40, 16, 3 + 6 * talk, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		const vig = ctx.createRadialGradient(160, 160, 90, 160, 160, 230);
		vig.addColorStop(0, "rgba(0,0,0,0)");
		vig.addColorStop(1, "rgba(0,0,0,0.35)");
		ctx.fillStyle = vig;
		ctx.fillRect(0, 0, S, S);

		const img = ctx.getImageData(0, 0, N, N);
		const d = img.data;
		if (!noise) noise = new Int8Array(d.length);
		for (let i = 0; i < d.length; i += 4) {
			const g = ((rand() + rand() + rand() - 1.5) * 9) | 0;
			d[i] += g + ((rand() * 5) | 0) - 2;
			d[i + 1] += g + ((rand() * 3) | 0) - 1;
			d[i + 2] += g + ((rand() * 7) | 0) - 3;
		}
		ctx.putImageData(img, 0, 0);
		frame++;
	}

	function loop(ts) {
		if (ts - lastDraw >= 1000 / 30 - 2) {
			lastDraw = ts;
			draw(ts);
		}
		requestAnimationFrame(loop);
	}
	requestAnimationFrame(loop);

	let drag = null;
	bubble.addEventListener("mousedown", (e) => {
		e.preventDefault();
		const r = bubble.getBoundingClientRect();
		drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
		bubble.classList.add("drag");
		cap.event("webcam_drag_start", { x: r.left, y: r.top });
	});
	window.addEventListener("mousemove", (e) => {
		if (!drag) return;
		const x = Math.max(8, Math.min(innerWidth - S - 8, e.clientX - drag.dx));
		const y = Math.max(8, Math.min(innerHeight - S - 8, e.clientY - drag.dy));
		bubble.style.left = `${x}px`;
		bubble.style.top = `${y}px`;
	});
	window.addEventListener("mouseup", () => {
		if (!drag) return;
		drag = null;
		bubble.classList.remove("drag");
		const r = bubble.getBoundingClientRect();
		cap.event("webcam_drag_end", { x: r.left, y: r.top });
	});
	window.capWebcamRect = () => {
		const r = bubble.getBoundingClientRect();
		return [r.left, r.top, r.width, r.height];
	};
})();
