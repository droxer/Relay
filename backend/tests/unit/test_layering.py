"""The backend's import graph must keep its layers pointing one way.

Layers, lowest first. A module may import its own layer or any lower one:

    core            ids, models, protocol vocabulary, pure configuration
    persistence     tables, stores, event reducers
    security, chat  account and chat-integration stores
    sessions        thread mutation and continuity
    daemon_registry the execution mechanism (node admission, queue, run lifecycle)
    application     the domain packages (accounts, agents, teams, projects,
                    tasks, skills, computer, execution, realtime),
                    collaboration, automations, notifications, and the
                    registry's node backend, which routes runs into it
    scheduler       the background task scheduler (``relay.tasks.scheduler``)
    api             HTTP routes
    root            app factory and CLI

``POLICY_MODULES`` are pure rules that every layer shares (a store validates
with them, the registry applies them). They may be imported from anywhere, so
they may import only ``relay.core`` and each other.

The graph includes imports inside functions: a deferred import still couples
the two modules, so the only one allowed is the root package's lazy facade.
"""

from __future__ import annotations

import ast
from collections import defaultdict
from pathlib import Path

RELAY_ROOT = Path(__file__).resolve().parents[2] / "relay"

LAYERS = {
    "core": 0,
    "persistence": 1,
    "security": 2,
    "chat": 2,
    "sessions": 3,
    "daemon_registry": 4,
    "accounts": 5,
    "agents": 5,
    "teams": 5,
    "projects": 5,
    "tasks": 5,
    "skills": 5,
    "computer": 5,
    "execution": 5,
    "realtime": 5,
    "collaboration": 5,
    "automations": 5,
    "notifications": 5,
    "migrations_runtime": 5,
    "api": 7,
    # Operator tooling: only the CLI and migrations import it.
    "ops": 8,
}
ROOT_LAYER = 9
MODULE_LAYERS = {
    # The node backend routes a run to a node and then hands it to the
    # registry; nothing in the registry calls back into it. Its run intake
    # (``relay.daemon_registry.intake``) sits on the same layer.
    "relay.daemon_registry.node_backend": LAYERS["tasks"],
    "relay.daemon_registry.intake": LAYERS["tasks"],
    # The scheduler drives the task services; none of them reach back into it.
    "relay.tasks.scheduler": 6,
}
POLICY_MODULES = frozenset(
    {
        "relay.automations.context",
        "relay.automations.model",
        "relay.automations.schedule",
        "relay.collaboration.approvals",
        "relay.collaboration.awaiting",
        "relay.collaboration.contracts",
        "relay.collaboration.manifest",
        "relay.collaboration.models",
        "relay.collaboration.policy",
        "relay.collaboration.styles",
        "relay.collaboration.templates",
        "relay.collaboration.work",
        "relay.notifications.rules",
        "relay.projects.context",
        "relay.projects.setup_result",
        "relay.skills.rules",
        "relay.tasks.claims",
        "relay.tasks.execution",
        "relay.tasks.flow",
        "relay.tasks.issue_triage",
        "relay.tasks.workspace",
    }
)
# Package initializers that must stay empty so importing one leaf module never
# executes the rest of its package.
EMPTY_PACKAGES = (
    "accounts",
    "agents",
    "api",
    "api/accounts",
    "api/admin",
    "api/agents",
    "api/chat",
    "api/computers",
    "api/projects",
    "api/tasks",
    "api/threads",
    "api/web",
    "automations",
    "chat",
    "computer",
    "daemon_registry",
    "execution",
    "ops",
    "persistence",
    "projects",
    "realtime",
    "sessions",
    "skills",
    "tasks",
    "teams",
)
LAZY_IMPORT_ALLOWED = frozenset({"relay"})


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(RELAY_ROOT.parent).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _resolve(module: str, is_package: bool, level: int, target: str | None) -> str:
    base = module.split(".")
    if not is_package:
        base = base[:-1]
    if level > 1:
        base = base[: len(base) - (level - 1)]
    return ".".join(base + (target.split(".") if target else []))


def _type_checking_nodes(tree: ast.Module) -> set[int]:
    hidden: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and "TYPE_CHECKING" in ast.unparse(node.test):
            hidden.update(id(child) for child in ast.walk(node))
    return hidden


def _function_nodes(tree: ast.Module) -> set[int]:
    inside: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            inside.update(id(child) for child in ast.walk(node))
    return inside


