import "./style.css";
import {
	INITIAL_STATE,
	OsmError,
	PRESETS,
	VIEW,
	baseWeightPx,
	drawRoads,
	fetchRoads,
	reduce,
	renderSvg,
	resolveStyle,
	scaledClassWeights,
	searchPlaces,
	uniformWeight,
	type AppEvent,
	type AppState,
	type Background,
	type PresetId,
} from "./index.ts";
import { downloadPng, downloadSvg } from "./export.ts";

const form = byId("search-form", HTMLFormElement);
const queryInput = byId("city-query", HTMLInputElement);
const statusEl = byId("status", HTMLParagraphElement);
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
const exportSvgBtn = byId("export-svg", HTMLButtonElement);
const exportPngBtn = byId("export-png", HTMLButtonElement);
const canvas = byId("map", HTMLCanvasElement);
const emptyEl = byId("empty", HTMLParagraphElement);
const mapCtx = canvas.getContext("2d");
if (!mapCtx) throw new Error("Canvas 2D is unavailable.");
const ctx: CanvasRenderingContext2D = mapCtx;

let state: AppState = INITIAL_STATE;
let inFlight = 0;
let abort: AbortController | null = null;
let lastSolidBg = "#F7F2E8";
let lastPlacesQuery = "";

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

exportSvgBtn.addEventListener("click", () => {
	if (!state.map) return;
	downloadSvg(fileName(state.map.place.name, "svg"), currentSvg());
});

exportPngBtn.addEventListener("click", () => {
	if (!state.map) return;
	void downloadPng(fileName(state.map.place.name, "png"), currentSvg(), VIEW);
});

const resize = new ResizeObserver(() => paintMap());
resize.observe(canvas);
syncUi();

async function dispatch(event: AppEvent): Promise<void> {
	const prev = state;
	state = reduce(state, event);
	syncUi();

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

	if (state.load.kind === "loading") {
		const prevKey =
			prev.load.kind === "loading"
				? `${prev.load.place.osm.kind}:${prev.load.place.osm.id}`
				: "";
		const nextKey = `${state.load.place.osm.kind}:${state.load.place.osm.id}`;
		if (prevKey !== nextKey) {
			const gen = ++inFlight;
			abort?.abort();
			abort = new AbortController();
			try {
				const map = await fetchRoads(state.load.place, { signal: abort.signal });
				if (gen !== inFlight) return;
				await dispatch({ kind: "loaded", map });
			} catch (error) {
				if (gen !== inFlight || isAbort(error)) return;
				await dispatch({ kind: "fail", message: errorMessage(error) });
			}
		}
	}
}

function syncUi(): void {
	const style = resolveStyle(state.choice);
	statusEl.textContent = statusText(state);
	statusEl.dataset.busy =
		state.load.kind === "searching" || state.load.kind === "loading"
			? "true"
			: "false";

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
				button.dataset.index = String(index);
				button.textContent = place.name;
				li.append(button);
				placesEl.append(li);
			});
		}
		placesEl.hidden = false;
	} else {
		lastPlacesQuery = "";
		placesEl.hidden = true;
		placesEl.replaceChildren();
	}

	for (const chip of presetsEl.querySelectorAll<HTMLButtonElement>(".chip")) {
		chip.setAttribute(
			"aria-pressed",
			state.choice.kind === "preset" && chip.dataset.preset === state.choice.id
				? "true"
				: "false",
		);
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
	emptyEl.hidden = ready;
	paintMap();
}

function paintMap(): void {
	if (!state.map) {
		const dpr = window.devicePixelRatio || 1;
		const rect = canvas.getBoundingClientRect();
		canvas.width = Math.max(1, Math.round(rect.width * dpr));
		canvas.height = Math.max(1, Math.round(rect.height * dpr));
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		return;
	}
	const dpr = window.devicePixelRatio || 1;
	const rect = canvas.getBoundingClientRect();
	const cssW = Math.max(1, rect.width);
	const cssH = Math.max(1, rect.height);
	canvas.width = Math.max(1, Math.round(cssW * dpr));
	canvas.height = Math.max(1, Math.round(cssH * dpr));
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	drawRoads(ctx, state.map, resolveStyle(state.choice), {
		width: cssW,
		height: cssH,
	});
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
			return `${current.map.place.name}. ${current.map.roads.length.toLocaleString()} roads`;
		case "searching":
			return `Looking up ${current.load.query}…`;
		case "choose":
			return "Several matches. Pick one.";
		case "loading":
			return `Drawing roads for ${current.load.place.name}. Large cities take a minute.`;
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

function byId<T extends Element>(
	id: string,
	Ctor: new (...args: never[]) => T,
): T {
	const el = document.getElementById(id);
	if (!(el instanceof Ctor)) throw new Error(`Missing #${id}`);
	return el;
}
