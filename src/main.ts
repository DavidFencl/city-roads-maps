import "./style.css";
import {
	INITIAL_STATE,
	OsmError,
	PRESETS,
	VIEW,
	FIT_CAMERA,
	MARGIN_MAX_KM,
	baseWeightPx,
	clampCamera,
	drawCredit,
	drawRoads,
	fetchRoads,
	reduce,
	renderSvg,
	resolveStyle,
	scaledClassWeights,
	searchPlaces,
	snapshotFrame,
	uniformWeight,
	zoomCamera,
	type AppEvent,
	type AppState,
	type Background,
	type Camera,
	type PresetId,
	type Style,
} from "./index.ts";
import {
	mapCacheKey,
	readCachedMap,
	readCachedTile,
	readCachedTiles,
	writeCachedMap,
	writeCachedTile,
} from "./cache.ts";
import { downloadPng, downloadSvg } from "./export.ts";

const form = byId("search-form", HTMLFormElement);
const queryInput = byId("city-query", HTMLInputElement);
const statusEl = byId("status", HTMLParagraphElement);
const statusMark = byId("status-mark", HTMLElement);
const statusTextEl = byId("status-text", HTMLElement);
const errorEl = byId("error", HTMLParagraphElement);
const errorText = byId("error-text", HTMLElement);
const retryBtn = byId("retry", HTMLButtonElement);
const placesEl = byId("places", HTMLUListElement);
const presetsEl = byId("presets", HTMLDivElement);
const bgColor = byId("bg-color", HTMLInputElement);
const bgTransparent = byId("bg-transparent", HTMLInputElement);
const roadColor = byId("road-color", HTMLInputElement);
const weightInput = byId("weight", HTMLInputElement);
const weightOut = byId("weight-out", HTMLOutputElement);
const byClass = byId("by-class", HTMLInputElement);
const marginInput = byId("margin", HTMLInputElement);
const marginOut = byId("margin-out", HTMLOutputElement);
const exportSvgBtn = byId("export-svg", HTMLButtonElement);
const exportPngBtn = byId("export-png", HTMLButtonElement);
const plate = byId("plate", HTMLElement);
const canvas = byId("map", HTMLCanvasElement);
const emptyEl = byId("empty", HTMLParagraphElement);
const loadingEl = byId("loading", HTMLParagraphElement);
const loadingText = byId("loading-text", HTMLElement);
const zoomEl = byId("zoom", HTMLDivElement);
const zoomInBtn = byId("zoom-in", HTMLButtonElement);
const zoomOutBtn = byId("zoom-out", HTMLButtonElement);
const zoomFitBtn = byId("zoom-fit", HTMLButtonElement);
const mapCtx = canvas.getContext("2d");
if (!mapCtx) throw new Error("Canvas 2D is unavailable.");
const ctx: CanvasRenderingContext2D = mapCtx;

let state: AppState = INITIAL_STATE;
let inFlight = 0;
let abort: AbortController | null = null;
let lastSolidBg = "#F7F2E8";
let lastPlacesQuery = "";
let camera: Camera = FIT_CAMERA;
let sharpTimer = 0;
let tileNote = "";
let rememberedCustom: Style = resolveStyle({ kind: "preset", id: "paper" });

type Snapshot = {
	readonly canvas: HTMLCanvasElement;
	readonly camera: Camera;
	readonly cssW: number;
	readonly cssH: number;
};

let snapshot: Snapshot | null = null;
const pointers = new Map<number, { readonly x: number; readonly y: number }>();
let pinch: { readonly distance: number; readonly zoom: number } | null = null;

for (const [id, preset] of Object.entries(PRESETS) as [PresetId, (typeof PRESETS)[PresetId]][]) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "chip";
	button.dataset.preset = id;
	button.title = preset.label;
	const swatch = document.createElement("span");
	swatch.className = "swatch";
	if (preset.style.background.kind === "solid") {
		swatch.style.background = preset.style.background.color;
	} else {
		swatch.dataset.clear = "true";
	}
	const stroke = document.createElement("span");
	stroke.className = "swatch-road";
	stroke.style.background = cssColor(preset.style.roadColor);
	swatch.append(stroke);
	const label = document.createElement("span");
	label.textContent = preset.label;
	button.append(swatch, label);
	button.addEventListener("click", () => {
		void dispatch({ kind: "preset", id });
	});
	presetsEl.append(button);
}

