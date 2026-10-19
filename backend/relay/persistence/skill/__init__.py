"""Skill metadata and the object store holding skill bundle bytes.

``DatabaseSkillStore`` (``store.py``) is assembled from one mixin per concern:
``writes``, ``assignments``, ``reads``, and ``events``; ``state.py`` declares
their shared engine and tables, ``rules.py`` the bundle validation, and
``rows.py`` the row mapping.
"""
