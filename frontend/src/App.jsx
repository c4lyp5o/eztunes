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
import { motion } from "motion/react";
import SplitMap from "./components/SplitMap.jsx";
import TrackList from "./components/TrackList.jsx";
import PhaseReadout from "./components/PhaseReadout.jsx";
import SignIn from "./components/SignIn.jsx";
import { formatDuration, formatWhen } from "./lib/format.js";
import "./styles/base.css";
import "./styles/app.css";
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
	const [clientId, setClientId] = useState("");

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
				<main className="signin wrap">
					<p className="lead">Checking your session.</p>
				</main>
			);
		}
		return <SignIn onSignIn={handleSignIn} />;
	}

	const busy = status === "pending" || status === "processing";

	return (
		<div className="wrap">
			<header className="bar">
				<span className="wordmark">ezTunes</span>
				<div className="bar-links">
					<span>Session {clientId.slice(0, 8)}</span>
					<button
						type="button"
						className="button-quiet"
						onClick={async () => {
							await fetch("/api/logout", { method: "POST" });
							setAuthState("locked");
						}}
					>
						Lock
					</button>
				</div>
			</header>

			{/* ---------------------------------------------------------- */}
			{/* The hero. The headline on the left, the product on the     */}
			{/* stage on the right: the actual splitter, at true size.     */}
			{/* ---------------------------------------------------------- */}
			<section className="hero grid">
				<motion.div
					className="hero-copy"
					initial={{ opacity: 0, y: 20 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
				>
					<h1 className="display">Every silence is a cut.</h1>
					<p className="lead">
						Give it a video. It finds the quiet gaps between the
						tracks, cuts there, and names each one from what it
						hears.
					</p>
				</motion.div>

				<motion.div
					className="stage"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.9, delay: 0.15 }}
				>
					<div className="stage-inner">
						<div className="fragment" data-ui>
							<form onSubmit={handleSubmit} className="stack">
								<div className="form-row">
									<div className="form-field">
										<label className="label" htmlFor="youtube-url">
											Video URL
										</label>
										<input
											id="youtube-url"
											type="url"
											placeholder="https://www.youtube.com/watch?v=..."
											value={url}
											onChange={(e) => setUrl(e.target.value)}
											required
											className="field"
										/>
									</div>

									<div className="form-field">
										<label className="label" htmlFor="expected-tracks">
											Track count
										</label>
										<input
											id="expected-tracks"
											type="number"
											min="1"
											placeholder="Auto"
											value={expectedTracks}
											onChange={(e) => setExpectedTracks(e.target.value)}
											className="field"
										/>
									</div>

									<motion.button
										type="submit"
										className="button"
										disabled={busy}
										whileTap={{ scale: 0.97 }}
									>
										Split it
									</motion.button>
								</div>

								{error ? <p className="error">{error}</p> : null}

								{busy || status === "completed" || status === "failed" ? (
									<PhaseReadout phase={phase} />
								) : null}

								{progressMsg ? (
									<p className="small muted">{progressMsg}</p>
								) : null}

								<SplitMap tracks={tracks} />

								<TrackList tracks={tracks} />

								{status === "completed" && jobId ? (
									<motion.button
										type="button"
										className="button"
										onClick={() => handleDownload(jobId)}
										whileTap={{ scale: 0.97 }}
										style={{ alignSelf: "flex-start" }}
									>
										Download the zip
									</motion.button>
								) : null}
							</form>
						</div>
					</div>
				</motion.div>
			</section>

			{/* ---------------------------------------------------------- */}
			{/* The pictures. Real photographs of the rooms this tool      */}
			{/* sits in, and one clip of a fader travelling between two     */}
			{/* tracks, which is the whole idea in a single moving image.  */}
			{/* ---------------------------------------------------------- */}
			<section className="section">
				<div className="stack">
					<h2 className="head">It works like a mixing desk.</h2>

					<div className="photostrip">
						<motion.figure
							className="photo photo-lede"
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, amount: 0.3 }}
							transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
						>
							<video
								autoPlay
								loop
								muted
								playsInline
								poster="/media/fader-poster.jpg"
								aria-label="A fader on a mixing console moving up and down"
							>
								<source src="/media/fader.webm" type="video/webm" />
							</video>
							<figcaption className="photo-caption">
								A fader travelling between two tracks. The
								boundary is the gap.
							</figcaption>
						</motion.figure>

						<motion.figure
							className="photo"
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, amount: 0.3 }}
							transition={{
								duration: 0.8,
								delay: 0.1,
								ease: [0.22, 1, 0.36, 1],
							}}
						>
							<img
								src="/photos/dj-holding-a-vinyl-in-her-hands.jpg"
								alt="A DJ holding a vinyl record beside a turntable"
								width="1920"
								height="1282"
								loading="lazy"
							/>
							<figcaption className="photo-caption">
								A sleeve full of tracks, waiting to be pulled
								apart.
							</figcaption>
						</motion.figure>

						<motion.figure
							className="photo"
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, amount: 0.3 }}
							transition={{
								duration: 0.8,
								delay: 0.2,
								ease: [0.22, 1, 0.36, 1],
							}}
						>
							<img
								src="/photos/digico-s21-mixing-console-2017.jpg"
								alt="A digital mixing console with rows of faders"
								width="1920"
								height="1285"
								loading="lazy"
							/>
							<figcaption className="photo-caption">
								Rows of channels, each one a separate track.
							</figcaption>
						</motion.figure>

						<motion.figure
							className="photo"
							initial={{ opacity: 0, y: 24 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, amount: 0.3 }}
							transition={{
								duration: 0.8,
								delay: 0.3,
								ease: [0.22, 1, 0.36, 1],
							}}
						>
							<img
								src="/photos/japanese-audio-engineer-at-mixing-console.jpg"
								alt="An audio engineer at a mixing console"
								width="1920"
								height="2560"
								loading="lazy"
							/>
							<figcaption className="photo-caption">
								Somebody is listening for the gap right now.
							</figcaption>
						</motion.figure>
					</div>
				</div>
			</section>

			{/* ---------------------------------------------------------- */}
			{/* The history. The real output of every job this session    */}
			{/* has run, with the tracks it produced.                     */}
			{/* ---------------------------------------------------------- */}
			<section className="section">
				<div className="stack">
					<h2 className="head">What this session has split.</h2>

					{history.length === 0 ? (
						<p className="empty">
							Nothing yet. Submit a link and the job appears here
							with the tracks it produced.
						</p>
					) : (
						<div className="jobs">
							{history.map((job) => (
								<motion.div
									key={job.id}
									className="job"
									initial={{ opacity: 0, y: 12 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.45 }}
								>
									<span className="job-title">
										{job.title || job.video_url}
									</span>
									<span
										className={`job-status ${
											job.status === "completed"
												? "job-status-done"
												: job.status === "failed"
													? "job-status-failed"
													: "job-status-live"
										}`}
									>
										{job.status === "completed"
											? `${job.track_count ?? 0} tracks`
											: job.status}
									</span>
									<span className="job-meta">
										{formatWhen(job.created_at)}
										{job.duration_secs
											? ` · ${formatDuration(job.duration_secs)}`
											: ""}
									</span>
									<span className="job-meta">
										{job.status === "completed" ? (
											<>
												<button
													type="button"
													className="button-quiet"
													onClick={() => handleDownload(job.id)}
												>
													Download
												</button>
												{" · "}
												<button
													type="button"
													className="button-quiet"
													onClick={() => openJob(job.id)}
												>
													See the tracks
												</button>
											</>
										) : null}
									</span>
									{job.status === "failed" && job.error_msg ? (
										<span className="job-error">{job.error_msg}</span>
									) : null}
								</motion.div>
							))}
						</div>
					)}

					{openJobId ? (
						<div className="fragment" data-ui>
							<TrackList tracks={tracks} />
						</div>
					) : null}
				</div>
			</section>

			<footer className="footer">
				<div className="stack">
					<p className="footer-name">ezTunes</p>
					<p className="credits">
						Photographs by Shixart1985, Niranjan Arminius and Sgroey,
						via Wikimedia Commons, under CC BY 2.0 and CC BY-SA 4.0. The
						clip is by Ángela Gómez, under CC BY-SA 4.0. Type is Hanken
						Grotesk.
					</p>
				</div>
			</footer>
		</div>
	);
}
