import type { SnapPoint } from "@/timeline/snapping";
import { ZERO_MEDIA_TIME } from "@/wasm";

export function getTimelineStartSnapPoints(): SnapPoint[] {
	return [{ time: ZERO_MEDIA_TIME, type: "timeline-start" }];
}
