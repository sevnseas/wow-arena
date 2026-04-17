# Mixamo Character Setup

## Quick Start

The project now supports loading animated Mixamo characters!

### Step 1: Get a Mixamo Character

1. Go to https://www.mixamo.com
2. Sign in with your Adobe ID (or create one - free)
3. Browse the Characters section
4. Pick a character you like (e.g., "XBot", "Warrok (Orc)", etc.)
5. Download as **GLB** format

### Step 2: Place the Character

1. Save the downloaded GLB file as `public/models/character.glb`
2. Make sure the directory exists: `mkdir -p public/models`

### Step 3: Enable Mixamo Mode

Add `?mixamo=1` to the URL:
- http://localhost:3000/threejs-arena/?mixamo=1

That's it! The character will load and the game will use it.

## Animation Names

Mixamo characters typically include these animations:
- `idle` - Standing still
- `walk` - Walking movement
- `run` - Running/sprinting
- `cast` - Spell casting (optional, falls back to idle)
- Other actions like attack, jump, etc.

If your Mixamo character has different animation names, you can modify the animation lookup in `src/mixamo-character.ts`.

## Fallback

If loading fails, the game will automatically fall back to the procedural character so you can still play.

## Testing

Two modes available:
- **Without Mixamo**: `http://localhost:3000/threejs-arena/` (default - uses procedural character)
- **With Mixamo**: `http://localhost:3000/threejs-arena/?mixamo=1` (loads character.glb)

## Troubleshooting

### Character doesn't load
- Check browser console for errors
- Verify file is at `public/models/character.glb`
- Make sure it's a valid GLB file
- Check that it has animations named `idle`, `walk`, `run`

### Animations don't play
- Log available animations: Check console output when character loads
- Mixamo might use different animation names - check your GLB file in Blender or Three.js editor
- Update animation mappings in `MixamoCharacterView.playAnimation()`

### Character is huge/tiny
- The loader auto-scales to ~2 units tall
- If it's still wrong, adjust the scale factor in `MixamoCharacterView.load()`
