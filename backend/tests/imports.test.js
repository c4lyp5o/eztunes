import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";

const ROOT = path.join(import.meta.dir, "..");

// The worker is never imported by the other tests (it starts its job loop on
// load), so a dependency whose exports change can break it without a single
// failing test. archiver 8 dropped its default export and the worker crashed
// on boot. Bundling resolves every import without running the module.
describe("entry points", () => {
	for (const entry of ["server.js", "worker.js"]) {
		test(`${entry} resolves all of its imports`, async () => {
			const out = await mkdtemp(path.join(tmpdir(), "eztunes-build-"));
			try {
				const result = await Bun.build({
					entrypoints: [path.join(ROOT, entry)],
					target: "bun",
					outdir: out,
					packages: "bundle",
				});
				const messages = result.logs.map((l) => l.message).join("\n");
				expect(messages).toBe("");
				expect(result.success).toBe(true);
			} finally {
				await rm(out, { recursive: true, force: true });
			}
		});
	}
});

describe("zip output", () => {
	test("ZipArchive writes a real zip of a directory", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "eztunes-zip-"));
		try {
			await mkdir(path.join(dir, "album"));
			await writeFile(path.join(dir, "album", "01.mp3"), "not really audio");
			const zipPath = path.join(dir, "out.zip");
			await new Promise((resolve, reject) => {
				const output = createWriteStream(zipPath);
				const archive = new ZipArchive({ zlib: { level: 6 } });
				output.on("close", resolve);
				archive.on("error", reject);
				archive.pipe(output);
				archive.directory(path.join(dir, "album"), false);
				archive.finalize();
			});
			const bytes = await readFile(zipPath);
			expect(bytes.subarray(0, 2).toString()).toBe("PK");
			expect(bytes.includes(Buffer.from("01.mp3"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
