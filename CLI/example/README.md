# cesvu Python library examples

Three minimal, hardcoded encrypt/decrypt script pairs showing how to use
the `cesvu` Python package's modules directly in your own code, instead
of shelling out to the installed `cesvu` CLI command. Each script has no
command-line arguments — edit the constants at the top of the file, then
run it.

```
CLI/example/
  raw/            custom passphrase you choose yourself (passProfile = 3)
  diceware/       generated 6-word Diceware passphrase   (passProfile = 1)
  emoji/          generated 8-emoji passphrase           (passProfile = 2)
```

These subfolders demonstrate the same CFP1 document-framing behavior
(auto-detecting `.txt`/`.md`/`.csv` so the resulting `.cesvu` file opens in
the cesvu.com web app's viewer instead of a plain download) — the only
thing that differs between them is which passphrase profile is used and
where the passphrase comes from.

Relative `PLAINTEXT_PATH`/`ENCRYPTED_PATH` values are resolved against
each script's own directory, not your shell's current working directory —
so you can run `python raw/encrypt_file.py` from anywhere and it will
always look for `sample.txt` right next to `raw/encrypt_file.py`.

## Setup

```
pip install -e ../cesvu
```

(installs the `cesvu` package in editable mode from `CLI/cesvu/`, shared
by all three example pairs)

## `raw/` — custom passphrase (passProfile = 3)

You choose the passphrase yourself and type it directly into both scripts.
This is the profile the Python CLI's `--password` / `--password-file` /
`$CESVU_PASSPHRASE` flags use, and the one the web app's *encrypt* flow
never offers (see `README.md`, "Custom password"). It applies
**zero normalization** — every code point, including leading/trailing
spaces and letter case, is significant, and it is capped at 512 UTF-8
bytes.

```
echo "Hello, cesvu!" > raw/sample.txt
python raw/encrypt_file.py
python raw/decrypt_file.py
cat raw/sample.txt
```

Edit `PASSPHRASE` in both `raw/encrypt_file.py` and `raw/decrypt_file.py`
to the same value before running — it is not generated for you.

**Why `passphrase_type="raw"` matters:** `encrypt_cesvu_stream()` defaults
`passphrase_type` to `None`, which is `passProfile = 1` (Diceware
normalization) — silently collapsing whitespace and lowercasing ASCII in
whatever you pass as `PASSPHRASE`. `raw/encrypt_file.py` passes
`passphrase_type="raw"` explicitly so a custom password round-trips
byte-for-byte instead.

## `diceware/` — generated passphrase (passProfile = 1)

`diceware/encrypt_file.py` generates a fresh 6-word passphrase from the
EFF large wordlist using a CSPRNG, encrypts with it, and **prints it to
stdout** — there is no `PASSPHRASE` constant to edit on the encrypt side,
since generation is the whole point.

```
echo "Hello, cesvu!" > diceware/sample.txt
python diceware/encrypt_file.py
# copy the printed passphrase into diceware/decrypt_file.py's PASSPHRASE
python diceware/decrypt_file.py
cat diceware/sample.txt
```

This profile normalizes whitespace/case, so a pasted passphrase with an
extra space or different capitalization still decrypts correctly — unlike
`raw/`.

## `emoji/` — generated passphrase (passProfile = 2)

Same shape as `diceware/`, but `emoji/encrypt_file.py` generates an
8-emoji passphrase from the curated 800-emoji wordlist and passes
`passphrase_type="emoji"`.

```
echo "Hello, cesvu!" > emoji/sample.txt
python emoji/encrypt_file.py
# copy the printed passphrase into emoji/decrypt_file.py's PASSPHRASE
python emoji/decrypt_file.py
cat emoji/sample.txt
```

This profile normalizes away invisible variation-selector/ZWJ/whitespace
code points some apps insert around emoji on copy/paste.

## What each `encrypt_file.py` does

1. Reads `PLAINTEXT_PATH`.
2. If it has a `.txt`/`.md`/`.csv` extension (and `FORCE_RAW` is not set),
   wraps it in CFP1 document framing — the same framing the cesvu.com web
   app's own Export button produces — so the resulting `.cesvu` file
   opens directly in the web app's document viewer on import, instead of a
   plain download prompt. Every other file type always encrypts as a
   plain/raw file.
3. Encrypts with the profile-appropriate passphrase (see above) and writes
   `ENCRYPTED_PATH` atomically.

## What each `decrypt_file.py` does

1. Decrypts `ENCRYPTED_PATH` with `PASSPHRASE` — `decrypt_cesvu()` reads
   `passProfile` from the file's own header and normalizes `PASSPHRASE`
   accordingly, so a decrypt script never needs to know or declare which
   profile the file was encrypted with.
2. If CFP1 document framing is present (from `raw/`, `diceware/`, or
   `emoji/`'s encrypt script, the full CLI, or the web app itself) and
   `FORCE_RAW` is not set, automatically unwraps it back to just the human
   content.
3. Writes `PLAINTEXT_PATH` atomically.

## Difference from the real `cesvu encrypt`/`cesvu decrypt` commands

These scripts are intentionally minimal — no argparse, no interactive
passphrase prompt, no progress bars, no Windows-console/emoji handling,
and (in every `decrypt_file.py`) no untrusted-filename safety validation
(see `../cesvu/src/cesvu/output_names.py`), since the destination path
here is always one you chose yourself rather than one derived from the
file's own embedded metadata. For the full-featured command-line tool, see
`../cesvu/README.md`.
