#!/usr/bin/env python3
"""Verify only Tauri's documented UNK -> NSS patch; reject every other byte difference."""
import hashlib
import pathlib
import sys

UNKNOWN = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
NSIS = b'__TAURI_BUNDLE_TYPE_VAR_NSS'
GAME_MARKERS = (b'DOTA_GAMERULES_STATE_', b'techies_suicide', b'game-sound-play')

def verify(built: bytes, installed: bytes) -> str:
    if built.count(UNKNOWN) != 1:
        raise ValueError('Expected exactly one original Tauri bundle marker')
    expected = built.replace(UNKNOWN, NSIS, 1)
    if installed != expected:
        raise ValueError('Installer payload differs beyond the exact Tauri UNK -> NSS patch')
    if any(marker in installed for marker in GAME_MARKERS):
        raise ValueError('Game implementation marker found in core executable')
    return hashlib.sha256(installed).hexdigest()

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: companion-verify-nsis-payload.py BUILT_EXE INSTALLED_EXE')
    digest = verify(pathlib.Path(sys.argv[1]).read_bytes(), pathlib.Path(sys.argv[2]).read_bytes())
    print(f'Exact NSIS payload verified (only UNK -> NSS): sha256={digest}')
