from typing import Optional, List, Dict, Any, Union, Literal
from pydantic import BaseModel, Field

MissionType = Literal[
    'growth',
    'capital-preservation',
    'event-reduction',
    'accumulation',
    'cash-allocation',
    'capital-target'
]

MissionStatus = Literal['active', 'paused', 'completed', 'failed', 'expired']
MissionProgressStatus = Literal['on-track', 'ahead', 'behind', 'at-risk']

class MissionProgress(BaseModel):
    currentPct: float
    status: MissionProgressStatus
    lastEvaluatedAt: float
    detail: str

class MissionCheckpoint(BaseModel):
    ts: float
    progressPct: float
    note: str

# For Phase 1 we will use Dict[str, Any] for polymorphic fields like targets and constraints
# to maintain simple parity with the complex TS discriminated unions.
class Mission(BaseModel):
    id: str
    type: MissionType
    name: str
    description: str
    status: MissionStatus
    createdAt: float
    updatedAt: float
    expiresAt: Optional[float] = None
    target: Dict[str, Any]
    progress: MissionProgress
    constraints: List[Dict[str, Any]]
    checkpoints: List[MissionCheckpoint]
