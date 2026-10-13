"""LLM adapter. The model only writes narrative fields from a supplied evidence pack.

Providers: "anthropic" (Claude via the official SDK) or "none". If no provider is configured, the
API key is missing, the request fails, or the model declines, `LlmUnavailable` is raised and the
caller falls back to the deterministic template report, which is labelled as such.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from app.config import Settings
from app.investigation.report import LlmNarrative

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a methane-emissions investigation analyst writing for a repair-coordination team.
You receive an evidence pack (JSON) about one candidate emission source assembled from satellite and
airborne plume detections. Write the narrative fields of an investigation report.

Rules:
- Use only facts present in the evidence pack. Every number you write must appear in the pack.
- Never name an operator, company, facility, contractor or person; none are in the evidence.
- Remote sensing locates a plume origin to tens–hundreds of metres. Never claim it identifies a
  specific component (valve, pipe, seal). Phrase causes as possibilities to be confirmed on site.
- A single detection date does not establish persistence. A missing detection does not prove an
  emission stopped.
- Each possible explanation must cite basis_refs using ids from evidence_references, and carry a
  confidence of low, medium or high that reflects how directly the evidence supports it.
- Keep the summary to 3-5 sentences. Be precise and neutral."""


class LlmUnavailable(RuntimeError):
    pass


class NarrativeGenerator(Protocol):
    model_identifier: str

    def generate(self, evidence_pack: dict[str, Any]) -> LlmNarrative: ...


class AnthropicNarrativeGenerator:
    def __init__(self, api_key: str, model: str, timeout_s: float) -> None:
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=api_key, timeout=timeout_s, max_retries=2)
        self.model_identifier = f"anthropic/{model}"
        self._model = model

    def generate(self, evidence_pack: dict[str, Any]) -> LlmNarrative:
        a = self._anthropic
        try:
            response = self._client.messages.parse(
                model=self._model,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                output_config={"effort": "medium"},
                messages=[
                    {
                        "role": "user",
                        "content": "Evidence pack:\n```json\n"
                        + json.dumps(evidence_pack, indent=1, default=str)
                        + "\n```\nWrite the report narrative.",
                    }
                ],
                output_format=LlmNarrative,
            )
        except a.RateLimitError as exc:
            raise LlmUnavailable(f"rate limited: {exc}") from exc
        except a.APIStatusError as exc:
            raise LlmUnavailable(f"API error {exc.status_code}") from exc
        except a.APIConnectionError as exc:
            raise LlmUnavailable(f"connection error: {exc}") from exc
        if response.stop_reason == "refusal":
            raise LlmUnavailable("model declined the request")
        if response.stop_reason == "max_tokens" or response.parsed_output is None:
            raise LlmUnavailable(f"no structured output (stop_reason={response.stop_reason})")
        return response.parsed_output


def get_generator(settings: Settings) -> NarrativeGenerator | None:
    if settings.llm_provider == "anthropic":
        if not settings.anthropic_api_key:
            log.warning("llm provider 'anthropic' configured without ANTHROPIC_API_KEY; using template")
            return None
        return AnthropicNarrativeGenerator(
            settings.anthropic_api_key, settings.llm_model, settings.llm_timeout_s
        )
    return None
