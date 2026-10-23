"""LineLedger agent: Strands Agents + a model + the MCP server over Streamable HTTP.

Default model: local Ollama, loopback only, no cloud (D4).
Opt-in: LINELEDGER_MODEL_PROVIDER=bedrock uses Amazon Nova on Amazon Bedrock through the project-only AWS
profile (D11). Any other model id, provider or AWS profile is refused at startup.
"""
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from guard import (
    DEFAULT_BEDROCK_MODEL,
    DEFAULT_REGION,
    PROJECT_PROFILE,
    model_provider,
    require_loopback,
    require_nova,
    require_project_profile,
    require_region,
    scrub_aws_env,
)

PROVIDER = model_provider()
scrub_aws_env(PROVIDER)  # must run before strands (and boto3) is imported

import boto3  # noqa: E402
from strands import Agent  # noqa: E402
from strands.hooks import BeforeInvocationEvent, BeforeModelCallEvent, HookProvider, HookRegistry  # noqa: E402
from strands.models.bedrock import BedrockModel  # noqa: E402
from strands.models.ollama import OllamaModel  # noqa: E402
from strands.tools.mcp import MCPClient  # noqa: E402

OLLAMA_HOST = require_loopback(os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"))
MCP_URL = require_loopback(os.environ.get("LINELEDGER_MCP_URL", "http://127.0.0.1:8787/mcp"))
OLLAMA_MODEL = os.environ.get("LINELEDGER_MODEL", "qwen3:4b-instruct")
BEDROCK_MODEL = os.environ.get("LINELEDGER_BEDROCK_MODEL", DEFAULT_BEDROCK_MODEL)
REGION = os.environ.get("LINELEDGER_AWS_REGION", DEFAULT_REGION)
MODEL_ID = BEDROCK_MODEL if PROVIDER == "bedrock" else OLLAMA_MODEL
PORT = int(os.environ.get("AGENT_PORT", "8788"))
MAX_TOKENS = 512
# Each tool call costs one more model call. Our requests need one tool, so 4 calls leaves room for a retry
# and still bounds a runaway tool loop (CPU time locally, tokens on Bedrock).
# Bedrock turns that fail (no network, throttling, expired credentials) are answered by the local Ollama
# model instead. LINELEDGER_FALLBACK=off disables this. Ollama stays loopback only (D4).
FALLBACK = os.environ.get("LINELEDGER_FALLBACK", "on").strip().lower() != "off"
MAX_MODEL_CALLS = int(os.environ.get("LINELEDGER_MAX_MODEL_CALLS", "4"))

SYSTEM_PROMPT = (
    "You are LineLedger, a factory-floor assistant for a plant manager or line operator. "
    "All data is synthetic demo data. Use the provided tools for every fact about shift output, "
    "handover notes, follow-ups, stock and container loads; never invent numbers. "
    "Rules for tool arguments: omit optional arguments the user did not state. Never pass shift_date or shift to get_shift_summary; call it with no arguments. "
    "Use the author \"Operator\" for a handover note when the user names no author. "
    "State only what the tool result says; do not add names or details. "
    "For the state of all lines call get_live_line_status once with no arguments and use roll_up and each line's state; "
    "for one line pass line_id. A line is running only when its state is RUN; say the plant time (sim_now) and the reason_code of any stopped line. "
    "A sensor is above its limit only when value is at or above trip_limit (warn_limit for a warning). "
    "Answer in one or two short sentences suitable for speech."
)


class ModelCallLimit(HookProvider):
    """Ends the turn with a fixed message once a request has used max_calls model calls."""

    MESSAGE = "I stopped after too many steps. Please ask again in a shorter way."

    def __init__(self, max_calls: int) -> None:
        if max_calls < 1:
            raise ValueError("max_calls must be at least 1")
        self.max_calls = max_calls
        self.calls = 0

    def register_hooks(self, registry: HookRegistry, **_kwargs) -> None:
        registry.add_callback(BeforeInvocationEvent, self._reset)
        registry.add_callback(BeforeModelCallEvent, self._count)

    def _reset(self, _event: BeforeInvocationEvent) -> None:
        self.calls = 0

    def _count(self, event: BeforeModelCallEvent) -> None:
        self.calls += 1
        if self.calls > self.max_calls:
            event.cancel = self.MESSAGE


def build_model(provider: str, model_id: str, ollama_host: str = OLLAMA_HOST, region: str = REGION):
    if provider == "ollama":
        return OllamaModel(
            require_loopback(ollama_host),
            model_id=model_id,
            temperature=0,
            max_tokens=MAX_TOKENS,
            options={"num_ctx": 8192},
            additional_args={"think": False},  # skip Qwen3 reasoning tokens: CPU time
        )
    if provider == "bedrock":
        require_nova(model_id)
        require_project_profile()
        # The session reads only the project files named by AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE.
        session = boto3.Session(profile_name=PROJECT_PROFILE, region_name=require_region(region))
        return BedrockModel(model_id=model_id, boto_session=session, temperature=0, max_tokens=MAX_TOKENS)
    raise ValueError(f"unknown provider {provider!r}")


def assert_model_allowed(model) -> None:
    """Startup assertion (D4, D11): a bare Agent() would build a Bedrock model with a Claude model id."""
    if isinstance(model, OllamaModel):
        return
    if isinstance(model, BedrockModel):
        require_nova(model.config.get("model_id"))
        return
    raise RuntimeError(f"agent model must be OllamaModel or a Nova BedrockModel, got {type(model).__name__}")


def build_agent(
    mcp_url: str = MCP_URL,
    ollama_host: str = OLLAMA_HOST,
    model_id: str | None = None,
    provider: str = PROVIDER,
    region: str = REGION,
) -> Agent:
    if model_id is None:
        model_id = BEDROCK_MODEL if provider == "bedrock" else OLLAMA_MODEL
    model = build_model(provider, model_id, ollama_host=ollama_host, region=region)
    mcp = MCPClient(url=require_loopback(mcp_url))
    agent = Agent(
        model=model,
        tools=[mcp],
        system_prompt=SYSTEM_PROMPT,
        callback_handler=None,
        hooks=[ModelCallLimit(MAX_MODEL_CALLS)],
    )
    assert_model_allowed(agent.model)
    return agent


SESSION_LOST = ("Session terminated", "Session not found")
# The MCP server closes sessions idle for 30 minutes; rebuild before that so the agent never holds a dead one.
REBUILD_AFTER_IDLE_S = 20 * 60


def session_lost(agent: Agent) -> bool:
    """True when a tool call in the last turn failed because the MCP session is gone (server restart or expiry)."""
    for message in agent.messages:
        for block in message.get("content", []):
            result = block.get("toolResult") if isinstance(block, dict) else None
            if result and result.get("status") == "error":
                text = " ".join(str(c.get("text", "")) for c in result.get("content", []) if isinstance(c, dict))
                if any(marker in text for marker in SESSION_LOST):
                    return True
    return False


class AgentRunner:
    """Owns the agent and its MCP session. One request at a time; a lost session is rebuilt and retried once."""

    def __init__(self, factory=None, provider: str = PROVIDER) -> None:
        self.factory = factory or build_agent
        self.provider = provider
        self.lock = threading.Lock()
        self.agent: Agent | None = None  # built on the first request, so the agent can start before the MCP server
        self.last_used = time.monotonic()
        self.rebuilds = 0

    def rebuild(self) -> None:
        old = self.agent
        self.agent = self.factory()
        self.rebuilds += 1
        try:
            if old is not None:
                old.cleanup()
        except Exception:  # noqa: BLE001  the old session may already be gone
            pass

    def answer(self, text: str):
        with self.lock:
            if self.agent is None:
                self.agent = self.factory()
            elif time.monotonic() - self.last_used > REBUILD_AFTER_IDLE_S:
                self.rebuild()
            for attempt in (1, 2):
                self.agent.messages.clear()  # one request, one conversation: bounds context size and CPU time
                result, used, provider = ask_with_fallback(self.agent, text, self.provider, self._fallback)
                if used is self.agent and attempt == 1 and session_lost(self.agent):
                    self.rebuild()
                    continue
                break
            self.last_used = time.monotonic()
            calls = tool_calls(used, 0)
            if used is not self.agent:
                try:
                    used.cleanup()
                except Exception:  # noqa: BLE001
                    pass
            return result, calls, provider

    @staticmethod
    def _fallback() -> Agent:
        return build_agent(provider="ollama")


def tool_calls(agent: Agent, since: int) -> list[dict]:
    calls = []
    for message in agent.messages[since:]:
        for block in message.get("content", []):
            if "toolUse" in block:
                calls.append({"name": block["toolUse"]["name"], "input": block["toolUse"]["input"]})
    return calls


def turn_usage(result) -> dict | None:
    """Token usage of the latest invocation: {inputTokens, outputTokens, totalTokens}, or None."""
    invocation = getattr(getattr(result, "metrics", None), "latest_agent_invocation", None)
    usage = getattr(invocation, "usage", None)
    if not usage:
        return None
    return {k: int(usage.get(k, 0)) for k in ("inputTokens", "outputTokens", "totalTokens")}


def ask_with_fallback(agent: Agent, text: str, provider: str, build_fallback):
    """Returns (result, agent_used, provider_used). A failed bedrock turn is retried on a local Ollama agent."""
    try:
        return agent(text), agent, provider
    except Exception as error:
        if provider != "bedrock" or not FALLBACK:
            raise
        print(f"bedrock turn failed ({type(error).__name__}); answering with local Ollama", file=sys.stderr, flush=True)
        fallback = build_fallback()
        fallback.messages.clear()
        return fallback(text), fallback, "ollama"


class Handler(BaseHTTPRequestHandler):
    runner: AgentRunner
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
        try:
            result, calls, provider = self.runner.answer(text)
        except Exception as error:  # surface model/connection errors to the UI, never fake success
            return self._send(502, {"error": f"{type(error).__name__}: {error}"})
        body = {
            "reply": str(result).strip(),
            "tool_calls": calls,
            "seconds": round(time.monotonic() - started, 1),
            "provider": provider,
            "model": MODEL_ID if provider == PROVIDER else OLLAMA_MODEL,
            "fallback": provider != PROVIDER,
            "usage": turn_usage(result),
        }
        # Per-turn token log (cost evidence for the bedrock provider). No prompt text, no credentials.
        print(json.dumps({"turn": {k: body[k] for k in ("provider", "model", "seconds", "usage")},
                          "tools": [c["name"] for c in body["tool_calls"]]}), file=sys.stderr, flush=True)
        self._send(200, body)

    @classmethod
    def _fallback(cls) -> Agent:
        if cls.fallback_agent is None:
            cls.fallback_agent = build_agent(provider="ollama")
        return cls.fallback_agent

    def log_message(self, fmt, *args):  # quiet
        pass


def warm_up_ollama() -> None:
    """Loads the model into memory now and keeps it there, so the first question does not wait for the load."""
    try:
        body = json.dumps({"model": OLLAMA_MODEL, "keep_alive": "60m"}).encode()
        urllib.request.urlopen(urllib.request.Request(f"{OLLAMA_HOST}/api/generate", body, {"content-type": "application/json"}), timeout=300).read()
    except Exception as error:  # noqa: BLE001  Ollama may not be running yet; the first request then reports it
        print(f"model warm-up skipped: {type(error).__name__}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    assert_model_allowed(build_model(PROVIDER, MODEL_ID))  # refuse a wrong model or profile at startup, without needing the MCP server
    Handler.runner = AgentRunner()
    if PROVIDER == "ollama" or FALLBACK:
        threading.Thread(target=warm_up_ollama, daemon=True).start()
    where = "local Ollama" if PROVIDER == "ollama" else f"Amazon Bedrock, {REGION}, profile {PROJECT_PROFILE}"
    print(f"LineLedger agent ({MODEL_ID}, {where}) on http://127.0.0.1:{PORT}/chat")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
