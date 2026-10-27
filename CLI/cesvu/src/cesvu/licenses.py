"""Generate THIRD_PARTY_LICENSES.txt for the cesvu Python package.

Walks every distribution reachable through ``cesvu``'s declared
``Requires-Dist`` graph (direct + transitive closure) and concatenates each
distribution's LICENSE / COPYING / NOTICE files verbatim, separated by
per-distribution headers carrying the project name, version, SPDX license
expression, and homepage.

Usage::

    # write (regenerate)
    python scripts/generate_third_party_licenses.py
    cesvu-licenses                            # same, after `pip install -e .`

    # CI gate (no write)
    python scripts/generate_third_party_licenses.py --check

The output is intentionally self-contained: a downstream user can read one
file and see every license that affects them. The bundle is shipped inside
both the sdist and the wheel (see ``pyproject.toml``'s ``license-files`` +
``package-data``).

This module is the engine; the entry-point ``main()`` is invoked by:

- ``cesvu-licenses`` console script (registered in pyproject.toml)
- ``scripts/generate_third_party_licenses.py`` thin CLI wrapper
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from importlib import metadata as importlib_metadata
from pathlib import Path

# Repo-layout paths. This file lives at:
#   cesvu/CLI/cesvu/src/cesvu/licenses.py
# so:
#   REPO_ROOT = cesvu/CLI/cesvu
#   PACKAGE_ROOT = cesvu/CLI/cesvu/src/cesvu   (cesvu package namespace)
REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = Path(__file__).resolve().parent
BUNDLED_FILE = PACKAGE_ROOT / "licenses" / "THIRD_PARTY_LICENSES.txt"

# Filename hints we treat as license / notice text. Compared case-insensitively
# AND with an optional extension so "LICENSE", "License.md", "license.txt" all
# match.
LICENSE_FILENAMES = (
    "LICENSE",
    "LICENSE.TXT",
    "LICENSE.MD",
    "LICENSE.RST",
    "COPYING",
    "COPYING.TXT",
    "NOTICE",
    "NOTICE.TXT",
)

HEADER_SEP = "=" * 76
BLOCK_SEP = "-" * 76


def _read_text(path: Path) -> str | None:
    """Read a text file, returning None if it cannot be read."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeError):
        return None


def _find_license_files(
    dist: importlib_metadata.Distribution, distinfo_dir: Path
) -> list[Path]:
    """Collect LICENSE / COPYING / NOTICE files for ``dist``.

    Checks both the dist-info directory itself (``<dist-info>/LICENSE``) and
    every directory listed in ``dist.files`` for sibling LICENSE files (e.g.
    cffi ships a vendored pycparser whose LICENSE lives next to the .py).
    """
    candidates: list[Path] = []
    if distinfo_dir.is_dir():
        candidates.extend(distinfo_dir.iterdir())

    try:
        for f in dist.files or ():
            try:
                p = Path(str(f.locate())).resolve().parent
            except (OSError, RuntimeError):
                continue
            candidates.append(p)
    except Exception:
        pass

    seen: set[Path] = set()
    found: list[Path] = []
    for c in candidates:
        if not c.is_dir():
            continue
        for child in c.iterdir():
            try:
                name = child.name.upper()
            except (OSError, AttributeError):
                continue
            if child.is_file() and name in LICENSE_FILENAMES and child not in seen:
                found.append(child)
                seen.add(child)
    return found


def _spdx_license(dist: importlib_metadata.Distribution) -> str:
    """Best-effort SPDX expression for ``dist`` from its METADATA."""
    try:
        raw = (dist.metadata.get("License") or "").strip()
    except Exception:
        raw = ""
    # Some packages stuff the entire license text into License:. Cap it so
    # the bundle header stays readable.
    if len(raw) > 200:
        return "(see license text below)"
    return raw


