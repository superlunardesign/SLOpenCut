import type { SceneTracks } from "@/timeline";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	GroupMoveResult,
	MoveGroup,
	PlannedElementMove,
	PlannedTrackCreation,
} from "./types";
import {
	getDisplayTracks,
	getTrackPlacementByDisplayIndex,
	getTrackPlacementById,
} from "./track-placement";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type GroupMoveTarget =
	| {
			kind: "existingTrack";
			anchorTargetTrackId: string;
	  }
	| {
			kind: "newTracks";
			anchorInsertIndex: number;
			newTrackIds: string[];
	  };

export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	if (target.kind === "newTracks") {
		return resolveNewTrackMove({
			group,
			tracks,
			anchorStartTime,
			anchorInsertIndex: target.anchorInsertIndex,
			newTrackIds: target.newTrackIds,
		});
	}

	return resolveExistingTrackMove({
		group,
		tracks,
		anchorStartTime,
		anchorTargetTrackId: target.anchorTargetTrackId,
	});
}

function resolveExistingTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorTargetTrackId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorTargetTrackId: string;
}): GroupMoveResult | null {
	const anchorTargetPlacement = getTrackPlacementById({
		tracks,
		trackId: anchorTargetTrackId,
	});
	if (!anchorTargetPlacement) {
		return null;
	}

	const targetTrackIdsByElementId = resolveExistingTrackIdsByElementId({
		group,
		tracks,
		anchorTargetDisplayIndex: anchorTargetPlacement.displayIndex,
	});
	if (!targetTrackIdsByElementId) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId,
	});

	const moves = group.members.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdsByElementId.get(member.elementId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	if (!canApplyMovesToExistingTracks({ tracks, moves })) {
		// Try push-insert: shift right-side stationary clips to make room.
		const movingElementIds = new Set(
			group.members.map((member) => member.elementId),
		);
		const pushMoves = computePushMoves({ primaryMoves: moves, movingElementIds, tracks });
		if (!pushMoves || pushMoves.length === 0) return null;
		const allMoves = [...moves, ...pushMoves];
		if (!canApplyMovesToExistingTracks({ tracks, moves: allMoves })) return null;
		return {
			moves: allMoves,
			createTracks: [],
			targetSelection: moves.map(({ elementId, targetTrackId }) => ({
				trackId: targetTrackId,
				elementId,
			})),
		};
	}

	return {
		moves,
		createTracks: [],
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function resolveNewTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorInsertIndex,
	newTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorInsertIndex: number;
	newTrackIds: string[];
}): GroupMoveResult | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.elementId === group.anchor.elementId,
	);
	if (anchorMemberIndex < 0 || newTrackIds.length < sortedMembers.length) {
		return null;
	}

	const hasAudioMember = sortedMembers.some(
		(member) => member.trackSection === "audio",
	);
	const hasNonAudioMember = sortedMembers.some(
		(member) => member.trackSection !== "audio",
	);
	if (hasAudioMember && hasNonAudioMember) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId: new Map(),
	});
	const blockStartIndex = hasAudioMember
		? clampAudioInsertIndex({
				tracks,
				insertIndex: anchorInsertIndex - anchorMemberIndex,
			})
		: Math.max(
				0,
				Math.min(anchorInsertIndex - anchorMemberIndex, tracks.overlay.length),
			);

	const createTracks: PlannedTrackCreation[] = sortedMembers.map(
		(member, memberIndex) => ({
			id: newTrackIds[memberIndex],
			type: getTrackTypeForElementType({
				elementType: member.elementType,
			}),
			index: blockStartIndex + memberIndex,
		}),
	);
	const moves = sortedMembers.map((member, memberIndex) => ({
		sourceTrackId: member.trackId,
		targetTrackId: newTrackIds[memberIndex],
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	return {
		moves,
		createTracks,
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function clampAudioInsertIndex({
	tracks,
	insertIndex,
}: {
	tracks: SceneTracks;
	insertIndex: number;
}): number {
	const minimumAudioInsertIndex = tracks.overlay.length + 1;
	return Math.max(
		minimumAudioInsertIndex,
		Math.min(insertIndex, minimumAudioInsertIndex + tracks.audio.length),
	);
}

function resolveExistingTrackIdsByElementId({
	group,
	tracks,
	anchorTargetDisplayIndex,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorTargetDisplayIndex: number;
}): Map<string, string> | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.elementId === group.anchor.elementId,
	);
	if (anchorMemberIndex < 0) {
		return null;
	}

	const targetTrackIdsByElementId = new Map<string, string>();
	const usedTrackIds = new Set<string>();
	const anchorPlacement = getTrackPlacementByDisplayIndex({
		tracks,
		displayIndex: anchorTargetDisplayIndex,
	});
	if (!anchorPlacement) {
		return null;
	}

	targetTrackIdsByElementId.set(
		group.anchor.elementId,
		anchorPlacement.trackId,
	);
	usedTrackIds.add(anchorPlacement.trackId);

	let upperBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex - 1;
		memberIndex >= 0;
		memberIndex -= 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForElementType({
				elementType: member.elementType,
			}),
			startDisplayIndex: upperBoundaryIndex - 1,
			step: -1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			return null;
		}

		targetTrackIdsByElementId.set(member.elementId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		upperBoundaryIndex = targetPlacement.displayIndex;
	}

	let lowerBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex + 1;
		memberIndex < sortedMembers.length;
		memberIndex += 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForElementType({
				elementType: member.elementType,
			}),
			startDisplayIndex: lowerBoundaryIndex + 1,
			step: 1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			return null;
		}

		targetTrackIdsByElementId.set(member.elementId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		lowerBoundaryIndex = targetPlacement.displayIndex;
	}

	return targetTrackIdsByElementId;
}

