"""
Auto-activation module for the Halley shim.

Checks HALLEY_RECORD and HALLEY_REPLAY env vars to activate the
appropriate mode. Imported via sitecustomize.py injection by the CLI.
"""
import os

if os.environ.get("HALLEY_RECORD") == "1":
    from halley_sdk.recorder import patch
    patch()
elif os.environ.get("HALLEY_REPLAY"):
    cassette_path = os.environ["HALLEY_REPLAY"]
    from halley_sdk.replayer import patch
    patch(cassette_path)
