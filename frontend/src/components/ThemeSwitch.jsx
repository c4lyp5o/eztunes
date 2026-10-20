import { motion } from "motion/react";

/**
 * The theme switch.
 *
 * A real control: it answers click, Space and Enter, and it says which
 * state it is in. The knob travels to the side that matches the mood.
 */
export default function ThemeSwitch({ theme, onToggle }) {
	const dark = theme === "dark";

	return (
		<motion.button
			type="button"
			className="switch"
			role="switch"
			aria-checked={dark}
			aria-label="Dark theme"
			onClick={onToggle}
			whileTap={{ scale: 0.96 }}
		>
			<span className="switch-track" aria-hidden="true">
				<motion.span
					className="switch-knob"
					animate={{ x: dark ? 1.05 : 0 }}
					transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
				/>
			</span>
			<span>Dark</span>
		</motion.button>
	);
}
