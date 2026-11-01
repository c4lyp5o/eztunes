/**
 * The eztunes front end.
 *
 * The design direction is "the product performs": rather than describing
 * what the tool does, the page shows the tool doing it. The split map, the
 * named tracks and the phase readout are all real parts of the interface,
 * fed by the worker's progress broadcasts.
 *
 * The idea, in one sentence:
 *
 *   On this page, the silence between two tracks becomes the cut that
 *   separates them.
 *
 * The live thing is the split map: it fills in, track by track, as the
 * worker reports the boundaries it found and the titles it recognised.
 *
 * Nothing here renders job data before the session is authenticated. The
 * token is exchanged for an HttpOnly cookie and is never kept in the
 * browser's JavaScript, so an XSS bug has nothing to exfiltrate.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import PhaseReadout from "./components/PhaseReadout.jsx";
import SignIn from "./components/SignIn.jsx";
import SplitMap from "./components/SplitMap.jsx";
import TrackList from "./components/TrackList.jsx";
import Backdrop from "./ez/Backdrop";
import { Collapse, SlideRow, Stagger, StaggerItem } from "./ez/motion";
import { Brand, Shell } from "./ez/Shell";
import { btn, Chip, cx, EmptyState, inputCls, labelCls, Loading, panel, SectionLabel, Spinner } from "./ez/ui";
import { formatDuration, formatWhen } from "./lib/format.js";
/**
 * The API client.
 *
 * Every call carries the session cookie, which the server sets after a
 * successful token exchange. The token itself is never stored here or in
 * localStorage - the browser holds an HttpOnly cookie that JavaScript
 * cannot read.
 */
async function api(path, options = {}) {
	const res = await fetch(path, {
		credentials: "same-origin",
		...options,
		headers: {
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...options.headers,
		},
	});

	if (res.status === 401) {
		const err = new Error("Unauthorized");
		err.unauthorized = true;
		throw err;
	}

	const text = await res.text();
	const data = text ? JSON.parse(text) : null;

	if (!res.ok) {
		throw new Error(data?.error || `Request failed (${res.status})`);
	}
	return data;
}

/* ------------------------------------------------------------------ */
/* the app                                                            */
/* ------------------------------------------------------------------ */

