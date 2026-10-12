import type { View } from "./render.ts";

export function downloadSvg(filename: string, svg: string): void {
	const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
	triggerDownload(filename, blob);
}

export async function downloadPng(
	filename: string,
	svg: string,
	view: View,
): Promise<void> {
	const blob = await rasterizeSvg(svg, view);
	triggerDownload(filename, blob);
}

export function rasterizeSvg(svg: string, view: View): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(view.width));
			canvas.height = Math.max(1, Math.round(view.height));
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				URL.revokeObjectURL(url);
				reject(new Error("Could not create a canvas."));
				return;
			}
			ctx.drawImage(img, 0, 0);
			URL.revokeObjectURL(url);
			canvas.toBlob((png) => {
				if (!png) {
					reject(new Error("Could not encode PNG."));
					return;
				}
				resolve(png);
			}, "image/png");
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Could not rasterize the SVG."));
		};
		img.src = url;
	});
}

function triggerDownload(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.rel = "noopener";
	document.body.append(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
