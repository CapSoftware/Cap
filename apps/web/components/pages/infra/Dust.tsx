"use client";

import { useEffect, useRef } from "react";
import { PLAIN } from "./art";
import { FILM_EVENT } from "./film-source";
import styles from "./scene.module.css";

const RENDER_SCALE = 0.5;
const MAX_WIDTH = 1280;
const FRAME_MS = 1000 / 30;
const START_AFTER_MS = 400;

const VERTEX = `
attribute vec2 corner;
varying vec2 at;
void main() {
	at = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
	gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 at;
uniform float time;
uniform float horizon;
uniform vec4 slab;

const float EYE = 120.0;
const float SLAB_AT = 3400.0;
const vec2 LENS = vec2(1.2857, 0.6429);
const vec3 SUN = vec3(0.0, 0.9703, 0.2419);

float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

float noise(vec2 p) {
	vec2 cell = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
		mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), f.x),
		f.y
	);
}

float fbm(vec2 p) {
	float sum = 0.0;
	float gain = 0.5;
	for (int i = 0; i < 4; i++) {
		sum += gain * noise(p);
		p = p * 2.03 + 17.1;
		gain *= 0.5;
	}
	return sum;
}

float sheet(vec2 ground, float seed, float speed) {
	vec2 wide = vec2((ground.x - time * speed) * 0.0032, ground.y * 0.014 + time * 0.012) + seed;
	float streams = pow(clamp((fbm(wide) - 0.46) * 4.2, 0.0, 1.0), 1.5);
	vec2 fine = vec2((ground.x - time * speed * 1.6) * 0.02, ground.y * 0.07) + seed * 1.7;
	return streams * (0.4 + 0.75 * noise(fine));
}

void main() {
	float drop = at.y - horizon;
	float side = (at.x - 0.5) * LENS.x;
	vec3 ray = normalize(vec3(side, 1.0, -drop * LENS.y));
	float toward = max(dot(ray, SUN), 0.0);
	float lit = 0.13 + 0.6 * pow(toward, 5.0) + 0.5 * pow(toward, 40.0);
	bool onSlab = at.x > slab.x && at.x < slab.z && at.y > slab.y && at.y < slab.w;
	float dust = 0.0;

	if (drop > 0.0015) {
		float slope = drop * LENS.y;
		float nearAway = (EYE - 9.0) / slope;
		float nearSheet = sheet(vec2(side * nearAway, nearAway), 3.7, 34.0);
		nearSheet *= exp(-nearAway / 2600.0) * clamp((nearAway - 160.0) / 700.0, 0.0, 1.0);
		if (onSlab && nearAway > SLAB_AT) nearSheet = 0.0;

		float midAway = (EYE - 32.0) / slope;
		float midSheet = sheet(vec2(side * midAway, midAway), 19.3, 46.0);
		midSheet *= exp(-midAway / 2600.0) * clamp((midAway - 160.0) / 700.0, 0.0, 1.0);
		if (onSlab && midAway > SLAB_AT) midSheet = 0.0;

		dust = nearSheet + midSheet * 0.8;
	} else if (drop < -0.0015) {
		float away = 30.0 / (-drop * LENS.y);
		float veil = sheet(vec2(side * away, away), 41.9, 58.0);
		veil *= exp(-away / 5200.0) * clamp((away - 300.0) / 900.0, 0.0, 1.0);
		dust = veil * (onSlab ? 0.0 : 0.3);
	}

	float glow = dust * lit;
	float grain = (hash(gl_FragCoord.xy + time) - 0.5) / 255.0;
	vec3 color = max(vec3(0.92, 0.94, 1.0) * glow + grain, 0.0);
	gl_FragColor = vec4(color, max(color.r, max(color.g, color.b)));
}`;

const compile = (gl: WebGLRenderingContext, type: number, source: string) => {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
};

const createPainter = (canvas: HTMLCanvasElement) => {
	const gl = canvas.getContext("webgl", {
		alpha: true,
		antialias: false,
		depth: false,
		stencil: false,
		powerPreference: "low-power",
		premultipliedAlpha: true,
	});
	if (!gl) return null;
	const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
	const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
	const program = gl.createProgram();
	if (!vertex || !fragment || !program) return null;
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
	const select = gl.useProgram.bind(gl);
	select(program);

	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array([-1, -1, 3, -1, -1, 3]),
		gl.STATIC_DRAW,
	);
	const corner = gl.getAttribLocation(program, "corner");
	gl.enableVertexAttribArray(corner);
	gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

	gl.uniform1f(gl.getUniformLocation(program, "horizon"), PLAIN.horizon);
	gl.uniform4f(
		gl.getUniformLocation(program, "slab"),
		PLAIN.slab.left,
		PLAIN.slab.top,
		PLAIN.slab.right,
		PLAIN.slabBase,
	);
	const time = gl.getUniformLocation(program, "time");

	return (seconds: number) => {
		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.uniform1f(time, seconds);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	};
};

export const HeroDust = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)");
		let paint: ((seconds: number) => void) | null = null;
		let frame = 0;
		let seconds = Math.random() * 600;
		let last = 0;
		let inView = false;
		let filmOpen = false;
		let lost = false;

		const size = () => {
			const box = canvas.getBoundingClientRect();
			const width = Math.max(
				2,
				Math.round(Math.min(MAX_WIDTH, box.width * RENDER_SCALE)),
			);
			const height = Math.max(
				2,
				Math.round((width * box.height) / (box.width || 1)),
			);
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}
		};

		const tick = (now: number) => {
			frame = requestAnimationFrame(tick);
			const elapsed = now - last;
			if (elapsed < FRAME_MS - 2) return;
			seconds += Math.min(elapsed, 100) / 1000;
			last = now;
			paint?.(seconds);
			if (canvas.dataset.on !== "true") canvas.dataset.on = "true";
		};

		const sync = () => {
			const run =
				inView && !filmOpen && !lost && !still.matches && !document.hidden;
			if (run && !frame) {
				paint ??= createPainter(canvas);
				if (!paint) return;
				size();
				last = performance.now();
				frame = requestAnimationFrame(tick);
			} else if (!run && frame) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			if (still.matches) canvas.dataset.on = "false";
		};

		const seen = new IntersectionObserver(([entry]) => {
			inView = entry?.isIntersecting ?? false;
			sync();
		});
		const resized = new ResizeObserver(size);
		const onFilm = (event: Event) => {
			filmOpen = (event as CustomEvent<boolean>).detail;
			sync();
		};
		const onLost = (event: Event) => {
			event.preventDefault();
			lost = true;
			paint = null;
			canvas.dataset.on = "false";
			sync();
		};
		const onRestored = () => {
			lost = false;
			sync();
		};

		const begin = () => {
			seen.observe(canvas);
			resized.observe(canvas);
		};
		const idle = window.setTimeout(begin, START_AFTER_MS);

		document.addEventListener("visibilitychange", sync);
		window.addEventListener(FILM_EVENT, onFilm);
		still.addEventListener("change", sync);
		canvas.addEventListener("webglcontextlost", onLost);
		canvas.addEventListener("webglcontextrestored", onRestored);

		return () => {
			window.clearTimeout(idle);
			cancelAnimationFrame(frame);
			seen.disconnect();
			resized.disconnect();
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener(FILM_EVENT, onFilm);
			still.removeEventListener("change", sync);
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
		};
	}, []);

	return <canvas ref={canvasRef} className={styles.dust} data-on="false" />;
};
