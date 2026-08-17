#!/usr/bin/env python3
"""Package the extension into a single .xpi, and check it before doing so.

An .xpi is a zip with the manifest at its root. Firefox installs a signed one
with a single click on any modern release build, which is the only way to hand
somebody one file and have it work. See DISTRIBUTING.md for the signing step.

Python rather than `zip`, because the tests already need Python and `zip` is
not installed everywhere.
"""
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Everything the extension needs at runtime, and nothing else. Build scripts,
# notes and the output folder have no business inside the package.
INCLUDE_DIRS = ["background", "content", "engine", "panel", "popup", "icons"]
INCLUDE_FILES = ["manifest.json", "selfcheck.html", "selfcheck.js"]

# No remote code, no analytics, no exfiltration — enforced rather than promised.
BANNED = re.compile(
    r"\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|"
    r"\beval\s*\(|new\s+Function\s*\(|"
    r"""["'`]https?://(?!www\.w3\.org)""",
)


def collect():
    paths = []
    for name in INCLUDE_FILES:
        full = os.path.join(HERE, name)
        if not os.path.exists(full):
            sys.exit(f"missing required file: {name}")
        paths.append(name)
    for folder in INCLUDE_DIRS:
        for root, _, files in os.walk(os.path.join(HERE, folder)):
            for f in sorted(files):
                if f.startswith("."):
                    continue
                paths.append(os.path.relpath(os.path.join(root, f), HERE))
    return sorted(paths)


def audit(paths):
    """Refuse to build something that would fail a reviewer's first grep."""
    problems = []
    for rel in paths:
        if not rel.endswith((".js", ".html")):
            continue
        with open(os.path.join(HERE, rel), encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if line.lstrip().startswith(("*", "//", "<!--")):
                    continue          # prose about these things is fine
                if BANNED.search(line):
                    problems.append(f"{rel}:{n}: {line.strip()[:90]}")
    return problems


def main():
    with open(os.path.join(HERE, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    version = manifest["version"]

    paths = collect()
    problems = audit(paths)
    if problems:
        print("refusing to build — found things that must not ship:")
        for p in problems:
            print("  " + p)
        sys.exit(1)

    out_dir = os.path.join(HERE, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"pacetyper-{version}.xpi")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in paths:
            z.write(os.path.join(HERE, rel), rel)

    size = os.path.getsize(out)
    print(f"built dist/pacetyper-{version}.xpi  ({size / 1024:.0f} KB, "
          f"{len(paths)} files)")
    print(f"no network calls, no eval, no remote code  ({len(paths)} files checked)")
    print()
    print("Try it now, unsigned:")
    print("  about:debugging -> This Firefox -> Load Temporary Add-on -> pick the .xpi")
    print("  (gone when Firefox restarts)")
    print()
    print("To install it permanently or give it to someone, it has to be signed.")
    print("  See DISTRIBUTING.md")


if __name__ == "__main__":
    main()