const customChip = document.createElement("button");
customChip.type = "button";
customChip.className = "chip";
customChip.dataset.preset = "custom";
customChip.title = "Custom";
const customSwatch = document.createElement("span");
customSwatch.className = "swatch";
const customStroke = document.createElement("span");
customStroke.className = "swatch-road";
customSwatch.append(customStroke);
const customLabel = document.createElement("span");
customLabel.textContent = "Custom";
customChip.append(customSwatch, customLabel);
customChip.addEventListener("click", () => {
	void dispatch({ kind: "useCustom", style: rememberedCustom });
});
presetsEl.append(customChip);
paintCustomChip(rememberedCustom);

form.addEventListener("submit", (event) => {
	event.preventDefault();
	void dispatch({ kind: "submit", query: queryInput.value });
});

retryBtn.addEventListener("click", () => {
	void dispatch({ kind: "retry" });
});

placesEl.addEventListener("click", (event) => {
	const button = (event.target as HTMLElement).closest("button[data-index]");
	if (!button || !(button instanceof HTMLButtonElement)) return;
	if (state.load.kind !== "choose") return;
	const index = Number(button.dataset.index);
	const place = state.load.places[index];
	if (!place) return;
	void dispatch({ kind: "choose", place });
});

document.addEventListener("mousedown", (event) => {
	if (state.load.kind !== "choose") return;
	if (!(event.target instanceof Node) || form.contains(event.target)) return;
	void dispatch({ kind: "reset" });
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || state.load.kind !== "choose") return;
	event.preventDefault();
	void dispatch({ kind: "reset" });
});

bgColor.addEventListener("input", () => {
	lastSolidBg = bgColor.value;
	void dispatch({
		kind: "background",
		background: { kind: "solid", color: bgColor.value },
	});
});

bgTransparent.addEventListener("change", () => {
	const background: Background = bgTransparent.checked
		? { kind: "transparent" }
		: { kind: "solid", color: lastSolidBg };
	void dispatch({ kind: "background", background });
});

roadColor.addEventListener("input", () => {
	void dispatch({ kind: "roadColor", color: roadColor.value });
});

weightInput.addEventListener("input", () => {
	void dispatch({ kind: "weight", weight: currentWeight() });
});

byClass.addEventListener("change", () => {
	void dispatch({ kind: "weight", weight: currentWeight() });
});

marginInput.max = String(MARGIN_MAX_KM);
marginInput.addEventListener("input", () => {
	marginOut.value = marginLabel(Number(marginInput.value));
});
marginInput.addEventListener("change", () => {
	void dispatch({ kind: "margin", km: Number(marginInput.value) });
});

zoomInBtn.addEventListener("click", () => {
	zoomAbout(1.25);
});
zoomOutBtn.addEventListener("click", () => {
	zoomAbout(1 / 1.25);
});
zoomFitBtn.addEventListener("click", () => {
	fitMap();
});

canvas.addEventListener(
	"wheel",
	(event) => {
		if (!state.map || state.load.kind === "drawing") return;
		event.preventDefault();
		let delta = event.deltaY;
		if (event.deltaMode === 1) delta *= 16;
		if (event.deltaMode === 2) delta *= canvas.getBoundingClientRect().height;
		const rect = canvas.getBoundingClientRect();
		setCamera(
			zoomCamera(
				camera,
				viewOf(rect),
				event.clientX - rect.left,
				event.clientY - rect.top,
				camera.zoom * Math.exp(-delta * 0.0018),
			),
		);
		paintGlide();
	},
	{ passive: false },
);

canvas.addEventListener("pointerdown", (event) => {
	if (!state.map || event.button !== 0) return;
	canvas.setPointerCapture(event.pointerId);
	pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
	if (pointers.size === 2) {
		pinch = { distance: pointerDistance(), zoom: camera.zoom };
	}
	canvas.classList.add("panning");
});

canvas.addEventListener("pointermove", (event) => {
	const prev = pointers.get(event.pointerId);
	if (!prev) return;
	pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
	if (pointers.size >= 2 && pinch) {
		const distance = pointerDistance();
		if (pinch.distance > 0 && distance > 0) {
			const rect = canvas.getBoundingClientRect();
			const mid = pointerMidpoint();
			setCamera(
				zoomCamera(
					camera,
					viewOf(rect),
					mid.x - rect.left,
					mid.y - rect.top,
					pinch.zoom * (distance / pinch.distance),
				),
			);
			paintGlide();
		}
		return;
	}
	const rect = canvas.getBoundingClientRect();
	setCamera(
		clampCamera(
			{
				zoom: camera.zoom,
				x: camera.x + (event.clientX - prev.x),
				y: camera.y + (event.clientY - prev.y),
			},
			viewOf(rect),
		),
	);
	paintGlide();
});

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("dblclick", () => {
	fitMap();
});

