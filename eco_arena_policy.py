"""Multi-head masked arena policy (Task 2/3 network).

Reuses the permutation-invariant trunk from eco_policy (so target-relative
abstraction and the Task 2 permutation-invariance guardrail carry over) and adds
the three arena action heads the MultiDiscrete action space needs:

    move   : N_MOVE   discrete angles
    spell  : NSPELL   slots (idle / damage-heal / CC / defensive)
    target : N_TARGET priorities (current + 3 enemies + 2 allies)

The C++ engine's action mask (build_action_mask) is applied to each head's logits
before sampling, so a CC'd or dead agent can never sample a movement or non-idle
spell -- the structural half of the Task 4 action-mask alignment guarantee.
"""
import numpy as np
import torch
from torch import nn

import eco_engine as E
from eco_policy import PermInvTrunk, _layer_init

NEG_INF = -1e9
HEADS = (("move", E.N_MOVE), ("spell", E.NSPELL), ("target", E.N_TARGET))


class ArenaPolicy(nn.Module):
    def __init__(self, hidden=128, ent_hidden=64):
        super().__init__()
        self.trunk = PermInvTrunk(hidden, ent_hidden)
        self.heads = nn.ModuleDict({
            name: _layer_init(nn.Linear(hidden, dim), std=0.01)
            for name, dim in HEADS})
        self.critic = _layer_init(nn.Linear(hidden, 1), std=1.0)

    def forward(self, obs):
        h = self.trunk(obs)
        logits = {name: self.heads[name](h) for name, _ in HEADS}
        return logits, self.critic(h)

    @staticmethod
    def _apply_mask(logits, mask):
        """mask: (B, dim) 1=legal. Rows with no legal option -> uniform (no-op)."""
        if mask is None:
            return logits
        m = mask.to(logits.dtype)
        masked = logits.masked_fill(m < 0.5, NEG_INF)
        none = (m.sum(dim=1, keepdim=True) <= 0)
        return torch.where(none, torch.zeros_like(masked), masked)

    def split_masks(self, flat_mask):
        """(B, MASK_DIM) -> per-head mask tensors in HEADS order."""
        i = 0
        out = {}
        for name, dim in HEADS:
            out[name] = flat_mask[:, i:i + dim]
            i += dim
        return out

    @torch.no_grad()
    def act(self, obs, flat_mask=None, deterministic=False):
        logits, value = self.forward(obs)
        masks = self.split_masks(flat_mask) if flat_mask is not None else {}
        actions, logps = {}, {}
        for name, _ in HEADS:
            lg = self._apply_mask(logits[name], masks.get(name))
            if deterministic:
                a = lg.argmax(dim=-1)
            else:
                a = torch.distributions.Categorical(logits=lg).sample()
            actions[name] = a
            logps[name] = torch.log_softmax(lg, dim=-1).gather(
                1, a.unsqueeze(1)).squeeze(1)
        return actions, logps, value.squeeze(-1)

    def evaluate(self, obs, flat_mask, actions):
        """Re-evaluate stored actions for PPO: summed log-prob + summed entropy."""
        logits, value = self.forward(obs)
        masks = self.split_masks(flat_mask)
        logp = 0.0
        entropy = 0.0
        for name, _ in HEADS:
            lg = self._apply_mask(logits[name], masks[name])
            dist = torch.distributions.Categorical(logits=lg)
            logp = logp + dist.log_prob(actions[name])
            entropy = entropy + dist.entropy()
        return logp, entropy, value.squeeze(-1)
