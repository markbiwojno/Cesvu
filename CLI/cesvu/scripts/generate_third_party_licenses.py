#!/usr/bin/env python3
"""Repo-local wrapper for ``cesvu.licenses.main``.

Usage from the ``CLI/cesvu/`` directory (or with that as CWD)::

    python scripts/generate_third_party_licenses.py            # regenerate
    python scripts/generate_third_party_licenses.py --check   # CI freshness gate

Or after ``pip install -e .``::

    cesvu-licenses                       # same thing
    cesvu-licenses --check

The full engine lives in ``src/cesvu/licenses.py``. This wrapper exists so
the generator can be invoked from a fresh git clone (no install required) and
so its flags print the same help text regardless of where it was invoked.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the cesvu package importable when invoked from a fresh checkout without
# an editable install. scripts/ is one level below the package root.
HERE = Path(__file__).resolve().parent
PACKAGE_SRC = HERE.parent / "src"
if PACKAGE_SRC.is_dir():
    sys.path.insert(0, str(PACKAGE_SRC))

from cesvu.licenses import main  # noqa: E402  (import after sys.path tweak)

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
