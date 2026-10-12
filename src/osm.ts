export type GeoPoint = {
	readonly lon: number;
	readonly lat: number;
};

export type BBox = {
	readonly west: number;
	readonly south: number;
	readonly east: number;
	readonly north: number;
};

export type OsmRef =
	| { readonly kind: "relation"; readonly id: number }
	| { readonly kind: "way"; readonly id: number }
	| { readonly kind: "node"; readonly id: number };

export type Place = {
	readonly name: string;
	readonly osm: OsmRef;
	readonly bbox: BBox;
};

export const HIGHWAY_CLASSES = [
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"unclassified",
	"residential",
	"living_street",
	"service",
	"cycleway",
	"footway",
	"path",
	"other",
] as const;

export type HighwayClass = (typeof HIGHWAY_CLASSES)[number];

export type Road = {
	readonly id: number;
	readonly highway: HighwayClass;
	readonly path: readonly [GeoPoint, GeoPoint, ...GeoPoint[]];
};

export type RoadMap = {
	readonly place: Place;
	readonly bounds: BBox;
	readonly roads: readonly Road[];
};

export type OsmErrorCode =
	| "empty_query"
	| "no_results"
	| "nominatim_http"
	| "overpass_http"
	| "overpass_busy"
	| "overpass_empty"
	| "bad_payload"
	| "bad_view";

export class OsmError extends Error {
	readonly code: OsmErrorCode;
	constructor(code: OsmErrorCode, message: string) {
		super(message);
		this.name = "OsmError";
		this.code = code;
	}
}

export type RequestOptions = {
	readonly signal?: AbortSignal;
	readonly marginKm?: number;
};

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const OVERPASS_TIMEOUT_SEC = 45;
export const APP_USER_AGENT =
	"city-roads-maps/0.1 (https://github.com/DavidFencl/city-roads-maps)";

export const OVERPASS_ENDPOINTS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.openstreetmap.fr/api/interpreter",
	"https://overpass.osm.ch/api/interpreter",
] as const;

// Nominatim usage policy caps search at one request per second.
const NOMINATIM_MIN_INTERVAL_MS = 1000;

let lastNominatimAt = 0;
let nominatimChain: Promise<void> = Promise.resolve();

export function parseHighway(tag: string): HighwayClass {
	switch (tag) {
		case "motorway":
		case "motorway_link":
			return "motorway";
		case "trunk":
		case "trunk_link":
			return "trunk";
		case "primary":
		case "primary_link":
			return "primary";
		case "secondary":
		case "secondary_link":
			return "secondary";
		case "tertiary":
		case "tertiary_link":
			return "tertiary";
		case "unclassified":
			return "unclassified";
		case "residential":
			return "residential";
		case "living_street":
			return "living_street";
		case "service":
			return "service";
		case "cycleway":
			return "cycleway";
		case "footway":
		case "pedestrian":
		case "steps":
			return "footway";
		case "path":
		case "track":
		case "bridleway":
			return "path";
		default:
			return "other";
	}
}

export async function searchPlaces(
	query: string,
	options?: RequestOptions,
): Promise<Place[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		throw new OsmError("empty_query", "Type a city name.");
	}
	await waitNominatimSlot(options?.signal);
	const url = new URL(NOMINATIM_URL);
	url.searchParams.set("format", "json");
	url.searchParams.set("limit", "8");
	url.searchParams.set("q", trimmed);
	const response = await fetch(url, {
		method: "GET",
		headers: identityHeaders(),
		signal: options?.signal,
	});
	const data = await readJson(response, "nominatim_http");
	return parseNominatimSearch(data);
}

export async function geocodeCity(
	query: string,
	options?: RequestOptions,
): Promise<Place> {
	const places = await searchPlaces(query, options);
	if (places.length === 0) {
		throw new OsmError("no_results", `No places matched "${query.trim()}".`);
	}
	const relation = places.find((place) => place.osm.kind === "relation");
	return relation ?? places[0]!;
}

// One `out geom` for a whole city returns HTTP 504. A tile near 0.12 degrees comes back in a few seconds.
const TILE_SPAN_DEG = 0.12;

