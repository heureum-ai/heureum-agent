"""Path resolution utilities.

Source: pi-mono/packages/coding-agent/src/core/tools/path-utils.ts
"""

from __future__ import annotations

import os
import re
import unicodedata

# Unicode spaces that should be normalized to regular space
UNICODE_SPACES_PATTERN = re.compile(r"[\u00A0\u2000-\u200A\u202F\u205F\u3000]")

# Narrow no-break space used in macOS screenshot names
NARROW_NO_BREAK_SPACE = "\u202f"


def _normalize_unicode_spaces(s: str) -> str:
    """Normalize various Unicode space characters to regular space."""
    return UNICODE_SPACES_PATTERN.sub(" ", s)


def _try_macos_screenshot_path(file_path: str) -> str:
    """Try macOS AM/PM screenshot path variant (narrow no-break space before AM/PM)."""
    return re.sub(r" (AM|PM)\.", rf"{NARROW_NO_BREAK_SPACE}\1.", file_path)


def _try_nfd_variant(file_path: str) -> str:
    """Try NFD variant - macOS stores filenames in NFD (decomposed) form."""
    return unicodedata.normalize("NFD", file_path)


def _try_curly_quote_variant(file_path: str) -> str:
    """Try curly quote variant.

    macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran".
    Users typically type U+0027 (straight apostrophe).
    """
    return file_path.replace("'", "\u2019")


def _file_exists(file_path: str) -> bool:
    """Check if file exists."""
    return os.path.exists(file_path)


def _normalize_at_prefix(file_path: str) -> str:
    """Remove @ prefix if present."""
    return file_path[1:] if file_path.startswith("@") else file_path


def expand_path(file_path: str) -> str:
    """Expand path with ~ and normalize Unicode spaces and @ prefix."""
    normalized = _normalize_unicode_spaces(_normalize_at_prefix(file_path))
    if normalized == "~":
        return os.path.expanduser("~")
    if normalized.startswith("~/"):
        return os.path.expanduser("~") + normalized[1:]
    return normalized


def resolve_to_cwd(file_path: str, cwd: str) -> str:
    """Resolve a path relative to the given cwd.

    Handles ~ expansion and absolute paths.
    """
    expanded = expand_path(file_path)
    if os.path.isabs(expanded):
        return expanded
    return os.path.normpath(os.path.join(cwd, expanded))


def resolve_read_path(file_path: str, cwd: str) -> str:
    """Resolve path for reading, trying various macOS filename variants.

    Returns first existing variant found, or the original resolved path if none exist.
    """
    resolved = resolve_to_cwd(file_path, cwd)

    if _file_exists(resolved):
        return resolved

    # Try macOS AM/PM variant (narrow no-break space before AM/PM)
    am_pm_variant = _try_macos_screenshot_path(resolved)
    if am_pm_variant != resolved and _file_exists(am_pm_variant):
        return am_pm_variant

    # Try NFD variant (macOS stores filenames in NFD form)
    nfd_variant = _try_nfd_variant(resolved)
    if nfd_variant != resolved and _file_exists(nfd_variant):
        return nfd_variant

    # Try curly quote variant (macOS uses U+2019 in screenshot names)
    curly_variant = _try_curly_quote_variant(resolved)
    if curly_variant != resolved and _file_exists(curly_variant):
        return curly_variant

    # Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
    nfd_curly_variant = _try_curly_quote_variant(nfd_variant)
    if nfd_curly_variant != resolved and _file_exists(nfd_curly_variant):
        return nfd_curly_variant

    return resolved