function findCompatibleTrackPlacement({
	tracks,
	requiredTrackType,
	startDisplayIndex,
	step,
	usedTrackIds,
}: {
	tracks: SceneTracks;
	requiredTrackType: ReturnType<typeof getTrackTypeForElementType>;
	startDisplayIndex: number;
	step: -1 | 1;
	usedTrackIds: Set<string>;
}) {
	for (
		let displayIndex = startDisplayIndex;
		displayIndex >= 0 &&
		displayIndex < tracks.overlay.length + 1 + tracks.audio.length;
		displayIndex += step
	) {
		const placement = getTrackPlacementByDisplayIndex({
			tracks,
			displayIndex,
		});
		if (!placement) {
			continue;
		}

		if (
			placement.trackType === requiredTrackType &&
			!usedTrackIds.has(placement.trackId)
		) {
			return placement;
		}
	}

	return null;
}

function clampAnchorStartTime({
	group,
	tracks,
	anchorStartTime,
	targetTrackIdsByElementId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	targetTrackIdsByElementId: Map<string, string>;
}): MediaTime {
	const minimumAnchorStartTime = group.members.reduce(
		(minimumStartTime, member) =>
			member.timeOffset < ZERO_MEDIA_TIME
				? maxMediaTime({
						a: minimumStartTime,
						b: subMediaTime({
							a: ZERO_MEDIA_TIME,
							b: member.timeOffset,
						}),
					})
				: minimumStartTime,
		ZERO_MEDIA_TIME,
	);
	let clampedAnchorStartTime =
		anchorStartTime < minimumAnchorStartTime
			? minimumAnchorStartTime
			: anchorStartTime;

	const memberOnMainTrack = group.members.find(
		(member) =>
			targetTrackIdsByElementId.get(member.elementId) === tracks.main.id,
	);
	if (!memberOnMainTrack) {
		return clampedAnchorStartTime;
	}

	const movingElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	const requestedMainStartTime = addMediaTime({
		a: clampedAnchorStartTime,
		b: memberOnMainTrack.timeOffset,
	});
	const earliestStationaryMainStartTime = tracks.main.elements
		.filter((element) => !movingElementIds.has(element.id))
		.reduce<MediaTime | null>((earliestStartTime, element) => {
			if (earliestStartTime == null || element.startTime < earliestStartTime) {
				return element.startTime;
			}

			return earliestStartTime;
		}, null);
	if (
		earliestStationaryMainStartTime == null ||
		requestedMainStartTime <= earliestStationaryMainStartTime
	) {
		clampedAnchorStartTime = maxMediaTime({
			a: minimumAnchorStartTime,
			b: subMediaTime({
				a: ZERO_MEDIA_TIME,
				b: memberOnMainTrack.timeOffset,
			}),
		});
	}

	return clampedAnchorStartTime;
}

