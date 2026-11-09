"""Bounded Computer transport diagnostics and one incident per episode."""
import math
import uuid
from datetime import UTC, datetime
from typing import Any
from ..core.computer_identity import computer_id
from ..persistence.resource_lock import resource_transaction
from ..notifications.rules import transport_notification_rows

CAUSES = frozenset({'communication', 'storage', 'quarantine', 'revoked', 'execution'})


def transport_diagnostics(body: dict[str, Any]) -> dict[str, Any]:
    causes = body.get('causes', [])
    if not isinstance(causes, list) or len(causes) > len(CAUSES) or any(not isinstance(item, str) or item not in CAUSES for item in causes):
        raise ValueError('Invalid transport causes.')
    state = body.get('state')
    if state not in ('connecting', 'healthy', 'retrying', 'revoked'):
        raise ValueError('Invalid transport state.')
    result: dict[str, Any] = {'causes': sorted(set(causes)), 'state': state, 'recovered': body.get('recovered') is True}
    incident = body.get('incident')
    if incident is not None:
        try:
            result['incident'] = str(uuid.UUID(incident))
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError('Invalid incident identity.') from error
    for key in ('startedAt', 'observedAt', 'attempts', 'bytes', 'limitBytes', 'pending', 'quarantined', 'corrupt', 'accepted', 'capturingBytes'):
        value = body.get(key, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 2**53 - 1:
            raise ValueError(f'Invalid {key}.')
        result[key] = int(value)
    runs = body.get('runs', [])
    if not isinstance(runs, list) or len(runs) > 200 or any(not isinstance(item, str) or len(item) > 200 for item in runs):
        raise ValueError('Invalid transport run identities.')
    positions = body.get('positions', [])
    if not isinstance(positions, list) or len(positions) > 200:
        raise ValueError('Invalid acknowledged positions.')
    normalized_positions = []
    for position in positions:
        if not isinstance(position, dict) or not isinstance(position.get('commandId'), str) or len(position['commandId']) > 200 or isinstance(position.get('sequence'), bool) or not isinstance(position.get('sequence'), int) or not 0 <= position['sequence'] <= 2**53 - 1:
            raise ValueError('Invalid acknowledged position.')
        normalized_positions.append({'commandId': position['commandId'], 'sequence': position['sequence']})
    result['positions'] = normalized_positions
    result['runs'] = runs
    result['verified'] = body.get('verified') is True
    return result


def record_transport(ctx: Any, node: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    identity = computer_id(node)
    with resource_transaction(ctx.daemon_store.engine, "transport:" + identity):
        previous = ctx.daemon_store.transport_status(identity)
        # The backend may already have opened the episode while the daemon was offline.
        if previous and previous.get('incident') and not previous.get('recovered'):
            snapshot = {**snapshot, 'incident': previous['incident']}
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        if previous and snapshot.get('incident') and not snapshot.get('causes') and snapshot.get('state') == 'healthy':
            progressing = snapshot.get('pending', 0) == 0 or snapshot.get('accepted', 0) != previous.get('accepted', 0)
            last_progress = now_ms if progressing else previous.get('lastProgressAt', 0)
            healthy_since = previous.get('healthySince', now_ms)
            if now_ms - last_progress > 10_000:
                healthy_since = now_ms
            snapshot = {**snapshot, 'healthySince': healthy_since, 'lastProgressAt': last_progress,
                        'recovered': now_ms - healthy_since >= 10_000 and now_ms - last_progress <= 10_000}
        snapshot = {**snapshot, 'nodeId': node['id'], 'computerId': identity,
                    'receivedAt': datetime.now(UTC).isoformat(), 'diagnosticsPath': f"/api/v1/daemon-nodes/{node['id']}/transport"}
        ctx.daemon_store.save_transport_status(identity, snapshot)
        if snapshot.get('incident'):
            accounts = [] if node.get('userId') else ctx.auth_store.list_accounts()
            ctx.notification_store.update_incident(transport_notification_rows(node, accounts, snapshot))
    return snapshot
