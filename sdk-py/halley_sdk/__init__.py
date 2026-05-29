"""Halley SDK for Python — record/replay shim for LLM provider calls.

Heavy modules (recorder, replayer) require httpx and are imported lazily so
that ci_runner, invariants, schema_inference, etc. work in any Python env that
only has stdlib + the packages they need (i.e. no httpx required for eval-only
use cases).
"""

# Lazy accessors — only import recorder when explicitly used, so that
# `python3 -m halley_sdk.ci_runner` (which needs no httpx) doesn't fail on
# envs that don't have httpx installed.


def record_patch():
    from halley_sdk.recorder import patch
    return patch()


def record_unpatch():
    from halley_sdk.recorder import unpatch
    return unpatch()


__all__ = ["record_patch", "record_unpatch"]
