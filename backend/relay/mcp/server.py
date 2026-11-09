"""Python-owned MCP protocol and dispatch, hosted in the Relay backend."""

import json
import logging
from contextvars import ContextVar
from typing import Any
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import CallToolResult, TextContent, Tool
from starlette.concurrency import run_in_threadpool
from .access import may_manage
from .catalog import TOOL_OPERATIONS, WORK_OPERATIONS, tool_definitions
from .errors import McpError
from .operations import invoke, list_projects
from .work import invoke_work

CURRENT_GRANT: ContextVar[dict[str, Any] | None] = ContextVar("relay_mcp_grant", default=None)
MAX_RESULT_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)


def create_server(ctx: Any) -> StreamableHTTPSessionManager:
    server = Server("relay-projects", version="1.0.0")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        grant = CURRENT_GRANT.get()
        return tool_definitions(may_manage=grant is None or may_manage(grant))

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        try:
            grant = CURRENT_GRANT.get()
            if grant is None:
                raise McpError(401, "Authentication required.")
            operation = TOOL_OPERATIONS.get(name)
            if operation is None:
                raise McpError(400, "Unknown Relay MCP tool.")
            if operation == "projects":
                result = await run_in_threadpool(list_projects, ctx, grant)
            elif operation in WORK_OPERATIONS:
                result = await run_in_threadpool(invoke_work, ctx, grant, operation, arguments)
            else:
                result = await run_in_threadpool(
                    invoke,
                    ctx,
                    grant,
                    arguments["projectId"],
                    operation,
                    arguments,
                )
            encoded = json.dumps(result, ensure_ascii=False)
            if len(encoded.encode()) > MAX_RESULT_BYTES:
                raise McpError(400, "Tool result too large; narrow the query.")
            reply = CallToolResult(content=[TextContent(type="text", text=encoded)], structuredContent=result)
            if len(reply.model_dump_json(exclude_none=True).encode()) > MAX_RESULT_BYTES - 4096:
                raise McpError(400, "Tool result too large; narrow the query.")
            return reply
        except McpError as error:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=error.code)])
        except Exception as error:  # noqa: BLE001 - never disclose storage/credential details in tool output.
            logger.error("Relay MCP tool failed: %s (%s)", name, type(error).__name__)
            return CallToolResult(
                isError=True,
                content=[TextContent(type="text", text="Relay tool failed; retry or check Project availability.")],
            )

    return StreamableHTTPSessionManager(
        app=server, stateless=True, json_response=True, max_request_body_size=128 * 1024
    )
