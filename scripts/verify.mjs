import { mkdir, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import {
	VIEW,
	fetchRoads,
	geocodeCity,
	renderSvg,
	styleFromPreset,
} from "../src/index.ts";

const outDir = new URL("../verify-output/", import.meta.url);
await mkdir(outDir, { recursive: true });

const place = await geocodeCity("Prague");
const map = await fetchRoads(place);

if (map.roads.length < 100) {
	throw new Error(`Expected many Prague roads, got ${map.roads.length}.`);
}

const schemes = ["paper", "night"];
for (const id of schemes) {
	const svg = renderSvg(map, styleFromPreset(id), VIEW);
	if (!svg.includes("<path")) {
		throw new Error(`${id} SVG has no path.`);
	}
	if (!svg.includes("OpenStreetMap")) {
		throw new Error(`${id} SVG is missing OpenStreetMap credit.`);
	}
	const svgPath = new URL(`prague-${id}.svg`, outDir);
	await writeFile(svgPath, svg);
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: 1600 },
	})
		.render()
		.asPng();
	if (png[0] !== 0x89 || png[1] !== 0x50) {
		throw new Error(`${id} PNG is not a PNG.`);
	}
	await writeFile(new URL(`prague-${id}.png`, outDir), png);
	console.log(
		`wrote prague-${id}.svg and prague-${id}.png (${map.roads.length} roads)`,
	);
}
