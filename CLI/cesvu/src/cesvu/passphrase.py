"""passphrase.py — generate diceware / emoji passphrases for `cesvu encrypt`.

Uses a CSPRNG (os.urandom via the stdlib `secrets` module) with rejection
sampling so every word/emoji is chosen with exactly uniform probability
(no modulo bias), matching the security properties expected of the
generated share-passphrase flows in the web app.
"""

from __future__ import annotations

import functools
import json
import secrets
from importlib import resources
from typing import List

DICEWARE_WORD_COUNT = 6
EMOJI_COUNT = 8


@functools.lru_cache(maxsize=None)
def _load_wordlist(filename: str) -> List[str]:
    data = resources.files("cesvu").joinpath("wordlists", filename).read_text(encoding="utf-8")

    words = json.loads(data)
    if not isinstance(words, list) or not all(isinstance(w, str) for w in words):
        raise ValueError(f"{filename}: expected a JSON array of strings")
    return words


def eff_wordlist() -> List[str]:
    return _load_wordlist("eff_wordlist.json")


def emoji_wordlist() -> List[str]:
    return _load_wordlist("emoji_wordlist.json")


def _choice(seq: List[str]) -> str:
    # secrets.choice already does unbiased rejection sampling internally.
    return secrets.choice(seq)


def generate_diceware_passphrase(word_count: int = DICEWARE_WORD_COUNT) -> str:
    words = eff_wordlist()
    return " ".join(_choice(words) for _ in range(word_count))


def generate_emoji_passphrase(count: int = EMOJI_COUNT) -> str:
    emojis = emoji_wordlist()
    return "".join(_choice(emojis) for _ in range(count))
