import { HIGHWAY_CLASSES, type BBox, type HighwayClass, type Place, type Road, type RoadMap } from "./osm.ts";

const DB_NAME = "city-roads-maps";
const MAP_STORE = "maps";
const TILE_STORE = "tiles";
const DB_VERSION = 2;
// The shared cache keeps tiles for two weeks. This browser only needs a short copy.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

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

type TileRow = {
	readonly savedAt: number;
	readonly roads: readonly CachedRoad[];
};

export async function readCachedMap(key: string): Promise<RoadMap | null> {
	try {
		const row = await withStore(MAP_STORE, "readonly", (store) =>
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
		roads: map.roads.map(packRoad),
	};
	await withStore(MAP_STORE, "readwrite", (store) => requestToPromise(store.put(row, key)));
}

export async function readCachedTile(key: string): Promise<readonly Road[] | null> {
	try {
		const row = await withStore(TILE_STORE, "readonly", (store) =>
			requestToPromise(store.get(key)),
		);
		return decodeTile(row);
	} catch {
		return null;
	}
}

export async function readCachedTiles(
	keys: readonly string[],
): Promise<Map<string, readonly Road[] | null>> {
	const found = new Map<string, readonly Road[] | null>();
	if (keys.length === 0) return found;
	try {
		await withStore(TILE_STORE, "readonly", async (store) => {
			await Promise.all(
				keys.map(async (key) => {
					found.set(key, decodeTile(await requestToPromise(store.get(key))));
				}),
			);
		});
	} catch {
		for (const key of keys) found.set(key, null);
	}
	return found;
}

export async function writeCachedTile(key: string, roads: readonly Road[]): Promise<void> {
	const row: TileRow = {
		savedAt: Date.now(),
		roads: roads.map(packRoad),
	};
	await withStore(TILE_STORE, "readwrite", (store) => requestToPromise(store.put(row, key)));
}

function packRoad(road: Road): CachedRoad {
	return { id: road.id, highway: road.highway, path: packPath(road.path) };
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
	storeName: string,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
	const db = await openDb();
	const tx = db.transaction(storeName, mode);
	const result = await run(tx.objectStore(storeName));
	await transactionDone(tx);
	return result;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(MAP_STORE)) db.createObjectStore(MAP_STORE);
				if (!db.objectStoreNames.contains(TILE_STORE)) db.createObjectStore(TILE_STORE);
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => {
				dbPromise = null;
				reject(request.error ?? new Error("IndexedDB failed"));
			};
		});
	}
	return dbPromise;
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

function decodeTile(value: unknown): Road[] | null {
	if (!isRecord(value)) return null;
	if (typeof value.savedAt !== "number" || Date.now() - value.savedAt > MAX_AGE_MS) {
		return null;
	}
	if (!Array.isArray(value.roads)) return null;
	const roads: Road[] = [];
	for (const item of value.roads) {
		const road = decodeRoad(item);
		if (road) roads.push(road);
	}
	if (value.roads.length > 0 && roads.length === 0) return null;
	return roads;
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
