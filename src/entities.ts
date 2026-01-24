/**
 * Entity definitions for the arena
 */

export interface EntityDef {
  id: string;
  name: string;
  team: 'friendly' | 'enemy';
  position: [number, number, number];
  collider: {
    radius: number;
    height: number;
  };
  color: number;
  class?: string;
}

// Team colors
export const TEAM_COLORS = {
  friendly: 0x00ff88,
  enemy: 0xff4444
};

// Canonical player dimensions
export const PLAYER_COLLIDER = {
  radius: 0.35,
  height: 1.8
};

// Initial entity setup - Rogue/Mage/Priest vs enemy team
export const INITIAL_ENTITIES: EntityDef[] = [
  // Friendly team (player's team)
  {
    id: 'player',
    name: 'Player (Rogue)',
    team: 'friendly',
    position: [0, 0, 8],
    collider: { ...PLAYER_COLLIDER },
    color: 0xffff00, // Yellow for player
    class: 'Rogue'
  },
  {
    id: 'ally1',
    name: 'Mage',
    team: 'friendly',
    position: [-3, 0, 10],
    collider: { ...PLAYER_COLLIDER },
    color: 0x00aaff,
    class: 'Mage'
  },
  {
    id: 'ally2',
    name: 'Priest',
    team: 'friendly',
    position: [3, 0, 10],
    collider: { ...PLAYER_COLLIDER },
    color: 0xffffff,
    class: 'Priest'
  },
  // Enemy team
  {
    id: 'enemy1',
    name: 'Enemy Warrior',
    team: 'enemy',
    position: [0, 0, -8],
    collider: { ...PLAYER_COLLIDER },
    color: 0xff6600,
    class: 'Warrior'
  },
  {
    id: 'enemy2',
    name: 'Enemy Druid',
    team: 'enemy',
    position: [-4, 0, -10],
    collider: { ...PLAYER_COLLIDER },
    color: 0xff6600,
    class: 'Druid'
  },
  {
    id: 'enemy3',
    name: 'Enemy Shaman',
    team: 'enemy',
    position: [4, 0, -10],
    collider: { ...PLAYER_COLLIDER },
    color: 0xff6600,
    class: 'Shaman'
  }
];
