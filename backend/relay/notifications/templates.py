"""Copy for the waitlist's two emails, in the two languages the web UI ships.

Plain text is the real message; the HTML is the same words with a link, kept
minimal so it renders the same in every client. Anything a person typed (their
name) is escaped before it reaches the HTML part.
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
    },
}


def _copy(locale: str | None) -> dict[str, str]:
    return _COPY.get(locale or "en", _COPY["en"])


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
    html = "".join(
        [
            f"<p>{greeting_html}</p>",
            f"<p>{escape(copy['invite_body'])}</p>",
            f'<p><a href="{escape(invite_url, quote=True)}">{escape(copy["invite_action"])}</a></p>',
            f"<p>{escape(expiry)}</p>",
            f"<p>{escape(copy['footer'])}</p>",
        ]
    )
    return EmailMessage(to=to, subject=copy["invite_subject"], text=text, html=html)


def confirmation_email(*, to: str, locale: str | None) -> EmailMessage:
    copy = _copy(locale)
    text = f"{copy['confirm_body']}\n\n{copy['footer']}"
    html = f"<p>{escape(copy['confirm_body'])}</p><p>{escape(copy['footer'])}</p>"
    return EmailMessage(to=to, subject=copy["confirm_subject"], text=text, html=html)
