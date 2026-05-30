"""Task 2: permutation-invariant entity-encoder trunk (DeepSets / masked max-pool).

The flat-MLP trunk from the wolf-rabbit project breaks the moment entities die
and reproduce: a fixed obs slot stops meaning "the same rabbit", and slot order
leaks into the weights, so shuffling neighbours changes the policy's mind. This
trunk fixes that structurally.

Observation layout (per agent), length OBS_DIM = SELF_DIM + MAX_VIS * ENT_DIM:
    [ self-state (SELF_DIM) | MAX_VIS entity vectors (ENT_DIM each) ]

Each entity vector's first feature is its `active` flag (1 visible, 0 padding).
The encoder:
    h_self  = MLP(self_state)
    e_i     = phi(entity_i)                      # shared weights, all i
    pooled  = max_i e_i  over ACTIVE entities    # inactive -> -inf, ignored
    trunk   = MLP([h_self, pooled])
    -> actor logits, value

Max over the entity axis is symmetric, so the output is invariant to entity
order; masking inactive rows out of the max makes padding entities invisible.
"""
import numpy as np
import torch
from torch import nn

try:
    import pufferlib.pytorch
    _layer_init = pufferlib.pytorch.layer_init
except Exception:                       # standalone (no pufferlib) fallback
    def _layer_init(layer, std=1.0, bias_const=0.0):
        nn.init.orthogonal_(layer.weight, std)
        nn.init.constant_(layer.bias, bias_const)
        return layer

# Observation schema (shared by env + policy).
SELF_DIM = 4          # [x_norm, y_norm, energy_norm, is_fox]
ENT_DIM = 6           # [active, rel_dx, rel_dy, is_rabbit, is_fox, is_grass]
MAX_VIS = 16          # max visible neighbours packed per agent
OBS_DIM = SELF_DIM + MAX_VIS * ENT_DIM
NEG_INF = -1e9


class PermInvTrunk(nn.Module):
    """Permutation-invariant encoder shared by both species' policies."""

    def __init__(self, hidden=128, ent_hidden=64):
        super().__init__()
        self.self_enc = nn.Sequential(
            _layer_init(nn.Linear(SELF_DIM, ent_hidden)), nn.GELU())
        # shared per-entity embedding (applied identically to every slot)
        self.phi = nn.Sequential(
            _layer_init(nn.Linear(ENT_DIM - 1, ent_hidden)), nn.GELU(),
            _layer_init(nn.Linear(ent_hidden, ent_hidden)), nn.GELU())
        self.trunk = nn.Sequential(
            _layer_init(nn.Linear(2 * ent_hidden, hidden)), nn.GELU())
        self.hidden_size = hidden

    def forward(self, obs):
        obs = obs.float()
        self_state = obs[:, :SELF_DIM]
        ents = obs[:, SELF_DIM:].reshape(-1, MAX_VIS, ENT_DIM)
        active = ents[:, :, :1]                       # (B, MAX_VIS, 1)
        feats = ents[:, :, 1:]                         # (B, MAX_VIS, ENT_DIM-1)

        h_self = self.self_enc(self_state)             # (B, ent_hidden)
        e = self.phi(feats)                            # (B, MAX_VIS, ent_hidden)
        # mask inactive slots out of the max so padding can never win
        e = e.masked_fill(active < 0.5, NEG_INF)
        pooled, _ = e.max(dim=1)                       # (B, ent_hidden)
        # if an agent sees nothing, every slot is -inf -> zero it out
        any_active = (active >= 0.5).any(dim=1)        # (B, 1)
        pooled = torch.where(any_active, pooled, torch.zeros_like(pooled))

        return self.trunk(torch.cat([h_self, pooled], dim=1))


class EcoPolicy(nn.Module):
    """One species' policy: perm-invariant trunk + discrete actor + critic.

    action_dim defaults to 8 (compass directions). Two independent instances
    (fox + rabbit) give the two weight spaces Task 3 needs.
    """

    def __init__(self, action_dim=8, hidden=128, ent_hidden=64):
        super().__init__()
        self.trunk = PermInvTrunk(hidden, ent_hidden)
        self.actor = _layer_init(nn.Linear(hidden, action_dim), std=0.01)
        self.critic = _layer_init(nn.Linear(hidden, 1), std=1.0)
        self.action_dim = action_dim

    def forward(self, obs):
        h = self.trunk(obs)
        return self.actor(h), self.critic(h)

    @torch.no_grad()
    def act(self, obs, deterministic=False):
        logits, value = self.forward(obs)
        if deterministic:
            return logits.argmax(dim=-1), value
        probs = torch.distributions.Categorical(logits=logits)
        return probs.sample(), value


# ---- helper to assemble a single agent's observation (used by env + tests) ----
def pack_obs(self_state, entities):
    """self_state: (SELF_DIM,), entities: list of (ENT_DIM,) arrays (<=MAX_VIS).
    Pads to MAX_VIS with zero (inactive) rows. Returns (OBS_DIM,) float32."""
    out = np.zeros(OBS_DIM, dtype=np.float32)
    out[:SELF_DIM] = self_state
    for k, e in enumerate(entities[:MAX_VIS]):
        out[SELF_DIM + k * ENT_DIM: SELF_DIM + (k + 1) * ENT_DIM] = e
    return out
