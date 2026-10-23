"""Guards for the Strands agent (decisions D4 and D11).

Default provider "ollama": never reach AWS, never leave loopback (D4, unchanged).
Opt-in provider "bedrock" (LINELEDGER_MODEL_PROVIDER=bedrock): Amazon Nova on Bedrock only, through the
project-only AWS profile in ~/.aws-lineledger/, never the machine's default ~/.aws profile (D11).
"""
import os
import re
from pathlib import Path
from urllib.parse import urlparse

LOOPBACK = {"127.0.0.1", "localhost", "::1"}

PROVIDERS = ("ollama", "bedrock")
PROJECT_PROFILE = "lineledger"
# Only these AWS_* variables survive the scrub in bedrock mode. Key variables never do: keys come from the
# project credentials file only.
BEDROCK_PASSTHROUGH = ("AWS_PROFILE", "AWS_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE")
KEY_VARIABLES = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN")
# First-party Amazon Nova models only: Anthropic and other Marketplace models need a card and are not free.
NOVA_PREFIXES = ("amazon.nova-", "us.amazon.nova-")
DEFAULT_BEDROCK_MODEL = "us.amazon.nova-lite-v1:0"
DEFAULT_REGION = "us-east-1"
REGION_PATTERN = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-\d$")


def model_provider() -> str:
    """LINELEDGER_MODEL_PROVIDER, default "ollama". Anything else is refused."""
    value = os.environ.get("LINELEDGER_MODEL_PROVIDER", "ollama").strip().lower() or "ollama"
    if value not in PROVIDERS:
        raise ValueError(f"LINELEDGER_MODEL_PROVIDER must be one of {PROVIDERS}, got {value!r}")
    return value


def scrub_aws_env(provider: str = "ollama") -> None:
    """Call before importing strands.

    ollama: remove every AWS_* variable and point AWS config at /dev/null (D4, unchanged).
    bedrock: remove every AWS_* variable except the profile, region and the two file locations.
    """
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")
    keep = {k: os.environ[k] for k in BEDROCK_PASSTHROUGH if k in os.environ} if provider == "bedrock" else {}
    for key in [k for k in os.environ if k.startswith("AWS_")]:
        del os.environ[key]
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
    if provider == "bedrock":
        os.environ.update(keep)
    else:
        os.environ.update(AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null")


def project_aws_dir() -> Path:
    return Path.home() / ".aws-lineledger"


def require_project_profile() -> str:
    """Refuse to build a Bedrock model unless the project-only profile and files are in use.

    AWS_PROFILE must be "lineledger", and AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE must both point
    inside ~/.aws-lineledger/. This stops boto3 from silently using the default ~/.aws profile.
    """
    profile = os.environ.get("AWS_PROFILE")
    if profile != PROJECT_PROFILE:
        raise ValueError(f'AWS_PROFILE must be "{PROJECT_PROFILE}" for the bedrock provider, got {profile!r}')
    base = project_aws_dir().resolve()
    for var in ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"):
        value = os.environ.get(var)
        if not value:
            raise ValueError(f"{var} must be set to a file inside {base}")
        path = Path(value).expanduser().resolve()
        if base not in path.parents:
            raise ValueError(f"{var} must point inside {base}, got {path}")
    present = [k for k in KEY_VARIABLES if k in os.environ]
    if present:
        raise ValueError(f"key variables are not allowed, use the project credentials file: {present}")
    return profile


def require_nova(model_id: str) -> str:
    if not isinstance(model_id, str) or not model_id.startswith(NOVA_PREFIXES):
        raise ValueError(f"bedrock model must be an Amazon Nova model ({' or '.join(NOVA_PREFIXES)}...), got {model_id!r}")
    return model_id


def require_region(region: str) -> str:
    if not isinstance(region, str) or not REGION_PATTERN.match(region):
        raise ValueError(f"not an AWS Region name: {region!r}")
    return region


def require_loopback(url: str) -> str:
    host = urlparse(url).hostname
    if host not in LOOPBACK:
        raise ValueError(f"refusing non-loopback URL: {url}")
    return url
