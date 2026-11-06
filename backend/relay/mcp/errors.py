"""Errors safe to return across the Relay MCP interface."""


class McpError(ValueError):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)
