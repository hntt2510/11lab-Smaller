"""Pronunciation overrides and suspicious-term helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable


SCOPES = frozenset({"global", "voice", "project", "segment"})


@dataclass(frozen=True)
class PronunciationEntry:
    id: str
    term: str
    pronunciation: str
    language: str | None = None
    scope: str = "project"
    voice_id: str | None = None
    project_id: str | None = None
    segment_id: str | None = None

    def __post_init__(self) -> None:
        if not self.term.strip():
            raise ValueError("term must not be empty")
        if not self.pronunciation.strip():
            raise ValueError("pronunciation must not be empty")
        if self.scope not in SCOPES:
            raise ValueError(f"scope must be one of: {', '.join(sorted(SCOPES))}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "term": self.term,
            "pronunciation": self.pronunciation,
            "language": self.language,
            "scope": self.scope,
            "voice_id": self.voice_id,
            "project_id": self.project_id,
            "segment_id": self.segment_id,
        }


def apply_pronunciations(
    text: str,
    entries: Iterable[PronunciationEntry],
) -> str:
    """Apply longest terms first while preserving word boundaries."""

    result = text
    ordered = sorted(entries, key=lambda entry: len(entry.term), reverse=True)
    for entry in ordered:
        pattern = re.compile(rf"(?<!\w){re.escape(entry.term)}(?!\w)", re.I)
        result = pattern.sub(entry.pronunciation, result)
    return result


def find_suspicious_terms(text: str) -> list[str]:
    """Return acronym-like terms likely to need an override."""

    candidates = re.findall(r"(?<!\w)[A-Z][A-Z0-9./-]{1,}(?!\w)", text)
    return list(dict.fromkeys(candidates))
