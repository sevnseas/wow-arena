# RL4: Multi-Entity Control with Unified Action Space

## Overview
Extend the RL training framework to allow the policy to control **any entity type** (wolves, cats, dummies, werewolves, etc.) using a unified control scheme. The policy learns both movement and tactical decisions (where to move, who to attack) from a minimap-style observation space.

## Unified Control Scheme

### Player-Controllable Actions
The policy outputs discrete actions identical to player controls:
- `1` - Ability 1
- `2` - Ability 2
- `3` - Ability 3
- `w` - Move forward
- `a` - Move left/strafe
- `s` - Move back
- `d` - Move right/strafe
- Mouse turning - Rotate/face direction

These are the only outputs the policy needs to produce, regardless of entity type.

## Observation Space: Minimap-Style Input

### State Representation
Input is a compact, entity-agnostic observation:
- **All entities in arena** with:
  - Position (x, z coordinates or relative to player)
  - Current HP / Max HP
  - Entity type (wolf, cat, dummy, werewolf, etc.)
  - Team/faction (player vs enemy)
  - Status effects (if relevant)

Think of it like a top-down minimap showing all combatants, their health, and relative positions.

### Why This Input?
- **Generalization**: Works for any entity since the observation format is consistent
- **Decision-making**: Policy must learn:
  - Where to move (tactical positioning)
  - Who to attack (target selection)
  - When to use abilities (positioning + target awareness)
  - Kiting and spacing strategies

## Training Goal

Train policies to:
1. **Learn target selection**: Which entity to focus based on threat/health/position
2. **Learn positioning**: Movement decisions (approach, kite, maintain range)
3. **Learn ability timing**: When to use 1/2/3 based on target state and positioning
4. **Generalize across entity types**: A single policy backbone that adapts to different entity stats/abilities

## Implementation Notes

- Observation space must be entity-agnostic (no hardcoded ability knowledge)
- Action space is fixed (8 directions + 3 abilities)
- Different entity types have different stats, but the learned strategy should transfer
- Consider curriculum learning: train on simple entities first (dummies), then complex (werewolves)