// Kilometres to degrees. Latitude is nearly constant; longitude shrinks toward the poles.
export function expandBBox(box: BBox, marginKm: number): BBox {
	if (!(marginKm > 0)) return box;
	const midLat = (box.south + box.north) / 2;
	const latDeg = marginKm / 110.574;
	const cos = Math.cos((midLat * Math.PI) / 180);
	const lonDeg = marginKm / (111.32 * Math.max(cos, 0.2));
	return {
		west: box.west - lonDeg,
		south: Math.max(-85, box.south - latDeg),
		east: box.east + lonDeg,
		north: Math.min(85, box.north + latDeg),
	};
}

export async function fetchRoads(
	place: Place,
	options?: RequestOptions,
): Promise<RoadMap> {
	const marginKm = options?.marginKm ?? 0;
	// A margin has to include roads outside the city polygon, so those fetches use the box only.
	const bboxOnly = marginKm > 0;
	const seen = new Set<number>();
	const roads: Road[] = [];
	for (const tile of tilesFor(expandBBox(place.bbox, marginKm))) {
		for (const road of await roadsInTile(place, tile, options, 0, bboxOnly)) {
			if (seen.has(road.id)) continue;
			seen.add(road.id);
			roads.push(road);
		}
	}
	if (roads.length === 0) {
		throw new OsmError("overpass_empty", `No roads for ${place.name}.`);
	}
	return {
		place,
		bounds: boundsOf(roads, place.bbox),
		roads,
	};
}

export function parseNominatimSearch(data: unknown): Place[] {
	if (!Array.isArray(data)) {
		throw new OsmError("bad_payload", "Nominatim returned an unexpected payload.");
	}
	const places: Place[] = [];
	for (const item of data) {
		const place = parseNominatimHit(item);
		if (place) places.push(place);
	}
	return places;
}

export function parseOverpassGeom(data: unknown, place: Place): RoadMap {
	const roads = parseWays(data);
	if (roads.length === 0) {
		throw new OsmError("overpass_empty", `No roads for ${place.name}.`);
	}
	return {
		place,
		bounds: boundsOf(roads, place.bbox),
		roads,
	};
}

function parseWays(data: unknown): Road[] {
	if (!isRecord(data) || !Array.isArray(data.elements)) {
		throw new OsmError("bad_payload", "Overpass returned an unexpected payload.");
	}
	const roads: Road[] = [];
	for (const element of data.elements) {
		const road = parseOverpassWay(element);
		if (road) roads.push(road);
	}
	return roads;
}

function tilesFor(box: BBox): BBox[] {
	const width = box.east - box.west;
	const height = box.north - box.south;
	const cols = Math.max(1, Math.ceil(width / TILE_SPAN_DEG));
	const rows = Math.max(1, Math.ceil(height / TILE_SPAN_DEG));
	const tiles: BBox[] = [];
	for (let row = 0; row < rows; row++) {
		const south = box.south + (height * row) / rows;
		const north = row === rows - 1 ? box.north : box.south + (height * (row + 1)) / rows;
		for (let col = 0; col < cols; col++) {
			const west = box.west + (width * col) / cols;
			const east = col === cols - 1 ? box.east : box.west + (width * (col + 1)) / cols;
			tiles.push({ west, south, east, north });
		}
	}
	return tiles;
}

function quarter(box: BBox): BBox[] {
	const midLon = (box.west + box.east) / 2;
	const midLat = (box.south + box.north) / 2;
	return [
		{ west: box.west, south: box.south, east: midLon, north: midLat },
		{ west: midLon, south: box.south, east: box.east, north: midLat },
		{ west: box.west, south: midLat, east: midLon, north: box.north },
		{ west: midLon, south: midLat, east: box.east, north: box.north },
	];
}

async function roadsInTile(
	place: Place,
	box: BBox,
	options: RequestOptions | undefined,
	depth: number,
	bboxOnly: boolean,
): Promise<Road[]> {
	if (options?.signal?.aborted) throw abortError(options.signal);
	try {
		const data = await postOverpass(overpassQuery(place, box, bboxOnly), options);
		return parseWays(data);
	} catch (error) {
		if (isAbort(error)) throw error;
		// A busy dispatcher 504s. Smaller tiles only add more requests.
		if (error instanceof OsmError && error.code === "overpass_busy") throw error;
		if (!(error instanceof OsmError) || error.code !== "overpass_http" || depth >= 3) {
			throw error;
		}
		const roads: Road[] = [];
		for (const part of quarter(box)) {
			roads.push(...(await roadsInTile(place, part, options, depth + 1, bboxOnly)));
		}
		return roads;
	}
}