def _direct_dep_names() -> set[str]:
    """Project names declared in pyproject.toml's [project].dependencies.

    Robust against nested brackets in adjacent sections like
    ``license-files = [...]`` — walks lines from the ``dependencies = [``
    opener to the matching ``]`` rather than trying to span arbitrary
    bracket content with a single regex.
    """
    pyproject = REPO_ROOT / "pyproject.toml"
    if not pyproject.exists():
        return set()
    try:
        text = pyproject.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()

    # Find the line ``dependencies = [`` that lives inside the
    # [project] section, then collect lines until the matching `]`.
    lines = text.splitlines()
    in_project = False
    in_deps = False
    deps_lines: list[str] = []
    depth = 0
    for raw in lines:
        line = raw.split("#", 1)[0]  # strip trailing comments
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_project = stripped == "[project]"
            continue
        if not in_project:
            continue
        if not in_deps:
            # Look for the start marker on this line.
            if "dependencies" in line and "[" in line:
                in_deps = True
                # Capture whatever's on this line after the `[`
                deps_lines.append(line.split("[", 1)[1])
                depth = line.count("[") - line.count("]")
                if depth <= 0:
                    # Single-line: foo = ["a", "b"]
                    in_deps = False
                continue
        else:
            deps_lines.append(line)
            depth += line.count("[") - line.count("]")
            if depth <= 0:
                in_deps = False
                break

    # Now pull every quoted string out of the body, then split on the
    # first PEP 508 specifier / extras separator (`>`, `<`, `=`, `~`, `!`,
    # `;`) to recover just the project name. Handles things like
    # ``"pynacl>=1.5.0"`` and ``"requests[security]~=2.0"``.
    body = "\n".join(deps_lines)
    names: set[str] = set()
    for raw in re.findall(r'"([^"]+)"', body):
        match = re.match(r"[A-Za-z0-9_.\-]+", raw)
        if match:
            names.add(match.group(0).lower())
    return names




def _distinfo_dir(dist: importlib_metadata.Distribution) -> Path | None:
    """Path to this distribution's ``*.dist-info`` directory."""
    path = getattr(dist, "_path", None)
    if path is None:
        try:
            files = dist.files or ()
            for f in files:
                if f.name == "METADATA":
                    return Path(str(f.locate())).resolve().parent
        except Exception:
            return None
    if path is None:
        return None
    try:
        return Path(str(path)).resolve()
    except (OSError, RuntimeError):
        return None


def _filter_relevant(
    all_dists: list[importlib_metadata.Distribution], direct: set[str]
) -> list[importlib_metadata.Distribution]:
    """Restrict to direct deps + their transitive closure.

    Walks ``Requires-Dist`` recursively from each direct dep and keeps every
    package it can reach by name. Excludes unrelated distributions that just
    happen to live in the venv (pytest, coverage, etc.).
    """
    by_name: dict[str, importlib_metadata.Distribution] = {
        (d.metadata.get("Name") or "").strip().lower(): d
        for d in all_dists
        if d.metadata.get("Name")
    }
    reached: set[str] = set()
    stack = list(direct)
    while stack:
        n = stack.pop()
        if n in reached:
            continue
        reached.add(n)
        d = by_name.get(n)
        if d is None:
            continue
        try:
            reqs = d.requires or []
        except Exception:
            reqs = []
        for r in reqs:
            req_str = r or ""
            # Skip optional extras-gated requirements (e.g.
            # "pytest ; extra == 'tests'") — we only want the *unconditional*
            # runtime dependency closure, matching what `pip install
            # <direct-dep>` (no extras) actually pulls in. Without this, a
            # dep's test-only extras (pytest, coverage, etc.) leak into the
            # bundle even though they're never installed as real runtime deps.
            marker = req_str.split(";", 1)[1] if ";" in req_str else ""
            if "extra" in marker:
                continue
            m = re.match(r"^\s*([A-Za-z0-9_.\-]+)", req_str)
            if m:
                stack.append(m.group(1))

    return [by_name[n] for n in sorted(reached) if n in by_name]


