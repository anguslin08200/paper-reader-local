"""Bounded-context scientific translation through the official Claude Code CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

# Reuse the Codex bridge's validated cache, splitting, marker checks and failure reporting.
from codex_translate import INSTRUCTION, Store, split_source, update_status, validate

# Distinct policy keeps Claude translations out of Codex cache scopes and vice versa.
POLICY = "taiwan-science-claude-v1"
SCHEMA = {"type": "object", "properties": {"translation": {"type": "string"}},
          "required": ["translation"], "additionalProperties": False}
MODELS = ("sonnet", "opus", "haiku")
EFFORTS = ("low", "medium", "high")
# API credentials in the parent environment would switch Claude Code to pay-per-use billing.
_BILLING_VARIABLES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
                      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")


class ClaudeError(RuntimeError):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def claude_command() -> list[str]:
    # Call the native executable directly so document text never passes through cmd.exe.
    override = os.environ.get("PDF_TRANSLATE_CLAUDE_BIN")
    if override:
        return [override]
    native = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    launcher = shutil.which("claude.cmd")
    candidates = [native]
    if launcher:
        candidates.insert(0, Path(launcher).parent / "node_modules/@anthropic-ai/claude-code/bin/claude.exe")
    for entry in candidates:
        if entry.is_file():
            return [str(entry)]
    found = shutil.which("claude.exe") or shutil.which("claude")
    if found and Path(found).suffix.lower() not in (".cmd", ".ps1", ".bat", ""):
        return [found]
    raise RuntimeError("Claude Code CLI not found. Install @anthropic-ai/claude-code and run claude auth login.")


def subscription_environment() -> dict[str, str]:
    # Force the Claude.ai subscription login; never bill an API key exported by a parent process.
    env = dict(os.environ)
    for key in _BILLING_VARIABLES:
        env.pop(key, None)
    return env


def ensure_login(command: list[str], env: dict[str, str]) -> None:
    # Read only the official status summary; never read or copy the account's auth tokens.
    try:
        result = subprocess.run(command + ["auth", "status"], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", env=env, timeout=30,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        status = json.loads(result.stdout)
    except (ValueError, subprocess.SubprocessError) as error:
        raise RuntimeError("Could not read Claude login status. Run claude auth login, then retry.") from error
    if not status.get("loggedIn") or status.get("authMethod") != "claude.ai":
        raise RuntimeError("Claude.ai subscription login required. Run claude auth login, then retry.")


def build_command(command: list[str], model: str, effort: str, system: str, schema: dict) -> list[str]:
    # No tools, MCP servers, settings files or saved sessions: a pure inference-only request.
    # The custom system prompt also replaces Claude Code's coding-agent prompt to save tokens.
    return command + ["-p", "--model", model, "--effort", effort, "--tools", "",
                      "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
                      "--system-prompt", system, "--output-format", "json",
                      "--json-schema", json.dumps(schema, ensure_ascii=False)]


def classify(message: str, status=None) -> ClaudeError:
    # Expose only known categories; upstream messages may echo document text.
    lowered = message[:500].lower()
    if status == 429 or any(s in lowered for s in ("usage limit", "rate limit", "limit reached", "quota", "credit")):
        return ClaudeError("Claude subscription usage limit reached", retryable=False)
    if status in (401, 403) or any(s in lowered for s in ("login", "auth", "unauthorized", "oauth")):
        return ClaudeError("Claude.ai login is unavailable", retryable=False)
    if status in (500, 502, 503, 504, 529) or any(s in lowered for s in ("overloaded", "connection", "network", "econnreset")):
        return ClaudeError("Claude connection or service failed", retryable=True)
    return ClaudeError("Claude translation request failed", retryable=False)


def run_structured(command: list[str], env: dict[str, str], model: str, effort: str, system: str,
                   schema: dict, prompt: str, timeout: float) -> tuple[dict, dict | None]:
    # One fresh process per request; an empty working directory avoids loading project files.
    with tempfile.TemporaryDirectory(prefix="pdf-claude-") as directory:
        process = subprocess.Popen(build_command(command, model, effort, system, schema),
                                   cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                   errors="replace", env=env,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            # Send the document over stdin to avoid Windows command-line length limits.
            stdout, stderr = process.communicate(prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            # End the CLI and its children rather than leaving a model request running.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                               timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                process.kill()
            process.communicate()
            raise ClaudeError("Claude translation timed out", retryable=True)
    try:
        data = json.loads(stdout)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        # Startup failures print plain text; classify from the bounded stderr tail only.
        raise classify(stderr[-2000:] + stdout[-500:])
    usage = usage_counts(data.get("usage"))
    if process.returncode or data.get("is_error") or data.get("subtype") != "success":
        raise classify(str(data.get("result", "")) + stderr[-1000:], data.get("api_error_status"))
    output = data.get("structured_output")
    if not isinstance(output, dict):
        raise ClaudeError("Claude returned no structured translation", retryable=True)
    return output, usage


def usage_counts(usage) -> dict | None:
    # Map Claude counters onto the Codex names the GUI already displays; input includes cache.
    if not isinstance(usage, dict):
        return None
    numbers = {key: usage.get(key, 0) for key in ("input_tokens", "cache_creation_input_tokens",
                                                  "cache_read_input_tokens", "output_tokens")}
    if not all(type(value) is int and value >= 0 for value in numbers.values()):
        return None
    thinking = (usage.get("output_tokens_details") or {}).get("thinking_tokens", 0)
    total_input = numbers["input_tokens"] + numbers["cache_creation_input_tokens"] + numbers["cache_read_input_tokens"]
    return {"inputTokens": total_input, "cachedInputTokens": numbers["cache_read_input_tokens"],
            "outputTokens": numbers["output_tokens"],
            "reasoningOutputTokens": thinking if type(thinking) is int and thinking >= 0 else 0,
            "totalTokens": total_input + numbers["output_tokens"]}


def run_claude(source: str, context: list, glossary: str, args, command, env) -> str:
    # Single-paragraph fallback with the same rules and marker validation as the Codex bridge.
    payload = {"previous": context, "glossary": glossary, "source": source}
    output, _ = run_structured(command, env, args.model, args.effort, INSTRUCTION, SCHEMA,
                               json.dumps(payload, ensure_ascii=False), args.timeout)
    if not isinstance(output.get("translation"), str):
        raise ClaudeError("Claude did not produce a structured translation", retryable=True)
    return validate(source, output["translation"])


def parse_args():
    # Mirrors codex_translate.py so pdf2zh and the batch scheduler share one argument shape.
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--effort", choices=EFFORTS, default="low")
    # Accepted for argument compatibility with the Codex bridge; Claude has no service tier here.
    parser.add_argument("--service-tier", choices=("standard", "fast"), default="standard")
    parser.add_argument("--document", default="standalone")
    # Accept the batch pre-pass opt-out in bridge commands too.
    parser.add_argument("--no-auto-glossary", action="store_true")
    parser.add_argument("--glossary", type=Path)
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument("--context-chars", type=int, default=2000)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--cache", type=Path, default=Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
                        / "PDFMathTranslate/claude-cache.sqlite3")
    parser.add_argument("--check-login", action="store_true")
    parser.add_argument("--status-file", type=Path)
    args = parser.parse_args()
    if not 256 <= args.max_chars <= 12000 or not 0 <= args.context_chars <= 4000:
        parser.error("max-chars must be 256..12000; context-chars must be 0..4000")
    if not 1 <= args.timeout <= 600:
        parser.error("timeout must be 1..600")
    return args


def translate_source(source, args, command, env):
    # Cache scope includes model/effort/glossary so changing any of them re-translates.
    glossary = args.glossary.read_text(encoding="utf-8") if args.glossary else ""
    if len(glossary) > 4000:
        raise ValueError("Glossary exceeds 4000 characters")
    scope = hashlib.sha256(json.dumps([POLICY, args.document, args.model, args.effort,
                                      glossary, args.max_chars, args.context_chars]).encode()).hexdigest()
    store = Store(args.cache)
    checked = False
    translations = []
    try:
        for chunk in split_source(source, args.max_chars):
            key = hashlib.sha256((scope + chunk).encode("utf-8")).hexdigest()
            translated = store.get(key)
            if translated is None:
                if not checked:
                    ensure_login(command, env)
                    checked = True
                translated = run_claude(chunk, store.previous(scope, args.context_chars),
                                        glossary, args, command, env)
                store.put(key, scope, chunk, translated)
            translations.append(validate(chunk, translated))
        # Keep a boundary between chunks so retained English terms never concatenate.
        sys.stdout.write(validate(source, "\n".join(translations)))
    finally:
        store.db.close()
    return 0


def main():
    # stdout is reserved for the translation expected by PDFMathTranslate.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    command, env = claude_command(), subscription_environment()
    if args.check_login:
        ensure_login(command, env)
        print("Claude.ai subscription login ready")
        return 0
    source = sys.stdin.read()
    if not source.strip():
        return 0
    try:
        result = translate_source(source, args, command, env)
    except Exception as error:
        update_status(args.status_file, source, str(error))
        raise
    else:
        update_status(args.status_file, source, None)
        return result


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