def _import_graph() -> tuple[set[str], dict[str, dict[str, int]], dict[str, list[int]]]:
    paths = {_module_name(path): path for path in RELAY_ROOT.rglob("*.py")}
    edges: dict[str, dict[str, int]] = defaultdict(dict)
    lazy: dict[str, list[int]] = defaultdict(list)
    for module, path in paths.items():
        tree = ast.parse(path.read_text())
        hidden = _type_checking_nodes(tree)
        in_function = _function_nodes(tree)
        is_package = path.name == "__init__.py"
        for node in ast.walk(tree):
            if id(node) in hidden or not isinstance(node, ast.ImportFrom):
                continue
            if node.level:
                target = _resolve(module, is_package, node.level, node.module)
            elif node.module and node.module.startswith("relay"):
                target = node.module
            else:
                continue
            if id(node) in in_function:
                lazy[module].append(node.lineno)
            candidates = [target, *(f"{target}.{alias.name}" for alias in node.names)]
            for candidate in candidates:
                if candidate not in paths or candidate == module:
                    continue
                edges[module].setdefault(candidate, node.lineno)
                # Importing a.b.c first executes a/__init__ and a/b/__init__.
                parts = candidate.split(".")
                for depth in range(2, len(parts)):
                    parent = ".".join(parts[:depth])
                    if parent in paths and not module.startswith(parent + "."):
                        edges[module].setdefault(parent, node.lineno)
    return set(paths), edges, lazy


def _layer(module: str) -> int:
    """A module's layer: its own or its nearest package's ``MODULE_LAYERS``
    entry, else its top-level package's ``LAYERS`` entry."""
    parts = module.split(".")
    for depth in range(len(parts), 1, -1):
        prefix = ".".join(parts[:depth])
        if prefix in MODULE_LAYERS:
            return MODULE_LAYERS[prefix]
    return LAYERS.get(parts[1], ROOT_LAYER) if len(parts) > 1 else ROOT_LAYER


def _cycles(modules: set[str], edges: dict[str, dict[str, int]]) -> list[list[str]]:
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    found: list[list[str]] = []
    counter = 0

    def visit(node: str) -> None:
        nonlocal counter
        index[node] = low[node] = counter
        counter += 1
        stack.append(node)
        on_stack.add(node)
        for successor in edges.get(node, {}):
            if successor not in index:
                visit(successor)
                low[node] = min(low[node], low[successor])
            elif successor in on_stack:
                low[node] = min(low[node], index[successor])
        if low[node] == index[node]:
            component = []
            while True:
                member = stack.pop()
                on_stack.discard(member)
                component.append(member)
                if member == node:
                    break
            if len(component) > 1:
                found.append(sorted(component))

    for module in sorted(modules):
        if module not in index:
            visit(module)
    return found


def test_import_graph_has_no_cycles() -> None:
    modules, edges, _lazy = _import_graph()
    assert _cycles(modules, edges) == []


def test_imports_never_point_up_a_layer() -> None:
    modules, edges, _lazy = _import_graph()
    violations = [
        f"{source} (layer {_layer(source)}) imports {target} (layer {_layer(target)}) at line {line}"
        for source in sorted(modules)
        for target, line in sorted(edges[source].items())
        if target not in POLICY_MODULES
        and _layer(target) > _layer(source)
        and target.count(".") > 1  # a bare package import is covered by the init rule
    ]
    assert violations == []


def test_policy_modules_import_only_core_and_policy() -> None:
    modules, edges, _lazy = _import_graph()
    assert POLICY_MODULES <= modules, sorted(POLICY_MODULES - modules)
    violations = [
        f"{source} imports {target}"
        for source in sorted(POLICY_MODULES)
        for target in sorted(edges[source])
        if target not in POLICY_MODULES
        and not target.startswith("relay.core")
        and target.count(".") > 1
    ]
    assert violations == []


def test_relay_imports_are_module_level() -> None:
    _modules, _edges, lazy = _import_graph()
    deferred = {
        module: lines for module, lines in lazy.items() if module not in LAZY_IMPORT_ALLOWED
    }
    assert deferred == {}


def test_package_initializers_import_nothing() -> None:
    for package in EMPTY_PACKAGES:
        tree = ast.parse((RELAY_ROOT / package / "__init__.py").read_text())
        imports = [
            ast.unparse(node)
            for node in tree.body
            if isinstance(node, (ast.Import, ast.ImportFrom))
            and not (isinstance(node, ast.ImportFrom) and node.module == "__future__")
        ]
        assert imports == [], f"relay/{package}/__init__.py re-exports: {imports}"
