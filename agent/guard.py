"""Guards for the Strands agent (decision D4): never reach AWS, never leave loopback."""
import os
from urllib.parse import urlparse

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def scrub_aws_env() -> None:
    """Remove AWS credentials and point AWS config at /dev/null. Call before importing strands."""
    for key in [k for k in os.environ if k.startswith("AWS_")]:
        del os.environ[key]
    os.environ.update(
        AWS_EC2_METADATA_DISABLED="true",
        AWS_CONFIG_FILE="/dev/null",
        AWS_SHARED_CREDENTIALS_FILE="/dev/null",
    )


def require_loopback(url: str) -> str:
    host = urlparse(url).hostname
    if host not in LOOPBACK:
        raise ValueError(f"refusing non-loopback URL: {url}")
    return url
