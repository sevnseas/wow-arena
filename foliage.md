# Foliage System for Arena

References for foliage implementation:

- [Flora Synth Editor](https://www.florasynth.com/editor?id=PRESET_White%20Oak) - Tree generation and customization
- [Cozzy - 3D Environment Tool](https://cozzy-hqrq.onrender.com/) - Environment design and asset placement

## Implementation Strategy

The foliage system should integrate procedurally generated trees and vegetation into the arena landscape created by the terrain system.

### Goals
1. Add stylized trees matching WotLK aesthetic
2. Place vegetation on the procedural terrain
3. Ensure trees don't clip with arena structures (pillars, walls, ramps)
4. Maintain performance with optimized geometry

### Considerations
- Tree placement should avoid core arena area (±15 units)
- Height variation should follow terrain elevation
- LOD system for distant trees
- Shadow casting for atmosphere
