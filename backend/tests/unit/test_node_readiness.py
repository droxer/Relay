import pytest

from relay.core.node_readiness import is_live_node, ready_runtimes


def _node(**fields):
    return {"online": True, "stale": False, "status": "ready", **fields}


def test_only_ready_runtimes_count_and_disabled_ones_are_removed():
    nodes = [
        _node(agents={"codex": "ready", "claude": "missing"}, disabledAgents=["pi"]),
        _node(supportedAgents=["pi", "kimi"]),
    ]
    assert ready_runtimes(nodes) == {"codex", "kimi"}


def test_no_nodes_means_no_runtimes():
    assert ready_runtimes([]) == set()


@pytest.mark.parametrize("status", ["ready", "busy", "running"])
def test_a_working_node_is_live(status):
    assert is_live_node(_node(status=status))


@pytest.mark.parametrize(
    "fields",
    [{"online": False}, {"stale": True}, {"status": "stopped"}, {"status": "failed"}],
)
def test_an_unreachable_node_is_not_live(fields):
    assert not is_live_node(_node(**fields))
