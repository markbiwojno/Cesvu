"""atomic_io.py — "write-and-rename" atomic file output for cesvu CLI.

See CLI/write and rename strategy.txt for the rationale. Summary: write to
a temp file in the SAME directory as the final destination, fsync, then
os.replace() (atomic on the same filesystem) so a killed process never
leaves a corrupted-but-plausible-looking output file behind.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import sys
import tempfile

from pathlib import Path
from typing import Callable, Iterator


class InsufficientDiskSpaceError(Exception):
    def __init__(self, required: int, available: int, path: Path) -> None:
        super().__init__(
            f"Not enough free disk space at {path.parent}: need ~{required:,} bytes, "
            f"only {available:,} available."
        )
        self.required = required
        self.available = available
        self.path = path


def check_disk_space(destination: Path, required_bytes: int, safety_margin: float = 1.05) -> None:
    """Raise InsufficientDiskSpaceError if the destination's filesystem
    doesn't have roughly `required_bytes * safety_margin` free.

    `required_bytes` should be an estimate of the final output size (e.g.
    input file size for encrypt, since ciphertext is input + a small fixed
    per-chunk MAC overhead + header — always in the same ballpark).
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(destination.parent)
    needed = int(required_bytes * safety_margin)
    if usage.free < needed:
        raise InsufficientDiskSpaceError(needed, usage.free, destination)


@contextlib.contextmanager
def atomic_writer(destination: Path) -> Iterator[Callable[[bytes], None]]:
    """Stream output into a destination-local temporary file.

    On normal completion, flush and fsync the temporary file, close it, and
    replace `destination` with it.

    If an error occurs before replacement is attempted, cleanup is
    best-effort and the destination is not modified by this function.

    If os.replace() reports an error, the final destination state may be
    ambiguous. Replacement is never retried, and the destination is never
    deleted or otherwise modified as part of recovery.

    This function assumes the destination hierarchy is not writable by
    hostile processes. It does not defend against concurrent directory-entry
    substitution.
    """
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path_str = tempfile.mkstemp(
        dir=str(destination.parent),
        prefix=".cesvu-",
        suffix=".tmp",
    )
    tmp_path = Path(tmp_path_str)
    f = os.fdopen(fd, "wb")

    def write(chunk: bytes) -> None:
        f.write(chunk)

    replace_attempted = False

    try:
        yield write

        f.flush()
        os.fsync(f.fileno())
        f.close()

        replace_attempted = True
        os.replace(tmp_path, destination)

    except BaseException:
        # Preserve the active exception as the primary failure.
        try:
            f.close()
        except Exception:
            pass

        temp_was_absent = False
        cleanup_error: OSError | None = None

        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            temp_was_absent = True
        except OSError as exc:
            cleanup_error = exc

        # Use your established terminal-safe formatter here.
        safe_tmp = escape_for_display(str(tmp_path))
        safe_destination = escape_for_display(str(destination))

        if cleanup_error is not None:
            try:
                print(
                    "cesvu: warning: could not remove temporary file "
                    f'"{safe_tmp}": {cleanup_error}. It may contain sensitive '
                    "unencrypted data; delete it manually.",
                    file=sys.stderr,
                )
            except Exception:
                pass

        elif replace_attempted and temp_was_absent:
            try:
                print(
                    "cesvu: warning: the replacement operation failed, but "
                    "the temporary entry is no longer present. The destination "
                    f'state may be ambiguous; verify "{safe_destination}" '
                    "before retrying. No replacement was retried.",
                    file=sys.stderr,
                )
            except Exception:
                pass

        raise
