"""Arena action-head utilities and the Task 4 action-mask alignment guardrail.

The arena policy emits a MultiDiscrete action: a movement angle (N_MOVE), a spell
slot (NSPELL) and a target priority (N_TARGET). The C++ engine produces a per-agent
mask buffer (build_action_mask) with one column per discrete option, 1=allowed.

This module:
  * splits/applies that flat mask to per-head logits (masked-softmax sampling),
  * enforces the Task 4 runtime invariant -- if an agent is CC'd or dead, every
    movement and every non-idle spell option is locked to 0. Index drift during
    rapid target swaps / teammate deaths would silently break this and let
    gradients cross-contaminate, so we assert it every step.
"""
import numpy as np
import eco_engine as E

NEG_INF = -1e9
# flat-mask column layout, must mirror eco_engine.cpp build_action_mask
MOVE = slice(0, E.N_MOVE)
SPELL = slice(E.N_MOVE, E.N_MOVE + E.NSPELL)
TARGET = slice(E.N_MOVE + E.NSPELL, E.N_MOVE + E.NSPELL + E.N_TARGET)


def split_mask(mask):
    """(n_agents, MASK_DIM) flat mask -> (move, spell, target) sub-masks."""
    mask = np.asarray(mask)
    return mask[:, MOVE], mask[:, SPELL], mask[:, TARGET]


def masked_logits(logits, mask):
    """Add -inf to masked-out (0) options so they can never be sampled.

    logits, mask: (n_agents, n_options). Returns a float32 copy. Rows with no
    legal option fall back to all-zero logits (uniform) to avoid NaNs -- callers
    treat such an agent as a no-op (it is dead / fully locked).
    """
    logits = np.asarray(logits, dtype=np.float32).copy()
    mask = np.asarray(mask)
    none_legal = mask.sum(axis=1) <= 0
    logits[mask < 0.5] = NEG_INF
    logits[none_legal] = 0.0
    return logits


def assert_mask_lock(eng):
    """Task 4 guardrail. Verify the C++ mask is aligned with combat state for
    EVERY agent in the current build_agent_obs() ordering. Raises AssertionError
    on any drift. Call right after build_agent_obs()+build_action_mask()."""
    mask = np.asarray(eng.action_mask())
    slots = np.asarray(eng.agent_slots())
    move, spell, target = split_mask(mask)
    statuses = np.asarray(eng.statuses())
    hps = np.asarray(eng.hps())
    for row, slot in enumerate(slots):
        locked = statuses[slot] != E.ST_IDLE or hps[slot] <= 0.0
        if locked:
            assert move[row].sum() == 0.0, \
                f"agent slot {slot} CC'd/dead but movement not locked"
            assert spell[row, 1:].sum() == 0.0, \
                f"agent slot {slot} CC'd/dead but a spell head is open"
        assert spell[row, 0] == 1.0, "idle must always be legal"
        if hps[slot] <= 0.0:
            assert target[row].sum() == 0.0, "dead agent must select no target"
    return True


def sample_heads(rng, move_logits, spell_logits, target_logits, masks):
    """Masked-categorical sample of all three heads. Returns int arrays
    (move, spell, target), each (n_agents,)."""
    mv_m, sp_m, tg_m = masks
    out = []
    for logits, m in ((move_logits, mv_m), (spell_logits, sp_m),
                      (target_logits, tg_m)):
        ml = masked_logits(logits, m)
        ml = ml - ml.max(axis=1, keepdims=True)
        p = np.exp(ml)
        p /= p.sum(axis=1, keepdims=True)
        idx = np.array([rng.choice(p.shape[1], p=row) for row in p])
        out.append(idx)
    return tuple(out)
