#!/bin/sh
# Container entrypoint.
#
# The app runs as uid 1000 so it can write to a bind-mounted data directory
# that the host user owns. Docker creates a missing bind-mount source as
# root, though, and a root-owned ./data with the app running as uid 1000
# gives "SQLiteError: unable to open database file" (SQLITE_CANTOPEN) and a
# restart loop that looks like a code bug.
#
# So: fix the ownership of the writable paths as root, then drop privileges
# for the actual work. The app never runs as root.
set -e

DATA_DIR="${DATA_DIR:-/data}"
OUTPUT_DIR="${OUTPUT_DIR:-$DATA_DIR/blackhole}"

# Only touch paths that actually exist in this container.
for dir in "$DATA_DIR" "$OUTPUT_DIR"; do
	if [ -d "$dir" ]; then
		chown -R bun:bun "$dir" 2>/dev/null || true
	fi
done

# Hand over to the app user.
exec su-exec bun "$@"
