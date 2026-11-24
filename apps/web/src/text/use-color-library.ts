import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "slopencut-color-library";

const DEFAULT_COLORS = [
	"ffffff",
	"000000",
	"ef4444",
	"f97316",
	"eab308",
	"22c55e",
	"3b82f6",
	"8b5cf6",
	"ec4899",
	"6b7280",
];

function load(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_COLORS;
		const parsed = JSON.parse(raw) as string[];
		return parsed.length > 0 ? parsed : DEFAULT_COLORS;
	} catch {
		return DEFAULT_COLORS;
	}
}

function save(colors: string[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
	} catch {}
}

export function useColorLibrary() {
	const [colors, setColors] = useState<string[]>([]);

	useEffect(() => {
		setColors(load());
	}, []);

	const addColor = useCallback((hex: string) => {
		const current = load();
		const clean = hex.replace("#", "").toLowerCase();
		if (current.includes(clean)) return;
		const next = [...current, clean];
		save(next);
		setColors(next);
	}, []);

	const removeColor = useCallback((hex: string) => {
		const clean = hex.replace("#", "").toLowerCase();
		const next = load().filter((c) => c !== clean);
		save(next);
		setColors(next);
	}, []);

	const resetToDefaults = useCallback(() => {
		save(DEFAULT_COLORS);
		setColors(DEFAULT_COLORS);
	}, []);

	return { colors, addColor, removeColor, resetToDefaults };
}
