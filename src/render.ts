import type { BBox, GeoPoint, Road, RoadMap } from "./osm.ts";
import { OsmError } from "./osm.ts";
import type { Style } from "./style.ts";
import { strokeWidthFor } from "./style.ts";

export type View = {
	readonly width: number;
	readonly height: number;
};

export type Camera = {
	readonly zoom: number;
	readonly x: number;
	readonly y: number;
};

export const VIEW: View = { width: 1600, height: 1600 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;
export const FIT_CAMERA: Camera = { zoom: 1, x: 0, y: 0 };

const PAD = 0.05;
const OSM_CREDIT = "© OpenStreetMap contributors";
const OSM_COMMENT =
	"Map data © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright";

type Point = { readonly x: number; readonly y: number };

type Projector = {
	readonly xy: (point: GeoPoint) => Point;
	readonly strokeScale: number;
};

export function renderSvg(map: RoadMap, style: Style, view: View): string {
	const projector = makeProjector(map.bounds, view);
	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">`,
	);
	parts.push(`<!-- ${OSM_COMMENT} -->`);
	if (style.background.kind === "solid") {
		parts.push(
			`<rect width="100%" height="100%" fill="${escapeXml(style.background.color)}"/>`,
		);
	}
	const color = escapeXml(style.roadColor);
	for (const road of map.roads) {
		const d = pathD(road, projector);
		if (!d) continue;
		const width = strokeWidthFor(road.highway, style.weight) * projector.strokeScale;
		parts.push(
			`<path d="${d}" fill="none" stroke="${color}" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
		);
	}
	const font = Math.max(10, view.width * 0.00875);
	const x = view.width * 0.02;
	const y = view.height - view.height * 0.018;
	parts.push(
		`<text x="${fmt(x)}" y="${fmt(y)}" fill="${escapeXml(creditFill(style))}" font-family="sans-serif" font-size="${fmt(font)}">${escapeXml(OSM_CREDIT)}</text>`,
	);
	parts.push("</svg>");
	return parts.join("");
}

export type DrawOptions = {
	readonly camera?: Camera;
	readonly credit?: boolean;
	readonly clear?: boolean;
};

export function zoomCamera(
	camera: Camera,
	view: View,
	anchorX: number,
	anchorY: number,
	nextZoom: number,
): Camera {
	const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
	const cx = view.width / 2;
	const cy = view.height / 2;
	const mapX = (anchorX - cx - camera.x) / camera.zoom + cx;
	const mapY = (anchorY - cy - camera.y) / camera.zoom + cy;
	return clampCamera(
		{
			zoom,
			x: anchorX - cx - (mapX - cx) * zoom,
			y: anchorY - cy - (mapY - cy) * zoom,
		},
		view,
	);
}

export function clampCamera(camera: Camera, view: View): Camera {
	const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom));
	const limitX = (view.width / 2) * zoom;
	const limitY = (view.height / 2) * zoom;
	return {
		zoom,
		x: Math.min(limitX, Math.max(-limitX, camera.x)),
		y: Math.min(limitY, Math.max(-limitY, camera.y)),
	};
}

// How to blit a bitmap drawn with `from` so it matches `camera`.
export function snapshotFrame(
	camera: Camera,
	from: Camera,
	view: View,
): { readonly scale: number; readonly x: number; readonly y: number } {
	const scale = camera.zoom / from.zoom;
	const cx = view.width / 2;
	const cy = view.height / 2;
	return {
		scale,
		x: cx + camera.x - scale * (cx + from.x),
		y: cy + camera.y - scale * (cy + from.y),
	};
}

export function drawRoads(
	ctx: CanvasRenderingContext2D,
	map: RoadMap,
	style: Style,
	view: View,
	options?: DrawOptions,
): void {
	const camera = options?.camera ?? FIT_CAMERA;
	const projector = makeProjector(map.bounds, view);
	const clip = visibleWindow(camera, view);
	ctx.save();
	if (options?.clear !== false) {
		ctx.clearRect(0, 0, view.width, view.height);
		if (style.background.kind === "solid") {
			ctx.fillStyle = style.background.color;
			ctx.fillRect(0, 0, view.width, view.height);
		}
	}
	ctx.save();
	ctx.translate(view.width / 2 + camera.x, view.height / 2 + camera.y);
	ctx.scale(camera.zoom, camera.zoom);
	ctx.translate(-view.width / 2, -view.height / 2);
	ctx.strokeStyle = style.roadColor;
	const paths = new Map<number, Path2D>();
	for (const road of map.roads) {
		const widthKey = Math.round(
			strokeWidthFor(road.highway, style.weight) * projector.strokeScale * 1000,
		);
		let path = paths.get(widthKey);
		if (!path) {
			path = new Path2D();
			paths.set(widthKey, path);
		}
		appendRoad(path, road, projector, clip);
	}
	for (const [widthKey, path] of paths) {
		const width = widthKey / 1000;
		// Round caps on a hairline are pure cost at city scale. Compare in CSS pixels.
		const thin = width * camera.zoom < 2;
		ctx.lineCap = thin ? "butt" : "round";
		ctx.lineJoin = thin ? "bevel" : "round";
		ctx.lineWidth = width;
		ctx.stroke(path);
	}
	ctx.restore();
	if (options?.credit !== false) drawCredit(ctx, style, view);
	ctx.restore();
}

export function drawCredit(
	ctx: CanvasRenderingContext2D,
	style: Style,
	view: View,
): void {
	const font = Math.max(10, view.width * 0.00875);
	ctx.save();
	ctx.font = `${font}px sans-serif`;
	ctx.fillStyle = creditFill(style);
	ctx.textBaseline = "alphabetic";
	ctx.fillText(OSM_CREDIT, view.width * 0.02, view.height - view.height * 0.018);
	ctx.restore();
}

function makeProjector(bounds: BBox, view: View): Projector {
	if (!(view.width > 0) || !(view.height > 0)) {
		throw new OsmError("bad_view", "View size must be positive.");
	}
	const innerW = view.width * (1 - 2 * PAD);
	const innerH = view.height * (1 - 2 * PAD);
	const west = mercatorX(bounds.west);
	const east = mercatorX(bounds.east);
	const south = mercatorY(bounds.south);
	const north = mercatorY(bounds.north);
	const dx = east - west || 1e-9;
	const dy = north - south || 1e-9;
	const scale = Math.min(innerW / dx, innerH / dy);
	const mx = (west + east) / 2;
	const my = (south + north) / 2;
	const cx = view.width / 2;
	const cy = view.height / 2;
	return {
		xy(point) {
			return {
				x: cx + (mercatorX(point.lon) - mx) * scale,
				y: cy - (mercatorY(point.lat) - my) * scale,
			};
		},
		strokeScale: Math.min(view.width, view.height) / VIEW.width,
	};
}

type Clip = {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
};

// Points closer than this to the previous kept point share a pixel at city scale.
const MIN_STEP_SQ = 0.75 * 0.75;
const scratch: number[] = [];

// City-fit draws every road. A zoomed plate skips roads outside this map-space box.
function visibleWindow(camera: Camera, view: View): Clip | null {
	if (camera.zoom <= 1 && camera.x === 0 && camera.y === 0) return null;
	const pad = 8;
	const zoom = camera.zoom;
	const cx = view.width / 2;
	const cy = view.height / 2;
	return {
		minX: (-pad - cx - camera.x) / zoom + cx,
		maxX: (view.width + pad - cx - camera.x) / zoom + cx,
		minY: (-pad - cy - camera.y) / zoom + cy,
		maxY: (view.height + pad - cy - camera.y) / zoom + cy,
	};
}

function appendRoad(path: Path2D, road: Road, projector: Projector, clip: Clip | null): void {
	const points = road.path;
	const last = points.length - 1;
	scratch.length = 0;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let keptX = 0;
	let keptY = 0;
	for (let i = 0; i < points.length; i++) {
		const p = projector.xy(points[i]!);
		if (i > 0 && i < last) {
			const dx = p.x - keptX;
			const dy = p.y - keptY;
			if (dx * dx + dy * dy < MIN_STEP_SQ) continue;
		}
		scratch.push(p.x, p.y);
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
		keptX = p.x;
		keptY = p.y;
	}
	if (scratch.length < 4) return;
	if (
		clip &&
		(maxX < clip.minX || minX > clip.maxX || maxY < clip.minY || minY > clip.maxY)
	) {
		return;
	}
	path.moveTo(scratch[0]!, scratch[1]!);
	for (let i = 2; i < scratch.length; i += 2) {
		path.lineTo(scratch[i]!, scratch[i + 1]!);
	}
}

function mercatorX(lon: number): number {
	// Radians, same unit as mercatorY. Degrees here stretch the plate sideways.
	return (lon * Math.PI) / 180;
}

function mercatorY(lat: number): number {
	const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
	const latRad = (clamped * Math.PI) / 180;
	return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

function pathD(road: Road, projector: Projector): string {
	const pieces: string[] = [];
	const [first, ...rest] = road.path;
	const start = projector.xy(first);
	pieces.push(`M${fmt(start.x)} ${fmt(start.y)}`);
	for (const point of rest) {
		const p = projector.xy(point);
		pieces.push(`L${fmt(p.x)} ${fmt(p.y)}`);
	}
	return pieces.join(" ");
}

function creditFill(style: Style): string {
	if (style.background.kind === "transparent") return "rgba(0,0,0,0.55)";
	return luminance(style.background.color) < 0.4
		? "rgba(255,255,255,0.5)"
		: "rgba(0,0,0,0.45)";
}

function luminance(color: string): number {
	const rgb = parseRgb(color);
	if (!rgb) return 1;
	return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function parseRgb(
	color: string,
): { r: number; g: number; b: number } | null {
	const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color);
	if (hex) {
		const h = hex[1]!;
		if (h.length === 3) {
			return {
				r: Number.parseInt(h[0]! + h[0]!, 16),
				g: Number.parseInt(h[1]! + h[1]!, 16),
				b: Number.parseInt(h[2]! + h[2]!, 16),
			};
		}
		return {
			r: Number.parseInt(h.slice(0, 2), 16),
			g: Number.parseInt(h.slice(2, 4), 16),
			b: Number.parseInt(h.slice(4, 6), 16),
		};
	}
	const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
	if (!rgba) return null;
	return {
		r: Number(rgba[1]),
		g: Number(rgba[2]),
		b: Number(rgba[3]),
	};
}

function fmt(n: number): string {
	return n.toFixed(2);
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