export default function App() {
	// --- auth state ---
	// "checking" -> we are asking the server whether a session exists.
	// "locked"    -> no session. Nothing is fetched and nothing is rendered
	//               from job data in this state.
	// "unlocked"  -> session is valid, the app is live.
	const [authState, setAuthState] = useState("checking");
	const [, setClientId] = useState("");

	// --- job state ---
	const [url, setUrl] = useState("");
	const [expectedTracks, setExpectedTracks] = useState("");
	const [jobId, setJobId] = useState(null);
	const [status, setStatus] = useState("idle");
	const [progressMsg, setProgressMsg] = useState("");
	const [phase, setPhase] = useState(null);
	const [tracks, setTracks] = useState([]);
	const [history, setHistory] = useState([]);
	const [openJobId, setOpenJobId] = useState(null);
	const [error, setError] = useState("");

	// Keep the latest jobId in a ref so the socket handler always sees the
	// current value without re-opening the connection on every change.
	const jobIdRef = useRef(null);
	useEffect(() => {
		jobIdRef.current = jobId;
	}, [jobId]);

	const fetchHistory = useCallback(async () => {
		try {
			const jobs = await api("/api/history");
			setHistory(Array.isArray(jobs) ? jobs : []);
		} catch (err) {
			if (err.unauthorized) {
				setAuthState("locked");
				return;
			}
			setError(`History error: ${err.message}`);
		}
	}, []);

	// On mount, ask the server whether we already hold a valid session.
	// The cookie is HttpOnly, so this is the only way to know.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/history", {
					credentials: "same-origin",
				});
				if (cancelled) return;
				if (res.ok) {
					setAuthState("unlocked");
					const jobs = await res.json();
					setHistory(Array.isArray(jobs) ? jobs : []);
				} else {
					setAuthState("locked");
				}
			} catch {
				if (!cancelled) setAuthState("locked");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// The live socket. Only opened once authenticated.
	useEffect(() => {
		if (authState !== "unlocked") return undefined;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);

		ws.onmessage = (event) => {
			let data;
			try {
				data = JSON.parse(event.data);
			} catch {
				return;
			}

			const current = jobIdRef.current;
			if (current && data.jobId === current) {
				setStatus(data.status);
				setProgressMsg(data.progressMsg || "");
				if (data.detail?.phase) setPhase(data.detail.phase);

				// The boundaries and the names arrive in pieces. Merge them
				// into one list keyed by track index, so a track that was
				// found first and named later ends up complete.
				const incoming = data.detail?.tracks;
				if (Array.isArray(incoming) && incoming.length > 0) {
					setTracks((prev) => {
						const merged = new Map(prev.map((t) => [t.index, t]));
						for (const t of incoming) {
							const existing = merged.get(t.index) || {};
							merged.set(t.index, { ...existing, ...t });
						}
						return [...merged.values()].sort((a, b) => a.index - b.index);
					});
				}
			}

			fetchHistory();
		};

		ws.onclose = () => {
			// The server drops the session on restart; a closed socket means
			// the app can no longer refresh. Ask the user to sign in again.
			setAuthState((prev) => (prev === "unlocked" ? "locked" : prev));
		};

		return () => ws.close();
	}, [authState, fetchHistory]);

	const handleSignIn = useCallback(
		async (clientIdFromServer) => {
			// The sign-in screen already exchanged the token for a cookie and
			// got the identity back. There is nothing to re-post, and the
			// token is never held in this component.
			setClientId(clientIdFromServer || "");
			setAuthState("unlocked");
			await fetchHistory();
		},
		[fetchHistory],
	);

	const handleSubmit = async (event) => {
		event.preventDefault();
		if (!url || authState !== "unlocked") return;

		setStatus("pending");
		setProgressMsg("Job added to the queue");
		setPhase(null);
		setTracks([]);
		setError("");

		try {
			const data = await api("/api/process", {
				method: "POST",
				body: JSON.stringify({ videoUrl: url, expectedTracks }),
			});
			setJobId(data.jobId);
		} catch (err) {
			if (err.unauthorized) {
				setAuthState("locked");
				return;
			}
			setStatus("failed");
			setError(err.message);
		}
	};

	const handleDownload = async (idToDownload) => {
		if (!idToDownload || authState !== "unlocked") return;

		try {
			const res = await fetch(`/api/download/${idToDownload}`, {
				credentials: "same-origin",
			});

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(errText || "The server refused the download");
			}

			const blob = await res.blob();
			const objectUrl = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.style.display = "none";
			a.href = objectUrl;
			a.download = `eztunes_playlist_${idToDownload}.zip`;
			document.body.appendChild(a);
			a.click();

			setTimeout(() => {
				document.body.removeChild(a);
				window.URL.revokeObjectURL(objectUrl);
			}, 1000);
		} catch (err) {
			setError(`Download error: ${err.message}`);
		}
	};

	// The tracks on display: the ones of the job being worked on, or the
	// ones of a job the reader opened from the history.
	const openJob = async (id) => {
		setOpenJobId(id);
		try {
			const job = await api(`/api/jobs/${id}`);
			setTracks(Array.isArray(job.tracks) ? job.tracks : []);
		} catch {
			setTracks([]);
		}
	};

	// ---------------------------------------------------------------
	// The gate. No job data is fetched or shown before this.
	// ---------------------------------------------------------------
	if (authState !== "unlocked") {
		if (authState === "checking") {
			return (
				<main className="flex min-h-dvh items-center justify-center">
					<Loading label="Checking your session…" />
				</main>
			);
		}
		return <SignIn onSignIn={handleSignIn} />;
	}

	const busy = status === "pending" || status === "processing";
	const STATUS_TONE = { completed: "ok", failed: "bad" };

	return (
		<Shell
			brand={<Brand name="eztunes" glyph="tn" scope="Splits videos into tracks" />}
			topbarActions={
				<button
					type="button"
					className={cx(btn.sm, btn.ghost)}
					onClick={async () => {
						await fetch("/api/logout", { method: "POST" });
						setAuthState("locked");
					}}
				>
					Sign out
				</button>
			}
			title="Split"
			sub="Give it a video. It cuts at the silences between tracks and names each one from what it hears."
			width="max-w-[1200px]"
		>
			<Stagger className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
				{/* The splitter: the form, the pipeline, the map and the tracks. */}
				<StaggerItem className={panel}>
					<form onSubmit={handleSubmit}>
						<div className="grid gap-3 border-b border-line p-5 sm:grid-cols-[minmax(0,1fr)_120px_auto] sm:items-end">
							<div>
								<label className={labelCls} htmlFor="youtube-url">
									Video URL
								</label>
								<input
									id="youtube-url"
									type="url"
									placeholder="https://www.youtube.com/watch?v=..."
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									required
									className={inputCls}
								/>
							</div>
							<div>
								<label className={labelCls} htmlFor="expected-tracks">
									Track count
								</label>
								<input
									id="expected-tracks"
									type="number"
									min="1"
									placeholder="Auto"
									value={expectedTracks}
									onChange={(e) => setExpectedTracks(e.target.value)}
									className={inputCls}
								/>
							</div>
							<button type="submit" className={cx(btn.base, btn.primary)} disabled={busy}>
								{busy ? <Spinner /> : null}
								Split it
							</button>
						</div>

						<div className="space-y-4 p-5">
							<Collapse open={!!error}>
								<p className="rounded-lg bg-bad-dim px-3 py-2 text-[13px] text-bad">{error}</p>
							</Collapse>
							<Collapse open={busy || status === "completed" || status === "failed"}>
								<PhaseReadout phase={phase} />
							</Collapse>
							{progressMsg ? <p className="text-[12px] text-mute">{progressMsg}</p> : null}

							<div>
								<div className="mb-2 flex items-center gap-2">
									<SectionLabel>Split map</SectionLabel>
									<span className="text-[12px] text-mute">Cuts in the accent are the silences found</span>
								</div>
								<SplitMap tracks={tracks} />
							</div>

							<div>
								<div className="mb-2 flex items-center gap-2">
									<SectionLabel>Tracks</SectionLabel>
									{tracks.length > 0 && <span className="font-mono text-[12px] text-mute">{tracks.length.toLocaleString("en-US")}</span>}
									{status === "completed" && jobId ? (
										<button type="button" className={cx(btn.sm, btn.ghost, "ml-auto")} onClick={() => handleDownload(jobId)}>
											Download the zip
										</button>
									) : null}
								</div>
								<TrackList tracks={tracks} />
							</div>
						</div>
					</form>
				</StaggerItem>

				{/* The history: every job this session has run. */}
				<StaggerItem className="space-y-4">
					<section className={panel}>
						<header className="flex items-center gap-2 border-b border-line px-5 py-3">
							<SectionLabel>This session</SectionLabel>
							<span className="font-mono text-[12px] text-mute">{history.length.toLocaleString("en-US")}</span>
						</header>
						{history.length === 0 ? (
							<div className="p-5">
								<EmptyState title="Nothing split yet." hint="Submit a link and the job appears here with the tracks it produced." />
							</div>
						) : (
							<ul className="divide-y divide-line">
								<AnimatePresence initial={false}>
									{history.map((job) => (
										<SlideRow as="li" key={job.id} className={cx("px-5 py-3", openJobId === job.id && "bg-wash")}>
											<div className="flex items-start gap-2">
												<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{job.title || job.video_url}</span>
												<Chip tone={STATUS_TONE[job.status] ?? "accent"}>
													{job.status === "completed" ? `${job.track_count ?? 0} tracks` : job.status}
												</Chip>
											</div>
											<div className="mt-0.5 text-[12px] text-mute">
												{formatWhen(job.created_at)}
												{job.duration_secs ? <span className="font-mono"> · {formatDuration(job.duration_secs)}</span> : ""}
											</div>
											{job.status === "completed" ? (
												<div className="mt-2 flex gap-3">
													<button type="button" className={cx(btn.text, "text-[12px]")} onClick={() => handleDownload(job.id)}>
														Download
													</button>
													<button type="button" className={cx(btn.text, "text-[12px]")} onClick={() => openJob(job.id)}>
														See the tracks
													</button>
												</div>
											) : null}
											{job.status === "failed" && job.error_msg ? (
												<p className="mt-1 text-[12px] text-bad">{job.error_msg}</p>
											) : null}
										</SlideRow>
									))}
								</AnimatePresence>
							</ul>
						)}
					</section>

					<section className={cx(panel, "relative isolate h-[180px] overflow-hidden")}>
						<Backdrop className="-z-10" opacity={0.55} nodes={Math.max(6, Math.min(20, tracks.length || 10))} />
						<p className="absolute bottom-3 left-4 text-[12px] text-mute">
							{busy ? "Splitting…" : tracks.length ? `${tracks.length} tracks on the map` : "Idle"}
						</p>
					</section>
				</StaggerItem>
			</Stagger>
		</Shell>
	);
}
