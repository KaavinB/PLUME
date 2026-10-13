"""Repair project lifecycle. Mirrors the RepairEscrow contract; DRAFT and UNDER_VERIFICATION are off-chain."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Transition:
    action: str
    sources: frozenset[str]
    target: str  # for decision actions the target depends on the outcome; see DECISION_TARGETS
    roles: frozenset[str]


def _t(action: str, sources: set[str], target: str, roles: set[str]) -> Transition:
    return Transition(action, frozenset(sources), target, frozenset(roles))


RESUBMITTABLE = {"ASSIGNED", "REJECTED", "INCONCLUSIVE", "ADDITIONAL_EVIDENCE_REQUIRED"}
REFUNDABLE = {
    "FUNDED",
    "ASSIGNED",
    "REPAIR_SUBMITTED",
    "UNDER_VERIFICATION",
    "REJECTED",
    "INCONCLUSIVE",
    "ADDITIONAL_EVIDENCE_REQUIRED",
    "DISPUTED",
}

TRANSITIONS: dict[str, Transition] = {
    t.action: t
    for t in [
        _t("publish", {"DRAFT"}, "OPEN_FOR_FUNDING", {"sponsor"}),
        _t("fund", {"OPEN_FOR_FUNDING"}, "FUNDED", {"sponsor"}),
        _t("accept", {"FUNDED"}, "ASSIGNED", {"provider"}),
        _t("submit_evidence", RESUBMITTABLE, "REPAIR_SUBMITTED", {"provider"}),
        _t("start_review", {"REPAIR_SUBMITTED"}, "UNDER_VERIFICATION", {"verifier"}),
        _t("decide", {"REPAIR_SUBMITTED", "UNDER_VERIFICATION", "DISPUTED"}, "*", {"verifier"}),
        _t("dispute", {"VERIFIED", "REJECTED", "INCONCLUSIVE"}, "DISPUTED", {"sponsor", "provider"}),
        _t("release", {"VERIFIED"}, "PAID", {"sponsor", "provider", "verifier", "admin"}),
        _t("cancel", {"DRAFT", "OPEN_FOR_FUNDING", "FUNDED"}, "CANCELLED", {"sponsor"}),
        _t("refund_expired", REFUNDABLE, "EXPIRED", {"sponsor"}),
    ]
}

DECISION_TARGETS = {
    "VERIFIED": "VERIFIED",
    "REJECTED": "REJECTED",
    "INCONCLUSIVE": "INCONCLUSIVE",
    "ADDITIONAL_EVIDENCE_REQUIRED": "ADDITIONAL_EVIDENCE_REQUIRED",
}

TERMINAL = {"PAID", "CANCELLED", "EXPIRED"}


class TransitionError(Exception):
    def __init__(self, message: str, code: int = 409) -> None:
        super().__init__(message)
        self.code = code


def check_transition(action: str, current: str, role: str, outcome: str | None = None) -> str:
    """Validate an action against the lifecycle. Returns the resulting status or raises."""
    t = TRANSITIONS.get(action)
    if t is None:
        raise TransitionError(f"unknown action {action}", 400)
    if role not in t.roles:
        raise TransitionError(f"role '{role}' may not perform '{action}'", 403)
    if current not in t.sources:
        raise TransitionError(f"cannot {action} a project in state {current}", 409)
    if action == "decide":
        if outcome not in DECISION_TARGETS:
            raise TransitionError(f"invalid verification outcome {outcome}", 400)
        return DECISION_TARGETS[outcome]
    return t.target


def allowed_actions(current: str, role: str) -> list[str]:
    return sorted(a for a, t in TRANSITIONS.items() if current in t.sources and role in t.roles)
