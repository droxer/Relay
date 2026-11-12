from pathlib import Path

from store_fixtures import make_daemon_store
from relay.daemon_registry.nodes.liveness import merge_node_observation


def test_model_catalog_survives_storage_and_refresh(tmp_path: Path) -> None:
    store = make_daemon_store(tmp_path)
    node = {
        "id": "model-node", "status": "ready", "agents": {"codex": "ready"},
        "createdAt": "2026-11-12T00:00:00Z", "updatedAt": "2026-11-12T00:00:00Z",
        "agentModels": {"codex": ["provider/fast", "provider/deep"]},
        "customModelEndpoints": ["codex"],
        "agentDefaultModels": {"codex": "provider/fast"},
    }
    store.register_node(node)
    loaded = store.get_node("model-node")
    assert loaded is not None
    for key in ("agentModels", "customModelEndpoints", "agentDefaultModels"):
        assert loaded.get(key) == node[key]

    store.mark_node_seen("model-node", {"agentModels": {"codex": ["provider/new"]}})
    refreshed = store.get_node("model-node")
    assert refreshed is not None
    assert refreshed["agentModels"] == {"codex": ["provider/new"]}
    store.mark_node_seen("model-node", {
        "agentModels": {}, "customModelEndpoints": [], "agentDefaultModels": {},
    })
    cleared = store.get_node("model-node")
    assert cleared is not None
    for key in ("agentModels", "customModelEndpoints", "agentDefaultModels"):
        assert not cleared.get(key)
        assert not merge_node_observation(loaded, cleared).get(key)