// When a clip is dragged into a position that would overlap right-side
// stationary clips, compute how far each of those clips needs to shift right
// so the dragged clip can slot in without overlap.
//
// Returns null if the push is impossible (e.g. a stationary clip blocks on
// the LEFT of the insertion point — we never push leftward).
// Returns an empty array if no push is needed (no overlap detected).
function computePushMoves({
	primaryMoves,
	movingElementIds,
	tracks,
}: {
	primaryMoves: PlannedElementMove[];
	movingElementIds: Set<string>;
	tracks: SceneTracks;
}): PlannedElementMove[] | null {
	const allTracks = getDisplayTracks({ tracks });
	const sourceElements = new Map(
		allTracks.flatMap((track) =>
			track.elements.map((el) => [el.id, el] as const),
		),
	);

	// Collect the maximum push needed per element (keyed by elementId) in case
	// multiple primary moves on the same track require different push amounts.
	const pushByElementId = new Map<
		string,
		{ trackId: string; pushAmount: MediaTime }
	>();

	const movesByTargetTrackId = new Map<string, PlannedElementMove[]>();
	for (const move of primaryMoves) {
		const existing = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		existing.push(move);
		movesByTargetTrackId.set(move.targetTrackId, existing);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetPlacement = getTrackPlacementById({ tracks, trackId: targetTrackId });
		if (!targetPlacement) return null;

		const targetTrack = allTracks[targetPlacement.displayIndex];
		if (!targetTrack) return null;

		const stationaryElements = targetTrack.elements.filter(
			(el) => !movingElementIds.has(el.id),
		);

		for (const move of targetMoves) {
			const sourceEl = sourceElements.get(move.elementId);
			if (!sourceEl) return null;

			const movedEnd = addMediaTime({ a: move.newStartTime, b: sourceEl.duration });

			// Find stationary elements that overlap with the moved clip's new span.
			const overlapping = stationaryElements.filter((el) => {
				const elEnd = addMediaTime({ a: el.startTime, b: el.duration });
				return el.startTime < movedEnd && elEnd > move.newStartTime;
			});

			if (overlapping.length === 0) continue;

			// If any overlap starts BEFORE the insertion point we would need to
			// push leftward — not supported. Abort push for this drop target.
			if (overlapping.some((el) => el.startTime < move.newStartTime)) return null;

			// First blocker = the earliest right-side element that overlaps.
			const firstBlocker = overlapping.reduce((min, el) =>
				el.startTime < min.startTime ? el : min,
			);
			const pushAmount = subMediaTime({
				a: movedEnd,
				b: firstBlocker.startTime,
			});
			if (pushAmount <= ZERO_MEDIA_TIME) continue;

			// Shift every stationary element starting at or after the first
			// blocker rightward by the same push amount so relative spacing
			// is preserved (ripple-style).
			for (const el of stationaryElements) {
				if (el.startTime >= firstBlocker.startTime) {
					const existing = pushByElementId.get(el.id);
					if (!existing || pushAmount > existing.pushAmount) {
						pushByElementId.set(el.id, { trackId: targetTrackId, pushAmount });
					}
				}
			}
		}
	}

	if (pushByElementId.size === 0) return [];

	const result: PlannedElementMove[] = [];
	for (const [elementId, { trackId, pushAmount }] of pushByElementId) {
		const el = sourceElements.get(elementId);
		if (!el) return null;
		result.push({
			sourceTrackId: trackId,
			targetTrackId: trackId,
			elementId,
			newStartTime: addMediaTime({ a: el.startTime, b: pushAmount }),
		});
	}
	return result;
}

function canApplyMovesToExistingTracks({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): boolean {
	const movingElementIds = new Set(moves.map((move) => move.elementId));
	const sourceElements = new Map(
		getDisplayTracks({ tracks }).flatMap((track) =>
			track.elements.map((element) => [element.id, element] as const),
		),
	);
	const movesByTargetTrackId = new Map<string, PlannedElementMove[]>();
	for (const move of moves) {
		const targetMoves = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		targetMoves.push(move);
		movesByTargetTrackId.set(move.targetTrackId, targetMoves);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetPlacement = getTrackPlacementById({
			tracks,
			trackId: targetTrackId,
		});
		if (!targetPlacement) {
			return false;
		}

		const targetTrack = getDisplayTracks({ tracks })[
			targetPlacement.displayIndex
		];
		if (!targetTrack) {
			return false;
		}

		const timeSpans = targetMoves.map((move) => {
			const sourceElement = sourceElements.get(move.elementId);
			return {
				startTime: move.newStartTime,
				duration: sourceElement?.duration ?? ZERO_MEDIA_TIME,
			};
		});
		if (hasOverlappingTimeSpans({ timeSpans })) {
			return false;
		}

		if (
			!canPlaceTimeSpansOnTrack({
				track: {
					elements: targetTrack.elements.filter(
						(element) => !movingElementIds.has(element.id),
					),
				},
				timeSpans,
			})
		) {
			return false;
		}
	}

	return true;
}

function hasOverlappingTimeSpans({
	timeSpans,
}: {
	timeSpans: Array<{ startTime: number; duration: number }>;
}): boolean {
	const sortedSpans = [...timeSpans].sort(
		(leftSpan, rightSpan) => leftSpan.startTime - rightSpan.startTime,
	);

	for (let spanIndex = 1; spanIndex < sortedSpans.length; spanIndex += 1) {
		const previousSpan = sortedSpans[spanIndex - 1];
		const currentSpan = sortedSpans[spanIndex];
		if (
			previousSpan.startTime + previousSpan.duration >
			currentSpan.startTime
		) {
			return true;
		}
	}

	return false;
}
