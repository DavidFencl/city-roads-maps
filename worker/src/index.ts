import { cacheableBody, isTileQuery } from "./query.ts";

const UPSTREAMS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.openstreetmap.fr/api/interpreter",
	"https://overpass.osm.ch/api/interpreter",
] as const;

const USER_AGENT = "city-roads-maps/0.1 (https://github.com/DavidFencl/city-roads-maps)";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ATTEMPTS = 3;

interface TileObject {
	body: ReadableStream;
	customMetadata?: Record<string, string>;
}

interface TileBucket {
	get(key: string): Promise<TileObject | null>;
	put(
		key: string,
		value: string,
		options?: { customMetadata?: Record<string, string> },
	): Promise<unknown>;
}

interface Env {
	TILES: TileBucket;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === "OPTIONS") {
			return cors(new Response(null, { status: 204 }));
		}
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") {
			return cors(new Response("ok", { headers: { "content-type": "text/plain" } }));
		}
		if (request.method !== "POST" || url.pathname !== "/interpreter") {
			return cors(text("Not found.", 404));
		}
		const query = await readQuery(request);
		if (!query || !isTileQuery(query)) return cors(text("Query refused.", 400));

		const key = await sha256(query);
		const stored = await env.TILES.get(key);
		if (stored) {
			const savedAt = Number(stored.customMetadata?.savedAt ?? "0");
			if (Number.isFinite(savedAt) && Date.now() - savedAt < MAX_AGE_MS) {
				return tileResponse(stored.body, "HIT");
			}
		}

		const upstream = await fromUpstream(query);
		if ("busy" in upstream) {
			return cors(text("The map server is busy. Wait a moment, then try the city again.", 503));
		}
		if ("error" in upstream) return cors(text(upstream.error, 502));

		const body = upstream.body;
		ctx.waitUntil(
			env.TILES.put(key, body, { customMetadata: { savedAt: String(Date.now()) } }),
		);
		return tileResponse(body, "MISS");
	},
};

async function readQuery(request: Request): Promise<string | null> {
	const textBody = await request.text();
	if (textBody.length > 4000) return null;
	const params = new URLSearchParams(textBody);
	const query = params.get("data");
	return query && query.length > 0 ? query : null;
}

async function fromUpstream(
	query: string,
): Promise<{ body: string } | { busy: true } | { error: string }> {
	let sawBusy = false;
	for (const endpoint of UPSTREAMS) {
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			await slotWait(endpoint);
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
						"user-agent": USER_AGENT,
					},
					body: new URLSearchParams({ data: query }),
					signal: AbortSignal.timeout(53_000),
				});
				const body = await response.text();
				if (response.ok && cacheableBody(body)) return { body };
				if (
					response.status === 429 ||
					response.status === 504 ||
					isBusy(body) ||
					isBusyRemark(body)
				) {
					sawBusy = true;
					await delay(Math.min(1000 * 2 ** attempt, 4000));
					continue;
				}
				if (response.ok) return { error: "The map server returned an unusable tile." };
				break;
			} catch {
				break;
			}
		}
	}
	if (sawBusy) return { busy: true };
	return { error: "The map server did not answer." };
}

async function slotWait(endpoint: string): Promise<void> {
	const statusUrl = endpoint.replace(/\/interpreter\/?$/, "/status");
	try {
		const response = await fetch(statusUrl, { signal: AbortSignal.timeout(4000) });
		if (!response.ok) return;
		const text = await response.text();
		if (/slots available now/i.test(text)) return;
		const match = /\bin (\d+) seconds/i.exec(text);
		const seconds = match ? Number(match[1]) : 0;
		if (Number.isFinite(seconds) && seconds > 0) await delay(Math.min(seconds, 8) * 1000);
	} catch {
		// A hung status page must not block the tile.
	}
}

function isBusy(text: string): boolean {
	return /too busy|dispatcher|rate limit|too many requests|429/i.test(text);
}

function isBusyRemark(body: string): boolean {
	const head = body.slice(0, 4096);
	return /"remark"\s*:/i.test(head) && isBusy(head);
}

function tileResponse(body: BodyInit, cache: "HIT" | "MISS"): Response {
	return cors(
		new Response(body, {
			status: 200,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"x-tile-cache": cache,
			},
		}),
	);
}

function text(message: string, status: number): Response {
	return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function cors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", "*");
	headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
	headers.set("access-control-allow-headers", "accept, content-type");
	headers.set("access-control-max-age", "86400");
	return new Response(response.body, { status: response.status, headers });
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
