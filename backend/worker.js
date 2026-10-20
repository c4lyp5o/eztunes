import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import archiver from "archiver";
import youtubedl from "youtube-dl-exec";

import logger from "./logger.js";
import { openDatabase } from "./db.js";
import { loadConfig } from "./config.js";
import { sanitizeFileName } from "./paths.js";
import { sweepJobs } from "./sweep.js";

/**
 * The eztunes worker.
 *
 * Claims jobs from the SQLite queue, splits the audio, tags the tracks and
 * zips the result. Progress is pushed to the server over the internal
 * broadcast endpoint.
 *
 * Security-relevant behaviour:
 *  - ffmpeg is invoked with spawn() and an ARGV ARRAY. No shell, so no
 *    metadata from AudD or YouTube can ever be interpreted as a command. The
 *    previous code built a shell string; it was not exploitable as written
 *    (the sanitiser stripped quotes and cmd.exe does not re-parse
 *    metacharacters inside double quotes) but it was one careless edit away
 *    from remote code execution.
 *  - The AudD token comes from the environment only. It is never a literal in
 *    this file, so it cannot leak into the image layers or a git history.
 *  - The broadcast hop authenticates with its own internal token.
 */

const config = loadConfig();
const db = openDatabase(config.dbPath);

const OUTPUT_DIR = config.outputDir;

// Prevent overlapping sweeps
let sweepInFlight = false;
let shuttingDown = false;

// Graceful shutdown
process.on("SIGINT", () => {
	shuttingDown = true;
	logger.warn("SIGINT received. Shutting down after current job");
});
process.on("SIGTERM", () => {
	shuttingDown = true;
	logger.warn("SIGTERM received. Shutting down after current job");
});

/**
 * Run a program with an argv array. No shell is involved, so arguments are
 * passed through verbatim - a value that contains shell metacharacters is
 * data, never syntax.
 */
function run(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { shell: false, windowsHide: true });
		let stdout = "";
		let stderr = "";

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else
				reject(
					new Error(
						`${bin} exited with code ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`,
					),
				);
		});
	});
}

async function broadcastStatus(
	clientId,
	jobId,
	status,
	progressMsg,
	resultFileName = null,
) {
	try {
		logger.info(`[Job ${jobId}] ${progressMsg}`);
		if (status === "completed" && resultFileName) {
			// Store the NAME only. The server resolves it against the output
			// root and refuses anything that escapes.
			db.query(`UPDATE jobs SET status = ?, result_file = ? WHERE id = ?`).run(
				status,
				resultFileName,
				jobId,
			);
		} else {
			db.query(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, jobId);
		}

		await fetch(config.broadcastUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-internal-token": config.internalToken,
			},
			body: JSON.stringify({
				clientId,
				payload: {
					jobId,
					status,
					progressMsg,
					downloadUrl: status === "completed" ? `/api/download/${jobId}` : null,
				},
			}),
		});
	} catch (e) {
		logger.error(`Failed to broadcast status: ${e?.message || e}`);
	}
}

