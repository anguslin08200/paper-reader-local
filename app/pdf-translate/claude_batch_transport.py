"""Inference-only Claude Code CLI transport for PDF translation batches."""
from __future__ import annotations

import json

from claude_translate import ClaudeError, EFFORTS, claude_command, ensure_login, run_structured, subscription_environment
# Share the batch rules and error type so the scheduler treats both providers identically.
from codex_batch_transport import (_INSTRUCTIONS, _TERMS_INSTRUCTIONS, _TERMS_SCHEMA,
                                   _validated_terms, TranslationError)


class ClaudeBatchSession:
    """Run each batch as one fresh, tool-less `claude -p` request with structured output."""

    def __init__(self, model: str, effort: str, timeout: float = 120, service_tier: str = "standard"):
        # service_tier is accepted for interface compatibility; Claude Code has no tier switch here.
        if not isinstance(model, str) or not model or effort not in EFFORTS or timeout <= 0:
            raise ValueError("model, a supported effort and positive timeout are required")
        self.model, self.effort, self.timeout = model, effort, float(timeout)
        self.last_usage = None
        self._closed = False
        self._command, self._env = claude_command(), subscription_environment()
        # Each worker checks login once, before spending any subscription quota.
        try:
            ensure_login(self._command, self._env)
        except RuntimeError as error:
            raise TranslationError("Claude.ai login is unavailable", retryable=False) from error

    def translate(self, items: list[dict[str, str]], glossary: str = "") -> dict[str, str]:
        # Report the CLI's actual token counters for this request, never an estimate.
        self.last_usage = None
        if self._closed:
            raise TranslationError("Claude translation session is closed")
        if not isinstance(items, list) or not items:
            raise ValueError("items must be a nonempty list")
        if not isinstance(glossary, str):
            raise ValueError("glossary must be a string")
        ids = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] \
                    or not isinstance(item.get("source"), str):
                raise ValueError("each item requires string id and source")
            ids.append(item["id"])
        if len(set(ids)) != len(ids):
            raise ValueError("batch ids must be unique")
        # One required string per paragraph ID, matching the Codex batch output contract.
        schema = {"type": "object", "properties": {key: {"type": "string"} for key in ids},
                  "required": ids, "additionalProperties": False}
        payload = json.dumps({"glossary": glossary, "items": items}, ensure_ascii=False)
        try:
            result, self.last_usage = run_structured(self._command, self._env, self.model, self.effort,
                                                     _INSTRUCTIONS, schema, payload, self.timeout)
        except ClaudeError as error:
            raise TranslationError(str(error), retryable=error.retryable) from error
        if set(result) != set(ids) or any(not isinstance(result[key], str) or not result[key].strip() for key in ids):
            raise TranslationError("Claude returned missing or invalid translation IDs", True)
        return result

    def extract_terms(self, text: str, glossary: str = "") -> dict[str, str]:
        # Use the same structured CLI path and error classification as batch translation.
        self.last_usage = None
        if self._closed:
            raise TranslationError("Claude translation session is closed")
        if not isinstance(text, str) or not text.strip() or not isinstance(glossary, str):
            raise ValueError("text must be nonempty and glossary must be a string")
        payload = json.dumps({"text": text, "glossary": glossary}, ensure_ascii=False)
        try:
            result, self.last_usage = run_structured(self._command, self._env, self.model, self.effort,
                _TERMS_INSTRUCTIONS, _TERMS_SCHEMA, payload, self.timeout)
        except ClaudeError as error:
            raise TranslationError(str(error), retryable=error.retryable) from error
        return _validated_terms(result)

    def close(self) -> None:
        # Requests own their processes, so closing only blocks further use.
        self._closed = True

    def __enter__(self) -> "ClaudeBatchSession":
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()