canvas.addEventListener("keydown", (event) => {
	if (event.key === "+" || event.key === "=") {
		event.preventDefault();
		zoomAbout(1.25);
	} else if (event.key === "-" || event.key === "_") {
		event.preventDefault();
		zoomAbout(1 / 1.25);
	} else if (event.key === "0") {
		event.preventDefault();
		fitMap();
	}
});

exportSvgBtn.addEventListener("click", () => {
	if (!state.map) return;
	downloadSvg(fileName(state.map.place.name, "svg"), currentSvg());
});

exportPngBtn.addEventListener("click", () => {
	if (!state.map) return;
	void downloadPng(fileName(state.map.place.name, "png"), currentSvg(), VIEW);
});

const resize = new ResizeObserver(() => {
	if (state.load.kind === "drawing") return;
	paintMap();
});
resize.observe(canvas);
syncUi();

let drawToken = 0;

async function dispatch(event: AppEvent): Promise<void> {
	const prev = state;
	state = reduce(state, event);
	if (prev.load.kind === "loading" && state.load.kind === "drawing") {
		camera = FIT_CAMERA;
		snapshot = null;
	}
	const scheduleDraw =
		state.load.kind === "drawing" && prev.load.kind !== "drawing";
	syncUi({ paint: !scheduleDraw && state.load.kind !== "drawing" });
	if (scheduleDraw) {
		const token = ++drawToken;
		await nextPaint();
		if (token !== drawToken || state.load.kind !== "drawing") return;
		paintMap();
		state = reduce(state, { kind: "painted" });
		syncUi({ paint: false });
		return;
	}

	if (state.load.kind === "searching") {
		const started =
			prev.load.kind !== "searching" || prev.load.query !== state.load.query;
		if (started) {
			const gen = ++inFlight;
			abort?.abort();
			abort = new AbortController();
			try {
				const places = await searchPlaces(state.load.query, {
					signal: abort.signal,
				});
				if (gen !== inFlight) return;
				await dispatch({
					kind: "places",
					query: state.load.query,
					places,
				});
				return;
			} catch (error) {
				if (gen !== inFlight || isAbort(error)) return;
				await dispatch({ kind: "fail", message: errorMessage(error) });
				return;
			}
		}
	}

	if (state.load.kind === "loading" && fetchKey(prev) !== fetchKey(state)) {
		const gen = ++inFlight;
		const place = state.load.place;
		const marginKm = state.marginKm;
		abort?.abort();
		abort = new AbortController();
		const signal = abort.signal;
		try {
			const key = mapCacheKey(place, marginKm);
			const cached = await readCachedMap(key);
			if (gen !== inFlight) return;
			if (cached) {
				await dispatch({ kind: "loaded", map: cached });
				return;
			}
			tileNote = "";
			state = { ...state, map: null };
			syncUi({ paint: false });
			let paintQueued = false;
			const map = await fetchRoads(place, {
				signal,
				marginKm,
				tileCache: {
					read: readCachedTile,
					write: writeCachedTile,
					readMany: readCachedTiles,
				},
				onTile: (update) => {
					if (gen !== inFlight || state.load.kind !== "loading") return;
					tileNote = `${update.done} of ${update.total} tiles`;
					if (update.roads.length === 0) {
						syncUi({ paint: false });
						return;
					}
					state = {
						...state,
						map: { place, bounds: update.bounds, roads: update.roads },
					};
					if (paintQueued) {
						syncUi({ paint: false });
						return;
					}
					paintQueued = true;
					requestAnimationFrame(() => {
						paintQueued = false;
						if (gen !== inFlight || state.load.kind !== "loading") return;
						syncUi();
					});
				},
			});
			tileNote = "";
			if (gen !== inFlight) return;
			await dispatch({ kind: "loaded", map });
			void writeCachedMap(key, map).catch(() => undefined);
		} catch (error) {
			if (gen !== inFlight || isAbort(error)) return;
			await dispatch({ kind: "fail", message: errorMessage(error) });
		}
	}
}

function fetchKey(current: AppState): string {
	if (current.load.kind !== "loading") return "";
	return `${current.load.place.osm.kind}:${current.load.place.osm.id}:${current.marginKm}`;
}

