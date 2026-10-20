import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

/**
 * The API client.
 *
 * Every call carries the session cookie, which the server sets after a
 * successful token exchange. The token itself is never stored here or in
 * localStorage - the browser holds an HttpOnly cookie that JavaScript cannot
 * read, so an XSS bug cannot exfiltrate the credential.
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

function App() {
	// --- auth state -----------------------------------------------------
	// "checking" -> we are asking the server whether a session exists.
	// "locked"    -> no session, show the unlock form. NOTHING is fetched
	//               and NOTHING is rendered from job data in this state.
	// "unlocked"  -> session is valid, the app is live.
	const [authState, setAuthState] = useState("checking");
	const [token, setToken] = useState("");
	const [authError, setAuthError] = useState("");
	const [clientId, setClientId] = useState("");

	// --- job state ------------------------------------------------------
	const [url, setUrl] = useState("");
	const [expectedTracks, setExpectedTracks] = useState("");
	const [jobId, setJobId] = useState(null);
	const [status, setStatus] = useState("idle");
	const [progressMsg, setProgressMsg] = useState("");
	const [history, setHistory] = useState([]);

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
			setProgressMsg(`History error: ${err.message}`);
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
			}

			fetchHistory();
		};

		ws.onclose = () => {
			// The server drops the session on restart; a closed socket means
			// the app can no longer refresh. Ask the user to unlock again.
			setAuthState((prev) => (prev === "unlocked" ? "locked" : prev));
		};

		return () => ws.close();
	}, [authState, fetchHistory]);

	const handleUnlock = async (e) => {
		e.preventDefault();
		setAuthError("");
		try {
			const res = await fetch("/api/session", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});

			if (!res.ok) {
				setAuthError("That token was not accepted.");
				return;
			}

			const data = await res.json();
			setClientId(data.clientId || "");
			// Do not keep the token in component state longer than needed.
			setToken("");
			setAuthState("unlocked");
			await fetchHistory();
		} catch {
			setAuthError("Could not reach the server.");
		}
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!url || authState !== "unlocked") return;

		setStatus("pending");
		setProgressMsg("Job added to queue...");

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
			setProgressMsg(err.message);
		}
	};

	const handleDownload = async (jobIdToDownload) => {
		if (!jobIdToDownload || authState !== "unlocked") return;

		setProgressMsg("Downloading file...");

		try {
			const res = await fetch(`/api/download/${jobIdToDownload}`, {
				credentials: "same-origin",
			});

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(errText || "Server refused download");
			}

			const blob = await res.blob();
			const objectUrl = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.style.display = "none";
			a.href = objectUrl;
			a.download = `eztunes_playlist_${jobIdToDownload}.zip`;
			document.body.appendChild(a);
			a.click();

			setTimeout(() => {
				document.body.removeChild(a);
				window.URL.revokeObjectURL(objectUrl);
				setProgressMsg("All done!");
			}, 1000);
		} catch (err) {
			setStatus("failed");
			setProgressMsg(`Download error: ${err.message}`);
		}
	};

	const StatusCard = () => {
		if (status === "idle") {
			return (
				<div className="rounded-2xl border border-white/10 bg-white/5 p-6">
					<p className="text-sm text-slate-300">
						Ready. Paste a link to start splitting.
					</p>
				</div>
			);
		}

		if (status === "failed") {
			return (
				<div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6">
					<p className="text-sm font-semibold text-red-200">{progressMsg}</p>
				</div>
			);
		}

		if (status === "completed") {
			return (
				<div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6 flex items-center justify-between gap-4">
					<div>
						<p className="text-sm font-semibold text-emerald-200">Completed</p>
						<p className="text-sm text-slate-200/90">{progressMsg}</p>
					</div>
					<button
						type="button"
						onClick={() => handleDownload(jobId)}
						className="inline-flex items-center justify-center rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
					>
						Download ZIP
					</button>
				</div>
			);
		}

		// pending / processing
		return (
			<div className="rounded-2xl border border-white/10 bg-white/5 p-6 flex items-center gap-4">
				<div className="h-10 w-10 rounded-xl bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center">
					<svg
						className="animate-spin h-5 w-5 text-indigo-300"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<title>Loading...</title>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						></circle>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						></path>
					</svg>
				</div>

				<div className="min-w-0">
					<p className="text-sm font-semibold text-indigo-200">
						{status === "pending" ? "Queued" : "Processing"}
					</p>
					<p className="text-sm text-slate-200/90 truncate">{progressMsg}</p>
				</div>
			</div>
		);
	};

	// ---------------------------------------------------------------
	// The unlock screen. No job data is fetched or shown before this.
	// ---------------------------------------------------------------
	if (authState !== "unlocked") {
		return (
			<main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
				<div className="pointer-events-none fixed inset-0">
					<div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_20%_10%,rgba(99,102,241,0.25),transparent_60%),radial-gradient(900px_500px_at_90%_20%,rgba(16,185,129,0.18),transparent_55%),radial-gradient(800px_500px_at_50%_100%,rgba(148,163,184,0.10),transparent_60%)]" />
					<div className="absolute inset-0 bg-gradient-to-b from-slate-950/30 via-slate-950 to-slate-950" />
				</div>

				<div className="relative w-full max-w-md">
					<div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl shadow-black/30 p-8">
						<div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
							<span className="h-2 w-2 rounded-full bg-emerald-400" />
							EzTunes Splitter
						</div>

						<h1 className="mt-4 text-2xl font-semibold tracking-tight">
							{authState === "checking" ? "Checking session…" : "Unlock"}
						</h1>

						{authState === "checking" ? (
							<p className="mt-2 text-sm text-slate-300">
								Verifying your session with the server.
							</p>
						) : (
							<form onSubmit={handleUnlock} className="mt-6 space-y-4">
								<div>
									<label
										htmlFor="api-token"
										className="block text-xs text-slate-300 mb-2"
									>
										Access token
									</label>
									<input
										id="api-token"
										type="password"
										autoComplete="current-password"
										placeholder="Paste your EZTUNES_API_TOKEN"
										value={token}
										onChange={(e) => setToken(e.target.value)}
										required
										className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40"
									/>
								</div>

								{authError ? (
									<p className="text-sm font-semibold text-red-300">{authError}</p>
								) : null}

								<button
									type="submit"
									className="w-full inline-flex items-center justify-center rounded-xl bg-indigo-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-400 active:bg-indigo-600 transition-colors"
								>
									Unlock
								</button>

								<p className="text-xs text-slate-500">
									The token is exchanged for a session cookie. It is never
									stored in this browser.
								</p>
							</form>
						)}
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-slate-950 text-slate-100">
			{/* Background */}
			<div className="pointer-events-none fixed inset-0">
				<div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_20%_10%,rgba(99,102,241,0.25),transparent_60%),radial-gradient(900px_500px_at_90%_20%,rgba(16,185,129,0.18),transparent_55%),radial-gradient(800px_500px_at_50%_100%,rgba(148,163,184,0.10),transparent_60%)]" />
				<div className="absolute inset-0 bg-gradient-to-b from-slate-950/30 via-slate-950 to-slate-950" />
			</div>

			<div className="relative mx-auto max-w-6xl px-4 py-10 lg:px-10 lg:py-14">
				<header className="mb-8 flex items-start justify-between gap-6">
					<div>
						<div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
							<span className="h-2 w-2 rounded-full bg-emerald-400" />
							YouTube → ZIP
						</div>
						<h1 className="mt-4 text-3xl md:text-4xl font-semibold tracking-tight">
							EzTunes Splitter
						</h1>
						<p className="mt-2 text-sm md:text-base text-slate-300 max-w-2xl">
							Submit a YouTube link, let the server split tracks, then download
							a ZIP.
						</p>
					</div>

					<div className="hidden md:block text-right">
						<p className="text-xs text-slate-400">Client</p>
						<p className="text-xs font-mono text-slate-300 truncate max-w-52">
							{clientId || "…"}
						</p>
					</div>
				</header>

				<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
					{/* Main */}
					<section className="lg:col-span-2 rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl shadow-black/30">
						<div className="p-6 md:p-8">
							<form
								onSubmit={handleSubmit}
								className="grid grid-cols-1 md:grid-cols-12 gap-3"
							>
								<div className="md:col-span-8">
									<label
										htmlFor="youtube-url"
										className="block text-xs text-slate-300 mb-2"
									>
										YouTube URL
									</label>
									<input
										id="youtube-url"
										type="url"
										placeholder="https://www.youtube.com/watch?v=..."
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										required
										className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40"
									/>
								</div>

								<div className="md:col-span-4">
									<label
										htmlFor="expected-tracks"
										className="block text-xs text-slate-300 mb-2"
									>
										Expected tracks (optional)
									</label>
									<input
										id="expected-tracks"
										type="number"
										min="1"
										placeholder="e.g. 12"
										value={expectedTracks}
										onChange={(e) => setExpectedTracks(e.target.value)}
										className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40"
									/>
								</div>

								<div className="md:col-span-12 flex items-center justify-between gap-3 pt-1">
									<p className="text-xs text-slate-400">
										Your job history is tied to this session.
									</p>

									<button
										type="submit"
										disabled={status === "pending" || status === "processing"}
										className="inline-flex items-center justify-center rounded-xl bg-indigo-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-400 active:bg-indigo-600 disabled:opacity-50 transition-colors"
									>
										Split
									</button>
								</div>
							</form>

							<div className="mt-6">
								<StatusCard />
							</div>
						</div>

						<div className="border-t border-white/10 px-6 md:px-8 py-4 flex items-center justify-between">
							<div className="text-xs text-slate-400">
								Status:{" "}
								<span className="text-slate-200 font-semibold">{status}</span>
							</div>
							{jobId ? (
								<div className="text-xs text-slate-400">
									Job ID:{" "}
									<span className="text-slate-200 font-mono">{jobId}</span>
								</div>
							) : (
								<div className="text-xs text-slate-500">No active job</div>
							)}
						</div>
					</section>

					{/* History */}
					<aside className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl shadow-black/30 overflow-hidden">
						<div className="p-6">
							<div className="flex items-center justify-between gap-3">
								<h2 className="text-base font-semibold">History</h2>
								<button
									type="button"
									onClick={fetchHistory}
									className="text-xs rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-slate-200 hover:bg-white/10 transition-colors"
								>
									Refresh
								</button>
							</div>

							<p className="mt-2 text-xs text-slate-400">
								Recent jobs for this session.
							</p>
						</div>

						<div className="max-h-[520px] overflow-y-auto px-6 pb-6 space-y-3">
							{history.length === 0 ? (
								<div className="rounded-2xl border border-white/10 bg-slate-900/30 p-4">
									<p className="text-sm text-slate-300">No jobs yet.</p>
									<p className="text-xs text-slate-500 mt-1">
										Submit a link and your jobs will appear here.
									</p>
								</div>
							) : (
								history.map((job) => (
									<div
										key={job.id}
										className="rounded-2xl border border-white/10 bg-slate-900/35 p-4"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="text-xs text-slate-400">
													Job <span className="font-mono">#{job.id}</span>
												</p>
												<p className="mt-1 text-sm text-slate-200 truncate">
													{job.video_url}
												</p>
											</div>

											<span
												className={[
													"shrink-0 text-xs font-semibold px-2 py-1 rounded-full border",
													job.status === "completed"
														? "text-emerald-200 bg-emerald-500/10 border-emerald-500/20"
														: job.status === "processing"
															? "text-amber-200 bg-amber-500/10 border-amber-500/20"
															: job.status === "failed"
																? "text-red-200 bg-red-500/10 border-red-500/20"
																: "text-slate-200 bg-white/5 border-white/10",
												].join(" ")}
											>
												{job.status}
											</span>
										</div>

										{job.status === "completed" && (
											<div className="mt-3 flex justify-end">
												<button
													type="button"
													onClick={() => handleDownload(job.id)}
													className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 active:bg-emerald-600 transition-colors"
												>
													Download
												</button>
											</div>
										)}
									</div>
								))
							)}
						</div>
					</aside>
				</div>
			</div>
		</main>
	);
}

export default App;
