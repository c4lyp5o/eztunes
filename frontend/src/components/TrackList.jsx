import { AnimatePresence } from "motion/react";
import { SlideRow } from "../ez/motion";
import { EmptyState } from "../ez/ui";
import { formatDuration } from "../lib/format.js";

/**
 * The named tracks: which track, how long, and who it is by. Rows slide in
 * from the top as each one is cut and named.
 */
export default function TrackList({ tracks }) {
	if (!tracks || tracks.length === 0) {
		return <EmptyState title="No tracks yet." hint="They appear here as each one is cut and named." />;
	}

	return (
		<ol className="divide-y divide-line rounded-lg border border-line">
			<AnimatePresence initial={false}>
				{tracks.map((track) => (
					<SlideRow as="li" key={track.index} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5">
						<span className="font-mono text-[12px] text-mute">{track.index}</span>
						<span className="min-w-0 truncate text-[13px]">
							<span className={track.title ? "text-ink" : "text-mute"}>{track.title || "Unnamed"}</span>
							{track.artist ? <span className="text-mute"> · {track.artist}</span> : null}
						</span>
						<span className="font-mono text-[12px] text-dim">{track.length ? formatDuration(track.length) : <span className="text-mute">–</span>}</span>
					</SlideRow>
				))}
			</AnimatePresence>
		</ol>
	);
}
