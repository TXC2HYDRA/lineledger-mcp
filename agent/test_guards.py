import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from types import SimpleNamespace
from unittest import mock

import guard

ROOT = pathlib.Path(__file__).resolve().parent.parent
MCP_PORT = 8791
server = None


def setUpModule():
    """Start the real MCP server (in-memory database) so the Strands MCPClient has something to connect to."""
    global server
    env = {**os.environ, "PORT": str(MCP_PORT), "LINELEDGER_DB": ":memory:", "LINELEDGER_STORE": "sqlite"}
    server = subprocess.Popen([str(ROOT / "node_modules/.bin/tsx"), "server/main.ts"], cwd=ROOT, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{MCP_PORT}/api/health", timeout=1)
            return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError("MCP server did not start")


def tearDownModule():
    server.terminate()
    server.wait(timeout=10)


os.environ["LINELEDGER_MCP_URL"] = f"http://127.0.0.1:{MCP_PORT}/mcp"
os.environ.pop("LINELEDGER_MODEL_PROVIDER", None)  # these tests import the service in the default mode
os.environ["AWS_ACCESS_KEY_ID"] = "test-not-a-real-key"
os.environ["AWS_PROFILE"] = "personal"
guard.scrub_aws_env()

import service  # noqa: E402  (imports strands after the scrub)
from strands.models.bedrock import BedrockModel  # noqa: E402
from strands.models.ollama import OllamaModel  # noqa: E402

NOVA = "us.amazon.nova-lite-v1:0"


class ProjectProfile:
    """A temporary HOME with ~/.aws-lineledger/{config,credentials} holding obviously fake values."""

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = pathlib.Path(self.tmp.name)
        base = home / ".aws-lineledger"
        base.mkdir()
        (base / "config").write_text("[profile lineledger]\nregion = us-east-1\n")
        (base / "credentials").write_text(
            "[lineledger]\naws_access_key_id = test-not-a-real-key\naws_secret_access_key = test-not-a-real-secret\n")
        self.env = {
            "HOME": str(home),
            "AWS_PROFILE": "lineledger",
            "AWS_CONFIG_FILE": str(base / "config"),
            "AWS_SHARED_CREDENTIALS_FILE": str(base / "credentials"),
        }
        self.patch = mock.patch.dict(os.environ, self.env)
        self.patch.start()
        for key in guard.KEY_VARIABLES:
            os.environ.pop(key, None)
        return self

    def __exit__(self, *exc):
        self.patch.stop()
        self.tmp.cleanup()


class GuardTests(unittest.TestCase):
    def test_aws_env_scrubbed(self):
        self.assertNotIn("AWS_ACCESS_KEY_ID", os.environ)
        self.assertNotIn("AWS_PROFILE", os.environ)
        self.assertEqual(os.environ["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertEqual(os.environ["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")

    def test_agent_model_is_ollama(self):
        agent = service.build_agent()
        self.assertEqual(service.PROVIDER, "ollama")
        self.assertIsInstance(agent.model, OllamaModel)
        self.assertEqual(agent.model.config["model_id"], service.MODEL_ID)
        # the MCP tools were discovered over Streamable HTTP from the real server
        names = set(agent.tool_names)
        self.assertTrue({"get_shift_summary", "check_stock", "plan_container_load"} <= names, names)

    def test_non_loopback_refused(self):
        for url in ("http://example.com/mcp", "https://bedrock-runtime.us-east-1.amazonaws.com", "http://10.0.0.5:11434"):
            with self.assertRaises(ValueError):
                guard.require_loopback(url)
            with self.assertRaises(ValueError):
                service.build_agent(mcp_url=service.MCP_URL, ollama_host=url)
        self.assertEqual(guard.require_loopback("http://127.0.0.1:11434"), "http://127.0.0.1:11434")


class ProviderTests(unittest.TestCase):
    def test_provider_switch_defaults_to_ollama_and_rejects_unknown_values(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LINELEDGER_MODEL_PROVIDER", None)
            self.assertEqual(guard.model_provider(), "ollama")
            for value, expected in (("bedrock", "bedrock"), (" Bedrock ", "bedrock"), ("", "ollama")):
                os.environ["LINELEDGER_MODEL_PROVIDER"] = value
                self.assertEqual(guard.model_provider(), expected)
            for bad in ("anthropic", "openai", "bedrock-claude"):
                os.environ["LINELEDGER_MODEL_PROVIDER"] = bad
                with self.assertRaises(ValueError):
                    guard.model_provider()

    def test_bedrock_scrub_keeps_profile_and_files_but_strips_keys(self):
        env = {
            "AWS_PROFILE": "lineledger", "AWS_REGION": "us-east-1",
            "AWS_CONFIG_FILE": "/x/config", "AWS_SHARED_CREDENTIALS_FILE": "/x/credentials",
            "AWS_ACCESS_KEY_ID": "test-not-a-real-key", "AWS_SECRET_ACCESS_KEY": "x", "AWS_SESSION_TOKEN": "x",
            "AWS_DEFAULT_PROFILE": "employer", "AWS_ROLE_ARN": "x", "AWS_WEB_IDENTITY_TOKEN_FILE": "x",
        }
        with mock.patch.dict(os.environ, env):
            guard.scrub_aws_env("bedrock")
            aws = {k: v for k, v in os.environ.items() if k.startswith("AWS_")}
            self.assertEqual(aws, {
                "AWS_PROFILE": "lineledger", "AWS_REGION": "us-east-1",
                "AWS_CONFIG_FILE": "/x/config", "AWS_SHARED_CREDENTIALS_FILE": "/x/credentials",
                "AWS_EC2_METADATA_DISABLED": "true",
            })
        with self.assertRaises(ValueError):
            guard.scrub_aws_env("claude")

    def test_bedrock_rejects_non_nova_model_ids(self):
        with ProjectProfile():
            for bad in ("anthropic.claude-3-haiku-20240307-v1:0", "us.anthropic.claude-sonnet-4-6", "amazon.titan-text-lite-v1",
                        "meta.llama3-8b-instruct-v1:0", "amazon.novalite", "", None):
                with self.assertRaises(ValueError, msg=repr(bad)):
                    service.build_model("bedrock", bad)
            for good in ("amazon.nova-lite-v1:0", "us.amazon.nova-micro-v1:0", NOVA):
                self.assertEqual(guard.require_nova(good), good)

    def test_bedrock_refuses_without_the_project_profile(self):
        with ProjectProfile() as p:
            cases = [
                ("AWS_PROFILE", None), ("AWS_PROFILE", "default"),
                ("AWS_CONFIG_FILE", None), ("AWS_SHARED_CREDENTIALS_FILE", None),
                ("AWS_SHARED_CREDENTIALS_FILE", str(pathlib.Path(p.env["HOME"]) / ".aws" / "credentials")),
                ("AWS_CONFIG_FILE", str(pathlib.Path(p.env["HOME"]) / ".aws-lineledger-evil" / "config")),
                ("AWS_ACCESS_KEY_ID", "test-not-a-real-key"),
            ]
            for var, value in cases:
                with mock.patch.dict(os.environ, {}):
                    if value is None:
                        os.environ.pop(var, None)
                    else:
                        os.environ[var] = value
                    with self.assertRaises(ValueError, msg=f"{var}={value}"):
                        service.build_model("bedrock", NOVA)
            with self.assertRaises(ValueError):
                service.build_model("bedrock", NOVA, region="not a region")

    def test_bedrock_agent_builds_offline_with_the_project_profile(self):
        # Building the model creates a boto3 client but makes no AWS call; credentials are read lazily.
        with ProjectProfile():
            agent = service.build_agent(provider="bedrock", model_id=NOVA)
            self.assertIsInstance(agent.model, BedrockModel)
            self.assertEqual(agent.model.config["model_id"], NOVA)
            self.assertEqual(agent.model.config["max_tokens"], service.MAX_TOKENS)
            self.assertEqual(agent.model.client.meta.region_name, "us-east-1")
            names = set(agent.tool_names)
            self.assertTrue({"get_shift_summary", "check_stock", "plan_container_load"} <= names, names)

    def test_startup_assertion_rejects_models_built_around_the_guard(self):
        with ProjectProfile():
            import boto3
            session = boto3.Session(profile_name="lineledger", region_name="us-east-1")
            claude = BedrockModel(model_id="us.anthropic.claude-sonnet-4-6", boto_session=session)
            with self.assertRaises(ValueError):
                service.assert_model_allowed(claude)
            service.assert_model_allowed(BedrockModel(model_id=NOVA, boto_session=session))
        with self.assertRaises(RuntimeError):
            service.assert_model_allowed(object())

    def test_service_import_in_bedrock_mode_scrubs_keys_and_keeps_the_profile(self):
        code = ("import os, service; "
                "print(service.PROVIDER, service.MODEL_ID, 'AWS_ACCESS_KEY_ID' in os.environ, os.environ.get('AWS_PROFILE'))")
        env = {**os.environ, "LINELEDGER_MODEL_PROVIDER": "bedrock", "AWS_ACCESS_KEY_ID": "test-not-a-real-key",
               "AWS_PROFILE": "lineledger", "PYTHONPATH": str(ROOT / "agent")}
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "agent", env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.split(), ["bedrock", NOVA, "False", "lineledger"])
        env["LINELEDGER_MODEL_PROVIDER"] = "anthropic"
        bad = subprocess.run([sys.executable, "-c", "import service"], cwd=ROOT / "agent", env=env, capture_output=True, text=True, timeout=120)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("LINELEDGER_MODEL_PROVIDER", bad.stderr)


class LimitTests(unittest.TestCase):
    def test_model_call_limit_cancels_after_the_cap_and_resets_per_request(self):
        limit = service.ModelCallLimit(3)
        events = [SimpleNamespace(cancel=False) for _ in range(5)]
        for event in events:
            limit._count(event)
        self.assertEqual([e.cancel for e in events[:3]], [False, False, False])
        self.assertEqual(events[3].cancel, service.ModelCallLimit.MESSAGE)
        limit._reset(None)
        fresh = SimpleNamespace(cancel=False)
        limit._count(fresh)
        self.assertFalse(fresh.cancel)
        with self.assertRaises(ValueError):
            service.ModelCallLimit(0)

    def test_model_call_limit_stops_a_runaway_tool_loop_in_a_real_agent(self):
        from strands import Agent, tool
        from strands.models.model import Model

        calls = {"n": 0}

        @tool
        def ping() -> str:
            """Ping."""
            return "pong"

        class LoopingModel(Model):
            """Always asks for another tool call, like a model that never answers."""

            def update_config(self, **_kwargs):
                pass

            def get_config(self):
                return {"model_id": "fake"}

            async def structured_output(self, *_args, **_kwargs):
                raise NotImplementedError

            async def stream(self, *_args, **_kwargs):
                calls["n"] += 1
                yield {"messageStart": {"role": "assistant"}}
                yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"t{calls['n']}", "name": "ping"}}}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
                yield {"contentBlockStop": {}}
                yield {"messageStop": {"stopReason": "tool_use"}}
                yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12}, "metrics": {"latencyMs": 1}}}

        agent = Agent(model=LoopingModel(), tools=[ping], callback_handler=None, hooks=[service.ModelCallLimit(4)])
        result = agent("go")
        self.assertEqual(calls["n"], 4)
        self.assertEqual(str(result).strip(), service.ModelCallLimit.MESSAGE)
        self.assertEqual(service.turn_usage(result), {"inputTokens": 40, "outputTokens": 8, "totalTokens": 48})
        agent("again")
        self.assertEqual(calls["n"], 8)  # the count resets for each request

    def test_session_lost_detects_a_dead_mcp_session(self):
        lost = {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "status": "error", "content": [{"text": "MCPClientError: Session terminated"}]}}]}
        fine = {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "status": "error", "content": [{"text": "Unknown line"}]}}]}
        self.assertTrue(service.session_lost(SimpleNamespace(messages=[lost])))
        self.assertFalse(service.session_lost(SimpleNamespace(messages=[fine, {"role": "assistant", "content": [{"text": "ok"}]}])))

    def test_runner_rebuilds_the_agent_when_the_mcp_server_restarts(self):
        """A stateful MCP session dies with its server; the runner reconnects and retries once."""
        from strands import Agent
        from strands.models.model import Model
        from strands.tools.mcp import MCPClient

        port = 8792

        def serve():
            env = {**os.environ, "PORT": str(port), "LINELEDGER_DB": ":memory:", "LINELEDGER_STORE": "sqlite", "LINELEDGER_SIM": "off"}
            proc = subprocess.Popen([str(ROOT / "node_modules/.bin/tsx"), "server/main.ts"], cwd=ROOT, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(60):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
                    return proc
                except OSError:
                    time.sleep(0.25)
            proc.kill()
            raise RuntimeError("MCP server did not start")

        class ToolThenAnswer(Model):
            """Calls check_stock once, then repeats the tool result as its answer."""

            def update_config(self, **_kwargs):
                pass

            def get_config(self):
                return {"model_id": "fake"}

            async def structured_output(self, *_args, **_kwargs):
                raise NotImplementedError

            async def stream(self, messages, *_args, **_kwargs):
                results = [b["toolResult"] for b in messages[-1].get("content", []) if "toolResult" in b]
                yield {"messageStart": {"role": "assistant"}}
                if results:
                    text = " ".join(c.get("text", "") for c in results[0]["content"])
                    yield {"contentBlockDelta": {"delta": {"text": f"{results[0]['status']}: {text}"}}}
                    yield {"contentBlockStop": {}}
                    yield {"messageStop": {"stopReason": "end_turn"}}
                else:
                    yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": "check_stock"}}}}
                    yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"query": "steel"}'}}}}
                    yield {"contentBlockStop": {}}
                    yield {"messageStop": {"stopReason": "tool_use"}}

        def factory():
            return Agent(model=ToolThenAnswer(), tools=[MCPClient(url=f"http://127.0.0.1:{port}/mcp")], callback_handler=None)

        proc = serve()
        try:
            runner = service.AgentRunner(factory)
            first, calls = runner.answer("stock of steel")
            self.assertIn("STL-040", str(first))
            self.assertEqual([c["name"] for c in calls], ["check_stock"])
            proc.terminate()
            proc.wait(timeout=10)
            proc = serve()  # same port, new process: the old session id is unknown now
            second, _ = runner.answer("stock of steel")
            self.assertIn("STL-040", str(second))
            self.assertEqual(runner.rebuilds, 1)
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    def test_turn_usage_reads_the_latest_invocation(self):
        usage = {"inputTokens": 3000, "outputTokens": 120, "totalTokens": 3120, "cacheReadInputTokens": 0}
        result = SimpleNamespace(metrics=SimpleNamespace(latest_agent_invocation=SimpleNamespace(usage=usage)))
        self.assertEqual(service.turn_usage(result), {"inputTokens": 3000, "outputTokens": 120, "totalTokens": 3120})
        self.assertIsNone(service.turn_usage(SimpleNamespace(metrics=SimpleNamespace(latest_agent_invocation=None))))


if __name__ == "__main__":
    unittest.main()
