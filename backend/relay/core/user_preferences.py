"""Display preferences an Account can choose, and their defaults."""

from __future__ import annotations

from typing import Literal

UserTheme = Literal["light", "dark", "system"]
UserLanguage = Literal["en", "zh-CN", "zh-TW"]
USER_THEMES: tuple[UserTheme, ...] = ("light", "dark", "system")
USER_LANGUAGES: tuple[UserLanguage, ...] = ("en", "zh-CN", "zh-TW")
DEFAULT_USER_THEME: UserTheme = "system"
DEFAULT_USER_LANGUAGE: UserLanguage = "en"
