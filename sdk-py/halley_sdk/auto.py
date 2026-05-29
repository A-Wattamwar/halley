"""
Auto-activation module for the Halley shim.

Checks HALLEY_RECORD and HALLEY_REPLAY env vars to activate the
appropriate mode. Imported via sitecustomize.py injection by the CLI.

Modes:
  HALLEY_RECORD=1              → RECORD mode
  HALLEY_REPLAY=<path>         → REPLAY pure mode (default)
  HALLEY_REPLAY=<path> + HALLEY_HYBRID=1  → REPLAY hybrid mode
"""
import os

if os.environ.get("HALLEY_RECORD") == "1":
    from halley_sdk.recorder import patch
    patch()
elif os.environ.get("HALLEY_REPLAY"):
    cassette_path = os.environ["HALLEY_REPLAY"]
    mode = "hybrid" if os.environ.get("HALLEY_HYBRID") == "1" else "pure"
    from halley_sdk.replayer import patch
    patch(cassette_path, mode=mode)
