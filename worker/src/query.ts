const MAX_SPAN = 0.25;
const MAX_TIMEOUT = 90;

const BBOX_ONLY =
	/^\[out:json\]\[timeout:(\d+)\];\nway\[highway\]\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);\nout geom;$/;

const AREA =
	/^\[out:json\]\[timeout:(\d+)\];\narea\((\d+)\)->\.searchArea;\nway\[highway\]\(area\.searchArea\)\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);\nout geom;$/;

export type TileQuery = {
	readonly timeout: number;
	readonly south: number;
	readonly west: number;
	readonly north: number;
	readonly east: number;
};

// Only the highway-tile queries this app sends. Anything else is refused.
export function isTileQuery(query: string): boolean {
	const bbox = BBOX_ONLY.exec(query);
	const area = bbox ? null : AREA.exec(query);
	const match = bbox ?? area;
	if (!match) return false;
	const timeout = Number(match[1]);
	const offset = area ? 3 : 2;
	const south = Number(match[offset]);
	const west = Number(match[offset + 1]);
	const north = Number(match[offset + 2]);
	const east = Number(match[offset + 3]);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) return false;
	if (![south, west, north, east].every((value) => Number.isFinite(value))) return false;
	if (!(east > west && north > south)) return false;
	if (east - west > MAX_SPAN || north - south > MAX_SPAN) return false;
	return true;
}

// Large bodies are finished tiles. Small ones are parsed so an error page is not stored.
export function cacheableBody(body: string): boolean {
	const head = body.slice(0, 4096);
	if (!head.startsWith("{")) return false;
	if (/too busy|dispatcher|<!doctype|<html/i.test(head)) return false;
	if (/"remark"\s*:/i.test(head) && /error|timeout|timed out|too many|memory|rate/i.test(head)) {
		return false;
	}
	if (!/"elements"\s*:/.test(head)) return false;
	if (body.length > 200_000) return true;
	try {
		const data = JSON.parse(body) as { elements?: unknown; remark?: unknown };
		if (!Array.isArray(data.elements)) return false;
		if (
			typeof data.remark === "string" &&
			/error|timeout|timed out|too many|memory|rate/i.test(data.remark)
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}
