/**
 * The pipeline, in order. The page marks where the job has got to.
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
		<div className="phases" role="status" aria-live="polite">
			{PHASE_ORDER.map((p, i) => {
				const state =
					currentIndex === -1
						? ""
						: i < currentIndex
							? "phase-done"
							: i === currentIndex
								? "phase-current"
								: "";
				return (
					<span key={p.key} className={`phase ${state}`}>
						{p.label}
					</span>
				);
			})}
		</div>
	);
}
