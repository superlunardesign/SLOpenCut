"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Section, SectionContent } from "@/components/section";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { extractTimelineAudio } from "@/media/mediabunny";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { rippleShiftElements } from "@/ripple";
import type { TranscriptionWord } from "@/transcription/types";
import { EditorCore } from "@/core";

// ---- types ----

interface WordWithTimeline extends TranscriptionWord {
	timelineStart: number; // seconds on the timeline
	timelineEnd: number;
}

type TranscriptState =
	| { status: "idle"; error: string | null }
	| { status: "extracting" }
	| { status: "transcribing"; label: string }
	| { status: "done"; words: WordWithTimeline[] };

type TranscriptAction =
	| { type: "start_extract" }
	| { type: "start_transcribe"; label?: string }
	| { type: "done"; words: WordWithTimeline[] }
	| { type: "fail"; error: string }
	| { type: "reset" };

/* eslint-disable opencut/prefer-object-params */
function transcriptReducer(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	switch (action.type) {
		case "start_extract":
			return { status: "extracting" };
		case "start_transcribe":
			return { status: "transcribing", label: action.label ?? "Transcribing…" };
		case "done":
			return { status: "done", words: action.words };
		case "fail":
			return { status: "idle", error: action.error };
		case "reset":
			return { status: "idle", error: null };
	}
}
/* eslint-enable opencut/prefer-object-params */

// ---- helpers ----

function buildTimelineWords(words: TranscriptionWord[]): WordWithTimeline[] {
	return words.map((w) => ({
		...w,
		timelineStart: w.start,
		timelineEnd: w.end,
	}));
}

// Apply a single cut range to the timeline. Splits elements at cutStart and
// cutEnd (keeping both sides each time), deletes the middle fragment, then
// ripple-shifts everything after the cut left.
function applyTimelineCut(
	editor: EditorCore,
	cutStart: ReturnType<typeof mediaTimeFromSeconds>,
	cutEnd: ReturnType<typeof mediaTimeFromSeconds>,
): void {
	if (cutEnd <= cutStart) return;

	const collectOverlapping = (
		tracks: ReturnType<EditorCore["scenes"]["getActiveScene"]>["tracks"],
	) => {
		const allTracks = [
			...tracks.overlay,
			tracks.main,
			...tracks.audio,
		];
		return allTracks.flatMap((track) =>
			track.elements
				.filter(
					(el) =>
						el.startTime < cutEnd && el.startTime + el.duration > cutStart,
				)
				.map((el) => ({ trackId: track.id, elementId: el.id })),
		);
	};

	// Step 1: split at cutEnd (both sides — preserve elements after the cut)
	const overlapping = collectOverlapping(
		editor.scenes.getActiveScene().tracks,
	);
	if (overlapping.length === 0) return;

	editor.timeline.splitElements({
		elements: overlapping,
		splitTime: cutEnd,
		retainSide: "both",
	});

	// Step 2: split at cutStart on elements that now end at or before cutEnd
	// (i.e. left-of-cutEnd portions that still span cutStart)
	const afterCutEnd = collectOverlapping(
		editor.scenes.getActiveScene().tracks,
	).filter((ref) => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
		const el = allTracks
			.find((t) => t.id === ref.trackId)
			?.elements.find((e) => e.id === ref.elementId);
		if (!el) return false;
		// Only elements whose end is at or before cutEnd (left portions from step 1)
		return el.startTime + el.duration <= cutEnd;
	});

	if (afterCutEnd.length > 0) {
		editor.timeline.splitElements({
			elements: afterCutEnd,
			splitTime: cutStart,
			retainSide: "both",
		});
	}

	// Step 3: delete middle fragments — elements entirely within [cutStart, cutEnd]
	const tracksAfterSplits = editor.scenes.getActiveScene().tracks;
	const allTracksAfterSplits = [
		...tracksAfterSplits.overlay,
		tracksAfterSplits.main,
		...tracksAfterSplits.audio,
	];
	const toDelete = allTracksAfterSplits.flatMap((track) =>
		track.elements
			.filter(
				(el) =>
					el.startTime >= cutStart &&
					el.startTime + el.duration <= cutEnd,
			)
			.map((el) => ({ trackId: track.id, elementId: el.id })),
	);

	if (toDelete.length === 0) return;
	editor.timeline.deleteElements({ elements: toDelete });

	// Step 4: ripple — shift everything starting at or after cutEnd left by cut duration
	const cutDuration = cutEnd - cutStart;
	const afterDelete = editor.scenes.getActiveScene().tracks;
	editor.timeline.updateTracks({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		overlay: afterDelete.overlay.map((track) => ({
			...track,
			elements: rippleShiftElements({
				elements: track.elements as any[],
				afterTime: cutEnd,
				shiftAmount: cutDuration,
			}),
		})) as typeof afterDelete.overlay,
		main: {
			...afterDelete.main,
			elements: rippleShiftElements({
				elements: afterDelete.main.elements,
				afterTime: cutEnd,
				shiftAmount: cutDuration,
			}),
		},
		audio: afterDelete.audio.map((track) => ({
			...track,
			elements: rippleShiftElements({
				elements: track.elements,
				afterTime: cutEnd,
				shiftAmount: cutDuration,
			}),
		})),
	});
}

