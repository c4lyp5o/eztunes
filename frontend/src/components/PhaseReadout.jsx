import { motion } from "motion/react";
import { spring } from "../ez/motion";
import { cx } from "../ez/ui";

/**
 * The pipeline, in order. Done steps carry a check, the current one is
 * underlined by the one accent line, which slides as the job moves on.
 */
const PHASE_ORDER = [
	{ key: "downloading", label: "Downloading" },
	{ key: "detecting", label: "Finding silence" },
	{ key: "identifying", label: "Naming tracks" },
	{ key: "cutting", label: "Cutting" },
	{ key: "zipping", label: "Zipping" },
];

export default function PhaseReadout({ phase }) {
	const currentIndex = PHASE_ORDER.findIndex((p) => p.key === phase);

	return (
		<ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]" role="status" aria-live="polite">
			{PHASE_ORDER.map((p, i) => {
				const done = currentIndex !== -1 && i < currentIndex;
				const current = i === currentIndex;
				return (
					<li key={p.key} className={cx("relative flex items-center gap-1.5 pb-px", done ? "text-dim" : current ? "text-ink" : "text-mute")}>
						{done ? (
							<span className="text-ok" aria-hidden="true">
								✓
							</span>
						) : (
							<span className="font-mono text-mute">{i + 1}</span>
						)}
						{p.label}
						{current && (
							<motion.span layoutId="phase-line" className="absolute inset-x-0 -bottom-px h-px bg-accent" transition={spring} />
						)}
					</li>
				);
			})}
		</ol>
	);
}
