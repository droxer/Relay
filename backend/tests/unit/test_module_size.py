"""Backend modules and packages stay small.

A module over ``MAX_MODULE_LINES`` or a package (its own modules, not its
subpackages) over ``MAX_PACKAGE_LINES`` should be split by concern, the way
the daemon, session, and task stores are assembled from one mixin per concern.

The allowlists record what was already over budget. Each entry is a ceiling:
the module or package may shrink but never grow past it, and an entry that
falls under budget must be removed, so the lists only ever get shorter.
"""

from __future__ import annotations

from pathlib import Path

RELAY_ROOT = Path(__file__).resolve().parents[2] / "relay"

MAX_MODULE_LINES = 800
MAX_PACKAGE_LINES = 5000

OVERSIZED_MODULES: dict[str, int] = {}
OVERSIZED_PACKAGES: dict[str, int] = {}


def _lines(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def _module_sizes() -> dict[str, int]:
    return {
        path.relative_to(RELAY_ROOT).as_posix(): _lines(path)
        for path in RELAY_ROOT.rglob("*.py")
    }


def _package_sizes() -> dict[str, int]:
    return {
        (package.relative_to(RELAY_ROOT).as_posix() or "."): sum(
            _lines(path) for path in package.glob("*.py")
        )
        for package in {path.parent for path in RELAY_ROOT.rglob("__init__.py")}
    }


def _over_budget(sizes: dict[str, int], budget: int, ceilings: dict[str, int]) -> list[str]:
    return [
        f"{name}: {size} lines (budget {budget}, ceiling {ceilings.get(name, budget)})"
        for name, size in sorted(sizes.items())
        if size > ceilings.get(name, budget)
    ]


def _stale(sizes: dict[str, int], budget: int, ceilings: dict[str, int]) -> list[str]:
    return [name for name in sorted(ceilings) if sizes.get(name, 0) <= budget]


def test_modules_stay_under_budget() -> None:
    assert _over_budget(_module_sizes(), MAX_MODULE_LINES, OVERSIZED_MODULES) == []


def test_packages_stay_under_budget() -> None:
    assert _over_budget(_package_sizes(), MAX_PACKAGE_LINES, OVERSIZED_PACKAGES) == []


def test_allowlists_only_name_oversized_code() -> None:
    assert _stale(_module_sizes(), MAX_MODULE_LINES, OVERSIZED_MODULES) == []
    assert _stale(_package_sizes(), MAX_PACKAGE_LINES, OVERSIZED_PACKAGES) == []
