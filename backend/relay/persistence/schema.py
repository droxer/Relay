"""Single entry point for the declared Relay database schema.

Importing this module registers every table on the shared ``sql.metadata``.
Tables are declared in ``relay.persistence.tables`` and import nothing but
SQLAlchemy, ``sql``, and ``core``, so this module never imports a store and
any store may import it. Alembic's ``env.py`` and the schema-drift test import
it so that ``target_metadata`` describes the whole database.
"""

from __future__ import annotations

from .tables import admin_tokens as _admin_tokens  # noqa: F401
from .tables import agent_placements as _agent_placements  # noqa: F401
from .tables import agents as _agents  # noqa: F401
from .tables import auth as _auth  # noqa: F401
from .tables import automations as _automations  # noqa: F401
from .tables import chat as _chat  # noqa: F401
from .tables import daemon as _daemon  # noqa: F401
from .tables import device_authorizations as _device_authorizations  # noqa: F401
from .tables import maintenance as _maintenance  # noqa: F401
from .tables import managed_nodes as _managed_nodes  # noqa: F401
from .tables import notifications as _notifications  # noqa: F401
from .tables import org_settings as _org_settings  # noqa: F401
from .tables import profile_images as _profile_images  # noqa: F401
from .tables import projects as _projects  # noqa: F401
from .tables import sessions as _sessions  # noqa: F401
from .tables import skills as _skills  # noqa: F401
from .tables import tasks as _tasks  # noqa: F401
from .tables import teams as _teams  # noqa: F401
from .tables import waitlist as _waitlist  # noqa: F401
from .sql import metadata

__all__ = ["metadata"]
