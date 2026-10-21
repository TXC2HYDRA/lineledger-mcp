import os
import pathlib
import subprocess
import time
import unittest
import urllib.request

import guard

ROOT = pathlib.Path(__file__).resolve().parent.parent
MCP_PORT = 8791
server = None


def setUpModule():
    """Start the real MCP server (in-memory database) so the Strands MCPClient has something to connect to."""
    global server
    env = {**os.environ, "PORT": str(MCP_PORT), "LINELEDGER_DB": ":memory:"}
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
os.environ["AWS_ACCESS_KEY_ID"] = "AKIA-test-not-real"
os.environ["AWS_PROFILE"] = "personal"
guard.scrub_aws_env()

import service  # noqa: E402  (imports strands after the scrub)
from strands.models.ollama import OllamaModel  # noqa: E402


class GuardTests(unittest.TestCase):
    def test_aws_env_scrubbed(self):
        self.assertNotIn("AWS_ACCESS_KEY_ID", os.environ)
        self.assertNotIn("AWS_PROFILE", os.environ)
        self.assertEqual(os.environ["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertEqual(os.environ["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")

    def test_agent_model_is_ollama(self):
        agent = service.build_agent()
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


if __name__ == "__main__":
    unittest.main()
