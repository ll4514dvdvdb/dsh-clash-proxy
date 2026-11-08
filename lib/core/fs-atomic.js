// Crash-safe file replacement: write a sibling temp file, fsync it, then rename.
//
// `rename` is atomic on both POSIX and NTFS, so a reader either sees the old
// file or the complete new one — never a half-written subscription or settings
// document. Losing power between the rename and a directory fsync can still
// lose the entry (Windows has no directory fsync through Node), but the content
// itself is never torn.
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteFile(path, data, options = {}) {
	const { mode = 0o600 } = options;
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`;
	const handle = await open(temporary, "w", mode);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	return path;
}
