"""Single entry point for the declared Relay database schema.

Importing this module registers every store's tables on the shared
``store_common.metadata``. Alembic's ``env.py`` and the schema-drift test both
import it so that ``target_metadata`` describes the whole database rather than
whichever store happened to be imported first.
"""

from __future__ import annotations

from ..chat import integrations as _chat_integrations  # noqa: F401
from ..security import auth as _auth  # noqa: F401
from . import agent_placement_store as _agent_placement_store  # noqa: F401
from . import agent_store as _agent_store  # noqa: F401
from . import daemon_store as _daemon_store  # noqa: F401
from . import org_settings_store as _org_settings_store  # noqa: F401
from . import project_store as _project_store  # noqa: F401
from . import session_store as _session_store  # noqa: F401
from . import skill_store as _skill_store  # noqa: F401
from . import task_store as _task_store  # noqa: F401
from . import team_store as _team_store  # noqa: F401
from .store_common import metadata

__all__ = ["metadata"]
