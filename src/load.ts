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

export type AppState = {
	readonly map: RoadMap | null;
	readonly load: LoadState;
	readonly choice: StyleChoice;
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
	| { readonly kind: "fail"; readonly message: string }
	| { readonly kind: "retry" }
	| { readonly kind: "reset" }
	| { readonly kind: "preset"; readonly id: PresetId }
	| { readonly kind: "roadColor"; readonly color: string }
	| { readonly kind: "background"; readonly background: Background }
	| { readonly kind: "weight"; readonly weight: LineWeight };

export const INITIAL_STATE: AppState = {
	map: null,
	load: { kind: "idle" },
	choice: { kind: "preset", id: "paper" },
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
			return { ...state, map: event.map, load: { kind: "idle" } };
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
			return { ...state, choice: { kind: "preset", id: event.id } };
		case "roadColor":
			return withCustom(state, { roadColor: event.color });
		case "background":
			return withCustom(state, { background: event.background });
		case "weight":
			return withCustom(state, { weight: event.weight });
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

function placeKey(place: Place): string {
	return `${place.osm.kind}:${place.osm.id}`;
}