async function profileAndDetectSilences(
	filePath,
	clientId,
	jobId,
	expectedTracks,
) {
	// ====================================================================
	// PATH A: TARGET MODE (User provided an exact track count)
	// ====================================================================
	if (expectedTracks) {
		logger.info(
			`\n[Job ${jobId}] 🎯 TARGET MODE: Searching for exactly ${expectedTracks} tracks.`,
		);

		const dbLevels = [-25, -30, -35, -40, -45, -50];
		const testDurations = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0];

		let bestProfile = null;
		let bestDiff = Infinity;
		let exactMatchFound = false;

		for (let attempt = 0; attempt < testDurations.length; attempt++) {
			const minDur = testDurations[attempt];
			await broadcastStatus(
				clientId,
				jobId,
				"processing",
				`🔄 Sweep ${attempt + 1}/${testDurations.length} (Gap: ${minDur}s)`,
			);

			for (const db of dbLevels) {
				const silences = await runFFmpegSilence(filePath, db, minDur);

				if (silences.length > 0) {
					// Apply the 5-second filter to get the TRUE track count
					let estimatedTracks = 0;
					let tempStart = 0;
					for (let i = 0; i < silences.length; i++) {
						if (silences[i].start - tempStart > 5) estimatedTracks++;
						tempStart = silences[i].end;
					}
					estimatedTracks++; // Add the final track

					const diff = Math.abs(estimatedTracks - expectedTracks);

					// Save the closest match just in case we never find the exact one
					if (!bestProfile || diff < bestDiff) {
						bestProfile = { db, minDur, tracks: estimatedTracks };
						bestDiff = diff;
					}

					if (estimatedTracks === expectedTracks) {
						logger.success(
							`   ✅ Exact match found! (-${Math.abs(db)}dB, ${minDur}s gap)`,
						);
						exactMatchFound = true;
						break;
					}
				}
			}
			if (exactMatchFound) break;
		}

		// GUARD: bestProfile is only assigned inside the `silences.length > 0`
		// branch. If every dB level and every gap width found no silence at
		// all, it stays null and the old code threw a TypeError on
		// `bestProfile.db`. Fail the job with a clear message instead.
		if (!bestProfile) {
			throw new Error(
				"Could not detect any silences at any volume level. The audio may have no gaps between tracks, or it may not be audio at all.",
			);
		}

		if (!exactMatchFound) {
			logger.warn(
				`[Job ${jobId}] ⚠️ Could not find exactly ${expectedTracks} tracks.`,
			);
			logger.info(
				`[Job ${jobId}] 👉 Defaulting to closest match: ${bestProfile.tracks} tracks.`,
			);
		}

		await broadcastStatus(
			clientId,
			jobId,
			"processing",
			`Cutting tracks at ${bestProfile.db}dB (${bestProfile.minDur}s gap)`,
		);

		// Run the final cut using the exact parameters that won
		const finalSilences = await runFFmpegSilence(
			filePath,
			bestProfile.db,
			bestProfile.minDur,
		);
		return buildSongsArray(finalSilences);
	}

	// ====================================================================
	// PATH B: SMART AUTO MODE (No track count provided)
	// ====================================================================
	logger.info(
		`\n[Job ${jobId}] 🤖 SMART AUTO MODE: Clustering silence data...`,
	);
	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		"Analyzing silence distribution patterns...",
	);

	const silences = await runFFmpegSilence(filePath, -40, 0.8);

	if (silences.length === 0) {
		// Fallback: If -40dB found nothing, the audio is very loud. Try -30dB.
		const fallbackSilences = await runFFmpegSilence(filePath, -30, 0.8);
		if (fallbackSilences.length === 0)
			throw new Error("Could not detect any silences.");
		silences.push(...fallbackSilences);
	}

	// 🧠 THE OUTLIER FILTER: Strip intro/outro before clustering
	let gapsForMath = silences;
	if (silences.length >= 3) {
		gapsForMath = silences.filter((s, index) => {
			// Ignore the very first silence if it starts in the first 5 seconds (Intro)
			if (index === 0 && s.start < 5) return false;
			// Ignore the very last silence in the array (Outro card)
			if (index === silences.length - 1) return false;
			return true;
		});
	}
	if (gapsForMath.length === 0)
		// Fallback just in case the filter removed everything
		gapsForMath = silences;

	// 2. Extract durations from the FILTERED list and sort them
	const durations = gapsForMath.map((s) => s.duration).sort((a, b) => a - b);

	let maxJump = 0;
	let splitIndex = -1;

	// 3. Find the biggest "jump" in duration (e.g., jumping from 0.8s to 2.1s)
	for (let i = 0; i < durations.length - 1; i++) {
		const jump = durations[i + 1] - durations[i];

		// A jump of 0.4 seconds is our mathematical threshold for a "distinct cluster"
		if (jump > maxJump && jump >= 0.4) {
			maxJump = jump;
			splitIndex = i;
		}
	}

	let cutoffThreshold = 0.8; // Default safe threshold

	if (splitIndex !== -1) {
		// We found two distinct clusters!
		// Set the cutoff mathematically between the short pauses and the real transitions.
		cutoffThreshold = durations[splitIndex] + maxJump / 2;

		logger.info(
			`   🧠 Smart Analysis: Differentiated intra-song pauses vs. actual transitions.`,
		);
		logger.info(
			`   ✂️ Ignoring all silences shorter than ${cutoffThreshold.toFixed(2)}s`,
		);
	} else {
		logger.info(
			`   🧠 Smart Analysis: Silence gaps are uniform. Using baseline.`,
		);
	}

	// 4. Filter out the false positives!
	const validSilences = silences.filter((s) => s.duration >= cutoffThreshold);

	const songs = buildSongsArray(validSilences);
	logger.success(`   🎯 Smart Auto-Detection yielded ${songs.length} tracks.`);

	return songs;
}

// Helper function to keep things DRY
function buildSongsArray(silences) {
	const songs = [];
	let currentStart = 0;

	for (let i = 0; i < silences.length; i++) {
		const songEnd = silences[i].start;
		// 5 second glitch filter
		if (songEnd - currentStart > 5) {
			songs.push({ start: currentStart, end: songEnd });
		}
		currentStart = silences[i].end;
	}
	songs.push({ start: currentStart, end: null });

	return songs;
}