// ---- component ----

export function TranscriptView() {
	const editor = useEditor();
	const [state, dispatch] = useReducer(transcriptReducer, {
		status: "idle",
		error: null,
	});
	const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
		new Set(),
	);

	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());

	// Poll playback position via RAF so word highlighting stays in sync
	// frame-by-frame. useEditor only fires on state changes, not every frame.
	const [currentTimeSecs, setCurrentTimeSecs] = useState(0);
	const rafRef = useRef<number | null>(null);
	useEffect(() => {
		if (state.status !== "done") return;
		const tick = () => {
			setCurrentTimeSecs(editor.playback.getCurrentTime() / TICKS_PER_SECOND);
			rafRef.current = requestAnimationFrame(tick);
		};
		rafRef.current = requestAnimationFrame(tick);
		return () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		};
	}, [editor, state.status]);

	const handleTranscribe = useCallback(async () => {
		try {
			dispatch({ type: "start_extract" });
			const audioBlob = await extractTimelineAudio({
				tracks,
				mediaAssets,
				totalDuration,
				onProgress: () => {},
			});

			const samples = await downsampleToMono(audioBlob, 16000);

			// Split into 25-second chunks — Cloudflare's REST API has a ~10MB
			// body limit and 16kHz mono 16-bit PCM is ~800KB per 25s.
			const CHUNK_SECS = 25;
			const CHUNK_SAMPLES = CHUNK_SECS * 16000;
			const totalChunks = Math.ceil(samples.length / CHUNK_SAMPLES);
			const rawWords: TranscriptionWord[] = [];

			for (let c = 0; c < totalChunks; c++) {
				dispatch({
					type: "start_transcribe",
					label:
						totalChunks > 1
							? `Transcribing chunk ${c + 1} of ${totalChunks}…`
							: "Transcribing…",
				});

				const chunkSamples = samples.slice(
					c * CHUNK_SAMPLES,
					(c + 1) * CHUNK_SAMPLES,
				);
				const chunkBlob = encodeMonoWav(chunkSamples, 16000);
				const offsetSecs = c * CHUNK_SECS;

				const response = await fetch("/api/transcription", {
					method: "POST",
					body: chunkBlob,
					headers: { "Content-Type": "audio/wav" },
				});

				if (!response.ok) {
					const err = await response.json().catch(() => ({}));
					throw new Error(
						(err as { error?: string }).error ?? `HTTP ${response.status}`,
					);
				}

				const data = (await response.json()) as { words?: TranscriptionWord[] };
				for (const w of data.words ?? []) {
					rawWords.push({
						word: w.word,
						start: w.start + offsetSecs,
						end: w.end + offsetSecs,
					});
				}
			}

			if (rawWords.length === 0) {
				throw new Error(
					"No word-level timestamps returned — try a clip with clear speech.",
				);
			}

			dispatch({ type: "done", words: buildTimelineWords(rawWords) });
			setSelectedIndices(new Set());
		} catch (err) {
			dispatch({
				type: "fail",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, [tracks, mediaAssets, totalDuration]);

	const activeWordIndex =
		state.status === "done"
			? state.words.findIndex(
					(w) =>
						currentTimeSecs >= w.timelineStart &&
						currentTimeSecs < w.timelineEnd,
				)
			: -1;

	const handleDeleteSelected = useCallback(() => {
		if (state.status !== "done" || selectedIndices.size === 0) return;

		// Build list of cuts sorted right-to-left so earlier cuts aren't
		// shifted by ripple from later ones.
		const cuts = [...selectedIndices]
			.map((idx) => state.words[idx])
			.filter((w): w is WordWithTimeline => w !== undefined)
			.sort((a, b) => b.timelineStart - a.timelineStart);

		let currentWords = [...state.words];

		for (const cut of cuts) {
			const cutStart = mediaTimeFromSeconds({ seconds: cut.timelineStart });
			const cutEnd = mediaTimeFromSeconds({ seconds: cut.timelineEnd });

			applyTimelineCut(editor, cutStart, cutEnd);

			// Shift word timestamps: remove the cut word, shift later words left
			const durationSecs = (cutEnd - cutStart) / TICKS_PER_SECOND;
			currentWords = currentWords
				.filter((w) => w !== cut)
				.map((w) =>
					w.timelineStart >= cut.timelineEnd
						? {
								...w,
								timelineStart: w.timelineStart - durationSecs,
								timelineEnd: w.timelineEnd - durationSecs,
							}
						: w,
				);
		}

		dispatch({ type: "done", words: currentWords });
		setSelectedIndices(new Set());
	}, [editor, state, selectedIndices]);

	const isLoading =
		state.status === "extracting" || state.status === "transcribing";

	return (
		<PanelView>
			<Section>
				<SectionContent>
					{state.status !== "done" && (
						<div className="space-y-3">
							<p className="text-muted-foreground text-sm">
								Transcribe your timeline audio. Drag to select words, then press
								Delete to cut them from the video.
							</p>
							<Button
								className="w-full"
								onClick={handleTranscribe}
								disabled={isLoading}
							>
								{isLoading && <Spinner className="mr-2 h-4 w-4" />}
								{state.status === "extracting"
									? "Extracting audio…"
									: state.status === "transcribing"
										? state.label
										: "Transcribe Timeline"}
							</Button>
							{state.status === "idle" && state.error && (
								<p className="text-destructive text-xs">{state.error}</p>
							)}
						</div>
					)}

					{state.status === "done" && (
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground text-xs">
									{selectedIndices.size > 0
										? `${selectedIndices.size} word${selectedIndices.size !== 1 ? "s" : ""} selected`
										: `${state.words.length} words`}
								</span>
								<div className="flex gap-2">
									{selectedIndices.size > 0 && (
										<Button
											size="sm"
											variant="destructive"
											onClick={handleDeleteSelected}
										>
											Delete
										</Button>
									)}
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											dispatch({ type: "reset" });
											setSelectedIndices(new Set());
										}}
									>
										Re-transcribe
									</Button>
								</div>
							</div>

							<TranscriptText
								words={state.words}
								selectedIndices={selectedIndices}
								activeWordIndex={activeWordIndex}
								onSelectionChange={setSelectedIndices}
								onSeek={(seconds) =>
									editor.playback.seek({
										time: mediaTimeFromSeconds({ seconds }),
									})
								}
								onDeleteSelected={handleDeleteSelected}
							/>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}

// ---- TranscriptText ----

interface TranscriptTextProps {
	words: WordWithTimeline[];
	selectedIndices: Set<number>;
	activeWordIndex: number;
	onSelectionChange: (indices: Set<number>) => void;
	onSeek: (seconds: number) => void;
	onDeleteSelected: () => void;
}

function TranscriptText({
	words,
	selectedIndices,
	activeWordIndex,
	onSelectionChange,
	onSeek,
	onDeleteSelected,
}: TranscriptTextProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLSpanElement | null>(null);
	const dragAnchorRef = useRef<number | null>(null);
	const isDraggingRef = useRef(false);
	const hasDraggedRef = useRef(false);

	// Scroll active word into view during playback
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [activeWordIndex]);

	// Cancel drag on global mouseup
	useEffect(() => {
		const onMouseUp = () => {
			isDraggingRef.current = false;
		};
		window.addEventListener("mouseup", onMouseUp);
		return () => window.removeEventListener("mouseup", onMouseUp);
	}, []);

	const handleWordMouseDown = (idx: number, e: React.MouseEvent) => {
		e.preventDefault(); // prevent browser text selection
		isDraggingRef.current = true;
		hasDraggedRef.current = false;
		dragAnchorRef.current = idx;
		onSelectionChange(new Set([idx]));
	};

	const handleWordMouseEnter = (idx: number) => {
		if (!isDraggingRef.current || dragAnchorRef.current === null) return;
		hasDraggedRef.current = true;
		const anchor = dragAnchorRef.current;
		const lo = Math.min(anchor, idx);
		const hi = Math.max(anchor, idx);
		const next = new Set<number>();
		for (let i = lo; i <= hi; i++) next.add(i);
		onSelectionChange(next);
	};

	const handleWordMouseUp = (idx: number) => {
		isDraggingRef.current = false;
		// Single click (no drag): seek playhead to this word
		if (!hasDraggedRef.current) {
			const word = words[idx];
			if (word) onSeek(word.timelineStart);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (
			(e.key === "Delete" || e.key === "Backspace") &&
			selectedIndices.size > 0
		) {
			e.preventDefault();
			onDeleteSelected();
		}
		if (e.key === "Escape") {
			onSelectionChange(new Set());
		}
	};

	return (
		<div
			ref={containerRef}
			tabIndex={0}
			onKeyDown={handleKeyDown}
			className="outline-none text-sm leading-7 select-none max-h-[60vh] overflow-y-auto pr-1 focus:ring-1 focus:ring-ring rounded"
			style={{ wordBreak: "break-word", cursor: "text" }}
		>
			{words.map((word, i) => {
				const isSelected = selectedIndices.has(i);
				const isActive = i === activeWordIndex;
				return (
					<span
						key={`${i}-${word.word}`}
						ref={isActive ? activeRef : undefined}
						onMouseDown={(e) => handleWordMouseDown(i, e)}
						onMouseEnter={() => handleWordMouseEnter(i)}
						onMouseUp={() => handleWordMouseUp(i)}
						className={[
							"rounded px-0.5 transition-colors",
							isSelected
								? "bg-destructive/80 text-destructive-foreground"
								: isActive
									? "bg-primary/40 text-primary font-medium"
									: "hover:bg-muted",
						].join(" ")}
					>
						{word.word}
					</span>
				);
			})}
		</div>
	);
}

// ---- audio helpers ----

async function downsampleToMono(
	audioBlob: Blob,
	targetSampleRate: number,
): Promise<Float32Array> {
	const arrayBuffer = await audioBlob.arrayBuffer();
	const tempCtx = new AudioContext();
	const decoded = await tempCtx.decodeAudioData(arrayBuffer);
	await tempCtx.close();

	const frameCount = Math.ceil(decoded.duration * targetSampleRate);
	const offlineCtx = new OfflineAudioContext(1, frameCount, targetSampleRate);
	const source = offlineCtx.createBufferSource();
	source.buffer = decoded;
	source.connect(offlineCtx.destination);
	source.start(0);
	const resampled = await offlineCtx.startRendering();
	return resampled.getChannelData(0);
}

function encodeMonoWav(samples: Float32Array, sampleRate: number): Blob {
	const int16 = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		int16[i] = Math.max(
			-32768,
			Math.min(32767, Math.round(samples[i] * 32767)),
		);
	}
	const dataBytes = int16.byteLength;
	const buf = new ArrayBuffer(44 + dataBytes);
	const v = new DataView(buf);
	const s = (o: number, t: string) => {
		for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i));
	};
	s(0, "RIFF");
	v.setUint32(4, 36 + dataBytes, true);
	s(8, "WAVE");
	s(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	s(36, "data");
	v.setUint32(40, dataBytes, true);
	new Int16Array(buf, 44).set(int16);
	return new Blob([buf], { type: "audio/wav" });
}
