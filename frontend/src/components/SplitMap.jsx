import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../ez/motion";
import { EmptyState } from "../ez/ui";

/**
 * The map of the split.
 *
 * A long band cut into tracks. Each track is a slice of the source, sized
 * by its own length, and the silent gap between two tracks is left standing
 * in the accent colour: those gaps are the thing the tool found, so they
 * are the part that carries the colour.
 *
 * The map is drawn from the real boundaries the worker reports, so it
 * grows as the job runs.
 */

/*
 * A real silence is a fraction of a percent of the recording - three
 * seconds out of fourteen minutes. At true scale the cut would be a
 * hairline and invisible, which would hide the one thing the map exists
 * to show.
 *
 * So the cut is given a width of its own: it grows with the length of the
 * silence, so a long gap is visibly a longer cut, but it never falls below
 * the floor where the eye can find it.
 */
const GAP_PX_PER_SECOND = 3;
const MIN_GAP_PX = 8;
const MAX_GAP_PX = 30;

/*
 * A title is only drawn when its block is wide enough to hold it. Below
 * that the map is the shape of the recording, and the list underneath is
 * where the names live.
 */
const MIN_LABEL_FRACTION = 0.16;

export default function SplitMap({ tracks, duration }) {
	const reduce = useReducedMotion();

	if (!tracks || tracks.length === 0) {
		return (
			<EmptyState
				title="The map fills in as the split is found."
				hint="Every gap between two tracks is a silence the tool detected."
			/>
		);
	}

	const total = duration || tracks[tracks.length - 1].end || 0;

	return (
		<div className="flex h-14 w-full items-stretch overflow-hidden rounded-lg border border-line bg-inset" aria-hidden="true">
			{tracks.map((track, i) => {
				const start = track.start ?? 0;
				const end = track.end ?? start;
				const next = tracks[i + 1];
				const gap = next ? Math.max(0, (next.start ?? end) - end) : 0;
				const share = total > 0 ? (end - start) / total : 0;

				return (
					<AnimatePresence key={track.index ?? i} initial={false}>
						<motion.div
							className={`relative flex min-w-0 origin-left items-end px-2 pb-1.5 ${
								track.title ? "bg-raised" : "bg-shade"
							}`}
							style={{ flexGrow: Math.max(0.02, end - start) }}
							initial={reduce ? false : { scaleX: 0, opacity: 0 }}
							animate={{ scaleX: 1, opacity: 1 }}
							exit={reduce ? undefined : { opacity: 0 }}
							transition={{
								duration: reduce ? 0 : 0.5,
								delay: reduce ? 0 : Math.min(0.4, i * 0.05),
								ease: [0.22, 1, 0.36, 1],
							}}
						>
							{share >= MIN_LABEL_FRACTION ? (
								<span className="truncate text-[11px] font-medium text-dim">
									{track.title ?? `${track.index ?? i + 1}`}
								</span>
							) : null}
						</motion.div>
						{gap > 0.05 ? (
							<motion.div
								key={`gap-${track.index ?? i}`}
								className="origin-center bg-accent"
								style={{
									flex: `0 0 ${Math.min(
										MAX_GAP_PX,
										Math.max(MIN_GAP_PX, gap * GAP_PX_PER_SECOND),
									)}px`,
								}}
								initial={reduce ? false : { scaleX: 0 }}
								animate={{ scaleX: 1 }}
								transition={{ duration: reduce ? 0 : 0.4 }}
							/>
						) : null}
					</AnimatePresence>
				);
			})}
		</div>
	);
}
