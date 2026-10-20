import { motion, AnimatePresence } from "motion/react";
import { formatDuration } from "../lib/format.js";

/**
 * The named tracks.
 *
 * The real output of the job: which track, how long, and who it is by.
 */
export default function TrackList({ tracks }) {
	if (!tracks || tracks.length === 0) {
		return (
			<p className="empty">
				No tracks yet. They appear here as each one is cut and named.
			</p>
		);
	}

	return (
		<div className="tracklist">
			<AnimatePresence initial={false}>
				{tracks.map((track) => (
					<motion.div
						key={track.index}
						className="trackrow"
						initial={false}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
					>
						<span className="trackrow-index">{track.index}</span>
						<span>
							<span className="trackrow-title">{track.title}</span>
							{track.artist ? (
								<span className="trackrow-artist"> {track.artist}</span>
							) : null}
						</span>
						<span className="trackrow-length">
							{track.length ? formatDuration(track.length) : ""}
						</span>
					</motion.div>
				))}
			</AnimatePresence>
		</div>
	);
}
