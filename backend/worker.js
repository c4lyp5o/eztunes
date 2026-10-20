import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import archiver from "archiver";
import youtubedl from "youtube-dl-exec";

import logger from "./logger.js";
import db from "./db.js";

const execPromise = promisify(exec);

const BASE_OUTPUT_DIR = process.env.OUTPUT_DIR
	? path.resolve(process.env.OUTPUT_DIR)
	: path.join(process.cwd(), "blackhole");

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

const AUDD_API_TOKEN =
	process.env.AUDD_API_TOKEN;

const BROADCAST_URL =
	process.env.BROADCAST_URL || "http://localhost:5000/api/internal/broadcast";

// Worker tuning
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const SWEEP_INTERVAL_MS = Number(
	process.env.SWEEP_INTERVAL_MS || 12 * 60 * 60 * 1000,
);

const ffmpegPath = path.join(process.cwd(), "bin", "ffmpeg.exe");
const baseOutputDir = path.join(process.cwd(), "blackhole");

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

async function broadcastStatus(
	clientId,
	jobId,
	status,
	progressMsg,
	downloadUrl = null,
) {
	try {
		logger.info(`[Job ${jobId}] ${progressMsg}`);
		if (status === "completed" && downloadUrl) {
			db.query(`UPDATE jobs SET status = ?, result_file = ? WHERE id = ?`).run(
				status,
				downloadUrl,
				jobId,
			);
		} else {
			db.query(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, jobId);
		}

		await fetch(BROADCAST_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
		logger.error("Failed to broadcast status: ", e.message || e);
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
		`Analyzing silence distribution patterns...`,
	);

	const silences = await runFFmpegSilence(filePath, -40, 0.8);
	console.log("silences", silences);

	if (silences.length === 0) {
		// Fallback: If -40dB found nothing, the audio is very loud. Try -30dB.
		const fallbackSilences = await runFFmpegSilence(filePath, -30, 0.8);
		console.log("fallbackSilences", fallbackSilences);
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
	return new Promise((resolve, reject) => {
		const args = [
			"-i",
			filePath,
			"-af",
			`silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
			"-f",
			"null",
			"-",
		];
		const ffmpeg = spawn(ffmpegPath, args);
		let output = "";

		ffmpeg.stderr.on("data", (data) => (output += data.toString()));

		ffmpeg.on("close", (code) => {
			if (code !== 0)
				return reject(
					new Error(`FFmpeg silence detection failed at ${noiseDb}dB`),
				);

			const silenceStarts = [
				...output.matchAll(/silence_start: ([\d.]+)/g),
			].map((m) => parseFloat(m[1]));
			const silenceEnds = [...output.matchAll(/silence_end: ([\d.]+)/g)].map(
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
			resolve(silences);
		});

		ffmpeg.on("error", (err) => reject(err));
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
		const snippetCmd = `"${ffmpegPath}" -i "${filePath}" -ss ${snippetStart} -t 15 -c copy "${snippetPath}" -y`;
		await execPromise(snippetCmd);

		const songData = await recognizeSong(snippetPath);

		let songTitle = `Unknown Track ${trackNumber}`;
		let safeArtist = artist;
		let safeAlbum = album;

		if (songData) {
			songTitle = songData.title || songTitle;
			safeArtist = (songData.artist || safeArtist).replace(/"/g, "'");
			safeAlbum = (songData.album || safeAlbum).replace(/"/g, "'");
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

		const safeTitle = songTitle.replace(/"/g, "'");
		const safeFileName = songTitle.replace(/[/\\?%*:|"<>]/g, "-");
		const trackOutputPath = path.join(
			outputDir,
			`${trackNumber} - ${safeFileName}.mp3`,
		);

		let cmd = `"${ffmpegPath}" -i "${filePath}" -ss ${track.start}`;
		if (track.end !== null) cmd += ` -to ${track.end}`;
		cmd += ` -c copy -id3v2_version 3 -metadata title="${safeTitle}" -metadata artist="${safeArtist}" -metadata album="${safeAlbum}" -metadata track="${i + 1}/${totalTracks}" "${trackOutputPath}" -y`;

		try {
			await execPromise(cmd);
		} catch (err) {
			logger.error(`Failed to cut Track ${trackNumber}: `, err);
		}
	}
}

async function recognizeSong(filePath) {
	const formData = new FormData();
	formData.append("api_token", AUDD_API_TOKEN);
	formData.append("file", Bun.file(filePath));

	try {
		const response = await fetch("https://api.audd.io/", {
			method: "POST",
			body: formData,
		});
		const data = await response.json();
		if (data.status === "success" && data.result) return data.result;
		return null;
	} catch (err) {
		logger.error("Error in recognizeSong:", err);
		return null;
	} finally {
		await rm(filePath, { force: true }).catch(() => {});
	}
}

async function processAudioPipeline(videoUrl, jobId, clientId, expectedTracks) {
	const audioOutputDir = path.join(BASE_OUTPUT_DIR, `job_${jobId}`);
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

	await youtubedl(videoUrl, {
		extractAudio: true,
		audioFormat: "mp3",
		output: audioPath,
		ffmpegLocation: path.join(process.cwd(), "bin"),
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
	const zipPath = path.join(BASE_OUTPUT_DIR, `job_${jobId}_playlist.zip`);
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

	return zipPath;
}

async function sweeper() {
	if (sweepInFlight) return;
	sweepInFlight = true;

	try {
		logger.info("🧹 Sweeper: Checking for non-success jobs from previous runs");

		const stuckJobs = db
			.query(`SELECT id, result_file FROM jobs WHERE status != 'completed'`)
			.all();

		if (stuckJobs.length === 0) {
			logger.info("✨ Sweeper: No stuck jobs found.");
			return;
		}

		for (const job of stuckJobs) {
			const jobDir = path.join(BASE_OUTPUT_DIR, `job_${job.id}`);
			await rm(jobDir, { recursive: true, force: true }).catch(() => {});

			const zipPath = path.join(BASE_OUTPUT_DIR, `job_${job.id}_playlist.zip`);
			await rm(zipPath, { force: true }).catch(() => {});

			if (job.result_file) {
				await rm(job.result_file, { force: true }).catch(() => {});
			}
		}

		db.query(`DELETE FROM jobs WHERE status != 'completed'`).run();
		logger.success(
			`🧹 Sweeper: Removed ${stuckJobs.length} stuck job(s) and cleaned disk.`,
		);

		logger.info("🕰️ Sweeper: Checking for files older than 7 days");

		const oldJobs = db
			.query(`
        SELECT id, result_file 
        FROM jobs 
        WHERE created_at <= datetime('now', '-7 days')
    `)
			.all();

		if (oldJobs.length === 0) return;

		for (const job of oldJobs) {
			if (job.result_file) {
				await rm(job.result_file, { force: true }).catch(() => {});
			}
		}

		db.query(
			`DELETE FROM jobs WHERE created_at <= datetime('now', '-7 days')`,
		).run();
		logger.success(
			`🕰️ Sweeper: Deleted ${oldJobs.length} old job(s) and freed up disk space.`,
		);
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
      SET status = 'processing'
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *
    `)
		.get();

	if (job)
		db.query(`UPDATE jobs SET updated_at = datetime('now') WHERE id = ?`).run(
			job.id,
		);

	return job;
}

async function startWorker() {
	await mkdir(BASE_OUTPUT_DIR, { recursive: true });

	setInterval(() => {
		sweeper().catch((e) => logger.error(`Sweeper error: ${e?.message || e}`));
	}, SWEEP_INTERVAL_MS);

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
			await delay(POLL_INTERVAL_MS);
			continue;
		}

		logger.info(`Picked up Job #${job.id}: ${job.video_url}`);

		try {
			await broadcastStatus(
				job.client_id,
				job.id,
				"processing",
				"Starting up pipeline",
			);

			const zipPath = await processAudioPipeline(
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
				zipPath,
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
