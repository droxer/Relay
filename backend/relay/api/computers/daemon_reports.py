"""Bounded replay batches with an independent durable receipt per report."""
import json
from contextlib import ExitStack
import re
from hashlib import sha256
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from loguru import logger

from ...daemon_registry.records import CommandEventMismatchError, DeletedDaemonNodeError, UnknownDaemonNodeError
from ...daemon_registry.runs.reports import ReportPredecessorMissing
from ..actors import bearer_token
from ..bodies import json_body
from ..deps import AppContextDep
from .daemon_events import daemon_node_event

router = APIRouter()


def _accept_batch(registry: Any, sandbox_id: str, token: str | None, reports: list[dict[str, str]]) -> list[dict[str, Any]]:
    receipts: list[dict[str, Any]] = []
    groups: dict[tuple[str, str], list[tuple[dict[str, str], dict[str, Any]]]] = {}
    for report in reports:
        try:
            event = daemon_node_event(json.loads(report['body']))
        except (ValueError, TypeError, KeyError):
            receipts.append({'id': report['id'], 'digest': report['digest'], 'status': 400})
            continue
        streamed = event['type'] in {'run.output', 'run.output.batch', 'run.collaboration'}
        key = (event['sessionId'], event['commandId'] if streamed else report['id'])
        groups.setdefault(key, []).append((report, event))
    for (session_id, _identity), group in groups.items():
        streamed = group[0][1]['type'] in {'run.output', 'run.output.batch', 'run.collaboration'}
        group_receipts: list[dict[str, Any]] = []
        try:
            with ExitStack() as stack:
                if streamed:
                    stack.enter_context(registry.dispatch_scope([sandbox_id]))
                    stack.enter_context(registry.daemon_store.report_ingest_scope(sandbox_id))
                    stack.enter_context(registry.store.mutation_scope(session_id))
                for report, event in group:
                    status = 200
                    try:
                        registry.handle_durable_report(sandbox_id, event, token, report['id'], report['digest'])
                    except ReportPredecessorMissing:
                        status = 503
                    except CommandEventMismatchError:
                        status = 409
                    except (ValueError, TypeError, KeyError):
                        status = 400
                    group_receipts.append({'id': report['id'], 'digest': report['digest'], 'status': status})
        except Exception:  # noqa: BLE001 - a failed transaction rolls back this stream; unrelated report groups must still progress
            logger.exception('Durable report group failed', node_id=sandbox_id, session_id=session_id)
            for _report, event in group:
                registry.output_sequences.pop(event['runId'], None)
                registry.output_sequences_hydrated.discard(event['runId'])
            group_receipts = [{'id': report['id'], 'digest': report['digest'], 'status': 500} for report, _event in group]
        receipts.extend(group_receipts)
    return receipts


@router.post('/daemon-nodes/{sandbox_id}/reports')
async def daemon_reports(sandbox_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    token = bearer_token(request)
    try:
        await run_in_threadpool(ctx.registry.assert_node_event_authorized, sandbox_id, token)
    except DeletedDaemonNodeError as error:
        raise HTTPException(410, 'Computer retired.') from error
    except PermissionError as error:
        raise HTTPException(401, 'Invalid Computer credential.') from error
    except UnknownDaemonNodeError as error:
        raise HTTPException(404, 'Computer not found.') from error
    body = await json_body(request)
    reports = body.get('reports')
    if not isinstance(reports, list) or not 1 <= len(reports) <= 50:
        raise HTTPException(400, 'Expected 1 to 50 reports.')
    for report in reports:
        if not isinstance(report, dict) or not isinstance(report.get('body'), str) or not isinstance(report.get('id'), str) or not re.fullmatch(r'[0-9a-f]{64}', report['id']) or report.get('digest') != sha256(report['body'].encode()).hexdigest():
            raise HTTPException(400, 'Invalid report identity or payload digest.')
        try:
            value = json.loads(report['body'])
            if not isinstance(value, dict) or value.get('type') not in ('run.output', 'run.output.batch', 'run.collaboration', 'run.completed', 'run.failed', 'run.cancelled'):
                raise ValueError('Invalid durable report type.')
        except (ValueError, TypeError) as error:
            raise HTTPException(400, 'Invalid report payload.') from error
    receipts = await run_in_threadpool(_accept_batch, ctx.registry, sandbox_id, token, reports)
    return {'receipts': receipts}
