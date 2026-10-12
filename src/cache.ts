import { HIGHWAY_CLASSES, type BBox, type HighwayClass, type Place, type Road, type RoadMap } from "./osm.ts";

const DB_NAME = "city-roads-maps";
const STORE = "maps";
const DB_VERSION = 1;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const HIGHWAYS = new Set<string>(HIGHWAY_CLASSES);

type CachedRoad = {
	readonly id: number;
	readonly highway: HighwayClass;
	readonly path: Float64Array;
};

type CachedRow = {
	readonly savedAt: number;
	readonly place: Place;
	readonly bounds: BBox;
	readonly roads: readonly CachedRoad[];
};

export function mapCacheKey(place: Place, marginKm: number): string {
	return `${place.osm.kind}:${place.osm.id}:${marginKm}`;
}

export async function readCachedMap(key: string): Promise<RoadMap | null> {
	try {
		const row = await withStore("readonly", (store) =>
			requestToPromise(store.get(key)),
		);
		return decodeRow(row);
	} catch {
		return null;
	}
}

export async function writeCachedMap(key: string, map: RoadMap): Promise<void> {
	const row: CachedRow = {
		savedAt: Date.now(),
		place: map.place,
		bounds: map.bounds,
		roads: map.roads.map((road) => ({
			id: road.id,
			highway: road.highway,
			path: packPath(road.path),
		})),
	};
	await withStore("readwrite", (store) => requestToPromise(store.put(row, key)));
}

function packPath(path: Road["path"]): Float64Array {
	const packed = new Float64Array(path.length * 2);
	for (let i = 0; i < path.length; i++) {
		const point = path[i]!;
		packed[i * 2] = point.lon;
		packed[i * 2 + 1] = point.lat;
	}
	return packed;
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
	const db = await openDb();
	try {
		const tx = db.transaction(STORE, mode);
		const result = await run(tx.objectStore(STORE));
		await transactionDone(tx);
		return result;
	} finally {
		db.close();
	}
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
	});
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
	});
}

function decodeRow(value: unknown): RoadMap | null {
	if (!isRecord(value)) return null;
	if (typeof value.savedAt !== "number" || Date.now() - value.savedAt > MAX_AGE_MS) {
		return null;
	}
	const place = decodePlace(value.place);
	const bounds = decodeBBox(value.bounds);
	if (!place || !bounds || !Array.isArray(value.roads)) return null;
	const roads: Road[] = [];
	for (const item of value.roads) {
		const road = decodeRoad(item);
		if (road) roads.push(road);
	}
	if (roads.length === 0) return null;
	return { place, bounds, roads };
}

function decodePlace(value: unknown): Place | null {
	if (!isRecord(value) || typeof value.name !== "string" || !value.name) return null;
	if (!isRecord(value.osm)) return null;
	const kind = value.osm.kind;
	const id = value.osm.id;
	if (kind !== "relation" && kind !== "way" && kind !== "node") return null;
	if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
	const bbox = decodeBBox(value.bbox);
	if (!bbox) return null;
	return { name: value.name, osm: { kind, id }, bbox };
}

function decodeBBox(value: unknown): BBox | null {
	if (!isRecord(value)) return null;
	const west = value.west;
	const south = value.south;
	const east = value.east;
	const north = value.north;
	if (
		typeof west !== "number" ||
		typeof south !== "number" ||
		typeof east !== "number" ||
		typeof north !== "number"
	) {
		return null;
	}
	if (![west, south, east, north].every(Number.isFinite)) return null;
	if (east <= west || north <= south) return null;
	return { west, south, east, north };
}

function decodeRoad(value: unknown): Road | null {
	if (!isRecord(value)) return null;
	const { id, highway, path } = value;
	if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
	if (typeof highway !== "string" || !HIGHWAYS.has(highway)) return null;
	if (!(path instanceof Float64Array) || path.length < 4 || path.length % 2 !== 0) {
		return null;
	}
	const points: Array<{ lon: number; lat: number }> = [];
	for (let i = 0; i < path.length; i += 2) {
		const lon = path[i]!;
		const lat = path[i + 1]!;
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
		points.push({ lon, lat });
	}
	const first = points[0];
	const second = points[1];
	if (!first || !second) return null;
	return {
		id,
		highway: highway as HighwayClass,
		path: [first, second, ...points.slice(2)],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
