/**
 * The theme.
 *
 * Two moods: the bottle-green ground on off-white, and the same bottle
 * green as the ground with a soft light ink. The choice is remembered in
 * localStorage, and the default is the dark one, because that is how the
 * product is mostly used.
 *
 * The attribute is set on the document element BEFORE the first paint by a
 * small inline script in index.html, so the page never flashes the wrong
 * ground on the way in.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "eztunes-theme";

/** Read the stored choice, falling back to dark. */
function readStoredTheme() {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored === "dark" || stored === "light") return stored;
	} catch {
		// A browser with storage turned off still gets a working toggle.
	}
	return "dark";
}

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	try {
		window.localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Nothing to do: the theme still applies for this visit.
	}
}

/**
 * The theme state, and the function that changes it.
 *
 * Kept apart from the switch component so each file exports only one
 * thing, which is what makes React Fast Refresh work in development.
 */
export function useTheme() {
	const [theme, setTheme] = useState(readStoredTheme);

	// Keep the document in step with the state, in case something else
	// changed it.
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	const toggle = useCallback(() => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	}, []);

	return { theme, toggle };
}
