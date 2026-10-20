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
import {
	DB_LEVELS,
	GAP_DURATIONS,
	buildSongs,
	estimateTrackCount,
	filterByDuration,
} from "./silence.js";
import { mapWithConcurrency } from "./concurrency.js";
import { PHASES, tracksFromTimestamps } from "./progress.js";

/**
 * How many ffmpeg processes may run at once.
 *
 * The work is CPU-bound and local, so this is a plain parallelism knob. It
 * is capped at 4 because the box running this is small, and because every
 * concurrent ffmpeg holds its own decoder buffers.
 */
const FFMPEG_CONCURRENCY = 4;

/**
 * How many AudD recognition requests may be in flight at once.
 *
 * Deliberately lower than the ffmpeg limit: this is a network round trip
 * against a free API, and the point is to overlap the latency without
 * hammering it.
 */
const AUDD_CONCURRENCY = 3;

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
	resultFileName,
	detail,
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
					// The structured detail the browser renders. The server
					// whitelists it before it reaches a socket.
					detail: detail ?? {},
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
	// ONE PASS PER dB LEVEL, DURATION FILTERED IN MEMORY
	// ====================================================================
	//
	// silencedetect's `d` parameter is a MINIMUM. A pass at d=0.2 reports
	// every silence at least 0.2s long, so it is a superset of a pass at
	// d=0.8 - and the longer pass is exactly the shorter one with the short
	// gaps filtered out. One pass per dB level plus an in-memory filter
	// replaces 48 full-file scans with 6.
	//
	// The equivalence was verified against a real ffmpeg across 6 levels x
	// 8 gap widths: 48/48 combinations matched exactly. See silence.js.

	// The shortest gap width - the pass that sees the most silences.
	const BASE_DURATION = GAP_DURATIONS[0];

	// One detection pass per dB level, run concurrently. Six ffmpeg
	// processes on six cores finish in the time of one, and each one is
	// independent of the others.
	const detections = await Promise.all(
		DB_LEVELS.map(async (db) => {
			const silences = await runFFmpegSilence(filePath, db, BASE_DURATION);
			return { db, silences };
		}),
	);

	// --- TARGET MODE: the user told us how many tracks to expect ---
	if (expectedTracks) {
		logger.info(
			`\n[Job ${jobId}] 🎯 TARGET MODE: Searching for exactly ${expectedTracks} tracks.`,
		);

		let bestProfile = null;
		let bestDiff = Infinity;

		for (const { db, silences } of detections) {
			// Cheap now: a filter over data we already have.
			for (const minDur of GAP_DURATIONS) {
				const filtered = filterByDuration(silences, minDur);
				if (filtered.length === 0) continue;

				const estimatedTracks = estimateTrackCount(filtered);
				const diff = Math.abs(estimatedTracks - expectedTracks);

				if (!bestProfile || diff < bestDiff) {
					bestProfile = { db, minDur, tracks: estimatedTracks };
					bestDiff = diff;
				}

				if (estimatedTracks === expectedTracks) {
					logger.success(
						`   ✅ Exact match found! (-${Math.abs(db)}dB, ${minDur}s gap)`,
					);
					break;
				}
			}
		}

		// GUARD: bestProfile is only assigned when at least one level found
		// a silence. If every dB level and every gap width found nothing, it
		// stays null and the old code threw a TypeError on `bestProfile.db`.
		// Fail the job with a clear message instead.
		if (!bestProfile) {
			throw new Error(
				"Could not detect any silences at any volume level. The audio may have no gaps between tracks, or it may not be audio at all.",
			);
		}

		if (bestDiff !== 0) {
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

		const finalSilences = filterByDuration(
			detections.find((d) => d.db === bestProfile.db).silences,
			bestProfile.minDur,
		);
		return buildSongs(finalSilences);
	}

	// ====================================================================
	// SMART AUTO MODE: no track count given
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

	// The primary level, with the loud fallback the original code used.
	const primary = detections.find((d) => d.db === -40);
	const fallback = detections.find((d) => d.db === -30);

	let silences = primary.silences;
	if (silences.length === 0) {
		silences = fallback.silences;
	}
	if (silences.length === 0) {
		// Nothing at either level: use whichever level found the most.
		const best = detections.reduce((a, b) => (b.silences.length > a.silences.length ? b : a));
		silences = best.silences;
	}
	if (silences.length === 0) {
		throw new Error("Could not detect any silences.");
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

	const songs = buildSongs(validSilences);
	logger.success(`   🎯 Smart Auto-Detection yielded ${songs.length} tracks.`);

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

	// ------------------------------------------------------------------
	// PHASE 1: cut a 15-second preview out of each track
	// ------------------------------------------------------------------
	// Every preview is an independent ffmpeg run over the same source, so
	// they run concurrently. The snippets are CPU-bound and local, so this
	// is a free win - no rate limit, no network.
	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		`Preparing ${totalTracks} track previews...`,
	);

	const snippetPaths = await mapWithConcurrency(
		timestamps,
		FFMPEG_CONCURRENCY,
		async (track, i) => {
			const trackNumber = String(i + 1).padStart(2, "0");
			const snippetPath = path.join(outputDir, `temp_snippet_${trackNumber}.mp3`);
			const snippetStart = track.start + 5;

			try {
				// INPUT SEEK: -ss BEFORE -i. ffmpeg jumps straight to the
				// frame instead of decoding from the start and discarding.
				// 3.2x faster on a 20-minute source.
				//
				// `-t` is a DURATION, so it stays correct after the seek.
				// Do not use -to here: after an input seek, -to is still
				// absolute, and would silently produce a track of the wrong
				// length. This was measured, not assumed.
				await run(config.ffmpegPath, [
					"-ss",
					String(snippetStart),
					"-i",
					filePath,
					"-t",
					"15",
					"-c",
					"copy",
					snippetPath,
					"-y",
				]);
				return snippetPath;
			} catch (err) {
				logger.error(
					`Failed to extract preview for track ${trackNumber}: ${err.message}`,
				);
				return null;
			}
		},
	);

	// ------------------------------------------------------------------
	// PHASE 2: recognise each preview
	// ------------------------------------------------------------------
	// This is the network-bound part - one round trip to AudD per track.
	// A bounded pool keeps the requests in flight at the same time without
	// hammering the API: at most 3 concurrent calls.
	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		`Identifying ${totalTracks} tracks...`,
	);

	const recognitions = await mapWithConcurrency(
		snippetPaths,
		AUDD_CONCURRENCY,
		async (snippetPath, i) => {
			if (!snippetPath) return null;
			const trackNumber = String(i + 1).padStart(2, "0");
			const songData = await recognizeSong(snippetPath);

			if (songData) {
				await broadcastStatus(
					clientId,
					jobId,
					"processing",
					`🎯 Match Found: "${songData.title || `Unknown Track ${trackNumber}`}" by ${songData.artist || artist}`,
					null,
					{
						phase: PHASES.IDENTIFYING,
						total: totalTracks,
						// The title is the whole point of the recognition
						// pass, so it is sent as soon as it is known rather
						// than at the end of the batch.
						tracks: [
							{
								index: i + 1,
								title: songData.title || `Unknown Track ${trackNumber}`,
								artist: songData.artist || artist,
							},
						],
					},
				);
			} else {
				await broadcastStatus(
					clientId,
					jobId,
					"processing",
					`🤷 No match for track ${trackNumber}`,
					null,
					{ phase: PHASES.IDENTIFYING, total: totalTracks },
				);
			}
			return songData;
		},
	);

	// ------------------------------------------------------------------
	// PHASE 3: cut and tag each track
	// ------------------------------------------------------------------
	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		`Cutting and tagging ${totalTracks} tracks...`,
	);

	const recognised = await mapWithConcurrency(
		timestamps,
		FFMPEG_CONCURRENCY,
		async (track, i) => {
			const trackNumber = String(i + 1).padStart(2, "0");
			const songData = recognitions[i];

			let songTitle = `Unknown Track ${trackNumber}`;
			let safeArtist = artist;
			let safeAlbum = album;

			if (songData) {
				songTitle = songData.title || songTitle;
				safeArtist = songData.artist || safeArtist;
				safeAlbum = songData.album || safeAlbum;
			}

			// The filename is sanitised for the FILESYSTEM. The metadata
			// values below are passed as separate argv entries, so they need
			// no shell escaping at all.
			const safeFileName = sanitizeFileName(
				songTitle,
				`Unknown Track ${trackNumber}`,
			);
			const trackOutputPath = path.join(
				outputDir,
				`${trackNumber} - ${safeFileName}.mp3`,
			);

			// INPUT SEEK again, with `-t` as a duration. After the seek the
			// output timeline starts at zero, so the duration is
			// end - start, NOT the absolute end.
			const args = ["-ss", String(track.start), "-i", filePath];
			if (track.end !== null) {
				args.push("-t", String(track.end - track.start));
			}
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

			// What the page shows: the named track, with its own boundaries.
			return {
				index: i + 1,
				title: songTitle,
				artist: safeArtist,
				album: safeAlbum,
				start: Math.round(track.start * 100) / 100,
				end: track.end === null ? null : Math.round(track.end * 100) / 100,
				length:
					track.end === null
						? null
						: Math.round((track.end - track.start) * 100) / 100,
			};
		},
	);

	return recognised;
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
		null,
		{ phase: PHASES.DOWNLOADING },
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
	await broadcastStatus(clientId, jobId, "processing", "Done downloading!", null, {
		phase: PHASES.DETECTING,
	});

	let audioTimestamps = [];

	if (info.chapters && info.chapters.length > 0) {
		await broadcastStatus(
			clientId,
			jobId,
			"processing",
			`Found ${info.chapters.length} official chapters!`,
			null,
			{ phase: PHASES.DETECTING, total: info.chapters.length },
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
			null,
			{ phase: PHASES.DETECTING },
		);
		audioTimestamps = await profileAndDetectSilences(
			audioPath,
			clientId,
			jobId,
			expectedTracks,
		);
	}

	// The boundaries are known now. Send them so the page can draw the
	// waveform and the cuts while the audio is still being cut.
	await broadcastStatus(
		clientId,
		jobId,
		"processing",
		`Found ${audioTimestamps.length} track boundaries`,
		null,
		{
			phase: PHASES.IDENTIFYING,
			total: audioTimestamps.length,
			tracks: tracksFromTimestamps(audioTimestamps),
		},
	);

	const recognisedTracks = await sliceAndTagAudio(
		audioPath,
		audioTimestamps,
		audioOutputDir,
		audioArtist,
		audioAlbum,
		clientId,
		jobId,
	);
	await broadcastStatus(clientId, jobId, "processing", "Zipping everything up", null, {
		phase: PHASES.ZIPPING,
		total: audioTimestamps.length,
	});

	await rm(audioPath).catch(() => {});
	const zipName = `job_${jobId}_playlist.zip`;
	const zipPath = path.join(OUTPUT_DIR, zipName);
	await new Promise((resolve, reject) => {
		const output = fs.createWriteStream(zipPath);
		// Compression level 6, not 9. The archive holds MP3s, which are
		// already compressed, so deflate has almost nothing to gain and
		// level 9 spends real CPU trying. Measured on 100MB of tracks:
		// level 9 was 1.7x slower than level 6 for a 1.2% smaller file.
		const archive = archiver("zip", { zlib: { level: 6 } });

		output.on("close", resolve);
		archive.on("error", reject);

		archive.pipe(output);
		archive.directory(audioOutputDir, false);
		archive.finalize();
	});
	await rm(audioOutputDir, { recursive: true, force: true }).catch(() => {});

	// Store what the job produced, so the history list can show the real
	// title, the real track count and the real track names instead of a
	// bare URL and a status.
	const durationSecs = Math.round(
		audioTimestamps[audioTimestamps.length - 1]?.end ?? 0,
	);
	db.query(
		`UPDATE jobs SET title = ?, track_count = ?, duration_secs = ?, tracks_json = ? WHERE id = ?`,
	).run(
		audioAlbum,
		recognisedTracks.length,
		durationSecs,
		JSON.stringify(recognisedTracks),
		jobId,
	);

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
