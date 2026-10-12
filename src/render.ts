import type { BBox, GeoPoint, Road, RoadMap } from "./osm.ts";
import { OsmError } from "./osm.ts";
import type { Style } from "./style.ts";
import { strokeWidthFor } from "./style.ts";

export type View = {
	readonly width: number;
	readonly height: number;
};

export const VIEW: View = { width: 1600, height: 1600 };

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

export function drawRoads(
	ctx: CanvasRenderingContext2D,
	map: RoadMap,
	style: Style,
	view: View,
): void {
	const projector = makeProjector(map.bounds, view);
	ctx.save();
	ctx.clearRect(0, 0, view.width, view.height);
	if (style.background.kind === "solid") {
		ctx.fillStyle = style.background.color;
		ctx.fillRect(0, 0, view.width, view.height);
	}
	ctx.strokeStyle = style.roadColor;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (const road of map.roads) {
		const [first, second, ...rest] = road.path;
		const start = projector.xy(first);
		ctx.beginPath();
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(projector.xy(second).x, projector.xy(second).y);
		for (const point of rest) {
			const p = projector.xy(point);
			ctx.lineTo(p.x, p.y);
		}
		ctx.lineWidth =
			strokeWidthFor(road.highway, style.weight) * projector.strokeScale;
		ctx.stroke();
	}
	const font = Math.max(10, view.width * 0.00875);
	ctx.font = `${font}px sans-serif`;
	ctx.fillStyle = creditFill(style);
	ctx.textBaseline = "alphabetic";
	ctx.fillText(
		OSM_CREDIT,
		view.width * 0.02,
		view.height - view.height * 0.018,
	);
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
