"""The transactional emails inline the web palette's light register.

Mail clients cannot read CSS variables, so the brand colours in
relay/notifications/templates.py are hex literals. This keeps them equal to
the tokens they stand for in web/src/styles/tokens/palette.css, so a palette
change cannot leave the email on a retired identity.
"""

from __future__ import annotations

import re
from pathlib import Path

from relay.notifications import templates

PALETTE = Path(__file__).resolve().parents[3] / "web" / "src" / "styles" / "tokens" / "palette.css"
LIGHT_MARKER = 'html[data-theme="light"]'


def _light_token(name: str) -> str:
    css = PALETTE.read_text(encoding="utf-8")
    light = css[css.index(LIGHT_MARKER) :]
    match = re.search(rf"{re.escape(name)}:\s*(#[0-9a-f]{{6}});", light)
    assert match, f"{name} is not a literal hex in the light register"
    return match.group(1)


def test_email_brand_colours_match_the_light_palette() -> None:
    assert templates.BRAND_ACTION == _light_token("--action")
    assert templates.BRAND_ON_ACTION == _light_token("--on-action")
    assert templates.BRAND_LIVE == _light_token("--live")
    assert templates.BRAND_INK == _light_token("--ink-1")
    assert templates.BRAND_MUTED == _light_token("--ink-3")


def test_every_email_wears_the_wordmark_and_link_mails_the_action_button() -> None:
    invite = templates.invite_email(
        to="ada@example.com", name="Ada", invite_url="https://relay.test/i#t", expires_on="Oct 30", locale="en"
    )
    changed = templates.password_changed_email(
        to="ada@example.com", username="ada", changed_at="10:00", locale="en"
    )
    for message in (invite, changed):
        assert f'color:{templates.BRAND_ACTION}">&rsaquo;' in message.html
        assert f'color:{templates.BRAND_LIVE}">&rsaquo;' in message.html
    assert f"background:{templates.BRAND_ACTION}" in invite.html
    assert "<a " not in changed.html