function runFFmpegSilence(filePath, noiseDb, minDuration) {
	const args = [
		"-i",
		filePath,
		"-af",
		`silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
		"-f",
		"null",
		"-",
	];

	return run(config.ffmpegPath, args)
		.then(({ stderr }) => {
			const silenceStarts = [
				...stderr.matchAll(/silence_start: ([\d.]+)/g),
			].map((m) => parseFloat(m[1]));
			const silenceEnds = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(
				(m) => parseFloat(m[1]),
			);

			const silences = [];

			for (
				let i = 0;
				i < Math.min(silenceStarts.length, silenceEnds.length);
				i++
			) {
				silences.push({
					start: silenceStarts[i],
					end: silenceEnds[i],
					duration: silenceEnds[i] - silenceStarts[i],
				});
			}
			return silences;
		})
		.catch((err) => {
			throw new Error(
				`FFmpeg silence detection failed at ${noiseDb}dB: ${err.message}`,
			);
		});
}

async function sliceAndTagAudio(
	filePath,
	timestamps,
	outputDir,
	artist,
	album,
	clientId,
	jobId,
) {
	const totalTracks = timestamps.length;

	for (let i = 0; i < totalTracks; i++) {
		await broadcastStatus(
			clientId,
			jobId,
			"processing",
			`Slicing and tagging track ${i + 1} of ${totalTracks}...`,
		);

		const track = timestamps[i];
		const trackNumber = String(i + 1).padStart(2, "0");

		const snippetPath = path.join(outputDir, `temp_snippet_${trackNumber}.mp3`);
		const snippetStart = track.start + 5;

		// ARGV ARRAY - no shell. Every value is passed through verbatim.
		await run(config.ffmpegPath, [
			"-i",
			filePath,
			"-ss",
			String(snippetStart),
			"-t",
			"15",
			"-c",
			"copy",
			snippetPath,
			"-y",
		]);

		const songData = await recognizeSong(snippetPath);

		let songTitle = `Unknown Track ${trackNumber}`;
		let safeArtist = artist;
		let safeAlbum = album;

		if (songData) {
			songTitle = songData.title || songTitle;
			safeArtist = songData.artist || safeArtist;
			safeAlbum = songData.album || safeAlbum;
			await broadcastStatus(
				clientId,
				jobId,
				"processing",
				`🎯 Match Found: "${songTitle}" by ${safeArtist}`,
			);
		} else {
			await broadcastStatus(
				clientId,
				jobId,
				"processing",
				`🤷‍♂️ No match for track ${trackNumber}`,
			);
		}

		// The filename is sanitised for the FILESYSTEM. The metadata values
		// below are passed as separate argv entries, so they need no shell
		// escaping at all.
		const safeFileName = sanitizeFileName(songTitle, `Unknown Track ${trackNumber}`);
		const trackOutputPath = path.join(
			outputDir,
			`${trackNumber} - ${safeFileName}.mp3`,
		);

		const args = ["-i", filePath, "-ss", String(track.start)];
		if (track.end !== null) args.push("-to", String(track.end));
		args.push(
			"-c",
			"copy",
			"-id3v2_version",
			"3",
			"-metadata",
			`title=${songTitle}`,
			"-metadata",
			`artist=${safeArtist}`,
			"-metadata",
			`album=${safeAlbum}`,
			"-metadata",
			`track=${i + 1}/${totalTracks}`,
			trackOutputPath,
			"-y",
		);

		try {
			await run(config.ffmpegPath, args);
		} catch (err) {
			logger.error(`Failed to cut Track ${trackNumber}: ${err.message}`);
		}
	}
}

async function recognizeSong(filePath) {
	const formData = new FormData();
	formData.append("api_token", config.auddToken);
	formData.append("file", Bun.file(filePath));

	try {
		const response = await fetch("https://api.audd.io/", {
			method: "POST",
			body: formData,
		});
		const data = await response.json();
		if (data.status === "success" && data.result) return data.result;
		if (data.status === "error") {
			logger.error(
				`AudD rejected the request: ${data.error?.error_message || "unknown error"}`,
			);
		}
		return null;
	} catch (err) {
		logger.error(`Error in recognizeSong: ${err.message}`);
		return null;
	} finally {
		await rm(filePath, { force: true }).catch(() => {});
	}
}

async function processAudioPipeline(videoUrl, jobId, clientId, expectedTracks) {
	const audioOutputDir = path.join(OUTPUT_DIR, `job_${jobId}`);
	await mkdir(audioOutputDir, { recursive: true });
	const audioPath = path.join(audioOutputDir, "source.mp3");

	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		"Downloading metadata and video from YouTube",
	);
	const info = await youtubedl(videoUrl, {
		dumpSingleJson: true,
		noWarnings: true,
	});

	// yt-dlp needs ffmpeg to mux the extracted audio. Point it at the same
	// ffmpeg the worker uses; in a container that is the one on PATH.
	const ffmpegLocation = path.dirname(config.ffmpegPath);

	await youtubedl(videoUrl, {
		extractAudio: true,
		audioFormat: "mp3",
		output: audioPath,
		ffmpegLocation,
	});

	const audioArtist = info?.uploader || "Unknown Artist";
	const audioAlbum = info?.title || "Unknown Album";
	await broadcastStatus(clientId, jobId, "processing", "Done downloading!");

	let audioTimestamps = [];

	if (info.chapters && info.chapters.length > 0) {
		await broadcastStatus(
			clientId,
			jobId,
			"processing",
			`Found ${info.chapters.length} official chapters!`,
		);
		audioTimestamps = info.chapters.map((ch) => ({
			start: ch.start_time,
			end: ch.end_time,
			title: ch.title,
		}));
	} else {
		await broadcastStatus(
			clientId,
			jobId,
			"processing",
			"No chapters found. Analyzing silences.",
		);
		audioTimestamps = await profileAndDetectSilences(
			audioPath,
			clientId,
			jobId,
			expectedTracks,
		);
	}

	await sliceAndTagAudio(
		audioPath,
		audioTimestamps,
		audioOutputDir,
		audioArtist,
		audioAlbum,
		clientId,
		jobId,
	);

	await broadcastStatus(clientId, jobId, "processing", "Zipping everything up");

	await rm(audioPath).catch(() => {});
	const zipName = `job_${jobId}_playlist.zip`;
	const zipPath = path.join(OUTPUT_DIR, zipName);
	await new Promise((resolve, reject) => {
		const output = fs.createWriteStream(zipPath);
		const archive = archiver("zip", { zlib: { level: 9 } });

		output.on("close", resolve);
		archive.on("error", reject);

		archive.pipe(output);
		archive.directory(audioOutputDir, false);
		archive.finalize();
	});
	await rm(audioOutputDir, { recursive: true, force: true }).catch(() => {});

	// Return the NAME, not the path.
	return zipName;
}

/**
 * Remove the artefacts of jobs that can never complete, and prune old
 * results.
 *
 * The logic lives in sweep.js so it can be tested against a real database
 * without booting the worker. See that module for why the old
 * "delete everything that is not completed" rule was dangerous.
 */
async function sweeper() {
	if (sweepInFlight) return;
	sweepInFlight = true;

	try {
		logger.info("🧹 Sweeper: checking for dead jobs and expired results");
		await sweepJobs(db, {
			outputDir: OUTPUT_DIR,
			stuckJobMs: config.stuckJobMs,
			retentionMs: config.retentionMs,
			logger,
		});
	} catch (e) {
		logger.error(`Sweeper error: ${e?.message || e}`);
	} finally {
		sweepInFlight = false;
	}
}

function claimNextJob() {
	const job = db
		.query(`
      UPDATE jobs
      SET status = 'processing', updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `)
		.get();

	return job;
}

async function startWorker() {
	await mkdir(OUTPUT_DIR, { recursive: true });

	setInterval(() => {
		sweeper().catch((e) => logger.error(`Sweeper error: ${e?.message || e}`));
	}, config.sweepIntervalMs);

	await sweeper();

	logger.info("Worker daemon started. Listening for jobs");

	while (!shuttingDown) {
		let job;

		try {
			job = claimNextJob();
		} catch (e) {
			logger.error(`Database polling error: ${e?.message || e}`);
			await delay(5000);
			continue;
		}

		if (!job) {
			await delay(config.pollIntervalMs);
			continue;
		}

		logger.info(`Picked up Job #${job.id}`);

		try {
			await broadcastStatus(
				job.client_id,
				job.id,
				"processing",
				"Starting up pipeline",
			);

			const zipName = await processAudioPipeline(
				job.video_url,
				job.id,
				job.client_id,
				job.expected_tracks,
			);

			await broadcastStatus(
				job.client_id,
				job.id,
				"completed",
				"All done!",
				zipName,
			);

			logger.success(`Job #${job.id} completed!`);
		} catch (err) {
			const msg = err?.message || String(err);
			db.query(
				`UPDATE jobs SET status = 'failed', error_msg = ? WHERE id = ?`,
			).run(msg, job.id);
			await broadcastStatus(job.client_id, job.id, "failed", `Error: ${msg}`);
			logger.error(`Job #${job.id} failed: ${msg}`);
		}
	}

	logger.warn("Worker stopped.");
}

startWorker();
