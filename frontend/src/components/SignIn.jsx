import { useState } from "react";
import Backdrop from "../ez/Backdrop";
import { Collapse, Screen } from "../ez/motion";
import { Brand } from "../ez/Shell";
import { ThemeToggle } from "../ez/theme";
import { btn, cx, inputCls, labelCls, Spinner } from "../ez/ui";

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
		<main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-4" style={{ background: "#05070d" }}>
			<Backdrop className="-z-10" opacity={0.7} nodes={16} />
			<div className="absolute top-4 right-4">
				<ThemeToggle compact />
			</div>
			<Screen className="relative w-full max-w-sm rounded-xl border border-line bg-surface p-8">
				<Brand name="eztunes" glyph="tn" />
				<h1 className="mt-6 text-[20px] font-semibold text-ink">Open the splitter</h1>
				<p className="mt-2 text-[13px] text-mute">
					Split a long recording into named tracks. The token is exchanged for a session cookie and is never stored in
					this browser.
				</p>

				<form onSubmit={handleSubmit} className="mt-6">
					<label className={labelCls} htmlFor="api-token">
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
						className={cx(inputCls, error && "border-bad")}
					/>
					<Collapse open={!!error}>
						<p className="pt-2 text-[12px] text-bad">{error}</p>
					</Collapse>
					<button type="submit" className={cx(btn.base, btn.primary, "mt-4 w-full")} disabled={busy}>
						{busy ? <Spinner /> : null}
						{busy ? "Checking" : "Open the splitter"}
					</button>
				</form>
			</Screen>
		</main>
	);
}
