#!/usr/bin/env python3
# Copyright    2026  Xiaomi Corp.        (authors:  Han Zhu)
#
# See ../../LICENSE for clarification regarding multiple authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Voice-design instruct constants for TTS inference.

Defines speaker attribute tags (gender, age, pitch, accent, dialect) and
translation/validation utilities between English and Chinese. Used by
``OmniVoice.generate()`` for voice design mode.
"""

import difflib
import re
from typing import Optional

_ZH_RE = re.compile(r"[\u4e00-\u9fff]")

# Category = set of {english: chinese, ...} items that are mutually exclusive.
# Accent (EN-only) and dialect (ZH-only) are stored as flat sets below.
_INSTRUCT_CATEGORIES = [
    {"male": "男", "female": "女"},
    {
        "child": "儿童",
        "teenager": "少年",
        "young adult": "青年",
        "middle-aged": "中年",
        "elderly": "老年",
    },
    {
        "very low pitch": "极低音调",
        "low pitch": "低音调",
        "moderate pitch": "中音调",
        "high pitch": "高音调",
        "very high pitch": "极高音调",
    },
    {"whisper": "耳语"},
    # Accent (English-only, no Chinese counterpart)
    {
        "american accent",
        "british accent",
        "australian accent",
        "chinese accent",
        "canadian accent",
        "indian accent",
        "korean accent",
        "portuguese accent",
        "russian accent",
        "japanese accent",
    },
    # Dialect (Chinese-only, no English counterpart)
    {
        "河南话",
        "陕西话",
        "四川话",
        "贵州话",
        "云南话",
        "桂林话",
        "济南话",
        "石家庄话",
        "甘肃话",
        "宁夏话",
        "青岛话",
        "东北话",
    },
]

_INSTRUCT_EN_TO_ZH = {}
_INSTRUCT_ZH_TO_EN = {}
_INSTRUCT_MUTUALLY_EXCLUSIVE = []
for _cat in _INSTRUCT_CATEGORIES:
    if isinstance(_cat, dict):
        _INSTRUCT_EN_TO_ZH.update(_cat)
        _INSTRUCT_ZH_TO_EN.update({v: k for k, v in _cat.items()})
        _INSTRUCT_MUTUALLY_EXCLUSIVE.append(set(_cat) | set(_cat.values()))
    else:
        _INSTRUCT_MUTUALLY_EXCLUSIVE.append(set(_cat))

_INSTRUCT_ALL_VALID = (
    set(_INSTRUCT_EN_TO_ZH)
    | set(_INSTRUCT_ZH_TO_EN)
    | _INSTRUCT_MUTUALLY_EXCLUSIVE[-2]  # accents
    | _INSTRUCT_MUTUALLY_EXCLUSIVE[-1]  # dialects
)

_INSTRUCT_VALID_EN = frozenset(i for i in _INSTRUCT_ALL_VALID if not _ZH_RE.search(i))
_INSTRUCT_VALID_ZH = frozenset(i for i in _INSTRUCT_ALL_VALID if _ZH_RE.search(i))


def resolve_instruct(instruct: Optional[str], use_zh: bool = False) -> str | None:
    """Validate and normalize a voice-design instruct using OmniVoice's vocabulary."""
    if instruct is None:
        return None

    instruct_str = instruct.strip()
    if not instruct_str:
        return None

    raw_items = [item for item in re.split(r"\s*[,，]\s*", instruct_str) if item]
    unknown = []
    normalized = []
    for raw in raw_items:
        item = raw.strip().lower()
        if item in _INSTRUCT_ALL_VALID:
            normalized.append(item)
        else:
            suggestion = difflib.get_close_matches(
                item, _INSTRUCT_ALL_VALID, n=1, cutoff=0.6
            )
            unknown.append((raw, item, suggestion[0] if suggestion else None))

    if unknown:
        details = []
        for raw, item, suggestion in unknown:
            if suggestion:
                details.append(
                    f"  '{raw}' -> '{item}' (unsupported; did you mean '{suggestion}'?)"
                )
            else:
                details.append(f"  '{raw}' -> '{item}' (unsupported)")
        raise ValueError(
            f"Unsupported instruct items found in {instruct_str}:\n"
            + "\n".join(details)
            + "\n\nValid English items: "
            + ", ".join(sorted(_INSTRUCT_VALID_EN))
            + "\nValid Chinese items: "
            + "，".join(sorted(_INSTRUCT_VALID_ZH))
        )

    has_dialect = any(item.endswith("话") for item in normalized)
    has_accent = any(" accent" in item for item in normalized)
    if has_dialect and has_accent:
        raise ValueError(
            "Cannot mix Chinese dialect and English accent in a single instruct."
        )
    if has_dialect:
        use_zh = True
    elif has_accent:
        use_zh = False

    if use_zh:
        normalized = [_INSTRUCT_EN_TO_ZH.get(item, item) for item in normalized]
    else:
        normalized = [_INSTRUCT_ZH_TO_EN.get(item, item) for item in normalized]

    conflicts = []
    for category in _INSTRUCT_MUTUALLY_EXCLUSIVE:
        matches = [item for item in normalized if item in category]
        if len(matches) > 1:
            conflicts.append(matches)
    if conflicts:
        raise ValueError(
            "Conflicting instruct items within the same category: "
            + "; ".join(" vs ".join(f"'{item}'" for item in group) for group in conflicts)
        )

    separator = "，" if any(_ZH_RE.search(item) for item in normalized) else ", "
    return separator.join(normalized)
