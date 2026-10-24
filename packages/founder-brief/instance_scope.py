"""Validated, immutable names for independent workflow installations.

The omitted instance is deliberately the historical founder-brief namespace.
Existing reviewed paths, markers, owners and hashes therefore retain meaning.
"""
from dataclasses import dataclass
import re
from typing import Optional


@dataclass(frozen=True)
class Scope:
    instance_id: Optional[str]
    relative_root: str
    managed_id: str
    marker: str
    script: str
    owner: str
    lock_name: str


def scope_for(instance_id=None):
    if instance_id is None:
        return Scope(None, ".hstack/founder-brief", "founder-brief",
                     "[hstack:founder-brief]", "hstack-founder-brief.py",
                     "hstack-founder-brief-v1", "founder-brief.lock")
    if not isinstance(instance_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", instance_id):
        raise ValueError("invalid_instance_id")
    managed_id = "workflow-" + instance_id
    return Scope(instance_id, ".hstack/workflows/" + instance_id, managed_id,
                 "[hstack:" + managed_id + "]", "hstack-" + managed_id + ".py",
                 "hstack-workflow-v1:" + instance_id, managed_id + ".lock")