function syncUi(options?: { paint?: boolean }): void {
	const style = resolveStyle(state.choice);
	const busy =
		state.load.kind === "searching" ||
		state.load.kind === "loading" ||
		state.load.kind === "drawing";
	const message = statusText(state);
	statusTextEl.textContent = message;
	statusEl.dataset.busy = busy ? "true" : "false";
	statusMark.hidden = !busy;
	const showCover = busy && (state.map?.roads.length ?? 0) === 0;
	loadingEl.hidden = !showCover;
	loadingText.textContent = message;
	plate.setAttribute("aria-busy", busy ? "true" : "false");

	const err =
		state.load.kind === "searchError" || state.load.kind === "fetchError"
			? state.load.message
			: "";
	errorEl.hidden = !err;
	errorText.textContent = err;

	if (state.load.kind === "choose") {
		if (lastPlacesQuery !== state.load.query) {
			lastPlacesQuery = state.load.query;
			placesEl.replaceChildren();
			state.load.places.forEach((place, index) => {
				const li = document.createElement("li");
				const button = document.createElement("button");
				button.type = "button";
				button.role = "option";
				button.dataset.index = String(index);
				button.textContent = place.name;
				li.append(button);
				placesEl.append(li);
			});
		}
		placesEl.hidden = false;
		queryInput.setAttribute("aria-expanded", "true");
	} else {
		lastPlacesQuery = "";
		placesEl.hidden = true;
		placesEl.replaceChildren();
		queryInput.setAttribute("aria-expanded", "false");
	}

	if (state.choice.kind === "custom") rememberedCustom = state.choice.style;
	paintCustomChip(rememberedCustom);
	for (const chip of presetsEl.querySelectorAll<HTMLButtonElement>(".chip")) {
		const pressed =
			chip.dataset.preset === "custom"
				? state.choice.kind === "custom"
				: state.choice.kind === "preset" && chip.dataset.preset === state.choice.id;
		chip.setAttribute("aria-pressed", pressed ? "true" : "false");
	}

	if (style.background.kind === "solid") {
		lastSolidBg = cssColor(style.background.color);
		bgColor.value = lastSolidBg;
		bgTransparent.checked = false;
		bgColor.disabled = false;
	} else {
		bgTransparent.checked = true;
		bgColor.disabled = true;
	}
	roadColor.value = cssColor(style.roadColor);
	const px = baseWeightPx(style.weight);
	weightInput.value = String(px);
	weightOut.value = px.toFixed(2);
	byClass.checked = style.weight.kind === "byClass";

	const ready = state.map !== null;
	exportSvgBtn.disabled = !ready;
	exportPngBtn.disabled = !ready;
	zoomEl.hidden = !ready || busy;
	canvas.classList.toggle("ready", ready && !busy);
	marginInput.value = String(state.marginKm);
	marginOut.value = marginLabel(state.marginKm);
	emptyEl.hidden = busy || ready;
	if (options?.paint === false) return;
	if (state.load.kind === "drawing") return;
	paintMap();
}

function nextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

