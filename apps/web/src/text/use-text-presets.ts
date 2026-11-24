import { useCallback, useEffect, useState } from "react";
import type { ParamValue } from "@/params";

const STORAGE_KEY = "slopencut-text-presets";

export interface TextPreset {
	id: string;
	name: string;
	/** All text params except 'content' */
	params: Record<string, ParamValue>;
}

function load(): TextPreset[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as TextPreset[]) : [];
	} catch {
		return [];
	}
}

function save(presets: TextPreset[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
	} catch {}
}

export function useTextPresets() {
	const [presets, setPresets] = useState<TextPreset[]>([]);

	useEffect(() => {
		setPresets(load());
	}, []);

	const savePreset = useCallback(
		(name: string, params: Record<string, ParamValue>) => {
			const next = [
				...load(),
				{ id: crypto.randomUUID(), name, params },
			];
			save(next);
			setPresets(next);
		},
		[],
	);

	const deletePreset = useCallback((id: string) => {
		const next = load().filter((p) => p.id !== id);
		save(next);
		setPresets(next);
	}, []);

	const renamePreset = useCallback((id: string, name: string) => {
		const next = load().map((p) => (p.id === id ? { ...p, name } : p));
		save(next);
		setPresets(next);
	}, []);

	return { presets, savePreset, deletePreset, renamePreset };
}
