"""
Commit-message rewriter for git filter-repo.

Invoked once per commit via:

    git filter-repo --force --commit-callback \
        "exec(open('_work/sprint-20-filter-script.py').read())"

The script is designed to run inside the callback scope that filter-repo
constructs (a function body with a bound `commit` local). It therefore avoids
module-level helper functions whose closures cannot see sibling locals, and
keeps all logic as straight-line code referencing `commit` directly.

A module-level cache of the rewrites map is stashed on the built-in `globals()`
dict of the exec context so we only load the JSON once across the per-commit
callback invocations.

For each commit whose original_id is in the map, the commit message is
replaced with:

    <new_subject>\n
    [\n<new_body>\n]            # only if new_body is non-empty
    \n<Co-Authored-By lines>\n  # preserved verbatim from the original

Commits not in the map are left untouched.
"""

import json as _json
import os as _os

# Cache the rewrites dict on globals() so we load the file only once.
if "_SPRINT20_REWRITES" not in globals():
    _candidates = [
        _os.path.join(_os.getcwd(), "_work", "sprint-20-rewrites.json"),
        "/tmp/sprint-20-rewrites.json",
    ]
    _rewrites = None
    for _p in _candidates:
        if _os.path.exists(_p):
            with open(_p, "r", encoding="utf-8") as _f:
                _rewrites = {e["hash"]: e for e in _json.load(_f)}
            break
    if _rewrites is None:
        raise FileNotFoundError(
            "sprint-20-rewrites.json not found in: " + repr(_candidates)
        )
    globals()["_SPRINT20_REWRITES"] = _rewrites

_rewrites_map = globals()["_SPRINT20_REWRITES"]

# filter-repo binds `commit` in the callback scope. If we are being exec'd
# outside that scope (e.g. during a unit-level smoke test) we simply bail out.
try:
    commit  # noqa: F821 — injected by the callback
except NameError:
    pass
else:
    if commit.original_id:
        _orig = commit.original_id.decode("utf-8", errors="replace")
        _entry = _rewrites_map.get(_orig)
        if _entry is not None:
            _old_msg = commit.message.decode("utf-8", errors="replace")
            _co = [
                _line
                for _line in _old_msg.splitlines()
                if _line.startswith("Co-Authored-By:")
            ]
            _subject = _entry["new_subject"]
            _body = (_entry.get("new_body") or "").rstrip()

            _parts = [_subject, "\n"]
            if _body:
                _parts.append("\n")
                _parts.append(_body)
                _parts.append("\n")
            if _co:
                _parts.append("\n")
                _parts.append("\n".join(_co))
                _parts.append("\n")

            commit.message = "".join(_parts).encode("utf-8")