function paintMap(mode: "sharp" | "glide" = "sharp"): void {
	const rect = canvas.getBoundingClientRect();
	const cssW = Math.max(1, rect.width);
	const cssH = Math.max(1, rect.height);
	const dpr = window.devicePixelRatio || 1;
	const view = { width: cssW, height: cssH };
	if (
		canvas.width !== Math.round(cssW * dpr) ||
		canvas.height !== Math.round(cssH * dpr)
	) {
		canvas.width = Math.max(1, Math.round(cssW * dpr));
		canvas.height = Math.max(1, Math.round(cssH * dpr));
		if (mode === "glide") mode = "sharp";
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	if (!state.map) {
		ctx.clearRect(0, 0, cssW, cssH);
		snapshot = null;
		return;
	}
	const style = resolveStyle(state.choice);
	if (mode === "glide" && snapshot && snapshot.cssW === cssW && snapshot.cssH === cssH) {
		const frame = snapshotFrame(camera, snapshot.camera, view);
		ctx.clearRect(0, 0, cssW, cssH);
		ctx.save();
		ctx.transform(frame.scale, 0, 0, frame.scale, frame.x, frame.y);
		ctx.drawImage(snapshot.canvas, 0, 0, cssW, cssH);
		ctx.restore();
		drawCredit(ctx, style, view);
		return;
	}
	drawRoads(ctx, state.map, style, view, { camera, credit: false });
	rememberSnapshot(cssW, cssH);
	drawCredit(ctx, style, view);
}

function paintGlide(): void {
	if (!snapshot) {
		paintMap("sharp");
		return;
	}
	paintMap("glide");
	window.clearTimeout(sharpTimer);
	sharpTimer = window.setTimeout(() => paintMap("sharp"), 180);
}

function rememberSnapshot(cssW: number, cssH: number): void {
	const copy = snapshot?.canvas ?? document.createElement("canvas");
	copy.width = canvas.width;
	copy.height = canvas.height;
	const copyCtx = copy.getContext("2d");
	if (!copyCtx) return;
	copyCtx.setTransform(1, 0, 0, 1, 0, 0);
	copyCtx.clearRect(0, 0, copy.width, copy.height);
	copyCtx.drawImage(canvas, 0, 0);
	snapshot = { canvas: copy, camera, cssW, cssH };
}

function currentSvg(): string {
	if (!state.map) return "";
	return renderSvg(state.map, resolveStyle(state.choice), VIEW);
}

function currentWeight() {
	const px = Number(weightInput.value);
	return byClass.checked ? scaledClassWeights(px) : uniformWeight(px);
}

function statusText(current: AppState): string {
	switch (current.load.kind) {
		case "idle":
			if (!current.map) return "";
			return `${current.map.place.name}. ${current.map.roads.length.toLocaleString()} roads${
				current.marginKm > 0 ? `. ${current.marginKm} km around` : ""
			}`;
		case "searching":
			return `Looking up ${current.load.query}…`;
		case "choose":
			return "Several matches. Pick one.";
		case "loading":
			return tileNote
				? `Fetching roads for ${current.load.place.name}. ${tileNote}.`
				: `Fetching roads for ${current.load.place.name}. The first draw of a large city takes a few minutes.`;
		case "drawing":
			return "Drawing the map.";
		case "searchError":
		case "fetchError":
			return "";
		default: {
			const _exhaustive: never = current.load;
			return _exhaustive;
		}
	}
}

function fileName(placeName: string, ext: string): string {
	const base =
		placeName
			.split(",")[0]
			?.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "city";
	return `${base}.${ext}`;
}

function cssColor(color: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		const [r, g, b] = color.slice(1);
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
	if (!rgba) return "#000000";
	const hex = [rgba[1], rgba[2], rgba[3]]
		.map((part) => Number(part).toString(16).padStart(2, "0"))
		.join("");
	return `#${hex}`;
}

function errorMessage(error: unknown): string {
	if (error instanceof OsmError) return error.message;
	if (error instanceof Error) return error.message;
	return "Something went wrong.";
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function paintCustomChip(style: Style): void {
	if (style.background.kind === "solid") {
		customSwatch.style.background = style.background.color;
		delete customSwatch.dataset.clear;
	} else {
		customSwatch.style.background = "";
		customSwatch.dataset.clear = "true";
	}
	customStroke.style.background = cssColor(style.roadColor);
}

function marginLabel(km: number): string {
	const rounded = Number.isFinite(km) ? Math.round(km) : 0;
	return `${rounded} km`;
}

function viewOf(rect: DOMRect): { width: number; height: number } {
	return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

function setCamera(next: Camera): void {
	camera = next;
}

function zoomAbout(factor: number): void {
	if (!state.map) return;
	const rect = canvas.getBoundingClientRect();
	const view = viewOf(rect);
	setCamera(zoomCamera(camera, view, view.width / 2, view.height / 2, camera.zoom * factor));
	paintGlide();
}

function fitMap(): void {
	if (!state.map) return;
	camera = FIT_CAMERA;
	window.clearTimeout(sharpTimer);
	paintMap("sharp");
}

function pointerDistance(): number {
	const points = [...pointers.values()];
	const a = points[0];
	const b = points[1];
	if (!a || !b) return 0;
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerMidpoint(): { x: number; y: number } {
	const points = [...pointers.values()];
	const a = points[0];
	const b = points[1];
	if (!a || !b) return a ?? { x: 0, y: 0 };
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function endPointer(event: PointerEvent): void {
	if (!pointers.has(event.pointerId)) return;
	pointers.delete(event.pointerId);
	if (pointers.size < 2) pinch = null;
	if (pointers.size === 0) {
		canvas.classList.remove("panning");
		window.clearTimeout(sharpTimer);
		paintMap("sharp");
	}
}

function byId<T extends Element>(
	id: string,
	Ctor: new (...args: never[]) => T,
): T {
	const el = document.getElementById(id);
	if (!(el instanceof Ctor)) throw new Error(`Missing #${id}`);
	return el;
}
