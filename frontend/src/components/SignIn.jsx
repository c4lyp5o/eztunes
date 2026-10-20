import { useState } from "react";
import { motion } from "motion/react";

/**
 * The gate.
 *
 * No job data is fetched or shown before this. The token is posted once
 * and exchanged for a signed HttpOnly cookie; the browser never keeps the
 * token itself, and JavaScript cannot read the cookie that comes back.
 */
export default function SignIn({ onSignIn }) {
	const [token, setToken] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const handleSubmit = async (event) => {
		event.preventDefault();
		setError("");
		setBusy(true);
		try {
			const res = await fetch("/api/session", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});

			if (!res.ok) {
				setError("That token was not accepted.");
				return;
			}

			const data = await res.json();
			await onSignIn(data.clientId || "");
		} catch {
			setError("Could not reach the server.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="signin wrap">
			<div className="signin-inner stack">
				<motion.div
					className="stack"
					initial={{ opacity: 0, y: 16 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
				>
					<h1 className="head">ezTunes</h1>
					<p className="lead">
						Split a long recording into named tracks. The token is
						exchanged for a session cookie and is never stored in
						this browser.
					</p>
				</motion.div>

				<form onSubmit={handleSubmit} className="stack">
					<div className="form-field">
						<label className="label" htmlFor="api-token">
							Access token
						</label>
						<input
							id="api-token"
							type="password"
							autoComplete="current-password"
							placeholder="EZTUNES_API_TOKEN"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							required
							className="field"
						/>
					</div>

					{error ? <p className="error">{error}</p> : null}

					<motion.button
						type="submit"
						className="button"
						disabled={busy}
						whileTap={{ scale: 0.97 }}
						style={{ alignSelf: "flex-start" }}
					>
						{busy ? "Checking" : "Open the splitter"}
					</motion.button>
				</form>
			</div>
		</main>
	);
}