def build_bundle(
    dists: list[importlib_metadata.Distribution],
    project_name: str = "cesvu",
    project_copyright: str = "Copyright 2026 Gigperfect LLC",
) -> str:
    """Render the full text of the bundled third-party license file."""
    out: list[str] = []
    out += [
        HEADER_SEP,
        f"  {project_name}",
        f"  {project_copyright}",
        "",
        "  This product includes software developed by third parties. The",
        "  full text of each upstream license is reproduced below verbatim.",
        "  See each project's homepage for source.",
        HEADER_SEP,
        "",
    ]
    missing: list[str] = []
    for dist in dists:
        name = (dist.metadata.get("Name") or "?").strip()
        version = (dist.metadata.get("Version") or "?").strip()
        spdx = _spdx_license(dist)
        homepage = (dist.metadata.get("Home-page") or "").strip()
        try:
            project_url = (dist.metadata.get("Project-URL") or "").strip()
        except Exception:
            project_url = ""

        out += [
            BLOCK_SEP,
            f"  {name} {version}",
            f"  License: {spdx or '(unknown - see file contents below)' }",
        ]
        if homepage:
            out.append(f"  Homepage: {homepage}")
        if project_url:
            # Multi-line "Project-URL: Foo, https://foo.example.com/" lines.
            for line in project_url.splitlines():
                if line.strip():
                    out.append(f"  Project-URL: {line.strip()}")
        out += [BLOCK_SEP, ""]

        distinfo = _distinfo_dir(dist)
        files = _find_license_files(dist, distinfo) if distinfo else []
        if not files:
            out += [
                "  (No LICENSE / COPYING / NOTICE file was found in the installed",
                "  distribution. The License: field above is the SPDX expression",
                "  from the dist's METADATA; full text can be fetched from the",
                "  homepage listed above.)",
                "",
            ]
            missing.append(name)
            continue

        for f in files:
            text = _read_text(f)
            if text is None:
                out.append(f"  [could not read {f.name}]")
                continue
            text = text.rstrip() + "\n"
            out.append(f"  ===== file: {f.name} =====")
            out.append(text)
            out.append("")

    out.append(HEADER_SEP)
    if missing:
        out += [
            "  NOTE: The following distributions had no readable LICENSE-style",
            "  file in their installed wheel. License metadata is shown above;",
            "  full text should be fetched from each project's homepage:",
            "",
        ]
        for n in missing:
            out.append(f"    - {n}")
        out += [HEADER_SEP, ""]

    return "\n".join(out)


def write_bundle(text: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def diff(a: str, b: str) -> bool:
    """True if the two strings are byte-equal."""
    return a == b


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate THIRD_PARTY_LICENSES.txt for the cesvu package."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Don't write. Exit 0 if the bundled file matches what would be "
            "regenerated; non-zero if it is stale or missing. Use in CI."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=BUNDLED_FILE,
        help=f"Where to write (default: {BUNDLED_FILE})",
    )
    args = parser.parse_args(argv)

    direct = _direct_dep_names()
    all_dists = sorted(
        importlib_metadata.distributions(),
        key=lambda d: (d.metadata.get("Name") or "").lower(),
    )

    # Dedup by project name. Editable installs + pip's editable wheel can both
    # leave a `cesvu` Distribution visible to importlib.metadata. Deduping by
    # the first one we see keeps the bundle clean.
    def _dedup(
        dists: list[importlib_metadata.Distribution],
    ) -> list[importlib_metadata.Distribution]:
        seen: dict[str, importlib_metadata.Distribution] = {}
        for d in dists:
            key = (d.metadata.get("Name") or "").strip().lower()
            if not key or key in seen:
                continue
            seen[key] = d
        # Preserve input order minus the dedup.
        return list(seen.values())

    # Always pin cesvu itself at the top so reviewers find OUR license first,
    # but make sure it appears exactly once (the relevant walk might also reach
    # it transitively, e.g. through a metadata quirk in editable installs).
    ours_name = "cesvu"
    ours = [
        d
        for d in all_dists
        if (d.metadata.get("Name") or "").strip().lower() == ours_name
    ]
    relevant = [
        d
        for d in _filter_relevant(all_dists, direct)
        if (d.metadata.get("Name") or "").strip().lower() != ours_name
    ]
    bundle = _dedup(ours + relevant)
    text = build_bundle(bundle)


    if args.check:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write(text)
            tmp_path = Path(tmp.name)
        try:
            existing = (
                args.out.read_text(encoding="utf-8", errors="replace")
                if args.out.exists()
                else ""
            )
            if not diff(tmp_path.read_text(encoding="utf-8"), existing):
                print(
                    f"[stale] {args.out} is out of date vs the current dep tree.",
                    file=sys.stderr,
                )
                print(
                    "        Regenerate with: "
                    "python scripts/generate_third_party_licenses.py",
                    file=sys.stderr,
                )
                return 1
            print(f"[ok] {args.out} is up to date ({len(bundle)} package(s)).")
            return 0
        finally:
            tmp_path.unlink(missing_ok=True)

    write_bundle(text, args.out)
    print(f"[wrote] {args.out} ({len(bundle)} package(s) included).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
