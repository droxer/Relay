import asyncio
from types import SimpleNamespace

from relay.api.computers.workspace_transport import dispatch_workspace_command
from relay.realtime.event_notifier import KeyedEventNotifier, workspace_response_key
from relay.computer.workspace_query import WorkspaceQueryBroker


def test_workspace_query_delivers_only_to_its_registered_node():
    async def scenario():
        broker = WorkspaceQueryBroker()
        future = broker.register("cmd_1", "node_a")
        assert broker.resolve("cmd_1", "node_b", {}) is False
        assert broker.resolve("cmd_1", "node_a", {"type": "workspace.listing"}) is True
        assert await future == {"type": "workspace.listing"}
        broker.discard("cmd_1")
        assert broker.resolve("cmd_1", "node_a", {}) is False

    asyncio.run(scenario())


def test_workspace_dispatch_reads_response_persisted_by_another_replica():
    class ResponseStore:
        def __init__(self):
            self.responses = {}

        def get_workspace_response(self, command_id):
            return self.responses.get(command_id)

    class Registry:
        def enqueue(self, node_id, command):
            assert node_id == "node_a"
            assert command["id"] == "cmd_distributed"

    async def scenario():
        store = ResponseStore()
        notifier = KeyedEventNotifier()
        ctx = SimpleNamespace(
            daemon_store=store,
            registry=Registry(),
            control_plane_notifier=notifier,
        )
        command = {"id": "cmd_distributed", "type": "workspace.list"}
        pending = asyncio.create_task(
            dispatch_workspace_command(ctx, {"id": "node_a"}, command)
        )
        await asyncio.sleep(0)
        response = {
            "type": "workspace.listing",
            "commandId": command["id"],
            "path": "",
            "exists": True,
            "entries": [],
        }

        store.responses[command["id"]] = response
        notifier.publish(workspace_response_key(command["id"]))

        assert await pending == response

    asyncio.run(scenario())