function overpassQuery(place: Place, box: BBox, bboxOnly: boolean): string {
	const timeout = `[out:json][timeout:${OVERPASS_TIMEOUT_SEC}];`;
	const { south, west, north, east } = box;
	const bbox = `(${south},${west},${north},${east})`;
	if (bboxOnly || place.osm.kind === "node") {
		return `${timeout}\nway[highway]${bbox};\nout geom;`;
	}
	// relation -> 3600000000, way -> 2400000000. Nodes have no area id.
	const areaId =
		place.osm.kind === "relation"
			? place.osm.id + 3_600_000_000
			: place.osm.id + 2_400_000_000;
	return `${timeout}\narea(${areaId})->.searchArea;\nway[highway](area.searchArea)${bbox};\nout geom;`;
}

const BUSY_ATTEMPTS = 6;

async function postOverpass(
	query: string,
	options?: RequestOptions,
): Promise<unknown> {
	let lastError: OsmError | undefined;
	let sawBusy = false;
	for (const endpoint of OVERPASS_ENDPOINTS) {
		for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt++) {
			if (options?.signal?.aborted) throw abortError(options.signal);
			await waitForSlot(endpoint, options?.signal);
			const deadline = AbortSignal.timeout((OVERPASS_TIMEOUT_SEC + 8) * 1000);
			const signal = options?.signal
				? AbortSignal.any([options.signal, deadline])
				: deadline;
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: identityHeaders("application/x-www-form-urlencoded; charset=UTF-8"),
					body: new URLSearchParams({ data: query }),
					signal,
				});
				const body = await response.text();
				if (response.ok) {
					const data = parseOverpassBody(body);
					if (overpassFailed(data)) {
						const remark = overpassRemark(data) ?? `Overpass error from ${endpoint}`;
						if (isServerBusy(remark)) {
							sawBusy = true;
							lastError = busyError();
							await sleep(busyWait(attempt), options?.signal);
							continue;
						}
						throw new OsmError("overpass_http", remark);
					}
					if (hasElements(data) || !sawBusy) return data;
					lastError = busyError();
					continue;
				}
				if (response.status === 429 || isServerBusy(body)) {
					sawBusy = true;
					lastError = busyError();
					const retryAfter = Number(response.headers.get("retry-after"));
					const wait =
						Number.isFinite(retryAfter) && retryAfter > 0
							? retryAfter * 1000
							: busyWait(attempt);
					await sleep(wait, options?.signal);
					continue;
				}
				lastError = new OsmError(
					"overpass_http",
					`Overpass ${response.status} from ${endpoint}`,
				);
				break;
			} catch (error) {
				if (options?.signal?.aborted) throw abortError(options.signal);
				if (error instanceof OsmError) throw error;
				lastError = new OsmError(
					"overpass_http",
					error instanceof Error ? error.message : `Overpass failed at ${endpoint}`,
				);
				break;
			}
		}
	}
	throw lastError ?? busyError();
}

function busyError(): OsmError {
	return new OsmError(
		"overpass_busy",
		"The map server is busy. Wait a moment, then try the city again.",
	);
}

function busyWait(attempt: number): number {
	return Math.min(2000 * 2 ** attempt, 12000);
}

function isServerBusy(text: string): boolean {
	return /too busy|dispatcher|rate limit|too many requests|429/i.test(text);
}

async function waitForSlot(endpoint: string, signal?: AbortSignal): Promise<void> {
	const url = endpoint.replace(/\/interpreter\/?$/, "/status");
	try {
		const headers = new Headers();
		headers.set("Accept", "text/plain");
		if (typeof globalThis.window === "undefined") {
			headers.set("User-Agent", APP_USER_AGENT);
		}
		const response = await fetch(url, { headers, signal });
		if (!response.ok) return;
		const text = await response.text();
		if (/slots available now/i.test(text)) return;
		const waits = [...text.matchAll(/\bin (\d+) seconds/gi)].map((match) =>
			Number(match[1]),
		);
		if (waits.length === 0) return;
		const seconds = Math.min(...waits.filter((value) => Number.isFinite(value)));
		if (!Number.isFinite(seconds)) return;
		await sleep(Math.min(Math.max(seconds, 1), 20) * 1000, signal);
	} catch (error) {
		if (signal?.aborted) throw abortError(signal);
	}
}

