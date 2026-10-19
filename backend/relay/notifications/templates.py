"""Copy for Relay's transactional emails, in the two languages the web UI ships.

Plain text is the real message; the HTML is the same words with a link, kept
minimal so it renders the same in every client. Anything a person typed (their
name) is escaped before it reaches the HTML part.

The HTML wears Relay's mark: a text wordmark whose two chevrons are the brand
handoff (the action blue leading, the live purple trailing) and the one link
drawn as the action button. Mail clients ignore CSS variables and many drop
SVG, so the light register's palette values are inlined here;
tests/unit/test_email_brand_parity.py keeps them equal to palette.css.
"""

from __future__ import annotations

from html import escape

from .mailer import EmailMessage

_COPY = {
    "en": {
        "invite_subject": "Your Relay invite",
        "invite_greeting": "Hi {name},",
        "invite_greeting_anonymous": "Hi,",
        "invite_body": "A spot opened up — you can start using Relay now.",
        "invite_action": "Create your account",
        "invite_expiry": "This link works once and expires on {expires}.",
        "confirm_subject": "You're on the Relay waitlist",
        "confirm_body": (
            "Thanks for your interest in Relay. You're on the list, and we'll "
            "email you an invite as soon as there's a spot."
        ),
        "footer": "If you didn't ask for this, you can ignore this email.",
        "reset_subject": "Reset your Relay password",
        "reset_body": "Someone asked to reset the password for @{username}.",
        "reset_action": "Choose a new password",
        "reset_expiry": "This link works once and expires in {minutes} minutes.",
        "reset_footer": "If you didn't ask for this, ignore this email — your password won't change.",
        "changed_subject": "Your Relay password was changed",
        "changed_body": "The password for @{username} was changed at {time}. Every signed-in session was signed out.",
        "changed_footer": "If this wasn't you, contact your Relay admin right away.",
    },
    "zh-CN": {
        "invite_subject": "你的 Relay 邀请",
        "invite_greeting": "{name}，你好：",
        "invite_greeting_anonymous": "你好：",
        "invite_body": "名额已为你开放，现在就可以开始使用 Relay。",
        "invite_action": "创建账号",
        "invite_expiry": "此链接仅可使用一次，将于 {expires} 失效。",
        "confirm_subject": "你已加入 Relay 候补名单",
        "confirm_body": "感谢你对 Relay 的关注。你已在候补名单中，一有名额我们会立即发送邀请邮件。",
        "footer": "如果这不是你本人的操作，请忽略此邮件。",
        "reset_subject": "重置你的 Relay 密码",
        "reset_body": "有人请求重置 @{username} 的密码。",
        "reset_action": "设置新密码",
        "reset_expiry": "此链接仅可使用一次，将在 {minutes} 分钟后失效。",
        "reset_footer": "如果这不是你本人的操作，请忽略此邮件，你的密码不会改变。",
        "changed_subject": "你的 Relay 密码已更改",
        "changed_body": "@{username} 的密码已于 {time} 更改，所有已登录的会话均已退出。",
        "changed_footer": "如果这不是你本人的操作，请立即联系你的 Relay 管理员。",
    },
}


# The light register of web/src/styles/tokens/palette.css (--action,
# --on-action, --live, --ink-1, --ink-3): mail is read on white.
BRAND_ACTION = "#2a44d3"
BRAND_ON_ACTION = "#ffffff"
BRAND_LIVE = "#a121ce"
BRAND_INK = "#171717"
BRAND_MUTED = "#525252"

_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def _copy(locale: str | None) -> dict[str, str]:
    return _COPY.get(locale or "en", _COPY["en"])


def _frame(body_html: str) -> str:
    """Wrap a message body in the wordmark header and the brand ink."""
    mark = (
        f'<p style="margin:0 0 24px;font-weight:700;font-size:18px;color:{BRAND_INK}">'
        f'<span style="color:{BRAND_ACTION}">&rsaquo;</span>'
        f'<span style="color:{BRAND_LIVE}">&rsaquo;</span> Relay</p>'
    )
    return (
        f'<div style="font-family:{_FONT};font-size:15px;line-height:1.5;color:{BRAND_INK}">'
        f"{mark}{body_html}</div>"
    )


def _action_link(url: str, label: str) -> str:
    return (
        f'<p><a href="{escape(url, quote=True)}" style="display:inline-block;padding:10px 16px;'
        f"border-radius:6px;background:{BRAND_ACTION};color:{BRAND_ON_ACTION};"
        f'font-weight:600;text-decoration:none">{escape(label)}</a></p>'
    )


def _muted(text: str) -> str:
    return f'<p style="color:{BRAND_MUTED}">{escape(text)}</p>'


def invite_email(
    *, to: str, name: str | None, invite_url: str, expires_on: str, locale: str | None
) -> EmailMessage:
    copy = _copy(locale)
    greeting_text = copy["invite_greeting"].format(name=name) if name else copy["invite_greeting_anonymous"]
    greeting_html = (
        copy["invite_greeting"].format(name=escape(name)) if name else copy["invite_greeting_anonymous"]
    )
    expiry = copy["invite_expiry"].format(expires=expires_on)
    text = "\n\n".join(
        [
            greeting_text,
            copy["invite_body"],
            f"{copy['invite_action']}: {invite_url}",
            expiry,
            copy["footer"],
        ]
    )
    html = _frame(
        "".join(
            [
                f"<p>{greeting_html}</p>",
                f"<p>{escape(copy['invite_body'])}</p>",
                _action_link(invite_url, copy["invite_action"]),
                f"<p>{escape(expiry)}</p>",
                _muted(copy["footer"]),
            ]
        )
    )
    return EmailMessage(to=to, subject=copy["invite_subject"], text=text, html=html)


def confirmation_email(*, to: str, locale: str | None) -> EmailMessage:
    copy = _copy(locale)
    text = f"{copy['confirm_body']}\n\n{copy['footer']}"
    html = _frame(f"<p>{escape(copy['confirm_body'])}</p>{_muted(copy['footer'])}")
    return EmailMessage(to=to, subject=copy["confirm_subject"], text=text, html=html)


def password_reset_email(
    *, to: str, username: str, reset_url: str, expires_in_minutes: int, locale: str | None
) -> EmailMessage:
    copy = _copy(locale)
    body = copy["reset_body"].format(username=username)
    expiry = copy["reset_expiry"].format(minutes=expires_in_minutes)
    text = "\n\n".join(
        [body, f"{copy['reset_action']}: {reset_url}", expiry, copy["reset_footer"]]
    )
    html = _frame(
        "".join(
            [
                f"<p>{escape(body)}</p>",
                _action_link(reset_url, copy["reset_action"]),
                f"<p>{escape(expiry)}</p>",
                _muted(copy["reset_footer"]),
            ]
        )
    )
    return EmailMessage(to=to, subject=copy["reset_subject"], text=text, html=html)


def password_changed_email(
    *, to: str, username: str, changed_at: str, locale: str | None
) -> EmailMessage:
    """No link on purpose: a look-alike of this mail should have nothing to click."""
    copy = _copy(locale)
    body = copy["changed_body"].format(username=username, time=changed_at)
    text = f"{body}\n\n{copy['changed_footer']}"
    html = _frame(f"<p>{escape(body)}</p>{_muted(copy['changed_footer'])}")
    return EmailMessage(to=to, subject=copy["changed_subject"], text=text, html=html)
