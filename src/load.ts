import type { Place, RoadMap } from "./osm.ts";
import type {
	Background,
	LineWeight,
	PresetId,
	Style,
	StyleChoice,
} from "./style.ts";
import { resolveStyle } from "./style.ts";

export type LoadState =
	| { readonly kind: "idle" }
	| { readonly kind: "searching"; readonly query: string }
	| {
			readonly kind: "choose";
			readonly query: string;
			readonly places: readonly Place[];
	  }
	| { readonly kind: "loading"; readonly place: Place }
	| { readonly kind: "drawing" }
	| {
			readonly kind: "searchError";
			readonly query: string;
			readonly message: string;
	  }
	| {
			readonly kind: "fetchError";
			readonly place: Place;
			readonly message: string;
	  };

export const MARGIN_MAX_KM = 20;

export function clampMarginKm(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(MARGIN_MAX_KM, Math.max(0, Math.round(value)));
}

export type AppState = {
	readonly map: RoadMap | null;
	readonly load: LoadState;
	readonly choice: StyleChoice;
	readonly marginKm: number;
};

export type AppEvent =
	| { readonly kind: "submit"; readonly query: string }
	| {
			readonly kind: "places";
			readonly query: string;
			readonly places: readonly Place[];
	  }
	| { readonly kind: "choose"; readonly place: Place }
	| { readonly kind: "loaded"; readonly map: RoadMap }
	| { readonly kind: "painted" }
	| { readonly kind: "fail"; readonly message: string }
	| { readonly kind: "retry" }
	| { readonly kind: "reset" }
	| { readonly kind: "preset"; readonly id: PresetId }
	| { readonly kind: "roadColor"; readonly color: string }
	| { readonly kind: "background"; readonly background: Background }
	| { readonly kind: "weight"; readonly weight: LineWeight }
	| { readonly kind: "margin"; readonly km: number };

export const INITIAL_STATE: AppState = {
	map: null,
	load: { kind: "idle" },
	choice: { kind: "preset", id: "paper" },
	marginKm: 0,
};

export function reduce(state: AppState, event: AppEvent): AppState {
	switch (event.kind) {
		case "submit": {
			const query = event.query.trim();
			if (!query) return state;
			return { ...state, load: { kind: "searching", query } };
		}
		case "places": {
			if (state.load.kind !== "searching" || state.load.query !== event.query) {
				return state;
			}
			if (event.places.length === 0) {
				return {
					...state,
					load: {
						kind: "searchError",
						query: event.query,
						message: `No places matched "${event.query}".`,
					},
				};
			}
			const only = event.places[0]!;
			if (event.places.length === 1) {
				return { ...state, load: { kind: "loading", place: only } };
			}
			return {
				...state,
				load: { kind: "choose", query: event.query, places: event.places },
			};
		}
		case "choose": {
			if (state.load.kind !== "choose") return state;
			return { ...state, load: { kind: "loading", place: event.place } };
		}
		case "loaded": {
			if (state.load.kind !== "loading") return state;
			if (placeKey(state.load.place) !== placeKey(event.map.place)) {
				return state;
			}
			return { ...state, map: event.map, load: { kind: "drawing" } };
		}
		case "painted": {
			if (state.load.kind !== "drawing") return state;
			return { ...state, load: { kind: "idle" } };
		}
		case "fail": {
			if (state.load.kind === "searching") {
				return {
					...state,
					load: {
						kind: "searchError",
						query: state.load.query,
						message: event.message,
					},
				};
			}
			if (state.load.kind === "loading") {
				return {
					...state,
					load: {
						kind: "fetchError",
						place: state.load.place,
						message: event.message,
					},
				};
			}
			return state;
		}
		case "retry": {
			if (state.load.kind === "searchError") {
				return { ...state, load: { kind: "searching", query: state.load.query } };
			}
			if (state.load.kind === "fetchError") {
				return { ...state, load: { kind: "loading", place: state.load.place } };
			}
			return state;
		}
		case "reset":
			return { ...state, load: { kind: "idle" } };
		case "preset":
			return withPaint(state, { kind: "preset", id: event.id });
		case "roadColor":
			return withPaint(state, withCustom(state, { roadColor: event.color }).choice);
		case "background":
			return withPaint(state, withCustom(state, { background: event.background }).choice);
		case "weight":
			return withPaint(state, withCustom(state, { weight: event.weight }).choice);
		case "margin": {
			const marginKm = clampMarginKm(event.km);
			if (marginKm === state.marginKm) return state;
			const next = { ...state, marginKm };
			const place = activePlace(state);
			if (
				place &&
				(state.load.kind === "idle" ||
					state.load.kind === "drawing" ||
					state.load.kind === "loading" ||
					state.load.kind === "fetchError")
			) {
				return { ...next, load: { kind: "loading", place } };
			}
			return next;
		}
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

function withCustom(state: AppState, patch: Partial<Style>): AppState {
	const style = resolveStyle(state.choice);
	return {
		...state,
		choice: { kind: "custom", style: { ...style, ...patch } },
	};
}

function withPaint(state: AppState, choice: StyleChoice): AppState {
	const next = { ...state, choice };
	if (state.map && (state.load.kind === "idle" || state.load.kind === "drawing")) {
		return { ...next, load: { kind: "drawing" } };
	}
	return next;
}

function placeKey(place: Place): string {
	return `${place.osm.kind}:${place.osm.id}`;
}

function activePlace(state: AppState): Place | null {
	if (state.map) return state.map.place;
	if (state.load.kind === "loading" || state.load.kind === "fetchError") {
		return state.load.place;
	}
	return null;
}