function parseOverpassBody(body: string): unknown {
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new OsmError("bad_payload", "Overpass returned an unexpected payload.");
	}
}

function hasElements(data: unknown): boolean {
	return isRecord(data) && Array.isArray(data.elements) && data.elements.length > 0;
}

function overpassFailed(data: unknown): boolean {
	if (!isRecord(data)) return true;
	if (hasElements(data)) return false;
	const remark = overpassRemark(data);
	if (!remark) return false;
	return /error|timeout|timed out|too many|memory|rate_limited/i.test(remark);
}

function overpassRemark(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.remark !== "string") return undefined;
	return data.remark;
}

function parseNominatimHit(item: unknown): Place | null {
	if (!isRecord(item)) return null;
	const kind = parseOsmKind(item.osm_type);
	const id = toPositiveInt(item.osm_id);
	const name = typeof item.display_name === "string" ? item.display_name : "";
	const bbox = parseNominatimBBox(item.boundingbox);
	if (!kind || id === null || !name || !bbox) return null;
	return { name, osm: { kind, id }, bbox };
}

function parseOsmKind(value: unknown): OsmRef["kind"] | null {
	if (value === "relation" || value === "way" || value === "node") return value;
	return null;
}

function parseNominatimBBox(boundingbox: unknown): BBox | null {
	// Nominatim order is south, north, west, east.
	if (!Array.isArray(boundingbox) || boundingbox.length < 4) return null;
	const south = toFiniteNumber(boundingbox[0]);
	const north = toFiniteNumber(boundingbox[1]);
	const west = toFiniteNumber(boundingbox[2]);
	const east = toFiniteNumber(boundingbox[3]);
	if (south === null || north === null || west === null || east === null) {
		return null;
	}
	return { west, south, east, north };
}

function parseOverpassWay(element: unknown): Road | null {
	if (!isRecord(element) || element.type !== "way") return null;
	const id = toPositiveInt(element.id);
	if (id === null) return null;
	const tags = isRecord(element.tags) ? element.tags : null;
	if (!tags || typeof tags.highway !== "string") return null;
	if (!Array.isArray(element.geometry)) return null;
	const points: GeoPoint[] = [];
	for (const node of element.geometry) {
		if (!isRecord(node)) continue;
		const lon = toFiniteNumber(node.lon);
		const lat = toFiniteNumber(node.lat);
		if (lon === null || lat === null) continue;
		points.push({ lon, lat });
	}
	const first = points[0];
	const second = points[1];
	if (!first || !second) return null;
	return {
		id,
		highway: parseHighway(tags.highway),
		path: [first, second, ...points.slice(2)],
	};
}

function boundsOf(roads: readonly Road[], fallback: BBox): BBox {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const road of roads) {
		for (const point of road.path) {
			if (point.lon < west) west = point.lon;
			if (point.lon > east) east = point.lon;
			if (point.lat < south) south = point.lat;
			if (point.lat > north) north = point.lat;
		}
	}
	if (!Number.isFinite(west)) return fallback;
	return { west, south, east, north };
}

function identityHeaders(contentType?: string): Headers {
	const headers = new Headers();
	headers.set("Accept", "application/json");
	if (contentType) headers.set("Content-Type", contentType);
	if (typeof globalThis.window === "undefined") {
		headers.set("User-Agent", APP_USER_AGENT);
	}
	return headers;
}

async function readJson(
	response: Response,
	code: OsmErrorCode,
): Promise<unknown> {
	if (!response.ok) {
		throw new OsmError(code, `Request failed (${response.status}).`);
	}
	try {
		return await response.json();
	} catch {
		throw new OsmError("bad_payload", "Response was not JSON.");
	}
}

function waitNominatimSlot(signal?: AbortSignal): Promise<void> {
	const run = nominatimChain.then(async () => {
		const wait = lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await sleep(wait, signal);
		lastNominatimAt = Date.now();
	});
	nominatimChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(signal?: AbortSignal): DOMException {
	if (signal?.reason instanceof DOMException) return signal.reason;
	return new DOMException("Aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function toPositiveInt(value: unknown): number | null {
	const n = toFiniteNumber(value);
	if (n === null || !Number.isInteger(n) || n <= 0) return null;
	return n;
}
