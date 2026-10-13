import { overpassQuery } from "../src/osm.ts";
import { cacheableBody, isTileQuery } from "../worker/src/query.ts";

const prague = {
	name: "Prague",
	osm: { kind: "relation" as const, id: 435514 },
	bbox: { west: 14.22, south: 49.94, east: 14.34, north: 50.06 },
};
const tile = { west: 14.22, south: 49.94, east: 14.34, north: 50.06 };
const areaQuery = overpassQuery(prague, tile, false);
const bboxQuery = overpassQuery(prague, tile, true);
const world = overpassQuery(
	prague,
	{ west: -10, south: 40, east: 20, north: 55 },
	true,
);

if (!isTileQuery(areaQuery)) throw new Error(`area query refused: ${areaQuery}`);
if (!isTileQuery(bboxQuery)) throw new Error(`bbox query refused: ${bboxQuery}`);
if (isTileQuery(world)) throw new Error("a country-sized box was accepted");
if (isTileQuery("way[highway](0,0,1,1);out;")) throw new Error("a foreign query was accepted");

const empty = JSON.stringify({ elements: [] });
const roads = JSON.stringify({ elements: [{ type: "way", id: 1 }] });
const remark = JSON.stringify({ remark: "runtime error: timeout", elements: [] });
const busy = "<html>dispatcher too busy</html>";

if (!cacheableBody(empty)) throw new Error("empty tile was not cacheable");
if (!cacheableBody(roads)) throw new Error("road tile was not cacheable");
if (cacheableBody(remark)) throw new Error("error remark was cacheable");
if (cacheableBody(busy)) throw new Error("busy page was cacheable");
if (!cacheableBody(`${roads.slice(0, -1)},"pad":"${"x".repeat(200_000)}"}`)) {
	throw new Error("large tile was not cacheable");
}

console.log("tile query checks passed");
