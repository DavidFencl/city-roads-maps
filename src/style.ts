export type Background =
	| { readonly kind: "solid"; readonly color: string }
	| { readonly kind: "transparent" };

export type LineWeight =
	| { readonly kind: "uniform"; readonly px: number }
	| {
			readonly kind: "byClass";
			readonly defaultPx: number;
			readonly byClass: Readonly<Record<string, number>>;
	  };

export type Style = {
	readonly background: Background;
	readonly roadColor: string;
	readonly weight: LineWeight;
};

export type Preset = {
	readonly label: string;
	readonly style: Style;
};

const CLASS_WEIGHT_SCALE: Readonly<Record<string, number>> = {
	motorway: 2.4,
	trunk: 2.1,
	primary: 1.8,
	secondary: 1.45,
	tertiary: 1.2,
	unclassified: 1.05,
	residential: 1,
	living_street: 0.9,
	service: 0.75,
	cycleway: 0.55,
	footway: 0.45,
	path: 0.45,
	other: 0.7,
};

export const PRESETS = {
	paper: {
		label: "Paper",
		style: {
			background: { kind: "solid", color: "#F7F2E8" },
			roadColor: "rgba(26,26,26,0.85)",
			weight: { kind: "uniform", px: 1.15 },
		},
	},
	night: {
		label: "Night",
		style: {
			background: { kind: "solid", color: "#12141A" },
			roadColor: "#E6E2D6",
			weight: { kind: "uniform", px: 1.1 },
		},
	},
	blueprint: {
		label: "Blueprint",
		style: {
			background: { kind: "solid", color: "#163A5F" },
			roadColor: "#D4E8F7",
			weight: {
				kind: "byClass",
				defaultPx: 1.05,
				byClass: {
					motorway: 2.5,
					trunk: 2.2,
					primary: 1.9,
					secondary: 1.5,
					tertiary: 1.25,
					unclassified: 1.1,
					residential: 1.05,
					living_street: 0.95,
					service: 0.8,
					cycleway: 0.6,
					footway: 0.5,
					path: 0.5,
				},
			},
		},
	},
	ink: {
		label: "Ink",
		style: {
			background: { kind: "solid", color: "#FFFFFF" },
			roadColor: "#111111",
			weight: { kind: "uniform", px: 1.4 },
		},
	},
	oxblood: {
		label: "Oxblood",
		style: {
			background: { kind: "solid", color: "#1A1010" },
			roadColor: "#C45C4A",
			weight: { kind: "uniform", px: 1.2 },
		},
	},
	sage: {
		label: "Sage",
		style: {
			background: { kind: "solid", color: "#E4EBE3" },
			roadColor: "#2C4A3A",
			weight: { kind: "uniform", px: 1.15 },
		},
	},
	print: {
		label: "Print",
		style: {
			background: { kind: "transparent" },
			roadColor: "#000000",
			weight: { kind: "uniform", px: 1.2 },
		},
	},
} as const satisfies Record<string, Preset>;

export type PresetId = keyof typeof PRESETS;

export type StyleChoice =
	| { readonly kind: "preset"; readonly id: PresetId }
	| { readonly kind: "custom"; readonly style: Style };

export function isPresetId(value: string): value is PresetId {
	return Object.prototype.hasOwnProperty.call(PRESETS, value);
}

export function styleFromPreset(id: PresetId): Style {
	return PRESETS[id].style;
}

export function resolveStyle(choice: StyleChoice): Style {
	return choice.kind === "preset" ? PRESETS[choice.id].style : choice.style;
}

export function uniformWeight(px: number): LineWeight {
	return { kind: "uniform", px };
}

export function scaledClassWeights(basePx: number): LineWeight {
	const byClass: Record<string, number> = {};
	for (const [highway, scale] of Object.entries(CLASS_WEIGHT_SCALE)) {
		byClass[highway] = basePx * scale;
	}
	return { kind: "byClass", defaultPx: basePx, byClass };
}

export function baseWeightPx(weight: LineWeight): number {
	return weight.kind === "uniform" ? weight.px : weight.defaultPx;
}

export function strokeWidthFor(
	highway: string,
	weight: LineWeight,
): number {
	if (weight.kind === "uniform") return weight.px;
	return weight.byClass[highway] ?? weight.defaultPx;
}
