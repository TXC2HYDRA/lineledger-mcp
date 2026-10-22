"""LineLedger agent: Strands Agents + local Ollama model + the MCP server over Streamable HTTP.

Loopback only. Zero cloud: the model is an explicit OllamaModel, never the Bedrock default.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from guard import require_loopback, scrub_aws_env

scrub_aws_env()  # must run before strands is imported

from strands import Agent  # noqa: E402
from strands.models.ollama import OllamaModel  # noqa: E402
from strands.tools.mcp import MCPClient  # noqa: E402

OLLAMA_HOST = require_loopback(os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"))
MCP_URL = require_loopback(os.environ.get("LINELEDGER_MCP_URL", "http://127.0.0.1:8787/mcp"))
MODEL_ID = os.environ.get("LINELEDGER_MODEL", "qwen3:4b-instruct")
PORT = int(os.environ.get("AGENT_PORT", "8788"))

SYSTEM_PROMPT = (
    "You are LineLedger, a factory-floor assistant for a plant manager or line operator. "
    "All data is synthetic demo data. Use the provided tools for every fact about shift output, "
    "handover notes, follow-ups, stock and container loads; never invent numbers. "
    "Answer in one or two short sentences suitable for speech."
)


def build_agent(mcp_url: str = MCP_URL, ollama_host: str = OLLAMA_HOST, model_id: str = MODEL_ID) -> Agent:
    model = OllamaModel(
        require_loopback(ollama_host),
        model_id=model_id,
        temperature=0,
        max_tokens=512,
        options={"num_ctx": 8192},
        additional_args={"think": False},  # skip Qwen3 reasoning tokens: CPU time
    )
    mcp = MCPClient(url=require_loopback(mcp_url))
    agent = Agent(model=model, tools=[mcp], system_prompt=SYSTEM_PROMPT, callback_handler=None)
    # Startup assertion (D4): a bare Agent() would build a Bedrock model.
    assert isinstance(agent.model, OllamaModel), "agent model must be OllamaModel"
    return agent


def tool_calls(agent: Agent, since: int) -> list[dict]:
    calls = []
    for message in agent.messages[since:]:
        for block in message.get("content", []):
            if "toolUse" in block:
                calls.append({"name": block["toolUse"]["name"], "input": block["toolUse"]["input"]})
    return calls


class Handler(BaseHTTPRequestHandler):
    agent: Agent
    allowed_origins = {f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (os.environ.get("WEB_PORT", "5173"),)}

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        origin = self.headers.get("origin")
        if origin is not None and origin not in self.allowed_origins:
            return self._send(403, {"error": "Origin not allowed"})
        if self.path != "/chat":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if not 0 < length <= 4096:
                return self._send(413, {"error": "body must be 1 to 4096 bytes"})
            text = str(json.loads(self.rfile.read(length))["text"]).strip()[:400]
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": 'expected JSON {"text": "..."}'})
        started = time.monotonic()
        self.agent.messages.clear()  # one request, one conversation: bounds context size and CPU time
        before = 0
        try:
            result = self.agent(text)
        except Exception as error:  # surface model/connection errors to the UI, never fake success
            return self._send(502, {"error": f"{type(error).__name__}: {error}"})
        self._send(200, {
            "reply": str(result).strip(),
            "tool_calls": tool_calls(self.agent, before),
            "seconds": round(time.monotonic() - started, 1),
            "model": MODEL_ID,
        })

    def log_message(self, fmt, *args):  # quiet
        pass


if __name__ == "__main__":
    Handler.agent = build_agent()
    print(f"LineLedger agent ({MODEL_ID}, local Ollama) on http://127.0.0.1:{PORT}/chat")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
